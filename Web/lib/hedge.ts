import { Level, walkAsks } from "./book";

/**
 * Hedge engine: builds a loss-capped payoff for a position out of Base binary
 * outcome markets ("underlying above strike at expiry?").
 *
 * All payoffs here are measured AT EXPIRY of the binaries. Before expiry the
 * hedge is only a mark-to-market position; whether it counts toward perp margin
 * is a venue margin-engine question this module does not model.
 */

export type LegSide = "yes" | "no";

export interface Position {
  /** Signed size in base units (long > 0, short < 0). */
  size: number;
  /** Current mark price of the underlying. */
  markPx: number;
}

export interface Candidate {
  outcome: number;
  strike: number;
  expiryMs: number;
  /** Ask levels for the YES token and the NO token. */
  yesAsks: Level[];
  noAsks: Level[];
  /** Base market contract that owns this book. */
  marketAddress?: `0x${string}`;
}

export interface Leg {
  outcome: number;
  side: LegSide;
  strike: number;
  /** Shares requested by the optimizer. */
  wanted: number;
  /** Shares the book can actually fill. */
  shares: number;
  avgPx: number;
  cost: number;
  marketAddress?: `0x${string}`;
}

export interface CurvePoint {
  price: number;
  unhedged: number;
  hedged: number;
}

export interface HedgePlan {
  legs: Leg[];
  totalCost: number;
  /** Cost as a fraction of position notional. */
  costPct: number;
  lossCap: number;
  /** Worst PnL (as a positive loss) in the protected window, excluding premium. */
  worstLossExPremium: number;
  /** Same, including premium paid. */
  worstLossWithPremium: number;
  /** True if worstLossExPremium <= lossCap. */
  capMet: boolean;
  /** Shares the optimizer wanted but the book could not fill. */
  unfilledShares: number;
  /** Price window the plan was optimized over. */
  window: { lo: number; hi: number };
  /** Expiry (ms) of the contracts the plan uses; null if there were no candidates. */
  expiryMs: number | null;
  curve: CurvePoint[];
}

const EPS = 1e-9;

export function legPayoff(leg: Pick<Leg, "side" | "strike" | "shares">, price: number): number {
  const wins = leg.side === "yes" ? price > leg.strike : price <= leg.strike;
  return wins ? leg.shares : 0;
}

export function positionPnl(pos: Position, price: number): number {
  return pos.size * (price - pos.markPx);
}

export function hedgedPnl(pos: Position, legs: Leg[], price: number): number {
  let pnl = positionPnl(pos, price);
  for (const l of legs) pnl += legPayoff(l, price) - l.cost;
  return pnl;
}

function buildGrid(pos: Position, legs: Leg[], lo: number, hi: number, steps = 200): number[] {
  const set = new Set<number>();
  for (let i = 0; i <= steps; i++) set.add(lo + ((hi - lo) * i) / steps);
  set.add(pos.markPx);
  // Put points right at each strike so the payoff steps are exact and visible.
  for (const l of legs) {
    for (const p of [l.strike, l.strike + 1e-6]) if (p >= lo && p <= hi) set.add(p);
  }
  return [...set].sort((a, b) => a - b);
}

export function payoffCurve(pos: Position, legs: Leg[], lo: number, hi: number): CurvePoint[] {
  return buildGrid(pos, legs, lo, hi).map((price) => ({
    price,
    unhedged: positionPnl(pos, price),
    hedged: hedgedPnl(pos, legs, price),
  }));
}

export interface PlanOptions {
  /** Max loss to tolerate inside the window, before premium. */
  lossCap: number;
  /** How far the protected window extends from mark, e.g. 0.2 = 20%. */
  windowPct: number;
  /** Only use contracts with this expiry (ms). Defaults to the earliest expiry that has candidates. */
  expiryMs?: number;
  /** Skip legs whose average fill price exceeds this (near-certain outcomes are poor hedges). */
  maxAvgPx?: number;
  /** Skip legs smaller than this notional in collateral (exchange minimums). */
  minNotional?: number;
}

/**
 * Staircase hedge. A long needs NO tokens at strikes below mark (pay when price <= strike);
 * a short needs YES tokens at strikes above mark (pay when price > strike).
 * For strikes K_1..K_n ordered outward from mark, the cheapest cumulative payoff that keeps the
 * loss under `lossCap` at every price in the window has a closed form (see comments below).
 */
