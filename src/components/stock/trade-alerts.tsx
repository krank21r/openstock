"use client";

import { useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownRight,
  ArrowUpRight,
  Bell,
  CircleCheck,
  X,
} from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtPct, fmtPrice, fmtTimeAgo } from "@/lib/format";
import { verdictClasses } from "@/components/stock/trade-setup-panel";
import accuracyJson from "@/data/signal-accuracy.json";
import type { AlertStatus, Quote, SignalSummary, TradeAlertView } from "@/lib/stock-types";

/** Measured behaviour of the daily engine (scripts/accuracy-report.ts). */
interface AccuracyBucket {
  n: number;
  winPct: number | null;
  expR: number | null;
}
const accuracy = accuracyJson as unknown as {
  horizonDays: number;
  method: string;
  overall: { long: AccuracyBucket; short: AccuracyBucket };
  bySymbol: Record<string, { long: AccuracyBucket; short: AccuracyBucket }>;
};

function historyFor(symbol: string, direction: "Long" | "Short"): AccuracyBucket | null {
  const row = accuracy.bySymbol[symbol];
  if (!row) return null;
  const bucket = direction === "Long" ? row.long : row.short;
  return bucket.n > 0 ? bucket : null;
}

interface TradeAlertsProps {
  alerts: TradeAlertView[] | undefined;
  isLoading: boolean;
  quotesBySymbol: Map<string, Quote>;
  /** Live summaries for watched symbols — detects alerts whose signal moved on. */
  signalsBySymbol: Map<string, SignalSummary>;
  onOpenSymbol: (symbol: string) => void;
}

/** Buy* = +1, Sell* = -1, anything else (Neutral) = 0. */
const signOf = (verdict: string) =>
  verdict.includes("Buy") ? 1 : verdict.includes("Sell") ? -1 : 0;

/**
 * Fill-distance rule: a setup is only a setup near its trigger price. Once price
 * has travelled more than a quarter ATR past the alert, entering is chasing.
 */
const CHASE_ATR_LIMIT = 0.25;

const GROUPS: { status: AlertStatus; title: string; description: string }[] = [
  { status: "OPEN", title: "Waiting for you", description: "Signal turned actionable — review and take the trade, or dismiss." },
  { status: "STALE", title: "Faded to Neutral", description: "The signal reverted before you acted. It may re-fire." },
  { status: "TAKEN", title: "Confirmed trades", description: "Tracked in My Trades with TP1 / TP2 / SL status." },
];

