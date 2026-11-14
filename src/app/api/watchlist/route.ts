import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Seeded per account on first load, so a fresh signup lands on something useful.
const DEFAULT_WATCHLIST = ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "GOOGL"];

const addSchema = z.object({
  symbol: z
    .string()
    .trim()
    .min(1)
    .max(15)
    .regex(/^[A-Za-z0-9^.\-=]+$/, "Invalid symbol"),
});

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  try {
    let items = await db.watchlistItem.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
    });
    if (items.length === 0) {
      for (const symbol of DEFAULT_WATCHLIST) {
        await db.watchlistItem.upsert({
          where: { userId_symbol: { userId: user.id, symbol } },
          update: {},
          create: { userId: user.id, symbol },
        });
      }
      items = await db.watchlistItem.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "asc" },
      });
    }
    return NextResponse.json({ items });
  } catch (err) {
    console.error("watchlist GET error:", err);
    return NextResponse.json({ error: "Failed to load watchlist" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  try {
    const body = await req.json();
    const parsed = addSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
    }
    const symbol = parsed.data.symbol.toUpperCase();
    const item = await db.watchlistItem.upsert({
      where: { userId_symbol: { userId: user.id, symbol } },
      update: {},
      create: { userId: user.id, symbol },
    });
    return NextResponse.json({ item }, { status: 201 });
  } catch (err) {
    console.error("watchlist POST error:", err);
    return NextResponse.json({ error: "Failed to add to watchlist" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  try {
    const symbol = req.nextUrl.searchParams.get("symbol")?.trim().toUpperCase() ?? "";
    if (!symbol) {
      return NextResponse.json({ error: "symbol query param is required" }, { status: 400 });
    }
    await db.watchlistItem.deleteMany({ where: { userId: user.id, symbol } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("watchlist DELETE error:", err);
    return NextResponse.json({ error: "Failed to remove from watchlist" }, { status: 500 });
  }
}
