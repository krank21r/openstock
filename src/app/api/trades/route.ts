import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getChart, getQuotes } from "@/lib/yahoo";
import { computeSignal } from "@/lib/signals";
import { evaluateTrade, type TradeStatus } from "@/lib/trade-status";
import type { TrackedTradeView } from "@/lib/stock-types";
import type { TrackedTrade } from "@prisma/client";

export const dynamic = "force-dynamic";

const ACTIVE: TradeStatus[] = ["OPEN", "TP1_HIT"];

function toView(t: TrackedTrade, extra?: TrackedTradeViewOverrides): TrackedTradeView {
  const status = (extra?.status ?? t.status) as TradeStatus;
  const pnlAtClosePct =
    status === "TP2_HIT"
      ? t.direction === "Long"
        ? ((t.target2 - t.entryPrice) / t.entryPrice) * 100
        : ((t.entryPrice - t.target2) / t.entryPrice) * 100
      : status === "SL_HIT"
        ? t.direction === "Long"
          ? ((t.stopLoss - t.entryPrice) / t.entryPrice) * 100
          : ((t.entryPrice - t.stopLoss) / t.entryPrice) * 100
        : null;

  return {
    id: t.id,
    symbol: t.symbol,
    companyName: t.companyName,
    direction: t.direction as "Long" | "Short",
    entryPrice: t.entryPrice,
    stopLoss: t.stopLoss,
    target1: t.target1,
    target2: t.target2,
    riskReward: t.riskReward,
    riskLevel: t.riskLevel,
    confidence: t.confidence,
    verdict: t.verdict,
    status,
    hitTp1: extra?.hitTp1 ?? t.hitTp1,
    currentPrice: extra?.currentPrice ?? t.lastPrice ?? null,
    pnlPct: extra?.pnlPct ?? t.pnlPct ?? null,
    pnlAtClosePct: pnlAtClosePct != null ? Math.round(pnlAtClosePct * 100) / 100 : null,
    progressPct: extra?.progressPct ?? null,
    highWater: extra?.highWater ?? t.highWater ?? null,
    lowWater: extra?.lowWater ?? t.lowWater ?? null,
    openedAt: t.openedAt.toISOString(),
    closedAt: (extra?.closedAt ?? t.closedAt)?.toISOString() ?? null,
    hitTp1At: (extra?.hitTp1At ?? t.hitTp1At)?.toISOString() ?? null,
    closedReason: extra?.closedReason ?? t.closedReason ?? null,
    message: extra?.message ?? "",
  };
}

interface TrackedTradeViewOverrides {
  currentPrice?: number | null;
  pnlPct?: number | null;
  progressPct?: number | null;
  status?: TradeStatus;
  hitTp1?: boolean;
  closedAt?: Date | null;
  hitTp1At?: Date | null;
  closedReason?: string | null;
  message?: string;
  highWater?: number | null;
  lowWater?: number | null;
}

function levelsOf(t: TrackedTrade) {
  return {
    direction: t.direction as "Long" | "Short",
    entryPrice: t.entryPrice,
    stopLoss: t.stopLoss,
    target1: t.target1,
    target2: t.target2,
  };
}

/**
 * GET /api/trades — list tracked trades.
 * Active trades are re-evaluated against fresh daily candles + live price;
 * terminal states (TP2 / SL) are persisted once and served from DB afterwards.
 */
