import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getChart } from "@/lib/yahoo";
import { computeSignal, toSummary } from "@/lib/signals";
import { detectSignalAlerts } from "@/lib/alerts";
import { syncActiveTrades } from "@/lib/trade-sync";
import { isCronAuthorized } from "@/lib/cron-auth";
import type { SignalSummary } from "@/lib/stock-types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET|POST /api/cron/alerts — background sweep for Trade Alerts / My Trades.
 *
 * Every other route in this app is driven by a client poll, so alerts only fade
 * to STALE — and trades only register TP1 / TP2 / SL — while a browser tab is
 * open. This endpoint performs one full pass with no browser at all:
 *
 *   1. recompute the signal for every watched symbol (same engine the signals
 *      route uses, so verdicts cannot drift between the two),
 *   2. run the usual transition detection -> open / refresh / stale alerts,
 *   3. re-evaluate active tracked trades against fresh candles + live price.
 *
 * Auth: when `CRON_SECRET` is set, callers must send it as
 * `Authorization: Bearer <secret>` (Vercel Cron does this for you) or
 * `?key=<secret>` (GitHub Actions, cron-job.org, curl). Without the env var the
 * route stays open so the app works out of the box.
 *
 * Scheduling: see .github/workflows/alerts-cron.yml (works on the Hobby plan,
 * where Vercel Cron cannot run more than once a day).
 */

const MAX_SYMBOLS = 40;

export async function GET(req: NextRequest) {
  return sweep(req);
}

export async function POST(req: NextRequest) {
  return sweep(req);
}

async function sweep(req: NextRequest) {
  const startedAt = Date.now();

  if (
    !isCronAuthorized({
      authorization: req.headers.get("authorization"),
      key: req.nextUrl.searchParams.get("key"),
    })
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const users = await db.user.findMany({
      select: { id: true, username: true },
      take: 200,
    });

    const perUser: {
      username: string;
      scanned: number;
      failed: number;
      alerts: { openBefore: number; openAfter: number; staleAfter: number };
      trades: { evaluated: number; closed: number };
    }[] = [];

    for (const user of users) {
      const watchlist = await db.watchlistItem.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "asc" },
        take: MAX_SYMBOLS,
        select: { symbol: true },
      });
      const symbols = watchlist.map((w) => w.symbol);

      const settled = await Promise.allSettled(
        symbols.map(async (symbol) => toSummary(computeSignal(await getChart(symbol, "6M")))),
      );
      const summaries = settled
        .filter((r): r is PromiseFulfilledResult<SignalSummary> => r.status === "fulfilled")
        .map((r) => r.value);

      const openBefore = await db.signalAlert.count({
        where: { userId: user.id, status: "OPEN" },
      });

      await detectSignalAlerts(
        user.id,
        summaries.map((s) => ({
          symbol: s.symbol,
          verdict: s.verdict,
          score: s.score,
          confidence: s.confidence,
        })),
      );

      const [openAfter, staleAfter] = await Promise.all([
        db.signalAlert.count({ where: { userId: user.id, status: "OPEN" } }),
        db.signalAlert.count({ where: { userId: user.id, status: "STALE" } }),
      ]);

      const trades = await syncActiveTrades(user.id);

      perUser.push({
        username: user.username,
        scanned: symbols.length,
        failed: symbols.length - summaries.length,
        alerts: { openBefore, openAfter, staleAfter },
        trades,
      });
    }

    return NextResponse.json({
      ok: true,
      users: perUser.length,
      perUser,
      ms: Date.now() - startedAt,
    });
  } catch (err) {
    console.error("cron sweep error:", err);
    return NextResponse.json(
      { error: "Sweep failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
