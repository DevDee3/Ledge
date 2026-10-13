import { defineChain } from "viem";

// NEXT_PUBLIC_* values are inlined at build time, so each must be referenced literally.
const CHAIN_VALUE = (process.env.NEXT_PUBLIC_CHAIN_ID ?? "84532").trim().toLowerCase();
const CHAIN_ALIASES: Record<string, number> = { base: 8453, "base-mainnet": 8453, "base-sepolia": 84532, sepolia: 84532, local: 31337 };
const RAW_CHAIN_ID = CHAIN_ALIASES[CHAIN_VALUE] ?? Number(CHAIN_VALUE);
const RAW_REGISTRY = process.env.NEXT_PUBLIC_LEDGE_REGISTRY;
const RAW_RPC = process.env.NEXT_PUBLIC_EVM_RPC;
const RAW_DEPLOY_BLOCK = (process.env.NEXT_PUBLIC_LEDGE_DEPLOY_BLOCK ?? "").trim();
const RAW_ENABLE_TRADING = process.env.NEXT_PUBLIC_ENABLE_TRADING;
const RAW_EXPLORER = process.env.NEXT_PUBLIC_EXPLORER_URL;
const RAW_ORACLE = process.env.NEXT_PUBLIC_LEDGE_ORACLE;

const DEFAULT_RPC: Record<number, string> = {
  8453: "https://mainnet.base.org",
  84532: "https://sepolia.base.org",
  31337: "http://127.0.0.1:8545",
};

const NAMES: Record<number, string> = {
  8453: "Base",
  84532: "Base Sepolia",
  31337: "Local (Anvil)",
};

export const CHAIN_ID = RAW_CHAIN_ID;
export const IS_LOCAL = RAW_CHAIN_ID === 31337;
export const RPC_URL = RAW_RPC ?? DEFAULT_RPC[RAW_CHAIN_ID] ?? "";
export const ENABLE_TRADING = RAW_ENABLE_TRADING === "1" && !IS_LOCAL;
export const EXPLORER_URL = RAW_EXPLORER?.replace(/\/$/, "") ?? null;
export const ORACLE: `0x${string}` | null = RAW_ORACLE && /^0x[0-9a-fA-F]{40}$/.test(RAW_ORACLE) ? RAW_ORACLE as `0x${string}` : null;

if (![8453, 84532, 31337].includes(RAW_CHAIN_ID)) {
  throw new Error(`Unsupported chain "${process.env.NEXT_PUBLIC_CHAIN_ID ?? "84532"}". Set NEXT_PUBLIC_CHAIN_ID to base-sepolia, 84532, base, 8453, or 31337.`);
}

export const chain = defineChain({
  id: RAW_CHAIN_ID,
  name: NAMES[RAW_CHAIN_ID] ?? `Chain ${RAW_CHAIN_ID}`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

export const REGISTRY: `0x${string}` | null =
  RAW_REGISTRY && /^0x[0-9a-fA-F]{40}$/.test(RAW_REGISTRY) ? (RAW_REGISTRY as `0x${string}`) : null;

if (ENABLE_TRADING && (!REGISTRY || (!IS_LOCAL && !ORACLE))) {
  throw new Error("Trading requires NEXT_PUBLIC_LEDGE_REGISTRY and NEXT_PUBLIC_LEDGE_ORACLE to be configured.");
}

/** First block to scan for Committed events. Set it to the deploy block to keep log queries small. */
export const DEPLOY_BLOCK = RAW_DEPLOY_BLOCK ? BigInt(RAW_DEPLOY_BLOCK) : BigInt(0);

if (REGISTRY && !IS_LOCAL && (!RAW_DEPLOY_BLOCK || !/^(0x[0-9a-fA-F]+|[1-9]\d*)$/.test(RAW_DEPLOY_BLOCK) || BigInt(RAW_DEPLOY_BLOCK) === 0n)) {
  throw new Error(`NEXT_PUBLIC_LEDGE_DEPLOY_BLOCK must be a non-zero deployment block; received ${RAW_DEPLOY_BLOCK ? JSON.stringify(RAW_DEPLOY_BLOCK) : "<unset>"}.`);
}

if (REGISTRY && !IS_LOCAL && !ORACLE) {
  throw new Error("NEXT_PUBLIC_LEDGE_ORACLE is required when the registry is configured.");
}

/**
 * Perp indices used ONLY on the local chain, where the mock oracle in DeployLocal.s.sol defines them.
 * On Base, these indexes identify the reference-price slots used by the configured oracle adapter.
 */
export const LOCAL_PERP_INDEX: Record<string, number> = { BTC: 0, ETH: 1, SOL: 2 };
