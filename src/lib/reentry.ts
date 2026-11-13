import { db } from "@/lib/db";

/**
 * Fresh-signal re-entry gate.
 *
 * Answer to "when SL is hit, do I wait for a new signal?": the signal verdict
 * does NOT turn Neutral just because a stop is hit — the stop-out is your
 * trade's outcome, not a change in market structure. The engine keeps saying
 * Buy/Sell until the market actually changes. So the app enforces the wait
 * explicitly:
 *
 * After a tracked trade on `symbol` ends in SL_HIT, re-entry is BLOCKED until
 * the signal engine fires a NEW signal for that symbol — i.e. a Trade Alert
 * row created AFTER the stop-out (Neutral -> Buy/Sell transition, or a
 * direction flip). Same-day re-fires of an already-TAKEN alert don't count
 * (one fresh signal per direction per day), which deliberately filters
 * same-day whipsaw.
 *
 * Fail-open on any DB error so the gate can never break the API.
 */
export interface ReentryGate {
  blocked: boolean;
  /** ISO timestamp of the stop-out that armed the gate (null when open). */
  stoppedAt: string | null;
}

export async function getReentryGate(symbol: string): Promise<ReentryGate> {
  try {
    const lastStop = await db.trackedTrade.findFirst({
      where: { symbol, status: "SL_HIT" },
      orderBy: { closedAt: "desc" },
    });
    if (!lastStop?.closedAt) return { blocked: false, stoppedAt: null };

    const freshSignal = await db.signalAlert.findFirst({
      where: { symbol, createdAt: { gt: lastStop.closedAt } },
      select: { id: true },
    });
    if (freshSignal) return { blocked: false, stoppedAt: null };

    return { blocked: true, stoppedAt: lastStop.closedAt.toISOString() };
  } catch (err) {
    console.error("getReentryGate error:", err);
    return { blocked: false, stoppedAt: null };
  }
}
