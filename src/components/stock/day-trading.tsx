"use client";

import { useQuery } from "@tanstack/react-query";
import {
  ArrowDownRight,
  ArrowUpRight,
  Check,
  Info,
  RefreshCw,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtPct, fmtPrice } from "@/lib/format";
import type { DayTradeIdea, DayTradeScan } from "@/lib/daytrade";

async function fetchScan(): Promise<DayTradeScan> {
  const res = await fetch("/api/daytrade");
  if (!res.ok) throw new Error("Scan failed");
  return res.json();
}

const clock = (ms: number) =>
  new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true }).format(
    new Date(ms),
  );

function DirectionBadge({ direction }: { direction: DayTradeIdea["direction"] }) {
  const long = direction === "Long";
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-0.5 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        long
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          : "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400"
      }`}
    >
      {long ? <ArrowUpRight className="size-3" aria-hidden /> : <ArrowDownRight className="size-3" aria-hidden />}
      {direction}
    </span>
  );
}

function Level({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </div>
      <div className={`tabular mt-0.5 text-sm font-semibold ${tone ?? ""}`}>{value}</div>
    </div>
  );
}

function IdeaCard({
  idea,
  qualifying,
  onOpenSymbol,
}: {
  idea: DayTradeIdea;
  qualifying: boolean;
  onOpenSymbol: (symbol: string) => void;
}) {
  const long = idea.direction === "Long";
  return (
    <div
      className={`rounded-lg border p-3 transition-colors hover:border-foreground/25 ${
        qualifying ? "" : "opacity-70"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <DirectionBadge direction={idea.direction} />
        <button
          type="button"
          onClick={() => onOpenSymbol(idea.symbol)}
          className="font-semibold hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          {idea.symbol}
        </button>
        <span className="hidden max-w-[150px] truncate text-xs text-muted-foreground sm:inline">
          {idea.name}
        </span>
        <span className="rounded border px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {idea.kind === "crypto" ? "Crypto" : "Stock"}
        </span>
        <span className="tabular ml-auto text-sm font-medium">{fmtPrice(idea.price)}</span>
        {idea.changePct != null ? (
          <span
            className={`tabular text-xs font-medium ${
              idea.changePct >= 0
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-red-600 dark:text-red-400"
            }`}
          >
            {fmtPct(idea.changePct)}
          </span>
        ) : null}
      </div>

      <div className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Level label="Entry" value={fmtPrice(idea.entry)} />
        <Level
          label="Stop"
          value={fmtPrice(idea.stop)}
          tone="text-red-600 dark:text-red-400"
        />
        <Level
          label="Target 1 (2R)"
          value={fmtPrice(idea.target1)}
          tone="text-emerald-600 dark:text-emerald-400"
        />
        <Level
          label="Target 2 (3R)"
          value={fmtPrice(idea.target2)}
          tone="text-emerald-600 dark:text-emerald-400"
        />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span>Risk {idea.riskPct}%</span>
        <span>R:R 1 : {idea.riskReward}</span>
        {idea.rsi != null ? <span>RSI(5m) {idea.rsi}</span> : null}
        {idea.relVolume != null ? (
          <span
            className={
              idea.relVolume >= 1.15
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-amber-600 dark:text-amber-400"
            }
            title="Volume so far versus the pace expected at this point of the session. Below 1.15× means the tape is quiet — the setup still stands, it just has less fuel."
          >
            Vol {idea.relVolume.toFixed(2)}× pace
          </span>
        ) : null}
        <span>VWAP {fmtPrice(idea.vwap)}</span>
        <span className={qualifying ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}>
          {idea.passed}/{idea.total} checks
        </span>
      </div>

      <ul className="mt-2 space-y-1">
        {idea.checks.map((c) => (
          <li key={c.label} className="flex items-start gap-1.5 text-[11px] leading-relaxed">
            {c.pass ? (
              <Check className="mt-0.5 size-3 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
            ) : (
              <X className="mt-0.5 size-3 shrink-0 text-red-500" aria-hidden />
            )}
            <span className={c.pass ? "text-muted-foreground" : "text-foreground"}>
              <span className="font-medium">{c.label}</span>
              {" — "}
              {c.detail}
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-2 flex items-center justify-between border-t pt-2">
        <span className="text-[11px] text-muted-foreground">
          {long ? "Long" : "Short"} · levels from {clock(idea.asOf)}
        </span>
        <button
          type="button"
          onClick={() => onOpenSymbol(idea.symbol)}
          className="text-[11px] font-medium text-foreground underline-offset-2 hover:underline"
        >
          Details
        </button>
      </div>
    </div>
  );
}

export function DayTrading({
  onOpenSymbol,
  enabled,
}: {
  onOpenSymbol: (symbol: string) => void;
  enabled: boolean;
}) {
  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ["daytrade"],
    queryFn: fetchScan,
    enabled,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const ideas = data?.ideas ?? [];
  const nearMisses = data?.nearMisses ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle>Day Trading</CardTitle>
          <CardDescription>
            Intraday setups in liquid US stocks and major crypto. A symbol is listed only when
            all {5} structural checks pass — trend, trigger, momentum, liquidity/volatility and
            risk geometry — and every check is shown, pass or fail.
          </CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
          className="shrink-0 gap-1.5"
          aria-label="Rescan day trades"
        >
          <RefreshCw className={`size-3.5 ${isFetching ? "animate-spin" : ""}`} aria-hidden />
          Rescan
        </Button>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span
              className={`size-1.5 rounded-full ${data?.marketOpen ? "animate-pulse bg-emerald-500" : "bg-muted-foreground/50"}`}
              aria-hidden
            />
            {data?.marketOpen ? "US session open" : "US session closed — stocks reflect the last session"} · crypto 24/7
          </span>
          {data ? (
            <>
              <span>{data.scanned} of {data.scanned + data.skipped} symbols judged</span>
              <span>scanned {clock(data.updatedAt)}</span>
            </>
          ) : null}
        </div>

        <p className="flex items-start gap-1.5 rounded-md border bg-muted/30 p-2 text-[11px] leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span>
            This is a strict confluence filter, not a probability estimate. The thresholds are
            conventional day-trading rules — there is no intraday backtest behind them yet. Levels
            are mechanical (stop 1×ATR capped at 0.4–1.2%, targets 2R / 3R) and assume an exit
            before the close.
          </span>
        </p>

        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} className="h-40 w-full" />
            ))}
          </div>
        ) : isError ? (
          <p className="text-sm text-muted-foreground">Scan failed. Try rescanning.</p>
        ) : (
          <>
            {ideas.length === 0 ? (
              <div className="rounded-lg border border-dashed p-6 text-center">
                <p className="text-sm font-medium">No qualifying setups right now</p>
                <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                  Nothing on the tape passes all five structural checks. That is the filter
                  working — day setups are the exception, not the rule. The scan reruns every 60
                  seconds.
                </p>
              </div>
            ) : (
              <section aria-label="Qualifying day trades" className="space-y-2">
                <div className="flex items-baseline justify-between">
                  <h3 className="text-xs font-semibold uppercase tracking-[0.14em]">
                    Qualifying
                    <span className="ml-2 font-medium text-muted-foreground">{ideas.length}</span>
                  </h3>
                  <p className="hidden text-[11px] text-muted-foreground sm:block">
                    All {5} structural checks passed — volume pace is shown, not gated
                  </p>
                </div>
                {ideas.map((idea) => (
                  <IdeaCard key={idea.symbol} idea={idea} qualifying onOpenSymbol={onOpenSymbol} />
                ))}
              </section>
            )}

            {nearMisses.length > 0 ? (
              <section aria-label="Closest misses" className="space-y-2 border-t pt-3">
                <div className="flex items-baseline justify-between">
                  <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    Closest misses — not tradeable
                    <span className="ml-2 font-medium">{nearMisses.length}</span>
                  </h3>
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  One check short. Shown so you can see what nearly qualified — not as setups.
                </p>
                {nearMisses.map((idea) => (
                  <IdeaCard
                    key={idea.symbol}
                    idea={idea}
                    qualifying={false}
                    onOpenSymbol={onOpenSymbol}
                  />
                ))}
              </section>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
