/**
 * Trade tracking, server-side sweep (no browser involved).
 *
 * The tracked-trade statuses (OPEN / TP1_HIT / TP2_HIT / SL_HIT) are normally
 * refreshed inside `GET /api/trades`, i.e. only while someone has the app open.
 * With the tab closed, a stop or target can be crossed and never recorded.
 *
 * This module performs the same evaluation pass for every active trade so a
 * scheduled job can keep the book current. It mirrors the GET handler's loop on
 * purpose: same `evaluateTrade` engine, same fields persisted, so a sweep and a
 * page load can never disagree.
 */

import { db } from "@/lib/db";
import { getChart, getQuotes } from "@/lib/yahoo";
import { evaluateTrade, type TradeStatus } from "@/lib/trade-status";
import type { TrackedTrade } from "@prisma/client";

const ACTIVE: TradeStatus[] = ["OPEN", "TP1_HIT"];

export interface TradeSyncResult {
  /** Active trades re-evaluated in this pass. */
  evaluated: number;
  /** Trades that became terminal (TP2 / SL) during this pass. */
  closed: number;
}

export async function syncActiveTrades(limit = 50): Promise<TradeSyncResult> {
  const trades = await db.trackedTrade.findMany({
    where: { status: { in: ACTIVE } },
    orderBy: { openedAt: "asc" },
    take: limit,
  });
  if (trades.length === 0) return { evaluated: 0, closed: 0 };

  const symbols = [...new Set(trades.map((t) => t.symbol))];

  const [chartResults, quoteResults] = await Promise.all([
    Promise.allSettled(symbols.map((s) => getChart(s, "6M"))),
    Promise.allSettled([getQuotes(symbols)]),
  ]);

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

  let closed = 0;

  for (const t of trades) {
    const chart = chartBySymbol.get(t.symbol);
    const ev = evaluateTrade(
      {
        direction: t.direction as "Long" | "Short",
        entryPrice: t.entryPrice,
        stopLoss: t.stopLoss,
        target1: t.target1,
        target2: t.target2,
      },
      chart ? chart.points : [],
      t.openedAt.getTime(),
      priceBySymbol.get(t.symbol) ?? null,
    );

    await db.trackedTrade.update({
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

    if (!ACTIVE.includes(ev.status)) closed++;
  }

  return { evaluated: trades.length, closed };
}
