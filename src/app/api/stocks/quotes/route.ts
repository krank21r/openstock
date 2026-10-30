import { NextRequest, NextResponse } from "next/server";
import { getQuotes } from "@/lib/yahoo";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const symbolsParam = req.nextUrl.searchParams.get("symbols") ?? "";
  const symbols = symbolsParam.split(",").map((s) => s.trim()).filter(Boolean);
  if (symbols.length === 0) {
    return NextResponse.json({ quotes: [] });
  }
  try {
    const quotes = await getQuotes(symbols);
    return NextResponse.json({
      quotes,
      errors: quotes
        .map((q, i) => (q === null ? symbols[i] : null))
        .filter((s): s is string => s !== null),
    });
  } catch (err) {
    console.error("quotes route error:", err);
    return NextResponse.json({ error: "Failed to load quotes" }, { status: 502 });
  }
}
