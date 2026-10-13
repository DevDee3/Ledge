import { describe, expect, it } from "vitest";
import { depthUpTo, parseL2Book, walkAsks } from "./book";
import { Candidate, legPayoff, planHedge } from "./hedge";

const EXP = Date.UTC(2026, 9, 9, 6, 0);

/** Deep books so liquidity doesn't bind unless a test wants it to. */
function cand(strike: number, mark: number, depth = 1e6, expiryMs = EXP): Candidate {
  // Crude implied probability: P(price above strike). Higher strike => lower YES price.
  const yes = Math.min(0.99, Math.max(0.01, 0.5 + (mark - strike) / (mark * 0.1)));
  const no = 1 - yes;
  return {
    outcome: Math.round(strike),
    strike,
    expiryMs,
    yesAsks: [{ px: Math.min(0.999, yes + 0.01), sz: depth }],
    noAsks: [{ px: Math.min(0.999, no + 0.01), sz: depth }],
  };
}

describe("book", () => {
  it("walks asks and reports partial fills", () => {
    const asks = [
      { px: 0.6, sz: 10 },
      { px: 0.5, sz: 5 },
    ];
    const f = walkAsks(asks, 8);
    expect(f.filled).toBe(8);
    expect(f.cost).toBeCloseTo(5 * 0.5 + 3 * 0.6);
    const partial = walkAsks(asks, 100);
    expect(partial.filled).toBe(15);
    expect(depthUpTo(asks, 0.5)).toBe(5);
  });

  it("parses an l2Book response", () => {
    const b = parseL2Book({
      levels: [[{ px: "0.55", sz: "10" }], [{ px: "0.57", sz: "4" }]],
    });
    expect(b.bids[0]).toEqual({ px: 0.55, sz: 10 });
    expect(b.asks[0]).toEqual({ px: 0.57, sz: 4 });
  });
});

describe("leg payoff semantics", () => {
  it("YES pays strictly above strike, NO pays at or below", () => {
    expect(legPayoff({ side: "yes", strike: 100, shares: 3 }, 100.01)).toBe(3);
    expect(legPayoff({ side: "yes", strike: 100, shares: 3 }, 100)).toBe(0);
    expect(legPayoff({ side: "no", strike: 100, shares: 3 }, 100)).toBe(3);
    expect(legPayoff({ side: "no", strike: 100, shares: 3 }, 100.01)).toBe(0);
  });
});

describe("planHedge", () => {
  const mark = 100;

  it("caps a long's loss with dense NO strikes (staircase)", () => {
    const strikes = Array.from({ length: 20 }, (_, i) => 99 - i); // 99..80
    const plan = planHedge({ size: 1, markPx: mark }, strikes.map((k) => cand(k, mark)), {
      lossCap: 2,
      windowPct: 0.2,
    });
    expect(plan.legs.length).toBeGreaterThan(5);
    expect(plan.legs.every((l) => l.side === "no")).toBe(true);
    expect(plan.capMet).toBe(true);
    expect(plan.worstLossExPremium).toBeLessThanOrEqual(2 + 1e-6);
    expect(plan.totalCost).toBeGreaterThan(0);
    expect(plan.unfilledShares).toBe(0);
    // Hedged curve never loses more than cap + premium inside the window.
    for (const p of plan.curve) {
      if (p.price >= plan.window.lo && p.price <= mark) {
        expect(p.hedged).toBeGreaterThanOrEqual(-(2 + plan.totalCost) - 1e-6);
      }
    }
  });

  it("admits when sparse strikes cannot meet the cap", () => {
    // Only strikes 95, 90, 85: loss between 95 and 100 reaches 5 > cap 2.
    const plan = planHedge({ size: 1, markPx: mark }, [95, 90, 85].map((k) => cand(k, mark)), {
      lossCap: 2,
      windowPct: 0.2,
    });
    expect(plan.capMet).toBe(false);
    expect(plan.worstLossExPremium).toBeGreaterThan(4.9);
  });

  it("mirrors for shorts using YES tokens above mark", () => {
    const strikes = Array.from({ length: 20 }, (_, i) => 101 + i); // 101..120
    const plan = planHedge({ size: -2, markPx: mark }, strikes.map((k) => cand(k, mark)), {
      lossCap: 3,
      windowPct: 0.2,
    });
    expect(plan.legs.every((l) => l.side === "yes")).toBe(true);
    expect(plan.capMet).toBe(true);
    expect(plan.worstLossExPremium).toBeLessThanOrEqual(3 + 1e-6);
  });

  it("reports liquidity shortfall instead of pretending", () => {
    const strikes = Array.from({ length: 20 }, (_, i) => 99 - i);
    const plan = planHedge({ size: 1, markPx: mark }, strikes.map((k) => cand(k, mark, 0.2)), {
      lossCap: 2,
      windowPct: 0.2,
    });
    expect(plan.unfilledShares).toBeGreaterThan(0);
    expect(plan.capMet).toBe(false);
  });

  it("returns an empty plan with no candidates or no position", () => {
    expect(planHedge({ size: 1, markPx: mark }, [], { lossCap: 1, windowPct: 0.1 }).legs).toEqual([]);
    expect(planHedge({ size: 0, markPx: mark }, [cand(95, mark)], { lossCap: 1, windowPct: 0.1 }).legs).toEqual([]);
  });

  it("uses only the earliest expiry unless one is chosen", () => {
    const later = EXP + 86_400_000;
    const plan = planHedge(
      { size: 1, markPx: mark },
      [cand(99, mark, 1e6, later), cand(98, mark, 1e6, EXP)],
      { lossCap: 0.5, windowPct: 0.2 },
    );
    expect(plan.legs.every((l) => l.strike === 98)).toBe(true);
  });
});
