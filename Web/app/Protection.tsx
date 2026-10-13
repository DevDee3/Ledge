"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  parseEventLogs,
  type EIP1193Provider,
} from "viem";
import { ledgeRegistryAbi } from "@/lib/abi";
import { CHAIN_ID, ENABLE_TRADING, EXPLORER_URL, IS_LOCAL, LOCAL_PERP_INDEX, ORACLE, REGISTRY, RPC_URL, chain } from "@/lib/chain";
import type { HedgePlan } from "@/lib/hedge";
import { executeBaseHedge, type BaseOrderStatus } from "@/lib/baseTrading";
import {
  STATUS,
  buildCommitArgs,
  commitBlockers,
  hashLegs,
  planAction,
  type CommitInput,
} from "@/lib/link";

interface Props {
  asset: string;
  isLong: boolean;
  notionalUsd: number;
  lossCapUsd: number;
  assetIndex: number | null;
  plan: HedgePlan;
  marketFetchedAt: number;
  onRefreshMarket: () => void;
  onPositionDetected: (position: { coin: string; size: number; notionalUsd: number }) => void;
}

interface OnchainPlan {
  id: bigint;
  isLong: boolean;
  status: (typeof STATUS)[number];
  expiry: number;
  entryPx: bigint;
  settlePx: bigint;
  notional: bigint;
  lossCap: bigint;
  unhedgedLoss: bigint;
  legsHash: `0x${string}`;
}

interface OnchainRecord {
  settled: number;
  triggered: number;
  lapsed: number;
  avoided: bigint;
}

type ImportedPosition = { coin: string; size: number; entryPx: number | null; liquidationPx: number | null; unrealizedPnl: number };

type StoredLegs = { outcome: number; side: "yes" | "no"; strike: number; shares: number }[];

const publicClient = createPublicClient({
  chain,
  transport: http(RPC_URL, { retryCount: 3, retryDelay: 500, timeout: 15_000 }),
});

const usd = (x: bigint) =>
  (Number(x) / 1e6).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function provider(): EIP1193Provider | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { ethereum?: EIP1193Provider }).ethereum ?? null;
}

const storeKey = (account: string) => `ledge:legs:${REGISTRY}:${account.toLowerCase()}`;

function loadLegs(account: string): Record<string, StoredLegs> {
  try {
    return JSON.parse(localStorage.getItem(storeKey(account)) ?? "{}");
  } catch {
    return {};
  }
}

function saveLegs(account: string, id: bigint, legs: StoredLegs) {
  try {
    const all = loadLegs(account);
    all[id.toString()] = legs;
    localStorage.setItem(storeKey(account), JSON.stringify(all));
  } catch {
    /* storage unavailable: the record on-chain is still valid, we just can't re-verify the legs */
  }
}

