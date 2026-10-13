import { keccak256, toBytes } from "viem";
import type { Leg } from "./hedge";

/** Mirrors LedgeRegistry constants. If the contract changes, change these (the e2e test checks them). */
export const SETTLE_WINDOW_S = 600;
export const MAX_DURATION_S = 7 * 24 * 3600;

/** Mirrors the contract's `Status` enum. */
export const STATUS = ["None", "Open", "Settled", "Lapsed"] as const;
export type StatusName = (typeof STATUS)[number];

/**
 * Canonical, order-independent text form of a leg list. The keccak256 of this string is what gets stored
 * on-chain as `legsHash`, so anyone holding the published legs can recompute and check it.
 */
export function canonicalLegs(legs: Pick<Leg, "outcome" | "side" | "strike" | "shares">[]): string {
  const rows = legs
    .map((l) => ({
      outcome: l.outcome,
      side: l.side,
      strike: l.strike.toFixed(6),
      shares: l.shares.toFixed(6),
    }))
    .sort((a, b) => a.outcome - b.outcome || a.side.localeCompare(b.side));
  return JSON.stringify(rows);
}

export function hashLegs(legs: Pick<Leg, "outcome" | "side" | "strike" | "shares">[]): `0x${string}` {
  return keccak256(toBytes(canonicalLegs(legs)));
}

const usd6 = (x: number) => BigInt(Math.round(x * 1e6));

export interface CommitInput {
  assetIndex: number | null;
  isLong: boolean;
  notionalUsd: number;
  lossCapUsd: number;
  expiryMs: number | null;
  legs: Pick<Leg, "outcome" | "side" | "strike" | "shares">[];
}

export type CommitArgs = readonly [number, boolean, bigint, bigint, bigint, `0x${string}`];

export function buildCommitArgs(i: CommitInput): CommitArgs {
  if (i.assetIndex === null || i.expiryMs === null) throw new Error("plan is not committable");
  const notional = usd6(i.notionalUsd);
  const cap = usd6(Math.min(i.lossCapUsd, i.notionalUsd));
  return [i.assetIndex, i.isLong, notional, cap, BigInt(Math.floor(i.expiryMs / 1000)), hashLegs(i.legs)];
}

/** Reasons the contract would revert, caught client-side before the user pays gas. Empty = OK. */
export function commitBlockers(i: CommitInput, nowMs: number): string[] {
  const out: string[] = [];
  if (i.assetIndex === null) out.push("No on-chain asset index for this market (demo data or unknown asset).");
  if (i.legs.length === 0) out.push("The plan has no hedge legs to record.");
  if (i.notionalUsd <= 0) out.push("Notional must be positive.");
  if (i.expiryMs === null) {
    out.push("No expiry to commit to.");
  } else {
    const nowS = Math.floor(nowMs / 1000);
    const exp = Math.floor(i.expiryMs / 1000);
    if (exp <= nowS) out.push("The hedge contracts have already expired.");
    else if (exp > nowS + MAX_DURATION_S) out.push("Expiry is more than 7 days away; the registry rejects that.");
  }
  return out;
}

export type PlanAction = "wait" | "settle" | "lapse" | "done";

/** What a plan can do right now, matching the contract's settle/lapse window rules. */
export function planAction(status: StatusName, expiryS: number, nowS: number): PlanAction {
  if (status !== "Open") return "done";
  if (nowS < expiryS) return "wait";
  if (nowS <= expiryS + SETTLE_WINDOW_S) return "settle";
  return "lapse";
}
