"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownRight,
  ArrowUpRight,
  Clock,
  RefreshCw,
  X,
} from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SearchCombobox } from "@/components/stock/search-combobox";
import { MyTrades } from "@/components/stock/my-trades";
import { Sparkline } from "@/components/stock/sparkline";
import { StockDetailDialog } from "@/components/stock/stock-detail-dialog";
import { ThemeToggle } from "@/components/stock/theme-toggle";
import { verdictClasses } from "@/components/stock/trade-setup-panel";
import { fmtChange, fmtClock, fmtPct, fmtPrice } from "@/lib/format";
import type {
  MarketResponse,
  Quote,
  SignalSummary,
  WatchlistItem,
} from "@/lib/stock-types";

const INDEX_LABELS: Record<string, string> = {
  "^GSPC": "S&P 500",
  "^IXIC": "Nasdaq",
  "^DJI": "Dow Jones",
  "^VIX": "VIX",
  "BTC-USD": "Bitcoin",
  "GC=F": "Gold",
};

const changeColor = (v: number) =>
  v > 0
    ? "text-emerald-500 dark:text-emerald-400"
    : v < 0
      ? "text-red-500 dark:text-red-400"
      : "text-muted-foreground";

async function fetchMarket(): Promise<MarketResponse> {
  const res = await fetch("/api/market");
  if (!res.ok) throw new Error("Market data failed");
  return res.json();
}

async function fetchWatchlist(): Promise<WatchlistItem[]> {
  const res = await fetch("/api/watchlist");
  if (!res.ok) throw new Error("Watchlist failed");
  const json = await res.json();
  return json.items ?? [];
}

async function fetchQuotes(symbols: string[]): Promise<Quote[]> {
  if (symbols.length === 0) return [];
  const res = await fetch(`/api/stocks/quotes?symbols=${encodeURIComponent(symbols.join(","))}`);
  if (!res.ok) throw new Error("Quotes failed");
  const json = await res.json();
  return (json.quotes ?? []).filter((q: Quote | null): q is Quote => q !== null);
}

async function fetchSignalSummaries(symbols: string[]): Promise<SignalSummary[]> {
  if (symbols.length === 0) return [];
  const res = await fetch(`/api/stocks/signals?symbols=${encodeURIComponent(symbols.join(","))}`);
  if (!res.ok) throw new Error("Signals failed");
  const json = await res.json();
  return json.signals ?? [];
}

