"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownRight,
  ArrowUpRight,
  BriefcaseBusiness,
  CircleCheck,
  Loader2,
  Trophy,
  X,
} from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtPct, fmtPrice } from "@/lib/format";
import type { TrackedTradeView } from "@/lib/stock-types";

async function fetchTrades(): Promise<TrackedTradeView[]> {
  const res = await fetch("/api/trades");
  if (!res.ok) throw new Error("Failed to load trades");
  const json = await res.json();
  return json.trades ?? [];
}

const STATUS_META: Record<
  TrackedTradeView["status"],
  { label: string; cls: string; dotCls?: string; pulse?: boolean }
> = {
  OPEN: {
    label: "In Progress",
    cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    dotCls: "bg-emerald-500",
    pulse: true,
  },
  TP1_HIT: {
    label: "TP1 Hit — Running to TP2",
    cls: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    dotCls: "bg-amber-500",
    pulse: true,
  },
  TP2_HIT: {
    label: "TP2 Hit — Target Achieved",
    cls: "border-emerald-500 bg-emerald-500 text-white",
  },
  SL_HIT: {
    label: "SL Hit — Stopped Out",
    cls: "border-red-500 bg-red-500 text-white",
  },
};

function StatusBadge({ trade }: { trade: TrackedTradeView }) {
  const meta = STATUS_META[trade.status];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-semibold ${meta.cls}`}
      title={trade.closedReason ?? trade.message}
    >
      {meta.dotCls ? (
        <span className={`size-1.5 rounded-full ${meta.pulse ? "animate-pulse" : ""} ${meta.dotCls}`} aria-hidden />
      ) : null}
      {meta.label}
    </span>
  );
}

/** Visual rail: SL — Entry — TP1 — TP2 with a live price marker. */
function LevelRail({ trade }: { trade: TrackedTradeView }) {
  const levels = [trade.stopLoss, trade.entryPrice, trade.target1, trade.target2];
  const min = Math.min(...levels);
  const max = Math.max(...levels);
  const span = max - min || 1;
  const pos = (v: number) => Math.min(100, Math.max(0, ((v - min) / span) * 100));

  const entryP = pos(trade.entryPrice);
  const tp1P = pos(trade.target1);
  const slP = pos(trade.stopLoss);
  const priceP =
    trade.currentPrice != null ? pos(trade.currentPrice) : entryP;
  const pnlPositive = (trade.pnlPct ?? 0) >= 0;

  return (
    <div className="relative h-6" aria-hidden>
      {/* Segments */}
      <div className="absolute inset-x-0 top-2.5 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="absolute top-0 h-full bg-red-400/50 dark:bg-red-500/40"
          style={{ left: `${Math.min(entryP, slP)}%`, width: `${Math.max(entryP, slP) - Math.min(entryP, slP)}%` }}
        />
        <div
          className="absolute top-0 h-full bg-emerald-400/35 dark:bg-emerald-500/30"
          style={{ left: `${Math.min(entryP, tp1P)}%`, width: `${Math.abs(tp1P - entryP)}%` }}
        />
        <div
          className="absolute top-0 h-full bg-emerald-500/60 dark:bg-emerald-400/50"
          style={{
            left: `${Math.min(tp1P, pos(trade.target2))}%`,
            width: `${Math.abs(pos(trade.target2) - tp1P)}%`,
          }}
        />
      </div>
      {/* Ticks */}
      {[slP, entryP, tp1P, pos(trade.target2)].map((p, i) => (
        <div
          key={i}
          className="absolute top-2 h-2 w-px bg-foreground/30"
          style={{ left: `${p}%` }}
        />
      ))}
      {/* Live price marker */}
      <div
        className={`absolute top-0.5 size-3.5 -translate-x-1/2 rounded-full border-2 border-background shadow transition-[left] duration-700 ${
          pnlPositive ? "bg-emerald-500" : "bg-red-500"
        }`}
        style={{ left: `${priceP}%` }}
      />
    </div>
  );
}

function fmtDay(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function TradeCard({
  trade,
  onOpenSymbol,
}: {
  trade: TrackedTradeView;
  onOpenSymbol?: (symbol: string) => void;
}) {
  const queryClient = useQueryClient();
  const long = trade.direction === "Long";

  const removeMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/trades?id=${encodeURIComponent(trade.id)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to remove trade");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["trades"] });
      toast({ title: "Trade removed", description: trade.symbol });
    },
    onError: () =>
      toast({ title: "Error", description: "Could not remove trade", variant: "destructive" }),
  });

  const pnl =
    trade.pnlAtClosePct != null ? trade.pnlAtClosePct : trade.pnlPct;
  const pnlColor =
    pnl == null
      ? "text-muted-foreground"
      : pnl >= 0
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-red-600 dark:text-red-400";

  return (
    <div className="rounded-lg border bg-card p-3 transition-colors hover:bg-accent/40">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onOpenSymbol?.(trade.symbol)}
          className="flex min-w-0 items-center gap-2 text-left focus-visible:outline-2 focus-visible:outline-ring"
          aria-label={`Open ${trade.symbol} details`}
        >
          <span className="font-semibold hover:underline">{trade.symbol}</span>
          <span className="hidden max-w-[150px] truncate text-xs text-muted-foreground sm:inline">
            {trade.companyName ?? ""}
          </span>
        </button>
        <Badge
          variant="outline"
          className={`gap-1 text-[10px] ${
            long
              ? "border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
              : "border-red-500/30 text-red-600 dark:text-red-400"
          }`}
        >
          {long ? (
            <ArrowUpRight className="size-3" aria-hidden />
          ) : (
            <ArrowDownRight className="size-3" aria-hidden />
          )}
          {trade.direction}
        </Badge>
        <div className="ml-auto flex items-center gap-1.5">
          <StatusBadge trade={trade} />
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:text-destructive"
            aria-label={`Remove ${trade.symbol} trade`}
            disabled={removeMutation.isPending}
            onClick={() => removeMutation.mutate()}
          >
            {removeMutation.isPending ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <X className="size-3.5" aria-hidden />
            )}
          </Button>
        </div>
      </div>

      {/* Level rail */}
      <div className="mt-2">
        <LevelRail trade={trade} />
      </div>

      {/* Levels */}
      <div className="mt-1.5 grid grid-cols-4 gap-1 text-center">
        <LevelCell
          label="Stop Loss"
          value={fmtPrice(trade.stopLoss)}
          hit={trade.status === "SL_HIT"}
          hitCls="text-red-600 dark:text-red-400"
        />
        <LevelCell label="Entry" value={fmtPrice(trade.entryPrice)} />
        <LevelCell
          label="TP1"
          value={fmtPrice(trade.target1)}
          hit={trade.hitTp1}
          hitCls="text-emerald-600 dark:text-emerald-400"
        />
        <LevelCell
          label="TP2"
          value={fmtPrice(trade.target2)}
          hit={trade.status === "TP2_HIT"}
          hitCls="text-emerald-600 dark:text-emerald-400"
        />
      </div>

      {/* Status line */}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          {trade.message || "Syncing trade status…"}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {trade.currentPrice != null ? (
            <span className="tabular text-xs text-muted-foreground">
              Now {fmtPrice(trade.currentPrice)}
            </span>
          ) : null}
          <span className={`tabular text-sm font-bold ${pnlColor}`}>
            {pnl != null ? fmtPct(pnl) : "—"}
          </span>
        </div>
      </div>

      {/* Progress toward TP2 */}
      {trade.status === "OPEN" || trade.status === "TP1_HIT" ? (
        <div className="mt-2 flex items-center gap-2">
          <Progress
            value={Math.min(100, Math.max(0, trade.progressPct ?? 0))}
            className="h-1.5"
            aria-label={`Progress toward target 2: ${Math.round(trade.progressPct ?? 0)}%`}
          />
          <span className="tabular shrink-0 text-[10px] text-muted-foreground">
            {Math.round(trade.progressPct ?? 0)}% to TP2
          </span>
        </div>
      ) : null}

      <p className="mt-1.5 text-[10px] text-muted-foreground/70">
        Opened {fmtDay(trade.openedAt)}
        {trade.closedAt ? ` · Closed ${fmtDay(trade.closedAt)}` : ""}
        {trade.riskReward != null ? ` · R:R 1:${trade.riskReward}` : ""}
        {trade.verdict ? ` · Signal was ${trade.verdict}` : ""}
      </p>
    </div>
  );
}

function LevelCell({
  label,
  value,
  hit,
  hitCls,
}: {
  label: string;
  value: string;
  hit?: boolean;
  hitCls?: string;
}) {
  return (
    <div className="rounded-md border bg-muted/30 px-1.5 py-1">
      <div className="flex items-center justify-center gap-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">
        {hit ? <CircleCheck className="size-2.5" aria-hidden /> : null}
        {label}
      </div>
      <div className={`tabular text-xs font-semibold ${hit ? hitCls : ""}`}>{value}</div>
    </div>
  );
}

export function MyTrades({ onOpenSymbol }: { onOpenSymbol?: (symbol: string) => void }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["trades"],
    queryFn: fetchTrades,
    refetchInterval: 30_000,
  });

  const trades = data ?? [];
  const activeCount = trades.filter(
    (t) => t.status === "OPEN" || t.status === "TP1_HIT",
  ).length;
  const wins = trades.filter((t) => t.status === "TP2_HIT").length;
  const losses = trades.filter((t) => t.status === "SL_HIT").length;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <BriefcaseBusiness className="size-4 text-primary" aria-hidden />
            My Trades
          </CardTitle>
          <CardDescription>
            Positions you took from a signal setup — TP1 / TP2 / SL status updates every 30s
          </CardDescription>
        </div>
        {trades.length > 0 ? (
          <div className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium">
            <Badge variant="outline" className="gap-1">
              <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" aria-hidden />
              {activeCount} active
            </Badge>
            <Badge variant="outline" className="gap-1 border-emerald-500/40">
              <Trophy className="size-3 text-emerald-500" aria-hidden /> {wins} TP2
            </Badge>
            <Badge variant="outline" className="gap-1 border-red-500/40">
              <X className="size-3 text-red-500" aria-hidden /> {losses} SL
            </Badge>
          </div>
        ) : null}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} className="h-32 w-full" />
            ))}
          </div>
        ) : isError ? (
          <p className="text-sm text-muted-foreground">Could not load your trades. Try refreshing.</p>
        ) : trades.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-8 text-center">
            <BriefcaseBusiness className="size-7 text-muted-foreground/50" aria-hidden />
            <p className="text-sm font-medium">No trades yet</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              Open any stock&apos;s detail view, check its Trade Setup, and tap{" "}
              <span className="font-semibold text-foreground">&ldquo;I Took This Trade&rdquo;</span>{" "}
              — OpenStock will then track TP1, TP2 and stop-loss for you.
            </p>
          </div>
        ) : (
          <div className="max-h-[560px] space-y-3 overflow-y-auto pr-1">
            {trades.map((t) => (
              <TradeCard key={t.id} trade={t} onOpenSymbol={onOpenSymbol} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
