"use client";

import { useQuery } from "@tanstack/react-query";
import {
  ArrowDownRight,
  ArrowUpRight,
  CircleCheck,
  Hourglass,
  ShieldAlert,
  Target,
} from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { TakeTradeButton } from "@/components/stock/take-trade-button";
import { fmtPrice } from "@/lib/format";
import { useStopModeStore } from "@/lib/stop-mode-store";
import type { SignalResult, StopMode, TrackedTradeView, Verdict } from "@/lib/stock-types";

export function verdictClasses(v: string): string {
  if (v === "Strong Buy" || v === "Buy")
    return "text-emerald-600 dark:text-emerald-400";
  if (v === "Sell" || v === "Strong Sell")
    return "text-red-600 dark:text-red-400";
  return "text-muted-foreground";
}

/** Signed compact weight, e.g. +2 / -1.5 */
function fmtWeight(weight: number): string {
  const w = Number(weight.toFixed(2));
  return w > 0 ? `+${w}` : `${w}`;
}

/** Signed score, e.g. +4.19 */
function fmtScore(score: number): string {
  return `${score > 0 ? "+" : ""}${score.toFixed(2)}`;
}

function weightToneCls(weight: number): string {
  if (weight > 0) return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
  if (weight < 0) return "bg-red-500/10 text-red-600 dark:text-red-400";
  return "bg-muted text-muted-foreground";
}

/** "S $325.33 (3 touches)" or "S —" when the level is absent. */
function srText(side: "S" | "R", level: { price: number; touches: number } | null | undefined): string {
  if (!level) return `${side} —`;
  return `${side} ${fmtPrice(level.price)} (${level.touches} ${level.touches === 1 ? "touch" : "touches"})`;
}

async function fetchSignal(symbol: string, stopMode: StopMode): Promise<SignalResult> {
  const res = await fetch(
    `/api/stocks/signals?symbol=${encodeURIComponent(symbol)}&stop=${stopMode}`,
  );
  if (!res.ok) throw new Error("Signal failed");
  return res.json();
}

async function fetchTrades(): Promise<TrackedTradeView[]> {
  const res = await fetch("/api/trades");
  if (!res.ok) throw new Error("Failed to load trades");
  const json = await res.json();
  return json.trades ?? [];
}

/** True while the position is still live (not TP2 / stopped out). */
const isLiveTrade = (t: TrackedTradeView) => t.status === "OPEN" || t.status === "TP1_HIT";

function DirectionIcon({ direction }: { direction: SignalResult["setup"]["direction"] }) {
  if (direction === "Long")
    return <ArrowUpRight className="size-4 text-emerald-500" aria-hidden />;
  if (direction === "Short")
    return <ArrowDownRight className="size-4 text-red-500" aria-hidden />;
  return <Hourglass className="size-4 text-muted-foreground" aria-hidden />;
}

