"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight, BriefcaseBusiness, Loader2 } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fmtPrice } from "@/lib/format";
import type { SignalResult, TradeSetup, TrackedTradeView } from "@/lib/stock-types";

async function fetchTrades(): Promise<TrackedTradeView[]> {
  const res = await fetch("/api/trades");
  if (!res.ok) throw new Error("Failed to load trades");
  const json = await res.json();
  return json.trades ?? [];
}

/** Status pill shown in place of the button when the symbol is already tracked. */
export function TradeStatusChip({ trade }: { trade: TrackedTradeView }) {
  const map: Record<
    TrackedTradeView["status"],
    { label: string; cls: string }
  > = {
    OPEN: {
      label: "Tracking · In Progress",
      cls: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
    },
    TP1_HIT: {
      label: "TP1 Hit ✓ · Running",
      cls: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30",
    },
    TP2_HIT: {
      label: "TP2 Hit — Target achieved",
      cls: "bg-emerald-500 text-white border-emerald-500",
    },
    SL_HIT: {
      label: "SL Hit — Stopped out",
      cls: "bg-red-500 text-white border-red-500",
    },
  };
  const s = map[trade.status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-semibold ${s.cls}`}
      title={trade.message}
    >
      {trade.direction === "Long" ? (
        <ArrowUpRight className="size-3.5" aria-hidden />
      ) : (
        <ArrowDownRight className="size-3.5" aria-hidden />
      )}
      {s.label}
    </span>
  );
}

interface TakeTradeButtonProps {
  symbol: string;
  setup: TradeSetup;
  verdict: SignalResult["verdict"];
  confidence: number;
}

export function TakeTradeButton({ symbol, setup, verdict, confidence }: TakeTradeButtonProps) {
  const queryClient = useQueryClient();

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
        body: JSON.stringify({ symbol }),
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

  const isWait = setup.direction === "Wait";

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          size="sm"
          className="gap-1.5"
          disabled={isWait || confirmMutation.isPending}
          aria-label={`Confirm you took the ${symbol} ${setup.direction} trade`}
        >
          {confirmMutation.isPending ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <BriefcaseBusiness className="size-3.5" aria-hidden />
          )}
          I Took This Trade
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <BriefcaseBusiness className="size-4 text-primary" aria-hidden />
            Confirm trade — {symbol}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-sm">
              <p>
                You&apos;re about to track this position exactly as the setup suggests. OpenStock
                will monitor it and update the status when it hits{" "}
                <span className="font-semibold text-emerald-600 dark:text-emerald-400">TP1</span>,{" "}
                <span className="font-semibold text-emerald-600 dark:text-emerald-400">TP2</span>{" "}
                or{" "}
                <span className="font-semibold text-red-600 dark:text-red-400">Stop Loss</span>.
              </p>
              <div className="rounded-lg border bg-muted/40 p-3 text-left">
                <div className="mb-2 flex items-center justify-between">
                  <span className="flex items-center gap-1.5 font-semibold text-foreground">
                    {setup.direction === "Long" ? (
                      <ArrowUpRight className="size-4 text-emerald-500" aria-hidden />
                    ) : (
                      <ArrowDownRight className="size-4 text-red-500" aria-hidden />
                    )}
                    {setup.direction} position
                  </span>
                  <Badge variant="outline" className="text-[10px]">
                    {verdict} · {confidence}% confidence
                  </Badge>
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
                  />
                  <Row label="Risk Level" value={setup.riskLevel} />
                </dl>
              </div>
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
            className="gap-1.5"
          >
            {confirmMutation.isPending ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <BriefcaseBusiness className="size-3.5" aria-hidden />
            )}
            Confirm & Track
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
