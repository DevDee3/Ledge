import { createPublicClient, http } from "viem";
import { readFileSync } from "node:fs";

const registry = process.env.NEXT_PUBLIC_LEDGE_REGISTRY;
const expectedOracle = process.env.NEXT_PUBLIC_LEDGE_ORACLE;
const factory = process.env.NEXT_PUBLIC_MARKET_FACTORY;
const collateral = process.env.NEXT_PUBLIC_LEDGE_COLLATERAL;
const rpc = process.env.NEXT_PUBLIC_EVM_RPC;
const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 0);

if (!/^0x[0-9a-fA-F]{40}$/.test(registry ?? "") || !/^0x[0-9a-fA-F]{40}$/.test(expectedOracle ?? "") || !/^0x[0-9a-fA-F]{40}$/.test(factory ?? "") || !/^0x[0-9a-fA-F]{40}$/.test(collateral ?? "") || !rpc || ![84532, 8453].includes(chainId)) {
  throw new Error("Set registry, oracle, market factory, collateral, RPC, and chain ID=84532 or 8453");
}

const abiSource = readFileSync(new URL("../lib/abi.ts", import.meta.url), "utf8");
const abi = JSON.parse(abiSource.slice(abiSource.indexOf("[") , abiSource.lastIndexOf("]") + 1));
const client = createPublicClient({ chain: { id: chainId, name: chainId === 84532 ? "Base Sepolia" : "Base", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } }, transport: http(rpc) });
const [code, oracle, count, block, factoryCode, collateralCode] = await Promise.all([
  client.getBytecode({ address: registry }),
  client.readContract({ address: registry, abi, functionName: "oracle" }),
  client.readContract({ address: registry, abi, functionName: "planCount" }),
  client.getBlockNumber(),
  client.getBytecode({ address: factory }),
  client.getBytecode({ address: collateral }),
]);

if (!code || code === "0x") throw new Error(`No contract code found at registry ${registry} on chain ${chainId}`);
if (!factoryCode || factoryCode === "0x") throw new Error(`No contract code found at market factory ${factory} on chain ${chainId}`);
if (!collateralCode || collateralCode === "0x") throw new Error(`No contract code found at collateral ${collateral} on chain ${chainId}`);
if (oracle.toLowerCase() !== expectedOracle.toLowerCase()) throw new Error(`Unexpected oracle: ${oracle}; expected ${expectedOracle}`);
console.log(JSON.stringify({ ok: true, chainId, registry, oracle, factory, collateral, planCount: count.toString(), checkedAtBlock: block.toString() }, null, 2));