export function TradeSetupPanel({ symbol }: { symbol: string }) {
  const stopMode = useStopModeStore((s) => s.stopMode);
  const setStopMode = useStopModeStore((s) => s.setStopMode);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["signal", symbol, stopMode],
    queryFn: () => fetchSignal(symbol, stopMode),
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });

  // Any live position on this symbol. Its levels were frozen when the user
  // confirmed and never move; the setup below is a *new* entry at today's price.
  const { data: trades } = useQuery({
    queryKey: ["trades"],
    queryFn: fetchTrades,
    refetchInterval: 30_000,
  });
  const position = (trades ?? []).find(
    (t) => t.symbol.toUpperCase() === symbol.toUpperCase() && isLiveTrade(t),
  );

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <p className="text-sm text-muted-foreground">Signal unavailable for {symbol}.</p>
    );
  }

  const { verdict, confidence, indicators, setup } = data;
  const bullish = verdict === "Strong Buy" || verdict === "Buy";

  // Signal-engine v2 fields (optional — absent on old payloads).
  const factors = data.factors ?? [];
  const ind = indicators;
  const bullOB = (ind.orderBlocks?.bullish ?? []).slice(0, 2);
  const bearOB = (ind.orderBlocks?.bearish ?? []).slice(0, 2);
  const hasSmartMoney =
    ind.structure != null ||
    ind.orderBlocks != null ||
    ind.liquidity != null ||
    ind.sr != null ||
    ind.volumeRatio != null ||
    ind.divergence != null;

  return (
    <div className="space-y-4" aria-label="Trade setup">
      {/* Verdict + confidence */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Verdict
          </span>
          <span className={`text-sm font-semibold ${verdictClasses(verdict)}`}>{verdict}</span>
        </div>
        <div className="flex min-w-[160px] flex-1 items-center gap-2">
          <span className="whitespace-nowrap text-xs text-muted-foreground">
            Confidence {confidence}%
          </span>
          <Progress value={confidence} className="h-1" aria-label={`Signal confidence ${confidence}%`} />
        </div>
      </div>

      {/* Indicator chips */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Chip label="Trend" value={indicators.trend} tone={indicators.trend === "Uptrend" ? "up" : indicators.trend === "Downtrend" ? "down" : "flat"} />
        <Chip
          label="RSI (14)"
          value={indicators.rsi != null ? indicators.rsi.toFixed(1) : "—"}
          tone={indicators.rsi == null ? "flat" : indicators.rsi >= 70 ? "down" : indicators.rsi <= 30 ? "up" : indicators.rsi >= 50 ? "up" : "down"}
        />
        <Chip
          label="MACD Hist"
          value={indicators.macd ? indicators.macd.histogram.toFixed(2) : "—"}
          tone={indicators.macd ? (indicators.macd.histogram >= 0 ? "up" : "down") : "flat"}
        />
        <Chip
          label="Ann. Vol"
          value={indicators.volatilityPct != null ? `${indicators.volatilityPct.toFixed(0)}%` : "—"}
          tone={indicators.volatilityPct == null ? "flat" : indicators.volatilityPct < 25 ? "up" : indicators.volatilityPct < 45 ? "flat" : "down"}
        />
      </div>

      {/* Why this signal (factor breakdown) */}
      {factors.length > 0 ? (
        <section className="border-t border-border pt-4" aria-label="Why this signal">
          <h3 className="mb-2 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Why this signal
          </h3>
          <ul
            className={`space-y-1.5 ${factors.length > 6 ? "max-h-56 overflow-y-auto pr-1" : ""}`}
            aria-label="Signal factors"
          >
            {factors.map((f, i) => (
              <li key={f.key || i} className="flex items-center gap-2">
                <span className="w-24 shrink-0 truncate text-xs font-medium sm:w-28" title={f.label}>
                  {f.label}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={f.detail}>
                  {f.detail}
                </span>
                <span
                  className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-semibold tabular ${weightToneCls(f.weight)}`}
                >
                  {fmtWeight(f.weight)}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-center justify-between gap-2 border-t border-border pt-2">
            <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Composite score
            </span>
            <span className="flex items-center gap-2">
              <span className="tabular text-xs font-semibold">{fmtScore(data.score)}</span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                {data.engine === "v2" ? "Engine v2" : "Engine v1"}
              </span>
            </span>
          </div>
        </section>
      ) : null}

      {/* Smart-money zones */}
      {hasSmartMoney ? (
        <section className="border-t border-border pt-4" aria-label="Smart-money zones">
          <h3 className="mb-2 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Smart-money zones
          </h3>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Chip
              label="Structure"
              value={ind.structure ?? "—"}
              tone={
                ind.structure === "Bullish"
                  ? "up"
                  : ind.structure === "Bearish"
                    ? "down"
                    : ind.structure === "Range"
                      ? "muted"
                      : "flat"
              }
            />
            <Cell label="Order blocks">
              {bullOB.length > 0 || bearOB.length > 0 ? (
                <div className="space-y-1">
                  {bullOB.map((z, i) => (
                    <div key={`bull-${i}`} className="flex items-center gap-1.5">
                      <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />
                      <span className="tabular">
                        Bull {fmtPrice(z.bottom)}–{fmtPrice(z.top)}
                      </span>
                    </div>
                  ))}
                  {bearOB.map((z, i) => (
                    <div key={`bear-${i}`} className="flex items-center gap-1.5">
                      <span className="size-1.5 shrink-0 rounded-full bg-red-500" aria-hidden />
                      <span className="tabular">
                        Bear {fmtPrice(z.bottom)}–{fmtPrice(z.top)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <span className="text-muted-foreground">None active</span>
              )}
            </Cell>
            <Cell label="Liquidity (EQH/EQL)">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="tabular">
                  Above {fmtPrice(ind.liquidity?.equalHighs)} · Below {fmtPrice(ind.liquidity?.equalLows)}
                </span>
                {ind.liquidity?.sweep ? (
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                      ind.liquidity.sweep === "bullish"
                        ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                        : "bg-red-500/10 text-red-600 dark:text-red-400"
                    }`}
                  >
                    {ind.liquidity.sweep === "bullish" ? "Bullish sweep" : "Bearish sweep"}
                  </span>
                ) : null}
              </span>
            </Cell>
            <Cell label="Tested S/R">
              <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                <span className="tabular">{srText("S", ind.sr?.support)}</span>
                <span className="text-muted-foreground">·</span>
                <span className="tabular">{srText("R", ind.sr?.resistance)}</span>
              </span>
            </Cell>
            <Chip
              label="Volume"
              value={ind.volumeRatio != null ? `${ind.volumeRatio.toFixed(1)}× avg` : "—"}
              tone={
                ind.volumeRatio == null
                  ? "flat"
                  : ind.volumeRatio >= 1.4
                    ? "up"
                    : ind.volumeRatio <= 0.6
                      ? "muted"
                      : "flat"
              }
            />
            <Chip
              label="RSI divergence"
              value={ind.divergence === "bullish" ? "Bullish" : ind.divergence === "bearish" ? "Bearish" : "—"}
              tone={ind.divergence === "bullish" ? "up" : ind.divergence === "bearish" ? "down" : "flat"}
            />
          </div>
        </section>
      ) : null}

      {/* Setup levels */}
      <div className="border-t border-border pt-4">
        {position ? (
          <div className="mb-4 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-700 dark:text-emerald-400">
                <CircleCheck className="size-3.5" aria-hidden />
                Your position — {position.direction}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {position.status === "OPEN" ? "In progress" : "TP1 hit — running to TP2"}
              </span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-4">
              <Level label="Your entry" value={fmtPrice(position.entryPrice)} />
              <Level label="Stop" value={fmtPrice(position.stopLoss)} />
              <Level label="TP1" value={fmtPrice(position.target1)} />
              <Level label="TP2" value={fmtPrice(position.target2)} />
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              Locked when you confirmed — nothing below changes these levels. The setup
              underneath is a <span className="font-medium text-foreground">new</span> entry at the
              current price, not a re-quote of your position.
            </p>
          </div>
        ) : null}
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <DirectionIcon direction={setup.direction} />
            {setup.direction === "Wait" ? "No trade suggested" : `${setup.direction} setup`}
          </span>
          <div className="flex items-center gap-3">
            <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Risk · {setup.riskLevel}
            </span>
            <div
              className="flex items-center gap-1.5"
              role="group"
              aria-label="Stop loss placement"
              title="Tight: closer of 1×ATR and just-below the last swing pivot. Balanced: farther of the 20-day S/R and 2×ATR."
            >
              <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                SL
              </span>
              <ToggleGroup
                type="single"
                size="sm"
                variant="outline"
                value={stopMode}
                onValueChange={(v) => {
                  if (v === "tight" || v === "balanced") setStopMode(v);
                }}
              >
                <ToggleGroupItem
                  value="tight"
                  className="h-7 px-2.5 text-xs"
                  aria-label="Tight stop loss"
                >
                  Tight
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="balanced"
                  className="h-7 px-2.5 text-xs"
                  aria-label="Balanced stop loss"
                >
                  Balanced
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
            <TakeTradeButton
              symbol={data.symbol}
              setup={setup}
              verdict={verdict}
              confidence={confidence}
              reentry={data.reentry ?? null}
            />
          </div>
        </div>
        {setup.direction === "Wait" ? (
          <p className="text-xs text-muted-foreground">
            Indicators disagree — no directional edge. Levels below are reference points.
          </p>
        ) : null}
        <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
          <Level label={setup.direction === "Short" ? "Exit (T1)" : "Target 1"} value={fmtPrice(setup.target1)} icon={<Target className="size-3" aria-hidden />} />
          <Level label={setup.direction === "Short" ? "Exit (T2)" : "Target 2"} value={fmtPrice(setup.target2)} icon={<Target className="size-3" aria-hidden />} />
          <Level
            label={position ? "New entry (if opened now)" : "Entry Zone"}
            value={fmtPrice(setup.entry)}
          />
          <Level
            label={`Stop Loss${setup.stopMode === "tight" ? " · Tight" : ""}`}
            value={fmtPrice(setup.stop)}
            hint={
              setup.stopAtrDist != null
                ? `${setup.stopAtrDist}×ATR from entry`
                : undefined
            }
            icon={<ShieldAlert className="size-3" aria-hidden />}
            danger={bullish ? false : true}
          />
          <Level label="Support (20d)" value={fmtPrice(setup.support)} />
          <Level label="Resistance (20d)" value={fmtPrice(setup.resistance)} />
          <Level label="Risk : Reward" value={setup.riskReward != null ? `1 : ${setup.riskReward}` : "—"} />
          <Level label="SMA20 / SMA50" value={`${fmtPrice(indicators.sma20)} / ${fmtPrice(indicators.sma50)}`} />
        </div>
      </div>

      {/* Reasoning */}
      <ul className="space-y-1" aria-label="Signal reasoning">
        {setup.notes.slice(0, 6).map((note, i) => (
          <li key={i} className="flex gap-2 text-xs text-muted-foreground">
            <span className="mt-1.5 size-1 shrink-0 rounded-full bg-primary/60" aria-hidden />
            {note}
          </li>
        ))}
      </ul>

      <p className="text-[10px] leading-relaxed text-muted-foreground/80">
        Signals combine trend, momentum and smart-money structure (SMA, RSI, MACD, ATR, market
        structure, order blocks, liquidity zones) computed from daily candles. Educational
        information only — not investment advice or a recommendation to trade.
      </p>
    </div>
  );
}

function Chip({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "up" | "down" | "flat" | "muted";
}) {
  const cls =
    tone === "up"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "down"
        ? "text-red-600 dark:text-red-400"
        : tone === "muted"
          ? "text-muted-foreground"
          : "text-foreground";
  return (
    <div className="border-l border-border pl-3">
      <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
      <div className={`tabular mt-0.5 text-sm font-medium ${cls}`}>{value}</div>
    </div>
  );
}

/** Composite smart-money cell: same frame as Chip, but the value can be rich (multi-line / badges). */
function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-l border-border pl-3">
      <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-xs font-medium">{children}</div>
    </div>
  );
}

function Level({
  label,
  value,
  icon,
  danger,
  hint,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
  danger?: boolean;
  hint?: string;
}) {
  return (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className={`tabular mt-0.5 text-sm font-medium ${danger ? "text-red-600 dark:text-red-400" : ""}`}>
        {value}
      </div>
      {hint ? <div className="mt-0.5 text-[10px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}
