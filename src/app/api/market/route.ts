import { NextResponse } from "next/server";
import { getQuotes, getMarketStatus } from "@/lib/yahoo";

export const dynamic = "force-dynamic";

/** Symbols shown in the top market strip. */
const INDICES = ["^GSPC", "^IXIC", "^DJI", "^VIX", "BTC-USD", "GC=F"];

/** Universe used to compute top gainers / losers. */
const UNIVERSE = [
  "AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "GOOGL", "META", "NFLX", "AMD", "INTC",
  "JPM", "V", "WMT", "XOM", "KO", "DIS", "BABA", "PFE", "CRM", "ORCL",
];

export async function GET() {
  try {
    const [indexQuotes, universeQuotes] = await Promise.all([
      getQuotes(INDICES),
      getQuotes(UNIVERSE),
    ]);

    const valid = universeQuotes.filter((q): q is NonNullable<typeof q> => q !== null);
    const byChange = [...valid].sort((a, b) => b.changePercent - a.changePercent);

    const display = (name: string, symbol: string) => name.replace(/\s*\(.*\)\s*$/, "") || symbol;

    return NextResponse.json({
      indices: indexQuotes.map((q, i) =>
        q ? { ...q, shortName: display(q.shortName, INDICES[i]) } : null,
      ),
      movers: {
        gainers: byChange.slice(0, 5),
        losers: byChange.slice(-5).reverse(),
      },
      status: getMarketStatus(),
      updatedAt: Date.now(),
    });
  } catch (err) {
    console.error("market route error:", err);
    return NextResponse.json({ error: "Failed to load market data" }, { status: 502 });
  }
}