export default function OpenStockPage() {
  const queryClient = useQueryClient();
  const [detailSymbol, setDetailSymbol] = useState<string | null>(null);
  const [moversTab, setMoversTab] = useState<"gainers" | "losers">("gainers");

  // ---------------- Data ----------------
  const marketQuery = useQuery({
    queryKey: ["market"],
    queryFn: fetchMarket,
    refetchInterval: 60_000,
  });

  const watchlistQuery = useQuery({
    queryKey: ["watchlist"],
    queryFn: fetchWatchlist,
  });

  const watchSymbols = useMemo(
    () => watchlistQuery.data?.map((w) => w.symbol) ?? [],
    [watchlistQuery.data],
  );

  const quotesQuery = useQuery({
    queryKey: ["quotes", watchSymbols],
    queryFn: () => fetchQuotes(watchSymbols),
    enabled: watchSymbols.length > 0,
    refetchInterval: 30_000,
  });

  const quotesBySymbol = useMemo(() => {
    const map = new Map<string, Quote>();
    for (const q of quotesQuery.data ?? []) map.set(q.symbol, q);
    return map;
  }, [quotesQuery.data]);

  const signalsQuery = useQuery({
    queryKey: ["signals", watchSymbols],
    queryFn: () => fetchSignalSummaries(watchSymbols),
    enabled: watchSymbols.length > 0,
    refetchInterval: 5 * 60_000,
  });

  const signalsBySymbol = useMemo(() => {
    const map = new Map<string, SignalSummary>();
    for (const s of signalsQuery.data ?? []) map.set(s.symbol, s);
    return map;
  }, [signalsQuery.data]);

  // ---------------- Mutations ----------------
  const addMutation = useMutation({
    mutationFn: async (symbol: string) => {
      const res = await fetch("/api/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol }),
      });
      if (!res.ok) throw new Error("Add failed");
      return symbol;
    },
    onSuccess: (symbol) => {
      queryClient.invalidateQueries({ queryKey: ["watchlist"] });
      toast({ title: "Added to watchlist", description: symbol });
    },
    onError: () =>
      toast({ title: "Error", description: "Could not add symbol", variant: "destructive" }),
  });

  const removeMutation = useMutation({
    mutationFn: async (symbol: string) => {
      const res = await fetch(`/api/watchlist?symbol=${encodeURIComponent(symbol)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Remove failed");
      return symbol;
    },
    onSuccess: (symbol) => {
      queryClient.invalidateQueries({ queryKey: ["watchlist"] });
      toast({ title: "Removed from watchlist", description: symbol });
    },
    onError: () =>
      toast({ title: "Error", description: "Could not remove symbol", variant: "destructive" }),
  });

  const toggleWatch = (symbol: string, watched: boolean) => {
    if (watched) removeMutation.mutate(symbol);
    else addMutation.mutate(symbol);
  };

  const refreshAll = () => {
    queryClient.invalidateQueries({ queryKey: ["market"] });
    queryClient.invalidateQueries({ queryKey: ["quotes"] });
    toast({ title: "Refreshing", description: "Fetching the latest market data…" });
  };

  const market = marketQuery.data;
  const movers = market?.movers;
  const status = market?.status;

  return (
    <div className="flex min-h-screen flex-col">
      {/* ---------------- Header ---------------- */}
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4">
          <a href="/" className="flex shrink-0 items-center gap-2" aria-label="OpenStock home">
            <span className="text-base font-semibold tracking-tight">OpenStock</span>
            <span className="mt-0.5 hidden text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground sm:block">
              Tracker
            </span>
          </a>
          <div className="ml-auto flex flex-1 items-center justify-end gap-2 sm:flex-none">
            <SearchCombobox onSelectSymbol={setDetailSymbol} watchSymbols={watchSymbols} />
            {status ? (
              <span
                className={`hidden items-center gap-1.5 text-xs font-medium md:inline-flex ${status.open ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}
              >
                <span
                  className={`size-1.5 rounded-full ${status.open ? "animate-pulse bg-emerald-500" : "bg-muted-foreground/50"}`}
                  aria-hidden
                />
                {status.label}
              </span>
            ) : null}
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* ---------------- Main ---------------- */}
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        {/* Indices strip */}
        <section aria-label="Market indices" className="mb-6">
          {marketQuery.isLoading ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 xl:grid-cols-6">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-[64px]" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 xl:grid-cols-6">
              {(market?.indices ?? []).map((q, i) =>
                q ? (
                  <button
                    key={q.symbol}
                    type="button"
                    onClick={() => setDetailSymbol(q.symbol)}
                    className="text-left transition-opacity hover:opacity-70 focus-visible:outline-2 focus-visible:outline-ring"
                    aria-label={`${INDEX_LABELS[q.symbol] ?? q.shortName}: ${fmtPrice(q.price)}, ${fmtPct(q.changePercent)}`}
                  >
                    <div className="truncate text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                      {INDEX_LABELS[q.symbol] ?? q.shortName}
                    </div>
                    <div className="tabular mt-1 text-lg font-semibold leading-tight">
                      {fmtPrice(q.price)}
                    </div>
                    <div className={`tabular mt-0.5 text-xs font-medium ${changeColor(q.changePercent)}`}>
                      {fmtPct(q.changePercent)}
                    </div>
                  </button>
                ) : (
                  <Skeleton key={`idx-${i}`} className="h-[64px]" />
                ),
              )}
            </div>
          )}
        </section>

        <div className="grid gap-6 lg:grid-cols-3">
          {/* Watchlist */}
          <Card className="lg:col-span-2">
            <CardHeader className="flex flex-row items-start justify-between space-y-0">
              <div>
                <CardTitle>Watchlist</CardTitle>
                <CardDescription>
                  {watchSymbols.length} symbol{watchSymbols.length === 1 ? "" : "s"} · prices update
                  every 30s
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={refreshAll}
                disabled={quotesQuery.isFetching || marketQuery.isFetching}
                className="gap-1.5"
                aria-label="Refresh quotes"
              >
                <RefreshCw
                  className={`size-3.5 ${quotesQuery.isFetching ? "animate-spin" : ""}`}
                  aria-hidden
                />
                Refresh
              </Button>
            </CardHeader>
            <CardContent>
              {watchlistQuery.isLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-12 w-full" />
                  ))}
                </div>
              ) : watchSymbols.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
                  <p className="text-sm font-medium">Your watchlist is empty</p>
                  <p className="text-xs text-muted-foreground">
                    Use the search above to add stocks you want to track.
                  </p>
                </div>
              ) : quotesQuery.isLoading ? (
                <div className="space-y-2">
                  {watchSymbols.map((s) => (
                    <Skeleton key={s} className="h-12 w-full" />
                  ))}
                </div>
              ) : (
                <>
                  {/* Desktop table */}
                  <div className="hidden max-h-[460px] overflow-y-auto md:block">
                    <Table>
                      <TableHeader className="sticky top-0 z-10 bg-card">
                        <TableRow>
                          <TableHead>Symbol</TableHead>
                          <TableHead className="text-right">Price</TableHead>
                          <TableHead className="text-right">Change</TableHead>
                          <TableHead className="text-center">Signal</TableHead>
                          <TableHead className="text-center">Trend (1D)</TableHead>
                          <TableHead className="w-10" aria-label="Actions" />
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {watchSymbols.map((sym) => {
                          const q = quotesBySymbol.get(sym);
                          return (
                            <TableRow
                              key={sym}
                              className="cursor-pointer"
                              onClick={() => setDetailSymbol(sym)}
                            >
                              <TableCell>
                                <div className="font-semibold">{sym}</div>
                                <div className="max-w-[180px] truncate text-xs text-muted-foreground">
                                  {q?.longName ?? q?.shortName ?? "—"}
                                </div>
                              </TableCell>
                              <TableCell className="tabular text-right font-medium">
                                {q ? fmtPrice(q.price) : "—"}
                              </TableCell>
                              <TableCell className="text-right">
                                {q ? (
                                  <span
                                    className={`tabular text-xs font-medium ${changeColor(q.changePercent)}`}
                                  >
                                    {fmtPct(q.changePercent)}
                                  </span>
                                ) : (
                                  "—"
                                )}
                              </TableCell>
                              <TableCell className="text-center">
                                {(() => {
                                  const sig = signalsBySymbol.get(sym);
                                  if (!sig) return <span className="text-xs text-muted-foreground">—</span>;
                                  return (
                                    <span
                                      className={`text-[11px] font-medium ${verdictClasses(sig.verdict)}`}
                                      title={`Score ${sig.score} · confidence ${sig.confidence}%`}
                                    >
                                      {sig.verdict}
                                    </span>
                                  );
                                })()}
                              </TableCell>
                              <TableCell className="text-center">
                                {q && q.spark.length > 1 ? (
                                  <div className="flex justify-center">
                                    <Sparkline data={q.spark} up={q.changePercent >= 0} />
                                  </div>
                                ) : (
                                  <span className="text-xs text-muted-foreground">—</span>
                                )}
                              </TableCell>
                              <TableCell onClick={(e) => e.stopPropagation()}>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-8 text-muted-foreground hover:text-destructive"
                                  aria-label={`Remove ${sym} from watchlist`}
                                  disabled={removeMutation.isPending}
                                  onClick={() => removeMutation.mutate(sym)}
                                >
                                  <X className="size-4" aria-hidden />
                                </Button>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>

                  {/* Mobile cards */}
                  <div className="grid max-h-[460px] gap-2 overflow-y-auto md:hidden">
                    {watchSymbols.map((sym) => {
                      const q = quotesBySymbol.get(sym);
                      return (
                        <div
                          key={sym}
                          role="button"
                          tabIndex={0}
                          onClick={() => setDetailSymbol(sym)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") setDetailSymbol(sym);
                          }}
                          className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border p-3 transition-colors hover:bg-accent/60"
                        >
                          <div className="min-w-0">
                            <div className="font-semibold">{sym}</div>
                            <div className="max-w-[140px] truncate text-xs text-muted-foreground">
                              {q?.longName ?? q?.shortName ?? "—"}
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="tabular font-medium">{q ? fmtPrice(q.price) : "—"}</div>
                            {q ? (
                              <div className={`tabular text-xs font-semibold ${changeColor(q.changePercent)}`}>
                                {fmtPct(q.changePercent)}
                              </div>
                            ) : null}
                            {(() => {
                              const sig = signalsBySymbol.get(sym);
                              return sig ? (
                                <span
                                  className={`mt-1 inline-block text-[10px] font-medium ${verdictClasses(sig.verdict)}`}
                                >
                                  {sig.verdict}
                                </span>
                              ) : null;
                            })()}
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
                            aria-label={`Remove ${sym} from watchlist`}
                            onClick={(e) => {
                              e.stopPropagation();
                              removeMutation.mutate(sym);
                            }}
                          >
                            <X className="size-4" aria-hidden />
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
              {quotesQuery.data && quotesQuery.data.length === 0 && watchSymbols.length > 0 ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  Some quotes could not be loaded. Check the symbols and try refreshing.
                </p>
              ) : null}
            </CardContent>
          </Card>

          {/* Movers */}
          <div className="flex flex-col gap-6">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle>Top Movers</CardTitle>
                <CardDescription>Today&apos;s biggest swings in the large-cap universe</CardDescription>
              </CardHeader>
              <CardContent>
                <Tabs
                  value={moversTab}
                  onValueChange={(v) => setMoversTab(v as "gainers" | "losers")}
                >
                  <TabsList className="mb-2 h-8 w-full justify-start gap-5 rounded-none border-b bg-transparent p-0">
                    <TabsTrigger
                      value="gainers"
                      className="rounded-none border-0 border-b-2 px-0 pb-2 text-xs data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                    >
                      Gainers
                    </TabsTrigger>
                    <TabsTrigger
                      value="losers"
                      className="rounded-none border-0 border-b-2 px-0 pb-2 text-xs data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                    >
                      Losers
                    </TabsTrigger>
                  </TabsList>
                  {marketQuery.isLoading ? (
                    <div className="space-y-2">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Skeleton key={i} className="h-11 w-full" />
                      ))}
                    </div>
                  ) : (
                    <ul className="space-y-1" aria-label={moversTab === "gainers" ? "Top gainers" : "Top losers"}>
                      {(movers?.[moversTab] ?? []).map((q) => (
                        <li key={q.symbol}>
                          <button
                            type="button"
                            onClick={() => setDetailSymbol(q.symbol)}
                            className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent/60 focus-visible:outline-2 focus-visible:outline-ring"
                          >
                            <div className="min-w-0">
                              <span className="font-semibold">{q.symbol}</span>
                              <span className="ml-2 hidden max-w-[130px] truncate align-middle text-xs text-muted-foreground sm:inline-block">
                                {q.shortName}
                              </span>
                            </div>
                            <div className="flex shrink-0 items-center gap-2.5">
                              <span className="tabular text-sm font-medium">{fmtPrice(q.price)}</span>
                              <span className={`tabular w-14 text-right text-xs font-medium ${changeColor(q.changePercent)}`}>
                                {fmtPct(q.changePercent)}
                              </span>
                            </div>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </Tabs>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Market Status</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">US Equities</span>
                  {status ? (
                    <span
                      className={`inline-flex items-center gap-1.5 text-xs font-medium ${status.open ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}
                    >
                      <span
                        className={`size-1.5 rounded-full ${status.open ? "animate-pulse bg-emerald-500" : "bg-muted-foreground/50"}`}
                        aria-hidden
                      />
                      {status.label}
                    </span>
                  ) : (
                    <Skeleton className="h-5 w-24" />
                  )}
                </div>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <Clock className="size-3.5" aria-hidden /> Last updated
                  </span>
                  <span className="tabular text-xs">
                    {market ? fmtClock(market.updatedAt) : "—"}
                  </span>
                </div>
                <p className="pt-1 text-xs leading-relaxed text-muted-foreground">
                  Quotes are delayed and provided by Yahoo Finance&apos;s public API. For
                  information only — not investment advice.
                </p>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* My Trades (tracked positions with TP/SL status) */}
        <section aria-label="My tracked trades" className="mt-6">
          <MyTrades onOpenSymbol={setDetailSymbol} />
        </section>
      </main>

      {/* ---------------- Footer (sticky bottom) ---------------- */}
      <footer className="mt-auto border-t bg-background">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-2 px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-xs text-muted-foreground sm:flex-row">
          <p>
            <span className="font-medium text-foreground">OpenStock</span> — open-source stock
            tracker
          </p>
          <p>Data: Yahoo Finance (delayed) · Not investment advice</p>
        </div>
      </footer>

      {/* ---------------- Detail dialog ---------------- */}
      <StockDetailDialog
        symbol={detailSymbol}
        open={detailSymbol !== null}
        onOpenChange={(o) => {
          if (!o) setDetailSymbol(null);
        }}
        watched={detailSymbol ? watchSymbols.includes(detailSymbol) : false}
        onToggleWatch={toggleWatch}
      />
    </div>
  );
}
