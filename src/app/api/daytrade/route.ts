import { NextRequest, NextResponse } from "next/server";
import { getChart, getQuotes, getMarketStatus } from "@/lib/yahoo";
import { evaluateDayTrade, type DayTradeIdea, type DayTradeScan } from "@/lib/daytrade";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/daytrade — intraday scanner for liquid US stocks + major crypto.
 *
 * Only ideas that pass EVERY confluence check are returned as `ideas`. Symbols
 * that fail exactly one check come back as `nearMisses` so the page can show
 * how close the tape is without pretending those are tradeable.
 */

const STOCKS = [
  "AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "GOOGL", "META", "AMD",
  "NFLX", "ORCL", "CRM", "UBER", "PLTR", "COIN", "DIS", "INTC",
];

const CRYPTO = ["BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD", "DOGE-USD", "ADA-USD", "AVAX-USD", "LINK-USD"];

const CONCURRENCY = 4;

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  const debug = req.nextUrl.searchParams.get("debug") === "1";

  try {
    const symbols = [...STOCKS, ...CRYPTO];

    // Intraday candles drive the setup; daily candles give trend + volume context.
    const evaluated = await mapLimited(symbols, CONCURRENCY, async (symbol) => {
      try {
        const [intraday, daily] = await Promise.all([
          getChart(symbol, "1D"),
          getChart(symbol, "6M"),
        ]);
        const quote = await getQuotes([symbol]);
        return evaluateDayTrade({
          symbol,
          name: quote[0]?.shortName ?? symbol,
          kind: symbol.includes("-USD") ? "crypto" : "stock",
          intraday: intraday.points,
          daily: daily.points,
        });
      } catch {
        return null; // one bad symbol must not kill the scan
      }
    });

    const judged = evaluated.filter((r): r is DayTradeIdea => r !== null);
    const ideas = judged
      .filter((i) => i.passed === i.total)
      .sort((a, b) => (b.relVolume ?? 0) - (a.relVolume ?? 0));

    const nearMisses = judged
      .filter((i) => i.passed === i.total - 1)
      .sort((a, b) => (b.relVolume ?? 0) - (a.relVolume ?? 0))
      .slice(0, 3);

    const payload: DayTradeScan & { ms: number; scannedCount: number; all?: unknown } = {
      ideas,
      nearMisses,
      scanned: judged.length,
      skipped: symbols.length - judged.length,
      marketOpen: getMarketStatus().open,
      updatedAt: Date.now(),
      ms: Date.now() - startedAt,
      scannedCount: symbols.length,
      // ?debug=1 → every judged symbol, so thresholds can be inspected.
      ...(debug
        ? {
            all: judged
              .sort((a, b) => b.passed - a.passed)
              .map((i) => ({
                symbol: i.symbol,
                direction: i.direction,
                passed: i.passed,
                failed: i.checks.filter((c) => !c.pass).map((c) => c.label),
              })),
          }
        : {}),
    };

    return NextResponse.json(payload, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.error("daytrade scan error:", err);
    return NextResponse.json({ error: "Scan failed" }, { status: 502 });
  }
}
