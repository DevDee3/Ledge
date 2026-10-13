import { createPublicClient, http, parseAbi, type WalletClient } from "viem";
import { chain, RPC_URL } from "./chain";
import type { HedgePlan } from "./hedge";

const COLLATERAL = process.env.NEXT_PUBLIC_LEDGE_COLLATERAL as `0x${string}` | undefined;
const publicClient = createPublicClient({
  chain,
  transport: http(RPC_URL, { retryCount: 3, retryDelay: 500, timeout: 15_000 }),
});
const erc20Abi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
const marketAbi = parseAbi(["function buy(uint8 side, uint64 maxPrice, uint128 shares) returns (uint128 filled, uint256 cost)"]);

export type BaseOrderStatus =
  | { filled: { totalSz: string; avgPx: string; txHash: `0x${string}` } }
  | { error: string };

/** Execute each hedge leg against a Base LedgeBinaryMarket ask book. */
export async function executeBaseHedge(wallet: WalletClient, plan: HedgePlan): Promise<BaseOrderStatus[]> {
  if (!COLLATERAL || !/^0x[0-9a-fA-F]{40}$/.test(COLLATERAL)) throw new Error("Base collateral token is not configured.");
  if (plan.legs.length === 0) throw new Error("There are no hedge legs to execute.");

  const account = wallet.account;
  if (!account || typeof account === "string") throw new Error("Connect a wallet before trading.");
  const statuses: BaseOrderStatus[] = [];

  for (const leg of plan.legs) {
    if (!leg.marketAddress) {
      statuses.push({ error: "This hedge leg is not backed by a Base market contract." });
      continue;
    }
    try {
      const shares = BigInt(Math.max(1, Math.round(leg.shares * 1e6)));
      const maxPrice = BigInt(Math.min(999_999, Math.ceil(leg.avgPx * 1e6)));
      const approval = await wallet.writeContract({ address: COLLATERAL, abi: erc20Abi, functionName: "approve", args: [leg.marketAddress, shares], account, chain });
      await publicClient.waitForTransactionReceipt({ hash: approval });
      const hash = await wallet.writeContract({ address: leg.marketAddress, abi: marketAbi, functionName: "buy", args: [leg.side === "yes" ? 0 : 1, maxPrice, shares], account, chain });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Base market transaction reverted");
      statuses.push({ filled: { totalSz: String(leg.shares), avgPx: leg.avgPx.toFixed(6), txHash: hash } });
    } catch (error) {
      statuses.push({ error: error instanceof Error ? error.message : "Base market transaction failed" });
    }
  }
  return statuses;
}
