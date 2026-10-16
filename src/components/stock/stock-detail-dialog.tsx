"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PriceChart } from "@/components/stock/price-chart";
import { TradeSetupPanel } from "@/components/stock/trade-setup-panel";
import { fmtChange, fmtCompact, fmtPct, fmtPrice } from "@/lib/format";
import {
  RANGE_TABS,
  type ChartResponse,
  type Quote,
  type RangeTab,
} from "@/lib/stock-types";

async function fetchChart(symbol: string, range: RangeTab): Promise<ChartResponse> {
  const res = await fetch(`/api/stocks/chart?symbol=${encodeURIComponent(symbol)}&range=${range}`);
  if (!res.ok) throw new Error("Failed to load chart");
  return res.json();
}

async function fetchQuote(symbol: string): Promise<Quote | null> {
  const res = await fetch(`/api/stocks/quotes?symbols=${encodeURIComponent(symbol)}`);
  if (!res.ok) throw new Error("Failed to load quote");
  const json = await res.json();
  return (json.quotes?.[0] as Quote | null) ?? null;
}

interface StockDetailDialogProps {
  symbol: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  watched: boolean;
  onToggleWatch: (symbol: string, watched: boolean) => void;
}

export function StockDetailDialog({
  symbol,
  open,
  onOpenChange,
  watched,
  onToggleWatch,
}: StockDetailDialogProps) {
  const queryClient = useQueryClient();
  const [range, setRange] = useState<RangeTab>("1M");

  const quoteQuery = useQuery({
    queryKey: ["quote", symbol],
    queryFn: () => fetchQuote(symbol as string),
    enabled: open && !!symbol,
    refetchInterval: 30_000,
  });

  const chartQuery = useQuery({
    queryKey: ["chart", symbol, range],
    queryFn: () => fetchChart(symbol as string, range),
    enabled: open && !!symbol,
    placeholderData: (prev) => prev,
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ sym, isWatched }: { sym: string; isWatched: boolean }) => {
      if (isWatched) {
        const res = await fetch(`/api/watchlist?symbol=${encodeURIComponent(sym)}`, {
          method: "DELETE",
        });
        if (!res.ok) throw new Error("Remove failed");
      } else {
        const res = await fetch("/api/watchlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol: sym }),
        });
        if (!res.ok) throw new Error("Add failed");
      }
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["watchlist"] });
      toast({
        title: vars.isWatched ? "Removed from watchlist" : "Added to watchlist",
        description: vars.sym,
      });
    },
    onError: (_err, vars) => {
      toast({
        title: "Error",
        description: `Could not update watchlist for ${vars.sym}`,
        variant: "destructive",
      });
    },
  });

  const quote = quoteQuery.data;
  const chart = chartQuery.data;
  const up = (quote?.change ?? chart?.points?.[0]?.c ?? 0) >= 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <div className="flex flex-wrap items-start justify-between gap-3 pr-6">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <DialogTitle className="text-2xl font-bold tracking-tight">{symbol}</DialogTitle>
                {quote?.exchange ? (
                  <Badge variant="secondary" className="text-[10px]">
                    {quote.exchange}
                  </Badge>
                ) : null}
              </div>
              <DialogDescription className="truncate">
                {quote?.longName ?? quote?.shortName ?? "Loading…"}
              </DialogDescription>
            </div>
            {symbol ? (
              <Button
                size="sm"
                variant={watched ? "secondary" : "default"}
                disabled={toggleMutation.isPending}
                onClick={() => onToggleWatch(symbol, watched)}
                className="gap-1.5"
              >
                {toggleMutation.isPending ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                ) : watched ? (
                  <EyeOff className="size-3.5" aria-hidden />
                ) : (
                  <Eye className="size-3.5" aria-hidden />
                )}
                {watched ? "Unwatch" : "Watch"}
              </Button>
            ) : null}
          </div>
        </DialogHeader>

        {/* Price header */}
        {quoteQuery.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-9 w-40" />
            <Skeleton className="h-5 w-28" />
          </div>
        ) : quote ? (
          <div>
            <div className="tabular text-3xl font-bold tracking-tight">{fmtPrice(quote.price)}</div>
            <div className={`tabular text-sm font-medium ${up ? "text-emerald-500 dark:text-emerald-400" : "text-red-500 dark:text-red-400"}`}>
              {fmtChange(quote.change)} ({fmtPct(quote.changePercent)})
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Quote unavailable.</p>
        )}

        {/* Chart + range tabs */}
        <div>
          {chartQuery.isLoading ? (
            <Skeleton className="h-64 w-full sm:h-72" />
          ) : chart && chart.points.length > 1 ? (
            <PriceChart
              points={chart.points}
              range={range}
              up={(chart.points[chart.points.length - 1]?.c ?? 0) >= chart.previousClose}
            />
          ) : (
            <div className="flex h-64 items-center justify-center rounded-md border text-sm text-muted-foreground sm:h-72">
              Chart data unavailable
            </div>
          )}
          <Tabs
            value={range}
            onValueChange={(v) => setRange(v as RangeTab)}
            className="mt-3"
          >
            <TabsList className="grid h-9 w-full grid-cols-6">
              {RANGE_TABS.map((r) => (
                <TabsTrigger key={r} value={r} className="px-0 text-xs">
                  {r}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        <Separator />

        {/* Key stats */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
          <Stat label="Prev Close" value={fmtPrice(quote?.previousClose)} />
          <Stat label="Day High" value={fmtPrice(quote?.dayHigh)} />
          <Stat label="Day Low" value={fmtPrice(quote?.dayLow)} />
          <Stat label="Volume" value={quote?.volume != null ? fmtCompact(quote.volume) : "—"} />
          <Stat label="52W High" value={fmtPrice(quote?.yearHigh)} />
          <Stat label="52W Low" value={fmtPrice(quote?.yearLow)} />
        </div>

        <Separator />

        {/* Trade signal & setup */}
        <section aria-label="Trade signal and setup">
          {symbol ? <TradeSetupPanel symbol={symbol} /> : null}
        </section>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="tabular text-sm font-semibold">{value}</div>
    </div>
  );
}