export function planHedge(pos: Position, candidates: Candidate[], opts: PlanOptions): HedgePlan {
  const { lossCap, windowPct } = opts;
  const abs = Math.abs(pos.size);
  const long = pos.size > 0;
  const mark = pos.markPx;
  const lo = mark * (1 - windowPct);
  const hi = mark * (1 + windowPct);

  const expiries = [...new Set(candidates.map((c) => c.expiryMs))].sort((a, b) => a - b);
  const expiry = opts.expiryMs ?? expiries[0];
  const pool = candidates.filter((c) => c.expiryMs === expiry);

  const wanted: { c: Candidate; shares: number }[] = [];

  if (abs > EPS && pool.length > 0) {
    if (long) {
      // Strikes strictly inside (lo, mark), ascending: K_1 < ... < K_n.
      const ks = pool.filter((c) => c.strike > lo && c.strike < mark).sort((a, b) => a.strike - b.strike);
      // Region (K_{j-1}, K_j] is covered by NO tokens i >= j. Worst price in that region is K_{j-1}+,
      // so cumulative shares sum_{i>=j} N_i must be >= abs*(mark - K_{j-1}) - lossCap, with K_0 = lo.
      const R = ks.map((_, j) => Math.max(0, abs * (mark - (j === 0 ? lo : ks[j - 1].strike)) - lossCap));
      ks.forEach((c, j) => {
        const n = R[j] - (j + 1 < ks.length ? R[j + 1] : 0);
        if (n > EPS) wanted.push({ c, shares: n });
      });
    } else {
      // Strikes strictly inside (mark, hi), ascending: K_1 < ... < K_n. YES at K_i pays when price > K_i.
      const ks = pool.filter((c) => c.strike > mark && c.strike < hi).sort((a, b) => a.strike - b.strike);
      // Region [K_j, K_{j+1}) is covered by YES tokens i <= j. Worst price is K_{j+1}-, with K_{n+1} = hi.
      const R = ks.map((_, j) => Math.max(0, abs * ((j + 1 < ks.length ? ks[j + 1].strike : hi) - mark) - lossCap));
      ks.forEach((c, j) => {
        const n = R[j] - (j > 0 ? R[j - 1] : 0);
        if (n > EPS) wanted.push({ c, shares: n });
      });
    }
  }

  const legs: Leg[] = [];
  let unfilled = 0;
  for (const { c, shares } of wanted) {
    const side: LegSide = long ? "no" : "yes";
    const fill = walkAsks(long ? c.noAsks : c.yesAsks, shares);
    const priceOk = opts.maxAvgPx === undefined || !(fill.avgPx > opts.maxAvgPx);
    const sizeOk = fill.cost >= (opts.minNotional ?? 0);
    if (fill.filled <= EPS || !priceOk || !sizeOk) {
      unfilled += shares;
      continue;
    }
    unfilled += shares - fill.filled;
    legs.push({
      outcome: c.outcome,
      side,
      strike: c.strike,
      wanted: shares,
      shares: fill.filled,
      avgPx: fill.avgPx,
      cost: fill.cost,
      marketAddress: c.marketAddress,
    });
  }

  const totalCost = legs.reduce((s, l) => s + l.cost, 0);
  const curve = payoffCurve(pos, legs, lo * 0.98, hi * 1.02);

  // Worst loss over the protected side of the window, premium excluded.
  const inWindow = curve.filter((p) => (long ? p.price >= lo && p.price <= mark : p.price >= mark && p.price <= hi));
  let worstEx = 0;
  for (const p of inWindow) {
    const exPremium = p.hedged + totalCost;
    worstEx = Math.max(worstEx, -exPremium);
  }

  return {
    legs,
    totalCost,
    costPct: abs * mark > 0 ? totalCost / (abs * mark) : 0,
    lossCap,
    worstLossExPremium: worstEx,
    worstLossWithPremium: worstEx + totalCost,
    capMet: worstEx <= lossCap + 1e-6,
    unfilledShares: unfilled,
    window: { lo, hi },
    expiryMs: expiry ?? null,
    curve,
  };
}
