import { NextResponse } from "next/server";
import { createPublicClient, http, parseAbi } from "viem";
import { CHAIN_ID, COLLATERAL, MARKET_FACTORY, ORACLE, REGISTRY, RPC_URL, chain } from "@/lib/chain";

const registryAbi = parseAbi([
  "function oracle() view returns (address)",
  "function planCount() view returns (uint256)",
]);
const factoryAbi = parseAbi(["function marketCount() view returns (uint256)"]);
const oracleAbi = parseAbi(["function px(uint32) view returns (uint64)"]);

const client = createPublicClient({
  chain,
  transport: http(RPC_URL, { retryCount: 2, retryDelay: 400, timeout: 10_000 }),
});

async function codeAt(address: `0x${string}` | null) {
  if (!address) return false;
  const code = await client.getBytecode({ address });
  return Boolean(code && code !== "0x");
}

export async function GET() {
  const checks: Record<string, boolean> = {
    chainConfigured: [8453, 84532].includes(CHAIN_ID),
    registryConfigured: Boolean(REGISTRY),
    oracleConfigured: Boolean(ORACLE),
    factoryConfigured: Boolean(MARKET_FACTORY),
    collateralConfigured: Boolean(COLLATERAL),
  };

  try {
    const [block, registryCode, oracleCode, factoryCode, collateralCode] = await Promise.all([
      client.getBlockNumber(),
      codeAt(REGISTRY),
      codeAt(ORACLE),
      codeAt(MARKET_FACTORY),
      codeAt(COLLATERAL),
    ]);
    checks.registryCode = registryCode;
    checks.oracleCode = oracleCode;
    checks.factoryCode = factoryCode;
    checks.collateralCode = collateralCode;

    let registryOracle: string | null = null;
    let planCount = "0";
    let marketCount = "0";
    let btcOraclePrice = "0";
    if (REGISTRY && registryCode) {
      const [configuredOracle, count] = await Promise.all([
        client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "oracle" }),
        client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "planCount" }),
      ]);
      registryOracle = configuredOracle;
      planCount = count.toString();
      checks.registryOracleMatches = Boolean(ORACLE && configuredOracle.toLowerCase() === ORACLE.toLowerCase());
    }
    if (MARKET_FACTORY && factoryCode) {
      marketCount = (await client.readContract({ address: MARKET_FACTORY, abi: factoryAbi, functionName: "marketCount" })).toString();
    }
    if (ORACLE && oracleCode) {
      btcOraclePrice = (await client.readContract({ address: ORACLE, abi: oracleAbi, functionName: "px", args: [0] })).toString();
      checks.btcOraclePriceSet = btcOraclePrice !== "0";
    }

    const ok = Object.values(checks).every(Boolean);
    return NextResponse.json({
      ok,
      chainId: CHAIN_ID,
      block: block.toString(),
      registryOracle,
      planCount,
      marketCount,
      btcOraclePrice,
      checks,
    }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      chainId: CHAIN_ID,
      checks,
      error: error instanceof Error ? error.message : String(error),
    }, { status: 503, headers: { "Cache-Control": "no-store, max-age=0" } });
  }
}
