import { NextRequest, NextResponse } from "next/server";
import { getChart } from "@/lib/yahoo";
import { computeSignal, toSummary } from "@/lib/signals";
import { detectSignalAlerts } from "@/lib/alerts";
import type { SignalSummary } from "@/lib/stock-types";

export const dynamic = "force-dynamic";

const CACHE_TTL_MS = 5 * 60 * 1000;
const summaryCache = new Map<string, { at: number; data: SignalSummary }>();

async function summarize(symbol: string): Promise<SignalSummary> {
  const key = symbol.toUpperCase();
  const hit = summaryCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  const chart = await getChart(key, "6M");
  const result = computeSignal(chart);
  const summary = toSummary(result);
  summaryCache.set(key, { at: Date.now(), data: summary });
  return summary;
}

/**
 * GET /api/stocks/signals?symbol=AAPL          -> full detailed signal + trade setup
 * GET /api/stocks/signals?symbols=A,B,C        -> lightweight summaries (for tables)
 */
export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol")?.trim();
  const symbolsParam = req.nextUrl.searchParams.get("symbols")?.trim();

  try {
    if (symbol) {
      const chart = await getChart(symbol.toUpperCase(), "6M");
      return NextResponse.json(computeSignal(chart));
    }

    if (symbolsParam) {
      const symbols = symbolsParam
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
        .slice(0, 40);
      const settled = await Promise.allSettled(symbols.map((s) => summarize(s)));
      const signalList = settled.map((r, i) =>
        r.status === "fulfilled"
          ? r.value
          : { symbol: symbols[i], verdict: "Neutral", score: 0, confidence: 0, trend: "Sideways", rsi: null },
      );

      // Detect Neutral -> actionable transitions / direction flips for watched
      // symbols and persist Trade Alerts. Runs on real (non-error) results only
      // so a transient Yahoo failure can't stale-out healthy alerts.
      await detectSignalAlerts(
        settled
          .map((r) => (r.status === "fulfilled" ? r.value : null))
          .filter((s): s is NonNullable<typeof s> => s !== null)
          .map((s) => ({ symbol: s.symbol, verdict: s.verdict, score: s.score, confidence: s.confidence })),
      );

      return NextResponse.json({ signals: signalList });
    }

    return NextResponse.json(
      { error: "Provide ?symbol=SYM for detail or ?symbols=A,B,C for summaries" },
      { status: 400 },
    );
  } catch (err) {
    console.error("signals route error:", err);
    return NextResponse.json({ error: "Failed to compute signals" }, { status: 502 });
  }
}
