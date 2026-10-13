// End-to-end check of the frontend <-> contract link against a LOCAL Anvil chain.
//
// Setup (see README): anvil, forge script DeployLocal, build/start the web app with the NEXT_PUBLIC_* vars
// pointing at the deployed registry, then:
//   REGISTRY=0x... ORACLE=0x... node scripts/e2e-local.mjs
//
// The browser gets an injected EIP-1193 wallet that forwards to Anvil's unlocked account #0, so the real
// UI signs and sends real transactions to the real contract. Assertions read the chain directly.
import { chromium } from "playwright";
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { foundry } from "viem/chains";
import { readFileSync } from "node:fs";

const RPC = process.env.RPC ?? "http://127.0.0.1:8545";
const APP = process.env.APP ?? "http://localhost:3100";
const REGISTRY = process.env.REGISTRY;
const ORACLE = process.env.ORACLE;
if (!REGISTRY || !ORACLE) {
  console.error("set REGISTRY and ORACLE (printed by the DeployLocal script)");
  process.exit(2);
}

const abiSrc = readFileSync(new URL("../lib/abi.ts", import.meta.url), "utf8");
const registryAbi = JSON.parse(abiSrc.slice(abiSrc.indexOf("[") , abiSrc.lastIndexOf("]") + 1));
const oracleAbi = parseAbi(["function set(uint32 index, uint64 value)"]);

const pub = createPublicClient({ chain: foundry, transport: http(RPC) });
const wal = createWalletClient({ chain: foundry, transport: http(RPC) });
const [ACCOUNT] = await wal.getAddresses();

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};
const rpc = (method, params = []) =>
  fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json());
const read = (functionName, args = []) => pub.readContract({ address: REGISTRY, abi: registryAbi, functionName, args });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium" });
const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
await context.addInitScript(({ rpc, account }) => {
  window.ethereum = {
    request: async ({ method, params }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [account];
      if (method === "wallet_switchEthereumChain") return null;
      const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }) });
      const j = await r.json();
      if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; throw e; }
      return j.result;
    },
    on() {},
    removeListener() {},
  };
}, { rpc: RPC, account: ACCOUNT });

const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));

try {
  const before = Number(await read("planCount"));

  // ---- 1. load + connect
  await page.goto(APP, { waitUntil: "load" });
  await page.waitForSelector("table", { timeout: 20000 });
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByText(/Connected 0x/).waitFor({ timeout: 15000 });
  check("wallet connects and panel loads", true);

  // ---- 2. commit from the UI
  const commitBtn = page.getByRole("button", { name: "Commit this hedge on-chain" });
  await page.getByRole("checkbox", { name: "Acknowledge local test mode" }).check();
  check("commit button enabled for a valid plan", await commitBtn.isEnabled());
  await commitBtn.click();
  const newId = before + 1;
  await page.getByText(`Committed plan #${newId} on-chain`).waitFor({ timeout: 20000 });
  const plan = await read("getPlan", [BigInt(newId)]);
  check("planCount increased by one", Number(await read("planCount")) === newId);
  check("on-chain owner is the connected account", plan.owner.toLowerCase() === ACCOUNT.toLowerCase());
  check("entry price came from the oracle, not the UI", plan.entryPx === 640000n, `entryPx=${plan.entryPx}`);
  check("notional is $10,000 (1e6 scale)", plan.notional === 10_000_000_000n);
  check("cap is $300 (3%)", plan.lossCap === 300_000_000n);
  check("plan is a long and Open", plan.isLong === true && plan.status === 1);
  check("legs hash recorded", /^0x[0-9a-f]{64}$/.test(plan.legsHash) && plan.legsHash !== "0x" + "0".repeat(64));
  await page.getByText("hash verified").first().waitFor({ timeout: 10000 });
  check("UI re-derives the legs hash and it matches the chain", true);

  // ---- 3. move the oracle -10% after expiry, settle from the UI
  await rpc("evm_setNextBlockTimestamp", [Number(plan.expiry) + 5]);
  await rpc("evm_mine");
  await wal.writeContract({ account: ACCOUNT, address: ORACLE, abi: oracleAbi, functionName: "set", args: [0, 576000] });
  await page.getByRole("button", { name: "Refresh" }).click();
  const settleBtn = page.getByRole("button", { name: "Settle" }).first();
  await settleBtn.waitFor({ timeout: 15000 });
  await settleBtn.click();
  await page.getByText(`Plan #${newId} settled`).waitFor({ timeout: 20000 });
  const settled = await read("getPlan", [BigInt(newId)]);
  check("plan is Settled on-chain", settled.status === 2);
  check("unhedged loss = $1,000 (-10% of $10k)", settled.unhedgedLoss === 1_000_000_000n, `loss=${settled.unhedgedLoss}`);
  const rec = await read("recordOf", [ACCOUNT]);
  check("record: floor was needed once", rec.triggered >= 1n && rec.settled >= 1n);
  check("record: $700 absorbed by the floor", rec.totalLossAvoided === 700_000_000n, `avoided=${rec.totalLossAvoided}`);
  await page.getByText("-10.00%").first().waitFor({ timeout: 10000 });
  await page.getByText("$700.00").first().waitFor({ timeout: 10000 });
  check("UI shows the -10.00% move and $700.00 absorbed", true);

  // ---- 4. lapse path: plan nobody settles
  const head = await pub.getBlock();
  const hash2 = await wal.writeContract({
    account: ACCOUNT, address: REGISTRY, abi: registryAbi, functionName: "commit",
    args: [0, false, 5_000_000_000n, 100_000_000n, head.timestamp + 3600n, "0x" + "ab".repeat(32)],
  });
  await pub.waitForTransactionReceipt({ hash: hash2 });
  const lapseId = newId + 1;
  await rpc("evm_increaseTime", [3600 + 601 + 5]);
  await rpc("evm_mine");
  await page.getByRole("button", { name: "Refresh" }).click();
  const lapseBtn = page.getByRole("button", { name: "Mark lapsed" }).first();
  await lapseBtn.waitFor({ timeout: 15000 });
  await page.getByText("not stored here").first().waitFor({ timeout: 5000 });
  check("UI offers 'Mark lapsed' after the window, and flags legs it cannot verify", true);
  await lapseBtn.click();
  await page.getByText(`Plan #${lapseId} marked lapsed`).waitFor({ timeout: 20000 });
  const lapsed = await read("getPlan", [BigInt(lapseId)]);
  check("plan is Lapsed on-chain", lapsed.status === 3);
  check("record counts the lapse", (await read("recordOf", [ACCOUNT])).lapsed >= 1n);

  check("no browser console errors", consoleErrors.length === 0, JSON.stringify(consoleErrors));
  await page.screenshot({ path: process.env.SHOT ?? "e2e-final.png", fullPage: true });
} catch (e) {
  failed++;
  console.log("FAIL  unexpected error:", e.message.split("\n")[0]);
  await page.screenshot({ path: "e2e-fail.png", fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}

console.log(failed === 0 ? "\nALL CHECKS PASSED" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
