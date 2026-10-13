import { createPublicClient, http } from "viem";
import { readFileSync } from "node:fs";

const registry = process.env.NEXT_PUBLIC_LEDGE_REGISTRY;
const expectedOracle = process.env.NEXT_PUBLIC_LEDGE_ORACLE;
const rpc = process.env.NEXT_PUBLIC_EVM_RPC;
const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 0);

if (!/^0x[0-9a-fA-F]{40}$/.test(registry ?? "") || !/^0x[0-9a-fA-F]{40}$/.test(expectedOracle ?? "") || !rpc || ![84532, 8453].includes(chainId)) {
  throw new Error("Set NEXT_PUBLIC_LEDGE_REGISTRY, NEXT_PUBLIC_LEDGE_ORACLE, NEXT_PUBLIC_EVM_RPC, and NEXT_PUBLIC_CHAIN_ID=84532 or 8453");
}

const abiSource = readFileSync(new URL("../lib/abi.ts", import.meta.url), "utf8");
const abi = JSON.parse(abiSource.slice(abiSource.indexOf("[") , abiSource.lastIndexOf("]") + 1));
const client = createPublicClient({ chain: { id: chainId, name: chainId === 84532 ? "Base Sepolia" : "Base", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } }, transport: http(rpc) });
const [code, oracle, count, block] = await Promise.all([
  client.getBytecode({ address: registry }),
  client.readContract({ address: registry, abi, functionName: "oracle" }),
  client.readContract({ address: registry, abi, functionName: "planCount" }),
  client.getBlockNumber(),
]);

if (!code || code === "0x") throw new Error(`No contract code found at registry ${registry} on chain ${chainId}`);
if (oracle.toLowerCase() !== expectedOracle.toLowerCase()) throw new Error(`Unexpected oracle: ${oracle}; expected ${expectedOracle}`);
console.log(JSON.stringify({ ok: true, chainId, registry, oracle, planCount: count.toString(), checkedAtBlock: block.toString() }, null, 2));
