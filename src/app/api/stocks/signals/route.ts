import { NextRequest, NextResponse } from "next/server";
import { getChart } from "@/lib/yahoo";
import { computeSignal, toSummary } from "@/lib/signals";

export const dynamic = "force-dynamic";

const CACHE_TTL_MS = 5 * 60 * 1000;
const summaryCache = new Map<string, { at: number; data: unknown }>();

async function summarize(symbol: string) {
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
      return NextResponse.json({
        signals: settled.map((r, i) =>
          r.status === "fulfilled"
            ? r.value
            : { symbol: symbols[i], verdict: "Neutral", score: 0, confidence: 0, trend: "Sideways", rsi: null },
        ),
      });
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