export async function GET() {
  try {
    const trades = await db.trackedTrade.findMany({
      orderBy: { openedAt: "desc" },
      take: 50,
    });

    const active = trades.filter((t) => ACTIVE.includes(t.status as TradeStatus));
    const symbols = [...new Set(active.map((t) => t.symbol))];

    // Fetch charts + quotes for all active symbols in parallel.
    const chartResults = await Promise.allSettled(
      symbols.map((s) => getChart(s, "6M")),
    );
    const quoteResults = await Promise.allSettled([getQuotes(symbols)]);
    const chartBySymbol = new Map<string, Awaited<ReturnType<typeof getChart>>>();
    chartResults.forEach((r, i) => {
      if (r.status === "fulfilled") chartBySymbol.set(symbols[i], r.value);
    });
    const priceBySymbol = new Map<string, number>();
    if (quoteResults[0].status === "fulfilled") {
      for (const q of quoteResults[0].value) {
        if (q && q.price > 0) priceBySymbol.set(q.symbol, q.price);
      }
    }

    const views: TrackedTradeView[] = [];
    for (const t of trades) {
      if (!ACTIVE.includes(t.status as TradeStatus)) {
        views.push(toView(t));
        continue;
      }

      const chart = chartBySymbol.get(t.symbol);
      const ev = evaluateTrade(
        levelsOf(t),
        chart ? chart.points : [],
        t.openedAt.getTime(),
        priceBySymbol.get(t.symbol) ?? null,
      );

      const updated = await db.trackedTrade.update({
        where: { id: t.id },
        data: {
          status: ev.status,
          hitTp1: ev.hitTp1,
          lastPrice: ev.currentPrice,
          pnlPct: ev.pnlPct,
          progressPct: ev.progressPct,
          highWater: ev.highWater,
          lowWater: ev.lowWater,
          hitTp1At: ev.hitTp1At ? new Date(ev.hitTp1At) : t.hitTp1At,
          closedAt: ev.closedAt ? new Date(ev.closedAt) : t.closedAt,
          closedReason: ev.closedReason ?? t.closedReason,
        },
      });

      views.push(
        toView(updated, {
          currentPrice: ev.currentPrice,
          pnlPct: ev.pnlPct,
          progressPct: ev.progressPct,
          status: ev.status,
          hitTp1: ev.hitTp1,
          closedAt: ev.closedAt ? new Date(ev.closedAt) : null,
          hitTp1At: ev.hitTp1At ? new Date(ev.hitTp1At) : null,
          closedReason: ev.closedReason,
          message: ev.message,
          highWater: ev.highWater,
          lowWater: ev.lowWater,
        }),
      );
    }

    return NextResponse.json({ trades: views });
  } catch (err) {
    console.error("GET /api/trades error:", err);
    return NextResponse.json({ error: "Failed to load trades" }, { status: 500 });
  }
}

/**
 * POST /api/trades — confirm "I took this trade".
 * Body: { symbol }. Levels come from the CURRENT signal setup for that symbol.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const parsed = z
      .object({ symbol: z.string().trim().min(1).max(12) })
      .safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }
    const symbol = parsed.data.symbol.toUpperCase();

    // Reject duplicates — one active trade per symbol.
    const existing = await db.trackedTrade.findFirst({
      where: { symbol, status: { in: ACTIVE } },
    });
    if (existing) {
      return NextResponse.json(
        { error: `${symbol} already has an active tracked trade` },
        { status: 409 },
      );
    }

    // Build the trade from the current signal setup.
    const chart = await getChart(symbol, "6M");
    const signal = computeSignal(chart);
    const { direction, entry, stop, target1, target2, riskReward, riskLevel } =
      signal.setup;

    if (direction === "Wait" || stop === entry || target1 === entry) {
      return NextResponse.json(
        {
          error:
            "No actionable trade setup for this symbol right now — wait for a directional signal.",
        },
        { status: 422 },
      );
    }

    const quote = await getQuotes([symbol]).catch(() => []);
    const companyName = quote[0]?.longName ?? quote[0]?.shortName ?? null;

    const trade = await db.trackedTrade.create({
      data: {
        symbol,
        companyName,
        direction,
        entryPrice: entry,
        stopLoss: stop,
        target1,
        target2,
        riskReward,
        riskLevel,
        confidence: signal.confidence,
        verdict: signal.verdict,
        status: "OPEN",
        hitTp1: false,
        lastPrice: entry,
        pnlPct: 0,
        progressPct: 0,
      },
    });

    return NextResponse.json({ trade: toView(trade) }, { status: 201 });
  } catch (err) {
    console.error("POST /api/trades error:", err);
    return NextResponse.json(
      { error: "Could not confirm the trade. Please try again." },
      { status: 500 },
    );
  }
}

/** DELETE /api/trades?id=... — remove a tracked trade. */
export async function DELETE(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get("id")?.trim();
    if (!id) {
      return NextResponse.json({ error: "Missing ?id=" }, { status: 400 });
    }
    const existing = await db.trackedTrade.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Trade not found" }, { status: 404 });
    }
    await db.trackedTrade.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/trades error:", err);
    return NextResponse.json({ error: "Failed to remove trade" }, { status: 500 });
  }
}
