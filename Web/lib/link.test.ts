import { describe, expect, it } from "vitest";
import {
  MAX_DURATION_S,
  SETTLE_WINDOW_S,
  buildCommitArgs,
  canonicalLegs,
  commitBlockers,
  hashLegs,
  planAction,
} from "./link";

const legs = [
  { outcome: 12, side: "no" as const, strike: 62080, shares: 100 },
  { outcome: 11, side: "no" as const, strike: 61440, shares: 100.5 },
];
const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const base = {
  assetIndex: 0,
  isLong: true,
  notionalUsd: 10_000,
  lossCapUsd: 300,
  expiryMs: NOW + 18 * 3600_000,
  legs,
};

describe("legs hash", () => {
  it("is independent of leg order", () => {
    expect(hashLegs(legs)).toBe(hashLegs([...legs].reverse()));
  });

  it("changes when any leg field changes", () => {
    const h = hashLegs(legs);
    expect(hashLegs([{ ...legs[0], shares: 101 }, legs[1]])).not.toBe(h);
    expect(hashLegs([{ ...legs[0], strike: 62081 }, legs[1]])).not.toBe(h);
    expect(hashLegs([{ ...legs[0], side: "yes" }, legs[1]])).not.toBe(h);
    expect(hashLegs([legs[0]])).not.toBe(h);
  });

  it("is a 32-byte hex string and has a stable canonical form", () => {
    expect(hashLegs(legs)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(canonicalLegs(legs)).toBe(
      '[{"outcome":11,"side":"no","strike":"61440.000000","shares":"100.500000"},{"outcome":12,"side":"no","strike":"62080.000000","shares":"100.000000"}]',
    );
  });
});

describe("buildCommitArgs", () => {
  it("scales USD to 1e6, seconds for expiry, and hashes the legs", () => {
    const [idx, long, notional, cap, expiry, hash] = buildCommitArgs(base);
    expect(idx).toBe(0);
    expect(long).toBe(true);
    expect(notional).toBe(10_000_000_000n);
    expect(cap).toBe(300_000_000n);
    expect(expiry).toBe(BigInt(Math.floor(base.expiryMs / 1000)));
    expect(hash).toBe(hashLegs(legs));
  });

  it("clamps the cap to the notional like the contract requires", () => {
    const [, , notional, cap] = buildCommitArgs({ ...base, lossCapUsd: 99_999 });
    expect(cap).toBe(notional);
  });

  it("refuses plans without a perp index or expiry", () => {
    expect(() => buildCommitArgs({ ...base, assetIndex: null })).toThrow();
    expect(() => buildCommitArgs({ ...base, expiryMs: null })).toThrow();
  });
});

describe("commitBlockers", () => {
  it("is empty for a good plan", () => {
    expect(commitBlockers(base, NOW)).toEqual([]);
  });

  it("flags each failure the contract would revert on", () => {
    expect(commitBlockers({ ...base, assetIndex: null }, NOW).join()).toMatch(/asset index/);
    expect(commitBlockers({ ...base, legs: [] }, NOW).join()).toMatch(/no hedge legs/);
    expect(commitBlockers({ ...base, notionalUsd: 0 }, NOW).join()).toMatch(/Notional/);
    expect(commitBlockers({ ...base, expiryMs: NOW - 1000 }, NOW).join()).toMatch(/expired/);
    expect(commitBlockers({ ...base, expiryMs: NOW }, NOW).join()).toMatch(/expired/);
    expect(commitBlockers({ ...base, expiryMs: NOW + (MAX_DURATION_S + 5) * 1000 }, NOW).join()).toMatch(/7 days/);
    expect(commitBlockers({ ...base, expiryMs: null }, NOW).join()).toMatch(/expiry/i);
  });

  it("allows an expiry of exactly seven days", () => {
    expect(commitBlockers({ ...base, expiryMs: NOW + MAX_DURATION_S * 1000 }, NOW)).toEqual([]);
  });
});

describe("planAction", () => {
  const exp = 1_000_000;
  it("follows the contract's settle window", () => {
    expect(planAction("Open", exp, exp - 1)).toBe("wait");
    expect(planAction("Open", exp, exp)).toBe("settle");
    expect(planAction("Open", exp, exp + SETTLE_WINDOW_S)).toBe("settle");
    expect(planAction("Open", exp, exp + SETTLE_WINDOW_S + 1)).toBe("lapse");
  });
  it("is done for anything not Open", () => {
    expect(planAction("Settled", exp, exp)).toBe("done");
    expect(planAction("Lapsed", exp, exp + 9999)).toBe("done");
    expect(planAction("None", exp, exp)).toBe("done");
  });
});
