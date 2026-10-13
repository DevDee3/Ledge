import { createPublicClient, http, parseAbi } from "viem";
import { chain, RPC_URL } from "./chain";
import type { Candidate } from "./hedge";

const FACTORY = process.env.NEXT_PUBLIC_MARKET_FACTORY as `0x${string}` | undefined;
const client = createPublicClient({
  chain,
  transport: http(RPC_URL, { retryCount: 3, retryDelay: 500, timeout: 15_000 }),
});

const factoryAbi = parseAbi([
  "function marketCount() view returns (uint256)",
  "function marketAt(uint256) view returns (address)",
]);
const marketAbi = parseAbi([
  "function underlying() view returns (string)",
  "function strike() view returns (uint64)",
  "function expiry() view returns (uint64)",
  "function referencePrice() view returns (uint64)",
  "function getBook(uint8) view returns (uint64[] prices, uint128[] shares)",
]);

export interface BaseMarketSnapshot {
  underlying: string;
  markPx: number;
  assetIndex: number | null;
  candidates: Candidate[];
  source: "live" | "demo";
  fetchedAt: number;
}

const ASSET_INDEX: Record<string, number> = { BTC: 0, ETH: 1, SOL: 2 };
type BaseCandidate = Omit<Candidate, "marketAddress"> & { marketAddress: `0x${string}`; markPx: number };

export class BaseMarketNotConfiguredError extends Error {
  readonly code = "MARKET_NOT_CONFIGURED" as const;

  constructor() {
    super("Base market factory is not configured. Set NEXT_PUBLIC_MARKET_FACTORY.");
    this.name = "BaseMarketNotConfiguredError";
  }
}

export async function getBaseMarket(underlying: string): Promise<BaseMarketSnapshot> {
  if (!FACTORY || !/^0x[0-9a-fA-F]{40}$/.test(FACTORY)) {
    throw new BaseMarketNotConfiguredError();
  }

  const count = Number(await client.readContract({ address: FACTORY, abi: factoryAbi, functionName: "marketCount" }));
  const addresses = await Promise.all(
    Array.from({ length: count }, (_, index) => client.readContract({ address: FACTORY, abi: factoryAbi, functionName: "marketAt", args: [BigInt(index)] })),
  );
  const now = Date.now();
  const candidates: BaseCandidate[] = [];
  // Keep RPC concurrency low. Public Base Sepolia endpoints commonly reject a burst of
  // dozens of simultaneous eth_call requests during a market refresh.
  for (let index = 0; index < addresses.length; index += 1) {
    const address = addresses[index];
    const [name, strike, expiry, referencePrice, yesBook, noBook] = await Promise.all([
      client.readContract({ address, abi: marketAbi, functionName: "underlying" }),
      client.readContract({ address, abi: marketAbi, functionName: "strike" }),
      client.readContract({ address, abi: marketAbi, functionName: "expiry" }),
      client.readContract({ address, abi: marketAbi, functionName: "referencePrice" }),
      client.readContract({ address, abi: marketAbi, functionName: "getBook", args: [0] }),
      client.readContract({ address, abi: marketAbi, functionName: "getBook", args: [1] }),
    ]);
    if (name !== underlying || Number(expiry) * 1000 <= now) continue;
    const toAsks = (book: readonly [readonly bigint[], readonly bigint[]]) => book[0].map((price, i) => ({ px: Number(price) / 1e6, sz: Number(book[1][i]) / 1e6 }));
    candidates.push({
      outcome: index,
      marketAddress: address,
      strike: Number(strike),
      expiryMs: Number(expiry) * 1000,
      yesAsks: toAsks(yesBook),
      noAsks: toAsks(noBook),
      markPx: Number(referencePrice),
    } satisfies BaseCandidate);
  }

  if (candidates.length === 0) throw new Error(`No active Base binary markets found for ${underlying}.`);
  return { underlying, markPx: candidates[0].markPx, assetIndex: ASSET_INDEX[underlying] ?? null, candidates, source: "live", fetchedAt: Date.now() };
}

export function getDemoBaseMarket(underlying: string): BaseMarketSnapshot {
  const markPx = underlying === "ETH" ? 2400 : 64000;
  const step = markPx * 0.01;
  const expiryMs = Date.now() + 18 * 3600_000;
  const candidates: Candidate[] = [];
  for (let i = -15; i <= 15; i++) {
    if (i === 0) continue;
    const strike = Math.round((markPx + i * step) * 100) / 100;
    const z = (markPx - strike) / (markPx * 0.02);
    const pYes = 1 / (1 + Math.exp(-1.7 * z));
    const clamp = (p: number) => Math.min(0.999, Math.max(0.001, p));
    const depth = 800 + 3000 * Math.exp(-Math.abs(i) / 5);
    candidates.push({
      outcome: i + 15,
      strike,
      expiryMs,
      yesAsks: [{ px: clamp(pYes + 0.012), sz: depth }, { px: clamp(pYes + 0.036), sz: depth * 2 }],
      noAsks: [{ px: clamp(1 - pYes + 0.012), sz: depth }, { px: clamp(1 - pYes + 0.036), sz: depth * 2 }],
    });
  }
  return { underlying, markPx, assetIndex: ASSET_INDEX[underlying] ?? null, candidates, source: "demo", fetchedAt: Date.now() };
}
