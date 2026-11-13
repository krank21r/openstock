"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Loader2, Lock } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { fmtPrice } from "@/lib/format";
import { useStopModeStore } from "@/lib/stop-mode-store";
import type {
  ReentryGate,
  SignalResult,
  TradeSetup,
  TrackedTradeView,
} from "@/lib/stock-types";

async function fetchTrades(): Promise<TrackedTradeView[]> {
  const res = await fetch("/api/trades");
  if (!res.ok) throw new Error("Failed to load trades");
  const json = await res.json();
  return json.trades ?? [];
}

/** Status text shown in place of the button when the symbol is already tracked. */
export function TradeStatusChip({ trade }: { trade: TrackedTradeView }) {
  const map: Record<
    TrackedTradeView["status"],
    { label: string; cls: string; dot: string; pulse?: boolean }
  > = {
    OPEN: {
      label: "Tracking · In Progress",
      cls: "text-emerald-600 dark:text-emerald-400",
      dot: "bg-emerald-500",
      pulse: true,
    },
    TP1_HIT: {
      label: "TP1 Hit · Running to TP2",
      cls: "text-amber-600 dark:text-amber-400",
      dot: "bg-amber-500",
      pulse: true,
    },
    TP2_HIT: {
      label: "TP2 Hit — Target achieved",
      cls: "text-emerald-600 dark:text-emerald-400",
      dot: "bg-emerald-500",
    },
    SL_HIT: {
      label: "SL Hit — Stopped out",
      cls: "text-red-600 dark:text-red-400",
      dot: "bg-red-500",
    },
  };
  const s = map[trade.status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-medium ${s.cls}`}
      title={trade.message}
    >
      <span
        className={`size-1.5 rounded-full ${s.pulse ? "animate-pulse" : ""} ${s.dot}`}
        aria-hidden
      />
      {s.label}
    </span>
  );
}

interface TakeTradeButtonProps {
  symbol: string;
  setup: TradeSetup;
  verdict: SignalResult["verdict"];
  confidence: number;
  /** Fresh-signal gate: true while re-entry is locked after a stop-out. */
  reentry?: ReentryGate | null;
}

export function TakeTradeButton({
  symbol,
  setup,
  verdict,
  confidence,
  reentry,
}: TakeTradeButtonProps) {
  const queryClient = useQueryClient();
  const stopMode = useStopModeStore((s) => s.stopMode);

  // Watch active trades so we can swap the button for a status chip.
  const tradesQuery = useQuery({
    queryKey: ["trades"],
    queryFn: fetchTrades,
    refetchInterval: 30_000,
  });

  const activeTrade = (tradesQuery.data ?? []).find(
    (t) => t.symbol === symbol && (t.status === "OPEN" || t.status === "TP1_HIT"),
  );

  const confirmMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/trades", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, stopMode }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to confirm trade");
      return json.trade as TrackedTradeView;
    },
    onSuccess: (trade) => {
      queryClient.invalidateQueries({ queryKey: ["trades"] });
      toast({
        title: `Trade confirmed — tracking ${trade.symbol} ${trade.direction}`,
        description:
          "You'll see live status for TP1, TP2 and stop-loss in the My Trades section.",
      });
    },
    onError: (err: Error) =>
      toast({ title: "Could not confirm trade", description: err.message, variant: "destructive" }),
  });

  if (activeTrade) {
    return (
      <div className="flex items-center gap-2" aria-live="polite">
        <TradeStatusChip trade={activeTrade} />
      </div>
    );
  }

  // Stopped out and no fresh signal yet — re-entry is locked until the engine
  // fires a new signal (Neutral -> Buy/Sell, or a direction flip).
  if (reentry?.blocked) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-600 dark:text-amber-400"
        title="Your last trade on this symbol was stopped out. The signal hasn't produced a new one since — wait for a fresh signal (Neutral, then a new Buy/Sell) in the Trade Alerts tab."
      >
        <Lock className="size-3" aria-hidden />
        Stopped out — waiting for fresh signal
      </span>
    );
  }

  const isWait = setup.direction === "Wait";

  // Sub-1:1 setups risk more than the first target pays. Not blocked — the
  // levels are explicit — but the confirm has to say it out loud.
  const risky = setup.riskReward != null && setup.riskReward < 1;
  const riskPerShare = Math.abs(setup.entry - setup.stop);
  const rewardPerShare = Math.abs(setup.target1 - setup.entry);

  // A dead disabled button explains nothing. When the engine offers no setup
  // (e.g. the signal faded after the alert fired) say why instead.
  if (isWait) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded border bg-muted/40 px-2 py-1 text-xs font-medium text-muted-foreground">
        No setup — signal is {verdict}
      </span>
    );
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          size="sm"
          disabled={confirmMutation.isPending}
          aria-label={`Confirm you took the ${symbol} ${setup.direction} trade`}
        >
          {confirmMutation.isPending ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : null}
          I Took This Trade
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Confirm trade — {symbol}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-sm">
              <p>
                You&apos;re about to track this position exactly as the setup suggests. OpenStock
                will monitor it and update the status when it hits{" "}
                <span className="font-medium text-emerald-600 dark:text-emerald-400">TP1</span>,{" "}
                <span className="font-medium text-emerald-600 dark:text-emerald-400">TP2</span>{" "}
                or{" "}
                <span className="font-medium text-red-600 dark:text-red-400">Stop Loss</span>.
              </p>
              <div className="rounded-md border p-3 text-left">
                <div className="mb-2 flex items-center justify-between">
                  <span className="flex items-center gap-1.5 font-medium text-foreground">
                    {setup.direction === "Long" ? (
                      <ArrowUpRight className="size-4 text-emerald-500" aria-hidden />
                    ) : (
                      <ArrowDownRight className="size-4 text-red-500" aria-hidden />
                    )}
                    {setup.direction} position
                  </span>
                  <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                    {verdict} · {confidence}%
                  </span>
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                  <Row label="Entry Zone" value={fmtPrice(setup.entry)} />
                  <Row
                    label="Stop Loss"
                    value={fmtPrice(setup.stop)}
                    valueCls="text-red-600 dark:text-red-400"
                  />
                  <Row
                    label="Target 1"
                    value={fmtPrice(setup.target1)}
                    valueCls="text-emerald-600 dark:text-emerald-400"
                  />
                  <Row
                    label="Target 2"
                    value={fmtPrice(setup.target2)}
                    valueCls="text-emerald-600 dark:text-emerald-400"
                  />
                  <Row
                    label="Risk : Reward"
                    value={setup.riskReward != null ? `1 : ${setup.riskReward}` : "—"}
                    valueCls={
                      risky ? "text-amber-600 dark:text-amber-400" : undefined
                    }
                  />
                  <Row
                    label="Stop Style"
                    value={
                      setup.stopMode === "tight"
                        ? "Tight (1×ATR / swing low)"
                        : "Balanced (2×ATR / 20-day S/R)"
                    }
                  />
                  <Row label="Risk Level" value={setup.riskLevel} />
                </dl>
              </div>
              {risky ? (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-left text-xs text-amber-700 dark:text-amber-300">
                  <span className="inline-flex items-center gap-1.5 font-semibold">
                    <AlertTriangle className="size-3.5" aria-hidden />
                    Below 1:1 — the stop is wider than the first target
                  </span>
                  <p className="mt-1 leading-relaxed">
                    Risking {fmtPrice(riskPerShare)} per share to make{" "}
                    {fmtPrice(rewardPerShare)} at TP1 (1 : {setup.riskReward}). A win here
                    pays less than a loss costs — consider the Tight stop before confirming.
                  </p>
                </div>
              ) : null}
              <p className="text-xs text-muted-foreground">
                Paper-tracking only — no real order is placed. Status is checked against live
                prices every 30 seconds.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault(); // keep dialog open until mutation settles
              confirmMutation.mutate();
            }}
            disabled={confirmMutation.isPending}
          >
            {confirmMutation.isPending ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : null}
            {risky ? "Track anyway (below 1:1)" : "Confirm & Track"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function Row({
  label,
  value,
  valueCls,
}: {
  label: string;
  value: string;
  valueCls?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`tabular font-semibold ${valueCls ?? "text-foreground"}`}>{value}</dd>
    </div>
  );
}