export default function Protection({ asset, isLong, notionalUsd, lossCapUsd, assetIndex, plan, marketFetchedAt, onRefreshMarket, onPositionDetected }: Props) {
  const [account, setAccount] = useState<`0x${string}` | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [plans, setPlans] = useState<OnchainPlan[]>([]);
  const [record, setRecord] = useState<OnchainRecord | null>(null);
  const [chainNow, setChainNow] = useState<number>(0) // replaced by the latest block time on connect;
  const [stored, setStored] = useState<Record<string, StoredLegs>>({});
  const [positions] = useState<ImportedPosition[]>([]);
  const positionsBusy = false;
  const [execution, setExecution] = useState<{ planKey: string; statuses: BaseOrderStatus[]; verified: boolean; pendingLegs: HedgePlan["legs"] } | null>(null);
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [localAcknowledged, setLocalAcknowledged] = useState(false);

  useEffect(() => {
    const p = provider() as (EIP1193Provider & {
      on?: (event: string, listener: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
    }) | null;
    if (!p?.on) return;
    const onAccountsChanged = (accounts: unknown) => {
      const next = Array.isArray(accounts) ? accounts[0] : null;
      setAccount(typeof next === "string" ? next as `0x${string}` : null);
      setPlans([]);
      setRecord(null);
      setStored({});
    };
    const onChainChanged = () => {
      setAccount(null);
      setPlans([]);
      setRecord(null);
      setMsg({ kind: "err", text: "Wallet network changed. Reconnect to continue." });
    };
    p.on("accountsChanged", onAccountsChanged);
    p.on("chainChanged", onChainChanged);
    return () => {
      p.removeListener?.("accountsChanged", onAccountsChanged);
      p.removeListener?.("chainChanged", onChainChanged);
    };
  }, []);

  // On Base, the reference-price index comes from the configured market/oracle deployment.
  const effectiveIndex = assetIndex ?? (IS_LOCAL ? (LOCAL_PERP_INDEX[asset] ?? null) : null);

  const input: CommitInput = useMemo(
    () => ({
      assetIndex: effectiveIndex,
      isLong,
      notionalUsd,
      lossCapUsd,
      expiryMs: plan.expiryMs,
      legs: plan.legs,
    }),
    [effectiveIndex, isLong, notionalUsd, lossCapUsd, plan.expiryMs, plan.legs],
  );
  const planKey = `${asset}:${isLong}:${notionalUsd}:${lossCapUsd}:${plan.expiryMs}:${plan.legs.map((leg) => `${leg.outcome}-${leg.side}-${leg.shares}`).join(",")}`;
  const hedgeVerified = execution?.planKey === planKey && execution.verified;
  const hedgeReady = hedgeVerified || (IS_LOCAL && localAcknowledged);
  const tradeBlocker = !ENABLE_TRADING
    ? "Trading is disabled in this build. Rebuild with NEXT_PUBLIC_ENABLE_TRADING=1."
    : plan.legs.length === 0
      ? "No executable hedge legs are available for the current market and settings."
      : !plan.capMet
        ? "The current hedge does not meet the loss cap. Widen the cap or adjust the protection window."
        : execution?.planKey === planKey && execution.pendingLegs.length > 0
          ? "Some hedge legs are still pending. Retry the missing legs first."
          : null;
  const blockers = useMemo(() => {
    const b = commitBlockers(input, chainNow * 1000);
    // Recording a plan that does not meet its own cap would be misleading.
    if (plan.legs.length > 0 && !plan.capMet) {
      b.push("This hedge does not meet your loss cap, so it should not be recorded as protection.");
    }
    if (!hedgeReady) {
      b.push("Execute and verify every hedge leg before recording this plan.");
    }
    return b;
  }, [input, chainNow, plan.legs.length, plan.capMet, hedgeReady]);

  const refresh = useCallback(
    async (who: `0x${string}`) => {
      if (!REGISTRY) return;
      const registry = REGISTRY;
      const code = await publicClient.getCode({ address: registry });
      if (!code || code === "0x") {
        throw new Error(`No LedgeRegistry contract was found at ${registry} on ${chain.name}. Check NEXT_PUBLIC_CHAIN_ID and NEXT_PUBLIC_LEDGE_REGISTRY, then rebuild the app.`);
      }
      if (!IS_LOCAL && ORACLE) {
        const configuredOracle = await publicClient.readContract({
          address: registry,
          abi: ledgeRegistryAbi,
          functionName: "oracle",
        });
        if (configuredOracle.toLowerCase() !== ORACLE.toLowerCase()) {
          throw new Error("Registry oracle does not match NEXT_PUBLIC_LEDGE_ORACLE. Refusing to use this deployment.");
        }
      }
      const block = await publicClient.getBlock();
      setChainNow(Number(block.timestamp));

      const rec = await publicClient.readContract({
        address: registry,
        abi: ledgeRegistryAbi,
        functionName: "recordOf",
        args: [who],
      });
      setRecord({
        settled: Number(rec.settled),
        triggered: Number(rec.triggered),
        lapsed: Number(rec.lapsed),
        avoided: rec.totalLossAvoided,
      });

      // Avoid a broad eth_getLogs query. Some Base RPC providers reject even a
      // correctly formed log filter when the range is large. The registry has a
      // bounded planCount, so read plans directly and keep only this owner's plans.
      const count = Number(await publicClient.readContract({
        address: registry,
        abi: ledgeRegistryAbi,
        functionName: "planCount",
      }));
      const rows: OnchainPlan[] = [];
      for (let index = 1; index <= count; index += 1) {
        const id = BigInt(index);
        const p = await publicClient.readContract({
          address: registry,
          abi: ledgeRegistryAbi,
          functionName: "getPlan",
          args: [id],
        });
        if (p.owner.toLowerCase() !== who.toLowerCase()) continue;
        rows.push({
          id,
          isLong: p.isLong,
          status: STATUS[p.status] ?? "None",
          expiry: Number(p.expiry),
          entryPx: p.entryPx,
          settlePx: p.settlePx,
          notional: p.notional,
          lossCap: p.lossCap,
          unhedgedLoss: p.unhedgedLoss,
          legsHash: p.legsHash,
        });
      }
      setPlans(rows.sort((a, b) => (a.id < b.id ? 1 : -1)));
      setStored(loadLegs(who));
    },
    [],
  );

  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(label);
    setMsg(null);
    try {
      setMsg({ kind: "ok", text: await fn() });
    } catch (e) {
      const err = e as { shortMessage?: string; message?: string };
      setMsg({ kind: "err", text: err.shortMessage ?? err.message ?? "Transaction failed" });
    } finally {
      setBusy(null);
    }
  };

  const wallet = (connectedAccount: `0x${string}` | null = account) => {
    const p = provider();
    if (!p) throw new Error("No wallet found. Install a browser wallet such as MetaMask or Rabby.");
    return createWalletClient({
      account: connectedAccount ?? undefined,
      chain,
      transport: custom(p),
    });
  };

  const buyHedge = () =>
    run("trade", async () => {
      if (!account) throw new Error("Connect a wallet first");
      if (Date.now() - marketFetchedAt > 30_000) throw new Error("Market data is older than 30 seconds. Refresh markets before placing hedge orders.");
      const statuses = await executeBaseHedge(wallet(account), plan);
      const fullyFilled = statuses.length === plan.legs.length && statuses.every((status, index) => {
        if (!(typeof status === "object" && status !== null && "filled" in status)) return false;
        return Number(status.filled.totalSz) + 1e-8 >= plan.legs[index].shares;
      });
      if (!fullyFilled) {
        setExecution({ planKey, statuses, verified: false, pendingLegs: plan.legs.filter((_, index) => !isFilled(statuses[index], plan.legs[index].shares)) });
        return "The hedge was only partially filled. Review the order result before retrying.";
      }
      const verified = fullyFilled;
      setExecution({ planKey, statuses, verified, pendingLegs: [] });
      return "All hedge legs filled and were verified by Base transaction receipts.";
    });

  const retryHedge = () =>
    run("retry", async () => {
      if (!account || !execution || execution.planKey !== planKey || execution.pendingLegs.length === 0) {
        throw new Error("There are no unfilled legs to retry.");
      }
      const retryPlan = { ...plan, legs: execution.pendingLegs };
      const retryStatuses = await executeBaseHedge(wallet(account), retryPlan);
      const nextStatuses = [...execution.statuses];
      let retryIndex = 0;
      plan.legs.forEach((leg, index) => {
        if (execution.pendingLegs.some((pending) => legKey(pending) === legKey(leg))) nextStatuses[index] = retryStatuses[retryIndex++];
      });
      const pendingLegs = plan.legs.filter((leg, index) => !isFilled(nextStatuses[index], leg.shares));
      const verified = pendingLegs.length === 0 && nextStatuses.every((status) => status && typeof status === "object" && "filled" in status);
      setExecution({ planKey, statuses: nextStatuses, verified, pendingLegs });
      return verified ? "All remaining legs filled and the complete hedge was verified." : "Some legs remain unfilled; the registry commit is still disabled.";
    });

  const connect = () =>
    run("connect", async () => {
      const w = wallet();
      const [addr] = await w.requestAddresses();
      if ((await w.getChainId()) !== CHAIN_ID) {
        try {
          await w.switchChain({ id: CHAIN_ID });
        } catch {
          await w.addChain({ chain });
          await w.switchChain({ id: CHAIN_ID });
        }
      }
      setAccount(addr);
      await refresh(addr);
      return `Connected ${short(addr)} on ${chain.name}`;
    });

  const disconnect = () => {
    setAccount(null);
    setPlans([]);
    setRecord(null);
    setStored({});
    setExecution(null);
    setTxHash(null);
    setMsg({ kind: "ok", text: "Wallet disconnected from Ledge." });
  };

  const commit = () =>
    run("commit", async () => {
      if (!REGISTRY || !account) throw new Error("Connect a wallet first");
      const args = buildCommitArgs(input);
      const hash = await wallet().writeContract({
        address: REGISTRY,
        abi: ledgeRegistryAbi,
        functionName: "commit",
        args,
        account,
        chain,
      });
      setTxHash(hash);
      setMsg({ kind: "ok", text: `Commit submitted. Waiting for ${chain.name} confirmation…` });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Commit transaction reverted");
      const ev = parseEventLogs({ abi: ledgeRegistryAbi, eventName: "Committed", logs: receipt.logs });
      const id = ev[0]?.args.id;
      if (id !== undefined) {
        saveLegs(
          account,
          id,
          plan.legs.map((l) => ({ outcome: l.outcome, side: l.side, strike: l.strike, shares: l.shares })),
        );
      }
      await refresh(account);
      return `Committed plan #${id ?? "?"} on-chain`;
    });

  const act = (fn: "settle" | "lapse", id: bigint) =>
    run(`${fn}-${id}`, async () => {
      if (!REGISTRY || !account) throw new Error("Connect a wallet first");
      const hash = await wallet().writeContract({
        address: REGISTRY,
        abi: ledgeRegistryAbi,
        functionName: fn,
        args: [id],
        account,
        chain,
      });
      setTxHash(hash);
      setMsg({ kind: "ok", text: `${fn === "settle" ? "Settlement" : "Lapse"} submitted. Waiting for ${chain.name} confirmation…` });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`${fn} reverted`);
      await refresh(account);
      return `Plan #${id} ${fn === "settle" ? "settled" : "marked lapsed"}`;
    });

  if (!REGISTRY) {
    return (
      <div className="surface p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="section-kicker">04 · Registry</div>
            <h2 className="section-title">Connect your wallet</h2>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted">
              Connect a MetaMask or Rabby wallet on {chain.name} to record protection.
            </p>
          </div>
          {account ? (
            <span className="status-pill"><span className="status-dot" /> {short(account)}</span>
          ) : (
            <button
              onClick={connect}
              disabled={busy !== null}
              className="rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-bg shadow-[0_8px_24px_rgba(244,184,96,0.16)] transition-transform hover:-translate-y-0.5 disabled:opacity-50"
            >
              {busy === "connect" ? "Connecting…" : "Connect wallet"}
            </button>
          )}
        </div>
        <p className="mt-4 border-t border-line pt-3 text-xs text-muted">
          Setup required: deploy <code className="num text-ink">LedgeRegistry</code>, then set <code className="num text-ink">NEXT_PUBLIC_LEDGE_REGISTRY</code> and <code className="num text-ink">NEXT_PUBLIC_LEDGE_DEPLOY_BLOCK</code> in <code className="num text-ink">.env.local</code>.
        </p>
      </div>
    );
  }

  return (
    <div className="surface space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="section-kicker">04 · Registry</div>
          <h2 className="section-title">On-chain protection</h2>
          <p className="mt-1 num text-xs text-muted">
            {chain.name} · registry {short(REGISTRY)}
          </p>
        </div>
        {account ? (
          <div className="flex items-center gap-3">
            <span className="num text-xs text-muted">{short(account)}</span>
            <button
              onClick={disconnect}
              disabled={busy !== null}
              className="rounded border border-line px-2 py-1 text-xs text-muted hover:border-bad/40 hover:text-bad disabled:opacity-50"
            >
              Disconnect
            </button>
            <button
              onClick={() =>
                run("refresh", async () => {
      await refresh(account);
      onRefreshMarket();
      return "Refreshed from chain";
                })
              }
              disabled={busy !== null}
              className="rounded border border-line px-2 py-1 text-xs text-muted hover:text-ink disabled:opacity-50"
            >
              Refresh
            </button>
          </div>
        ) : (
          <button
            onClick={connect}
            disabled={busy !== null}
            className="rounded border border-accent bg-accent/15 px-3 py-1.5 text-sm text-accent disabled:opacity-50"
          >
            {busy === "connect" ? "Connecting…" : "Connect wallet"}
          </button>
        )}
      </div>

      {account && (
        <>
          <div className="rounded border border-line bg-bg p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-xs font-medium text-ink">Your Base market positions</h3>
                <p className="mt-0.5 text-xs text-muted">Market positions will appear here after Base execution is indexed.</p>
              </div>
              {positionsBusy && <span className="text-xs text-muted" role="status">Loading…</span>}
            </div>
            {!positionsBusy && positions.length === 0 && <p className="mt-2 text-xs text-muted">No indexed Base positions found yet.</p>}
            {positions.length > 0 && (
              <div className="mt-3 space-y-2">
                {positions.map((position) => {
                  const positionNotional = Math.abs(position.size) * (position.entryPx ?? 0);
                  return (
                    <div key={position.coin} className="flex flex-wrap items-center justify-between gap-2 rounded border border-line px-3 py-2">
                      <div className="text-xs">
                        <span className="font-medium text-ink">{position.coin} {position.size > 0 ? "Long" : "Short"}</span>
                        <span className="ml-2 text-muted">{Math.abs(position.size).toFixed(4)} units · {positionNotional > 0 ? usdFromNumber(positionNotional) : "notional unavailable"}</span>
                      </div>
                      <button
                        onClick={() => onPositionDetected({ coin: position.coin, size: position.size, notionalUsd: positionNotional })}
                        className="rounded border border-accent px-2 py-1 text-xs text-accent hover:bg-accent/10"
                      >
                        Use position
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div>
            <div className="mb-3 rounded border border-line bg-bg p-3">
              <h3 className="text-xs font-medium text-ink">Review before signing</h3>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted md:grid-cols-4">
                <div><dt>Market</dt><dd className="font-medium text-ink">{asset} {isLong ? "Long" : "Short"}</dd></div>
                <div><dt>Notional</dt><dd className="num font-medium text-ink">{usdFromNumber(notionalUsd)}</dd></div>
                <div><dt>Loss cap</dt><dd className="num font-medium text-ink">{usdFromNumber(lossCapUsd)}</dd></div>
                <div><dt>Network</dt><dd className="font-medium text-ink">{chain.name}</dd></div>
                <div><dt>Expiry</dt><dd className="font-medium text-ink">{plan.expiryMs ? new Date(plan.expiryMs).toLocaleString() : "Unavailable"}</dd></div>
                <div><dt>Hedge legs</dt><dd className="num font-medium text-ink">{plan.legs.length}</dd></div>
                <div><dt>Execution</dt><dd className={`font-medium ${hedgeReady ? "text-good" : "text-accent"}`}>{hedgeReady ? "Verified" : "Not verified"}</dd></div>
              </dl>
            </div>
            <button
              onClick={buyHedge}
              disabled={tradeBlocker !== null || busy !== null}
              title={tradeBlocker ?? "Buy and verify the Base hedge legs"}
              className="mr-2 rounded border border-accent px-4 py-2 text-sm font-medium text-accent disabled:cursor-not-allowed disabled:opacity-40"
            >
              {!ENABLE_TRADING ? "Trading disabled" : busy === "trade" ? "Buying hedge…" : "Buy hedge legs"}
            </button>
            {tradeBlocker && <p className="mt-2 text-xs text-muted">{tradeBlocker}</p>}
            {execution?.planKey === planKey && execution.pendingLegs.length > 0 && (
              <button onClick={retryHedge} disabled={busy !== null} className="rounded border border-accent px-4 py-2 text-sm font-medium text-accent disabled:cursor-not-allowed disabled:opacity-40">
                {busy === "retry" ? "Retrying missing legs…" : `Retry ${execution.pendingLegs.length} missing leg${execution.pendingLegs.length === 1 ? "" : "s"}`}
              </button>
            )}
            <button
              onClick={commit}
              disabled={busy !== null || blockers.length > 0}
              className="rounded bg-accent px-4 py-2 text-sm font-medium text-bg disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === "commit" ? "Committing…" : "Commit this hedge on-chain"}
            </button>
            {execution?.planKey === planKey && (
              <div className="mt-3 rounded border border-line bg-bg p-3" role="status">
                <p className={`text-xs ${execution.verified ? "text-good" : "text-accent"}`}>
                  {execution.verified ? "Execution verified from recent venue fills." : "Execution is not fully verified; the on-chain commit remains disabled."}
                </p>
                <div className="mt-2 space-y-1.5">
                  {plan.legs.map((leg, index) => (
                    <div key={`${leg.outcome}-${leg.side}`} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="text-muted">{leg.side.toUpperCase()} {leg.strike.toLocaleString()} · requested {leg.shares.toFixed(4)}</span>
                      <span className={orderStatusTone(execution.statuses[index])}>{orderStatusText(execution.statuses[index])}</span>
                    </div>
                  ))}
                </div>
                {!execution.verified && <p className="mt-2 text-xs text-muted">Do not commit this plan. Review the fills and refresh the market before trying again.</p>}
              </div>
            )}
            {!ENABLE_TRADING && <p className="mt-2 text-xs text-muted">Trading is disabled for this deployment. Set <code className="num">NEXT_PUBLIC_ENABLE_TRADING=1</code> only after completing testnet validation.</p>}
            {IS_LOCAL && (
              <label className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-muted">
                <input
                  type="checkbox"
                  checked={localAcknowledged}
                  onChange={(event) => setLocalAcknowledged(event.target.checked)}
                  className="mt-0.5 accent-[var(--accent)]"
                  aria-label="Acknowledge local test mode"
                />
                <span>Local test mode: acknowledge that no real hedge execution is being verified.</span>
              </label>
            )}
            {blockers.length > 0 && (
              <ul className="mt-2 list-disc pl-5 text-xs text-muted">
                {blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}
            <p className="mt-2 rounded border border-accent/30 bg-accent/5 px-3 py-2 text-xs leading-relaxed text-muted">
              <strong className="text-accent">Important:</strong> registry records the plan and oracle entry price.
              {ENABLE_TRADING ? " Buy hedge legs sends expiring IOC orders and requires fill verification before commit." : " Trading is disabled in this deployment; no hedge execution can be verified here."}
            </p>
          </div>

          {record && (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Mini label="Settled" value={String(record.settled)} />
              <Mini label="Floor needed" value={String(record.triggered)} />
              <Mini label="Lapsed" value={String(record.lapsed)} />
              <Mini label="Loss absorbed by floor" value={usd(record.avoided)} />
            </div>
          )}

          {plans.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">Your on-chain Ledge protection plans</caption>
                <thead className="text-left text-xs text-muted">
                  <tr>
                    <th className="py-2 pr-3 font-medium">#</th>
                    <th className="py-2 pr-3 font-medium">Side</th>
                    <th className="py-2 pr-3 text-right font-medium">Notional</th>
                    <th className="py-2 pr-3 text-right font-medium">Cap</th>
                    <th className="py-2 pr-3 text-right font-medium">Move</th>
                    <th className="py-2 pr-3 font-medium">Legs</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {plans.map((p) => {
                    const action = planAction(p.status, p.expiry, chainNow);
                    const move =
                      p.status === "Settled" && p.entryPx > BigInt(0)
                        ? ((Number(p.settlePx) - Number(p.entryPx)) / Number(p.entryPx)) * 100
                        : null;
                    const legs = stored[p.id.toString()];
                    const verified = legs ? hashLegs(legs) === p.legsHash : null;
                    return (
                      <tr key={p.id.toString()} className="border-t border-line">
                        <td className="num py-2 pr-3">{p.id.toString()}</td>
                        <td className="py-2 pr-3">{p.isLong ? "Long" : "Short"}</td>
                        <td className="num py-2 pr-3 text-right">{usd(p.notional)}</td>
                        <td className="num py-2 pr-3 text-right">{usd(p.lossCap)}</td>
                        <td className="num py-2 pr-3 text-right">{move === null ? "–" : `${move.toFixed(2)}%`}</td>
                        <td className="py-2 pr-3 text-xs">
                          {verified === null ? (
                            <span className="text-muted">not stored here</span>
                          ) : verified ? (
                            <span className="text-good">hash verified</span>
                          ) : (
                            <span className="text-bad">hash mismatch</span>
                          )}
                        </td>
                        <td className="py-2 pr-3">{p.status}</td>
                        <td className="py-2 text-right">
                          {action === "settle" && (
                            <button
                              onClick={() => act("settle", p.id)}
                              disabled={busy !== null}
                              className="rounded border border-accent px-2 py-1 text-xs text-accent disabled:opacity-50"
                            >
                              Settle
                            </button>
                          )}
                          {action === "lapse" && (
                            <button
                              onClick={() => act("lapse", p.id)}
                              disabled={busy !== null}
                              className="rounded border border-line px-2 py-1 text-xs text-muted disabled:opacity-50"
                            >
                              Mark lapsed
                            </button>
                          )}
                          {action === "wait" && <span className="text-xs text-muted">opens at expiry</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {msg && (
        <p className={`text-xs ${msg.kind === "ok" ? "text-good" : "text-bad"}`} role={msg.kind === "err" ? "alert" : "status"}>
          {msg.text}
        </p>
      )}
      {txHash && EXPLORER_URL && (
        <a
          href={`${EXPLORER_URL}/${txHash}`}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-accent underline underline-offset-2"
        >
          View latest registry transaction
        </a>
      )}
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-line bg-bg p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="num mt-0.5 text-base font-semibold">{value}</div>
    </div>
  );
}

function orderStatusText(status: BaseOrderStatus | undefined) {
  if (!status) return "No response";
  if ("error" in status) return `Rejected: ${status.error}`;
  if ("filled" in status) return `Filled ${Number(status.filled.totalSz).toFixed(4)} @ ${Number(status.filled.avgPx).toFixed(4)}`;
  return "No response";
}

function orderStatusTone(status: BaseOrderStatus | undefined) {
  if (status && typeof status === "object" && "filled" in status) return "text-good";
  if (status && typeof status === "object" && "error" in status) return "text-bad";
  return "text-accent";
}

function legKey(leg: HedgePlan["legs"][number]) {
  return `${leg.outcome}:${leg.side}`;
}

function isFilled(status: BaseOrderStatus | undefined, requested: number) {
  return Boolean(status && typeof status === "object" && "filled" in status && Number(status.filled.totalSz) + 1e-8 >= requested);
}

function usdFromNumber(value: number) {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
