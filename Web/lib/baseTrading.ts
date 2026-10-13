import { createPublicClient, http, parseAbi, parseEventLogs, type WalletClient } from "viem";
import { chain, RPC_URL } from "./chain";
import type { HedgePlan } from "./hedge";

const COLLATERAL = process.env.NEXT_PUBLIC_LEDGE_COLLATERAL as `0x${string}` | undefined;
const publicClient = createPublicClient({
  chain,
  transport: http(RPC_URL, { retryCount: 3, retryDelay: 500, timeout: 15_000 }),
});
const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
]);
const marketAbi = parseAbi([
  "function buy(uint8 side, uint64 maxPrice, uint128 shares) returns (uint128 filled, uint256 cost)",
  "event Trade(uint256 indexed id, address indexed buyer, address indexed maker, uint8 side, uint256 price, uint256 shares)",
]);
const marketConfigAbi = parseAbi(["function collateral() view returns (address)"]);

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
      const marketCollateral = await publicClient.readContract({ address: leg.marketAddress, abi: marketConfigAbi, functionName: "collateral" });
      if (marketCollateral.toLowerCase() !== COLLATERAL.toLowerCase()) {
        throw new Error("Market collateral does not match the configured Base collateral token.");
      }
      const shares = BigInt(Math.max(1, Math.round(leg.shares * 1e6)));
      const maxPrice = BigInt(Math.min(999_999, Math.ceil(leg.avgPx * 1e6)));
      // Ledge markets use six-decimal collateral and charge price * shares / 1e6.
      // Approve only the maximum possible spend for this order, never the share count.
      const maxSpend = (shares * maxPrice) / 1_000_000n;
      const balance = await publicClient.readContract({
        address: COLLATERAL,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account.address],
      });
      if (balance < maxSpend) {
        throw new Error(`Insufficient Ledge collateral for this leg. Need ${(Number(maxSpend) / 1e6).toFixed(6)}; wallet has ${(Number(balance) / 1e6).toFixed(6)}.`);
      }
      const approval = await wallet.writeContract({ address: COLLATERAL, abi: erc20Abi, functionName: "approve", args: [leg.marketAddress, maxSpend], account, chain });
      await publicClient.waitForTransactionReceipt({ hash: approval });
      const hash = await wallet.writeContract({ address: leg.marketAddress, abi: marketAbi, functionName: "buy", args: [leg.side === "yes" ? 0 : 1, maxPrice, shares], account, chain });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Base market transaction reverted");
      const trades = parseEventLogs({ abi: marketAbi, eventName: "Trade", logs: receipt.logs });
      const actualShares = trades.reduce((sum, trade) => sum + trade.args.shares, 0n);
      const actualCost = trades.reduce((sum, trade) => sum + (trade.args.shares * trade.args.price) / 1_000_000n, 0n);
      if (actualShares === 0n) throw new Error("Base transaction succeeded but filled zero hedge shares.");
      const avgPx = Number(actualCost) / Number(actualShares);
      statuses.push({ filled: { totalSz: (Number(actualShares) / 1e6).toString(), avgPx: avgPx.toFixed(6), txHash: hash } });
    } catch (error) {
      statuses.push({ error: error instanceof Error ? error.message : "Base market transaction failed" });
    }
  }
  return statuses;
}