function DirectionBadge({ direction }: { direction: "Long" | "Short" }) {
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

function driftOf(alert: TradeAlertView, quotesBySymbol: Map<string, Quote>): number | null {
  if (alert.priceAtAlert == null || alert.priceAtAlert <= 0) return null;
  const now = quotesBySymbol.get(alert.symbol)?.price;
  if (now == null || !Number.isFinite(now)) return null;
  return ((now - alert.priceAtAlert) / alert.priceAtAlert) * 100;
}

function AlertRow({
  alert,
  quotesBySymbol,
  signalsBySymbol,
  onOpenSymbol,
  onDismiss,
  dismissPending,
}: {
  alert: TradeAlertView;
  quotesBySymbol: Map<string, Quote>;
  signalsBySymbol: Map<string, SignalSummary>;
  onOpenSymbol: (symbol: string) => void;
  onDismiss: (id: string) => void;
  dismissPending: boolean;
}) {
  const quote = quotesBySymbol.get(alert.symbol);
  const drift = driftOf(alert, quotesBySymbol);
  const stale = alert.status === "STALE";
  const taken = alert.status === "TAKEN";

  // The alert stores the verdict it fired with; the engine recomputes live.
  // If the signal has since changed direction (or faded to Neutral) the setup
  // in the detail panel is a "Wait" — offering "I Took This Trade" would lead
  // straight to a disabled confirm button.
  const nowVerdict = signalsBySymbol.get(alert.symbol)?.verdict ?? null;
  const drifted = nowVerdict != null && nowVerdict !== alert.verdict;
  const blocked = nowVerdict != null && signOf(nowVerdict) !== signOf(alert.verdict);

  // Chase guard — distance travelled AGAINST the entry, measured in ATR.
  // For a long, paying up above the alert price is chasing; for a short,
  // selling below it is. Negative values mean price came back to a better fill.
  const atr = signalsBySymbol.get(alert.symbol)?.atr ?? null;
  const alertPrice = alert.priceAtAlert;
  const nowPrice = quote?.price ?? null;
  const adverse =
    alertPrice != null && alertPrice > 0 && nowPrice != null
      ? alert.direction === "Long"
        ? nowPrice - alertPrice
        : alertPrice - nowPrice
      : null;
  const chaseAtr = adverse != null && atr != null && atr > 0 ? adverse / atr : null;
  const chasing = chaseAtr != null && chaseAtr > CHASE_ATR_LIMIT;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpenSymbol(alert.symbol)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onOpenSymbol(alert.symbol);
      }}
      className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors hover:bg-accent/60 focus-visible:outline-2 focus-visible:outline-ring ${
        stale ? "opacity-60" : ""
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <DirectionBadge direction={alert.direction} />
          <span className="font-semibold">{alert.symbol}</span>
          <span className="hidden max-w-[160px] truncate text-xs text-muted-foreground sm:inline">
            {alert.companyName ?? ""}
          </span>
          <span className={`text-[11px] font-medium ${verdictClasses(alert.verdict)}`}>
            {alert.verdict}
          </span>
          {taken ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
              <CircleCheck className="size-3.5" aria-hidden /> In My Trades
            </span>
          ) : null}
        </div>
        <div className="tabular mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span>Score {alert.score.toFixed(2)}</span>
          {Math.abs(alert.score) < 2.5 ? (
            <span
              className="font-medium text-amber-600 dark:text-amber-400"
              title="Cleared the 2.0 alert threshold but sits under 2.5 — the band where reversions are most common (59% within 3 sessions in the backtest). Treat it as the weakest grade that gets through."
            >
              thin conviction
            </span>
          ) : null}
          <span>Confidence {alert.confidence}%</span>
          {alert.priceAtAlert != null ? <span>At alert {fmtPrice(alert.priceAtAlert)}</span> : null}
          {quote ? <span>Now {fmtPrice(quote.price)}</span> : null}
          {drift != null ? (
            <span className={drift > 0 ? "font-medium text-emerald-600 dark:text-emerald-400" : drift < 0 ? "font-medium text-red-500 dark:text-red-400" : ""}>
              {fmtPct(drift)} since alert
            </span>
          ) : null}
          {drifted ? (
            <span className="font-medium">
              Signal now{" "}
              <span className={verdictClasses(nowVerdict!)}>{nowVerdict}</span>
            </span>
          ) : null}
          {(() => {
            const hist = historyFor(alert.symbol, alert.direction);
            if (!hist) return null;
            return (
              <span
                className="text-muted-foreground/80"
                title={`${hist.n} historical ${alert.direction.toLowerCase()} signals on ${alert.symbol} at a ${accuracy.horizonDays}-session horizon — measured, not a forecast.`}
              >
                hist {hist.winPct}% win · {hist.expR !== null && hist.expR >= 0 ? "+" : ""}
                {hist.expR}R
              </span>
            );
          })()}
          {chaseAtr != null ? (
            <span
              className={chasing ? "font-medium text-amber-600 dark:text-amber-400" : ""}
              title={
                chasing
                  ? `Price is ${chaseAtr.toFixed(2)} ATR past the alert price. A setup only counts near its trigger — entering here is chasing, not a fill at the level.`
                  : `Price is within ${CHASE_ATR_LIMIT} ATR of the alert price — still a valid fill zone.`
              }
            >
              {chasing
                ? `Chasing — ${chaseAtr.toFixed(2)} ATR past entry`
                : `${chaseAtr.toFixed(2)} ATR from entry`}
            </span>
          ) : null}
          <span>{fmtTimeAgo(alert.createdAt)}</span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
        {alert.status === "OPEN" && !blocked ? (
          <Button
            size="sm"
            className="h-8 text-xs"
            onClick={() => onOpenSymbol(alert.symbol)}
            title={
              chasing
                ? `Price is ${chaseAtr!.toFixed(2)} ATR past the alert price — you'd be entering late.`
                : undefined
            }
          >
            I Took This Trade
            {chasing ? <span aria-hidden className="ml-1 text-amber-500">!</span> : null}
          </Button>
        ) : null}
        {alert.status === "OPEN" && blocked ? (
          <span
            className="text-[11px] font-medium text-amber-600 dark:text-amber-400"
            title={`This alert fired on ${alert.verdict}. The signal has since moved to ${nowVerdict} — no setup to take. It will drop under "Faded to Neutral" on the next check.`}
          >
            Faded to {nowVerdict}
          </span>
        ) : null}
        {!taken ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground hover:text-destructive"
            aria-label={`Dismiss ${alert.symbol} alert`}
            disabled={dismissPending}
            onClick={() => onDismiss(alert.id)}
          >
            <X className="size-4" aria-hidden />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function TradeAlerts({ alerts, isLoading, quotesBySymbol, signalsBySymbol, onOpenSymbol }: TradeAlertsProps) {
  const queryClient = useQueryClient();

  const dismissMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch("/api/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) throw new Error("Dismiss failed");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["alerts"] });
      toast({ title: "Alert dismissed" });
    },
    onError: () => toast({ title: "Error", description: "Could not dismiss alert", variant: "destructive" }),
  });

  const groups = useMemo(
    () =>
      GROUPS.map((g) => ({
        ...g,
        items: (alerts ?? []).filter((a) => a.status === g.status),
      })),
    [alerts],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Trade Alerts</CardTitle>
        <CardDescription>
          Watched symbols that just turned Buy / Sell after Neutral — decide, then confirm under My Trades.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Measured accuracy of the engine behind these alerts. */}
        <details className="rounded-md border bg-muted/20 px-2.5 py-2 text-[11px] leading-relaxed">
          <summary className="cursor-pointer font-medium text-foreground">
            Measured accuracy — {" "}
            {(accuracy.overall.long.n + accuracy.overall.short.n).toLocaleString()} historical signals:
            longs {accuracy.overall.long.winPct ?? "—"}% hit / {accuracy.overall.long.expR ?? "—"}R ·
            shorts {accuracy.overall.short.winPct ?? "—"}% / {accuracy.overall.short.expR ?? "—"}R
          </summary>
          <p className="mt-1.5 text-muted-foreground">
            {accuracy.method} Over a {accuracy.horizonDays}-session horizon this is roughly a coin
            flip in R terms — score thresholds, a 200-day trend filter, different exit geometry and
            cross-sectional relative strength were each tested and none improved it out of sample.
            Treat the tab as a watchlist of where structure is stacking, not as a prediction.
          </p>
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3">
            {Object.entries(accuracy.bySymbol).map(([symbol, row]) => (
              <span key={symbol} className="tabular text-muted-foreground">
                <span className="font-medium text-foreground">{symbol}</span>{" "}
                L {row.long.winPct ?? "—"}%/{row.long.expR ?? "—"}R · S {row.short.winPct ?? "—"}%
                /{row.short.expR ?? "—"}R
              </span>
            ))}
          </div>
        </details>

        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : (alerts ?? []).length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
            <Bell className="size-6 text-muted-foreground" aria-hidden />
            <p className="text-sm font-medium">No alerts yet</p>
            <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
              We watch your watchlist around the clock. When a signal turns actionable
              (Buy / Sell after Neutral) it lands here with the full setup.
            </p>
          </div>
        ) : (
          groups.map(
            (g) =>
              g.items.length > 0 && (
                <section key={g.status} aria-label={g.title} className="space-y-2">
                  <div className="flex items-baseline justify-between">
                    <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-foreground">
                      {g.title}
                      <span className="ml-2 font-medium text-muted-foreground">{g.items.length}</span>
                    </h3>
                    <p className="hidden text-[11px] text-muted-foreground sm:block">{g.description}</p>
                  </div>
                  <div className="space-y-2">
                    {g.items.map((a) => (
                      <AlertRow
                        key={a.id}
                        alert={a}
                        quotesBySymbol={quotesBySymbol}
                        signalsBySymbol={signalsBySymbol}
                        onOpenSymbol={onOpenSymbol}
                        onDismiss={(id) => dismissMutation.mutate(id)}
                        dismissPending={dismissMutation.isPending}
                      />
                    ))}
                  </div>
                </section>
              ),
          )
        )}
      </CardContent>
    </Card>
  );
}
