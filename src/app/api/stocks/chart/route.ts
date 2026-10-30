import { NextRequest, NextResponse } from "next/server";
import { getChart, RANGE_OPTIONS, type RangeKey } from "@/lib/yahoo";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol")?.trim() ?? "";
  const range = (req.nextUrl.searchParams.get("range") ?? "1M") as RangeKey;

  if (!symbol) {
    return NextResponse.json({ error: "symbol is required" }, { status: 400 });
  }
  if (!(range in RANGE_OPTIONS)) {
    return NextResponse.json(
      { error: `range must be one of ${Object.keys(RANGE_OPTIONS).join(", ")}` },
      { status: 400 },
    );
  }
  try {
    const data = await getChart(symbol, range);
    return NextResponse.json(data);
  } catch (err) {
    console.error("chart route error:", err);
    return NextResponse.json({ error: "Failed to load chart data" }, { status: 502 });
  }
}
