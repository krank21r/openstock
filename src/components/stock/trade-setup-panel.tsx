"use client";

import { useQuery } from "@tanstack/react-query";
import {
  ArrowDownRight,
  ArrowUpRight,
  Hourglass,
  ShieldAlert,
  Target,
} from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { TakeTradeButton } from "@/components/stock/take-trade-button";
import { fmtPrice } from "@/lib/format";
import type { SignalResult, Verdict } from "@/lib/stock-types";

export function verdictClasses(v: Verdict): string {
  if (v === "Strong Buy" || v === "Buy")
    return "text-emerald-600 dark:text-emerald-400";
  if (v === "Sell" || v === "Strong Sell")
    return "text-red-600 dark:text-red-400";
  return "text-muted-foreground";
}

async function fetchSignal(symbol: string): Promise<SignalResult> {
  const res = await fetch(`/api/stocks/signals?symbol=${encodeURIComponent(symbol)}`);
  if (!res.ok) throw new Error("Signal failed");
  return res.json();
}

function DirectionIcon({ direction }: { direction: SignalResult["setup"]["direction"] }) {
  if (direction === "Long")
    return <ArrowUpRight className="size-4 text-emerald-500" aria-hidden />;
  if (direction === "Short")
    return <ArrowDownRight className="size-4 text-red-500" aria-hidden />;
  return <Hourglass className="size-4 text-muted-foreground" aria-hidden />;
}

export function TradeSetupPanel({ symbol }: { symbol: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["signal", symbol],
    queryFn: () => fetchSignal(symbol),
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });

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

      {/* Setup levels */}
      <div className="border-t border-border pt-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <DirectionIcon direction={setup.direction} />
            {setup.direction === "Wait" ? "No trade suggested" : `${setup.direction} setup`}
          </span>
          <div className="flex items-center gap-3">
            <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Risk · {setup.riskLevel}
            </span>
            <TakeTradeButton
              symbol={data.symbol}
              setup={setup}
              verdict={verdict}
              confidence={confidence}
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
          <Level label="Entry Zone" value={fmtPrice(setup.entry)} />
          <Level label="Stop Loss" value={fmtPrice(setup.stop)} icon={<ShieldAlert className="size-3" aria-hidden />} danger={bullish ? false : true} />
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
        Signals are generated algorithmically from technical indicators (SMA, RSI, MACD, ATR) on
        daily candles. Educational information only — not investment advice or a recommendation to
        trade.
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
  tone: "up" | "down" | "flat";
}) {
  const cls =
    tone === "up"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "down"
        ? "text-red-600 dark:text-red-400"
        : "text-foreground";
  return (
    <div className="border-l border-border pl-3">
      <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
      <div className={`tabular mt-0.5 text-sm font-medium ${cls}`}>{value}</div>
    </div>
  );
}

function Level({
  label,
  value,
  icon,
  danger,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
  danger?: boolean;
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
    </div>
  );
}
