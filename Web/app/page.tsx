"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { planHedge } from "@/lib/hedge";
import Protection from "./Protection";
import type { Candidate } from "@/lib/hedge";

interface Market {
  underlying: string;
  markPx: number;
  assetIndex: number | null;
  candidates: Candidate[];
  source: "live" | "demo";
  fetchedAt: number;
}

const ASSETS = ["BTC", "ETH", "SOL"];

const usd = (n: number, d = 2) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: d });
const px = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0 });

export default function Home() {
  const [asset, setAsset] = useState("BTC");
  const [dir, setDir] = useState<"long" | "short">("long");
  const [notional, setNotional] = useState(10000);
  const [capPct, setCapPct] = useState(3); // max tolerated loss, % of notional
  const [windowPct, setWindowPct] = useState(12);
  const [retry, setRetry] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  // Results are tagged with the asset they were fetched for; anything stale reads as "loading".
  const [result, setResult] = useState<{ asset: string; market?: Market; err?: string; code?: string } | null>(null);
  const current = result?.asset === asset ? result : null;
  const market = current?.market ?? null;
  const err = current?.err ?? null;
  const loading = !current;

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setRefreshing(true);
    fetch(`/api/market?underlying=${asset}&refresh=${retry}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) {
          const error = new Error(j.error ?? "request failed") as Error & { code?: string };
          error.code = j.code;
          throw error;
        }
        if (!j || j.underlying !== asset || !Number.isFinite(j.markPx) || j.markPx <= 0 || !Array.isArray(j.candidates)) {
          throw new Error("The market response was invalid. Please retry.");
        }
        return j as Market;
      })
      .then((m) => alive && setResult({ asset, market: m }))
      .catch((e) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        if (alive) setResult({ asset, err: String(e.message ?? e), code: e?.code });
      })
      .finally(() => {
        if (alive) setRefreshing(false);
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [asset, retry]);

  const plan = useMemo(() => {
    if (!market || market.markPx <= 0) return null;
    const size = (dir === "long" ? 1 : -1) * (notional / market.markPx);
    return planHedge({ size, markPx: market.markPx }, market.candidates, {
      lossCap: (notional * capPct) / 100,
      windowPct: windowPct / 100,
      maxAvgPx: 0.97,
      minNotional: 1,
    });
  }, [market, dir, notional, capPct, windowPct]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">⌁</span><div><div className="eyebrow">Risk infrastructure</div><div className="text-lg font-semibold tracking-tight">Ledge<span className="text-accent">.</span></div></div></div>
        <div className="status-pill"><span className="status-dot" /> Base Sepolia · Protection registry</div>
      </header>

      <section className="hero">
        <div><div className="eyebrow">Base protection, made explicit</div><h1>Put a floor under your position.</h1><p className="hero-copy">Model a loss-capped hedge, see exactly what it costs, and verify the protection before you record it on-chain.</p></div>
        <p className="hero-note">Built for expiry payoffs.<br />Live books. Transparent assumptions.</p>
      </section>

      {market?.source === "demo" && (
        <div className="mb-6 rounded border border-accent/50 bg-accent/10 px-4 py-3 text-sm text-accent">
          <strong>DEMO DATA.</strong> The market data provider was unreachable, so strikes, prices and depth
          below are invented for development. Do not trade on them.
        </div>
      )}
      {err && current?.code === "MARKET_NOT_CONFIGURED" && (
        <div className="mb-6 rounded border border-accent/50 bg-accent/10 px-4 py-3 text-sm text-accent" role="alert">
          <strong>Base markets are not configured.</strong>{" "}
          Deploy the Base testnet market factory, then set <code>NEXT_PUBLIC_MARKET_FACTORY</code> and
          <code> NEXT_PUBLIC_LEDGE_COLLATERAL</code> in <code>Web/.env</code> and restart the app.
        </div>
      )}
      {err && current?.code !== "MARKET_NOT_CONFIGURED" && (
        <div className="mb-6 rounded border border-bad/50 bg-bad/10 px-4 py-3 text-sm text-bad" role="alert">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span><strong>Market data unavailable.</strong> {err} Try again or choose another asset.</span>
            <button onClick={() => setRetry((n) => n + 1)} className="rounded border border-bad/50 px-3 py-1 text-xs hover:bg-bad/10">
              Retry
            </button>
          </div>
        </div>
      )}
      {market && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 text-xs text-muted" aria-live="polite">
          <span>
            {market.source === "live" ? "Live market data" : "Development-only simulated market data"} · updated {new Date(market.fetchedAt).toLocaleTimeString()}
          </span>
            <button onClick={() => setRetry((n) => n + 1)} disabled={refreshing} className="rounded border border-line px-3 py-1 hover:text-ink disabled:cursor-wait disabled:opacity-50">
            {refreshing ? "Refreshing…" : "Refresh markets"}
          </button>
        </div>
      )}

      <div className="grid gap-7 lg:grid-cols-[350px_1fr]">
        <section className="surface control-surface space-y-6 p-6">
          <div><div className="section-kicker">01 · Position</div><h2 className="section-title">Shape your protection</h2><p className="mt-2 text-xs leading-relaxed text-muted">Start with the position you want to protect. We’ll build the cheapest available outcome hedge inside your range.</p></div>
          <Field label="Asset">
            <div className="flex flex-wrap gap-2" role="group" aria-label="Asset">
              {ASSETS.map((a) => (
                <Chip key={a} on={a === asset} onClick={() => setAsset(a)}>
                  {a}
                </Chip>
              ))}
            </div>
          </Field>
          <Field label="Position">
            <div className="flex gap-2" role="group" aria-label="Position direction">
              <Chip on={dir === "long"} onClick={() => setDir("long")}>
                Long
              </Chip>
              <Chip on={dir === "short"} onClick={() => setDir("short")}>
                Short
              </Chip>
            </div>
          </Field>
          <Field label={`Notional · ${usd(notional, 0)}`}>
            <div className="mb-2 flex items-center gap-2">
              <input
                aria-label="Notional in US dollars"
                type="number"
                min={500}
                max={100000}
                step={500}
                value={notional}
                onChange={(e) => setNotional(clamp(Number(e.target.value), 500, 100000))}
                className="control-input num w-full rounded border px-3 py-2 text-sm text-ink"
              />
              <span className="text-xs text-muted">USD</span>
            </div>
            <input
              aria-label="Notional slider"
              type="range"
              min={500}
              max={100000}
              step={500}
              value={notional}
              onChange={(e) => setNotional(+e.target.value)}
              className="w-full accent-[var(--accent)]"
            />
          </Field>
          <Field label={`Max loss I accept · ${capPct}% (${usd((notional * capPct) / 100, 0)})`}>
            <div className="mb-2 flex items-center gap-2">
              <input
                aria-label="Maximum accepted loss percentage"
                type="number"
                min={0.5}
                max={10}
                step={0.5}
                value={capPct}
                onChange={(e) => setCapPct(clamp(Number(e.target.value), 0.5, 10))}
                className="control-input num w-full rounded border px-3 py-2 text-sm text-ink"
              />
              <span className="text-xs text-muted">%</span>
            </div>
            <input
              aria-label="Maximum accepted loss slider"
              type="range"
              min={0.5}
              max={10}
              step={0.5}
              value={capPct}
              onChange={(e) => setCapPct(+e.target.value)}
              className="w-full accent-[var(--accent)]"
            />
          </Field>
          <Field label={`Protect moves up to · ${windowPct}%`}>
            <div className="mb-2 flex items-center gap-2">
              <input
                aria-label="Protection window percentage"
                type="number"
                min={4}
                max={30}
                step={1}
                value={windowPct}
                onChange={(e) => setWindowPct(clamp(Number(e.target.value), 4, 30))}
                className="control-input num w-full rounded border px-3 py-2 text-sm text-ink"
              />
              <span className="text-xs text-muted">%</span>
            </div>
            <input
              aria-label="Protection window slider"
              type="range"
              min={4}
              max={30}
              step={1}
              value={windowPct}
              onChange={(e) => setWindowPct(+e.target.value)}
              className="w-full accent-[var(--accent)]"
            />
          </Field>
          <p className="text-xs leading-relaxed text-muted">
            Payoffs are computed at the binaries&apos; expiry. Mark-to-market before expiry will differ.
          </p>
        </section>

        <section className="min-w-0 space-y-7">
          {loading && <LoadingState />}
          {market && market.candidates.length === 0 && (
            <p className="rounded border border-line bg-panel p-5 text-sm text-muted">
              No open {asset} outcome markets right now, so nothing to hedge with. Try another asset.
            </p>
          )}
          {market && plan && market.candidates.length > 0 && (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Stat label="Hedge cost" value={usd(plan.totalCost)} sub={`${(plan.costPct * 100).toFixed(2)}% of notional`} />
                <Stat
                  label="Worst loss in window"
                  value={usd(plan.worstLossExPremium)}
                  sub={`+ ${usd(plan.totalCost)} premium`}
                  tone={plan.capMet ? "good" : "bad"}
                />
                <Stat
                  label="Your cap"
                  value={usd(plan.lossCap)}
                  sub={plan.capMet ? "met" : "NOT met"}
                  tone={plan.capMet ? "good" : "bad"}
                />
                <Stat label="Legs" value={String(plan.legs.length)} sub={`mark ${px(market.markPx)}`} />
              </div>

              <ExpiryNotice expiryMs={plan.expiryMs} />

              {!plan.capMet && (
                <div className="rounded border border-accent/35 bg-accent/6 px-4 py-3" role="status">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-medium text-accent">Coverage is incomplete at these settings.</p>
                      <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted">
                        {plan.unfilledShares > 0
                          ? "The available books cannot fill the full hedge at this size. Reduce the position size or allow a wider loss cap."
                          : "The available strikes are too sparse to hold your cap everywhere in the selected window. Allow a wider cap or protect a narrower range."}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      {capPct < 10 && (
                        <button
                          type="button"
                          onClick={() => setCapPct((value) => clamp(value + 1, 0.5, 10))}
                          className="rounded-lg border border-accent/40 px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent/10"
                        >
                          Widen cap
                        </button>
                      )}
                      {windowPct > 4 && (
                        <button
                          type="button"
                          onClick={() => setWindowPct((value) => clamp(value - 2, 4, 30))}
                          className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-ink/30 hover:text-ink"
                        >
                          Narrow window
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}

              <div
                className="surface payoff-card overflow-hidden p-5 sm:p-6"
                role="img"
                aria-label="Payoff chart comparing the unhedged and hedged position across the protected price window"
              >
                <div className="chart-summary" aria-label="Payoff chart reference values">
                  <div className="chart-key"><span>Current mark</span><strong className="num">{px(market.markPx)}</strong></div>
                  <div className="chart-key"><span>Your floor</span><strong className="num text-good">{usd(-plan.lossCap - plan.totalCost, 0)}</strong></div>
                  <div className="chart-key"><span>Protected range</span><strong className="num">{px(plan.window.lo)} — {px(plan.window.hi)}</strong></div>
                </div>
                <div className="mb-4 flex flex-wrap items-end justify-between gap-3"><div><div className="section-kicker">02 · Outcome map</div><h2 className="section-title">PnL at expiry</h2></div><span className="status-pill">Protected window</span></div>
                <div className="chart-frame h-96 sm:h-[28rem]">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={plan.curve} margin={{ top: 18, right: 22, bottom: 18, left: 8 }}>
                      <CartesianGrid stroke="var(--line)" vertical={false} strokeDasharray="2 5" />
                      <XAxis
                        dataKey="price"
                        type="number"
                        domain={["dataMin", "dataMax"]}
                        tickFormatter={px}
                        stroke="var(--muted)"
                        fontSize={11}
                        tickMargin={12}
                        axisLine={false}
                        tickLine={false}
                      />
                      <YAxis tickFormatter={(v) => usd(v, 0)} stroke="var(--muted)" fontSize={11} width={78} tickMargin={8} axisLine={false} tickLine={false} />
                      <Tooltip
                        cursor={{ stroke: "var(--blue)", strokeDasharray: "4 4", strokeOpacity: 0.55 }}
                        contentStyle={{ background: "#121a25", border: "1px solid var(--line)", borderRadius: 12, boxShadow: "0 16px 36px rgba(0,0,0,.28)", fontSize: 12, padding: "10px 12px" }}
                        labelFormatter={(v) => `Price ${px(Number(v))}`}
                        formatter={(v, name) => [usd(Number(v)), name === "hedged" ? "With Ledge" : "Unhedged"]}
                      />
                      <ReferenceArea
                        x1={plan.window.lo}
                        x2={plan.window.hi}
                        fill="var(--accent)"
                        fillOpacity={0.05}
                      />
                      <ReferenceLine x={market.markPx} stroke="var(--muted)" strokeDasharray="3 3" />
                      <ReferenceLine y={-plan.lossCap - plan.totalCost} stroke="var(--good)" strokeDasharray="4 4" />
                      <Line dataKey="unhedged" stroke="var(--muted)" strokeDasharray="6 5" dot={false} strokeWidth={1.5} isAnimationActive={false} />
                      <Line dataKey="hedged" stroke="var(--accent)" dot={false} strokeWidth={3} activeDot={{ r: 5, fill: "var(--accent)", stroke: "var(--bg)", strokeWidth: 2 }} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div className="chart-legend mt-5">
                  <span><i className="legend-swatch legend-swatch-muted" /> Unhedged perp</span>
                  <span><i className="legend-swatch legend-swatch-accent" /> With Ledge, premium included</span>
                  <span><i className="legend-swatch legend-swatch-good" /> Loss floor</span>
                  <span><i className="legend-swatch legend-swatch-window" /> Protected window</span>
                </div>
                <p className="mt-4 text-xs leading-relaxed text-muted">
                  Dashed grey: unhedged perp. Amber: with the hedge, premium included. Green line: your floor
                  (cap + premium). Shaded: protected window.
                </p>
              </div>

              <div className="surface overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
                  <div>
                    <div className="section-kicker">03 · Execution</div>
                    <h2 className="section-title">Trade checklist</h2>
                    <p className="mt-1 text-xs text-muted">Acquire these outcome legs before recording the plan.</p>
                  </div>
                  <button
                    onClick={async () => {
                      const text = plan.legs.map((leg) => `BUY ${leg.shares.toFixed(4)} ${asset} ${leg.side.toUpperCase()} @ ${leg.strike} at ~${leg.avgPx.toFixed(4)}`).join("\n");
                      try {
                        await navigator.clipboard.writeText(`${asset} hedge · expiry ${plan.expiryMs ? new Date(plan.expiryMs).toISOString() : "unknown"}\n${text}`);
                        setCopyStatus("Copied");
                      } catch {
                        setCopyStatus("Copy unavailable");
                      }
                      window.setTimeout(() => setCopyStatus(null), 2000);
                    }}
                    className="rounded border border-line px-3 py-1.5 text-xs text-muted hover:text-ink"
                  >
                    {copyStatus ?? "Copy order list"}
                  </button>
                </div>
                <table className="w-full text-sm">
                  <caption className="sr-only">Contracts included in the recommended hedge</caption>
                  <thead className="text-left text-xs text-muted">
                    <tr>
                      <th className="px-4 py-3 font-medium">Contract</th>
                      <th className="px-4 py-3 font-medium">Strike</th>
                      <th className="px-4 py-3 text-right font-medium">Shares</th>
                      <th className="px-4 py-3 text-right font-medium">Avg price</th>
                      <th className="px-4 py-3 text-right font-medium">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.legs.map((l) => (
                      <tr key={`${l.outcome}-${l.side}`} className="table-row border-t border-line transition-colors">
                        <td className="px-4 py-2.5">
                          <span className={l.side === "no" ? "text-bad" : "text-good"}>{l.side.toUpperCase()}</span>{" "}
                          <span className="text-muted">
                            {asset} {l.side === "no" ? "≤" : ">"} strike
                          </span>
                        </td>
                        <td className="num px-4 py-2.5">{px(l.strike)}</td>
                        <td className="num px-4 py-2.5 text-right">{l.shares.toFixed(1)}</td>
                        <td className="num px-4 py-2.5 text-right">{l.avgPx.toFixed(3)}</td>
                        <td className="num px-4 py-2.5 text-right">{usd(l.cost)}</td>
                      </tr>
                    ))}
                    {plan.legs.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-4 py-6 text-center text-muted">
                          No hedge needed at this cap, or no usable strikes.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <Protection
                asset={asset}
                isLong={dir === "long"}
                notionalUsd={notional}
                lossCapUsd={(notional * capPct) / 100}
                assetIndex={market.assetIndex}
                plan={plan}
                marketFetchedAt={market.fetchedAt}
                onRefreshMarket={() => setRetry((n) => n + 1)}
                onPositionDetected={(position) => {
                  if (ASSETS.includes(position.coin)) setAsset(position.coin);
                  setDir(position.size > 0 ? "long" : "short");
                  if (position.notionalUsd > 0) setNotional(Math.min(100000, Math.max(500, Math.round(position.notionalUsd / 500) * 500)));
                }}
              />
            </>
          )}
        </section>
      </div>
      <footer className="mt-10 border-t border-line pt-5 text-xs leading-relaxed text-muted">
        Ledge is an informational hedging tool, not financial advice. Outcome contracts can be illiquid, expire,
        and lose their entire premium. Review the market, fills, expiry, and network before signing a transaction.
      </footer>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="field-label">{label}</div>
      {children}
    </div>
  );
}

function clamp(value: number, min: number, max: number) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}

function LoadingState() {
  return (
    <div className="space-y-4" role="status" aria-live="polite">
      <span className="sr-only">Loading outcome markets</span>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[1, 2, 3, 4].map((item) => <div key={item} className="h-24 animate-pulse rounded-lg border border-line bg-panel" />)}
      </div>
      <div className="h-80 animate-pulse rounded-lg border border-line bg-panel" />
    </div>
  );
}

function ExpiryNotice({ expiryMs }: { expiryMs: number | null }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  if (!expiryMs) return null;
  const remaining = expiryMs - now;
  if (remaining <= 0) {
    return <p className="rounded border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad" role="alert">These outcome contracts have expired. Refresh the markets before placing or committing a hedge.</p>;
  }
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  return <p className="rounded border border-line bg-panel px-4 py-3 text-sm text-muted">Contracts expire in <span className="num text-ink">{hours}h {minutes}m</span> ({new Date(expiryMs).toLocaleString()}). Prices and availability can change before expiry.</p>;
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={`rounded border px-3 py-1.5 text-sm transition-colors ${
        on ? "border-accent bg-accent/15 text-accent" : "border-line text-muted hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "bad" }) {
  const color = tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : "text-ink";
  return (
    <div className="metric-card rounded-xl border p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className={`num mt-1 text-xl font-semibold ${color}`}>{value}</div>
      {sub && <div className="num mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}
