import { db } from "@/lib/db";
import { getQuotes } from "@/lib/yahoo";

/**
 * Signal transition detection -> "Trade Alerts".
 *
 * Runs on every watchlist signals poll (see /api/stocks/signals). Compares the
 * freshly computed verdict for each watched symbol against the persisted
 * SignalState and creates/reactivates SignalAlert rows on:
 *
 *   1. Neutral (or first observation after seed) -> Buy / Strong Buy / Sell / Strong Sell
 *   2. Direction flip: Buy* -> Sell* or Sell* -> Buy*
 *   3. Same-direction upgrade (Buy -> Strong Buy): refreshes the OPEN alert in place
 *
 * When a signal fades back to Neutral, OPEN alerts for that symbol are marked
 * STALE. When the user takes the trade, POST /api/trades marks the alert TAKEN.
 *
 * Dedup: one alert per symbol per UTC day per direction (alertKey). A re-fired
 * signal of the same direction on the same day reactivates a STALE row instead
 * of duplicating. TAKEN/DISMISSED rows are never resurrected automatically.
 *
 * First run after deploy seeds SignalState for every watched symbol silently —
 * no alert storm from pre-existing verdicts.
 */

export interface AlertSignalInput {
  symbol: string;
  verdict: string;
  score: number;
  confidence: number;
}

/**
 * Minimum |score| for a NEW alert to be created.
 *
 * 1.5 is where the verdict label flips to Buy/Sell, but alerts fired right at
 * that line revert far more often: replaying a year of daily candles
 * (scripts/alert-quality.ts, 365 transitions) gives a 65% fade-within-3-days
 * rate for |score| 1.5-2.0 versus 49% for 2.0+, with worse forward drift
 * (-0.24% vs -0.12% at +5 sessions). Requiring 2.0 removes the bulk of the
 * whipsaw alerts.
 *
 * Fading still uses the verdict itself (|score| < 1.5 -> Neutral), so the two
 * thresholds form a hysteresis band: an alert must be earned at 2.0 but is not
 * cancelled until the signal actually loses its verdict.
 *
 * Override with ALERT_MIN_SCORE. Values below 1.5 are clamped, since that is
 * where the verdict engine itself flips.
 */
const ALERT_MIN_SCORE = Math.max(1.5, Number(process.env.ALERT_MIN_SCORE ?? 2));

const dayKey = () => new Date().toISOString().slice(0, 10);

function directionOf(verdict: string): "Long" | "Short" {
  return verdict.toLowerCase().includes("buy") ? "Long" : "Short";
}

function signOf(verdict: string): number {
  if (verdict.includes("Buy")) return 1;
  if (verdict.includes("Sell")) return -1;
  return 0;
}

const isActionable = (verdict: string) => verdict !== "Neutral";

export async function detectSignalAlerts(
  userId: string,
  signals: AlertSignalInput[],
): Promise<void> {
  try {
    const symbols = signals.map((s) => s.symbol);
    if (symbols.length === 0) return;

    const [watchlist, states] = await Promise.all([
      db.watchlistItem.findMany({
        where: { userId, symbol: { in: symbols } },
        select: { symbol: true },
      }),
      db.signalState.findMany({ where: { userId, symbol: { in: symbols } } }),
    ]);

    const watched = new Set(watchlist.map((w) => w.symbol));
    if (watched.size === 0) return;
    const verdictBySymbol = new Map(states.map((s) => [s.symbol, s.verdict]));

    for (const sig of signals) {
      if (!watched.has(sig.symbol)) continue;
      const prev = verdictBySymbol.get(sig.symbol) ?? null;
      const curr = sig.verdict;

      // First observation ever (fresh DB / new watchlist entry): seed silently.
      if (prev === null) {
        await db.signalState.upsert({
          where: { userId_symbol: { userId, symbol: sig.symbol } },
          create: { userId, symbol: sig.symbol, verdict: curr },
          update: { verdict: curr },
        });
        continue;
      }

      if (prev === curr) continue; // nothing changed — no writes

      const prevSign = signOf(prev);
      const currSign = signOf(curr);

      if (isActionable(curr)) {
        const direction = directionOf(curr);
        const sameDirectionFlip = prevSign !== 0 && prevSign !== currSign;
        const freshTrigger = prevSign === 0; // was Neutral
        const sameSideChange = prevSign !== 0 && prevSign === currSign;

        if (freshTrigger || sameDirectionFlip) {
          // Threshold gate: a transition only counts once the score is strong
          // enough. Nothing is persisted on a weak reading, so the pending
          // Neutral->actionable edge is re-evaluated on the next poll instead of
          // being silently consumed.
          if (Math.abs(sig.score) < ALERT_MIN_SCORE) continue;

          const key = `${dayKey()}:${direction}`;
          const existing = await db.signalAlert.findUnique({
            where: {
              userId_symbol_alertKey: { userId, symbol: sig.symbol, alertKey: key },
            },
          });

          // Only create/reactivate when today's row isn't already handled (TAKEN/DISMISSED).
          if (!existing || existing.status === "STALE" || existing.status === "OPEN") {
            // Fetch a price + company snapshot only when we actually need to write.
            let priceAtAlert: number | null = null;
            let companyName: string | null = existing?.companyName ?? null;
            try {
              const quotes = await getQuotes([sig.symbol]);
              if (quotes[0] && quotes[0].price > 0) {
                priceAtAlert = quotes[0].price;
                companyName = quotes[0].longName || quotes[0].shortName || companyName;
              }
            } catch {
              // quote fetch failure must never block alert creation
            }

            await db.signalAlert.upsert({
              where: {
                userId_symbol_alertKey: { userId, symbol: sig.symbol, alertKey: key },
              },
              create: {
                userId,
                symbol: sig.symbol,
                companyName,
                direction,
                verdict: curr,
                score: sig.score,
                confidence: sig.confidence,
                priceAtAlert,
                alertKey: key,
                status: "OPEN",
              },
              update: {
                status: "OPEN",
                direction,
                verdict: curr,
                score: sig.score,
                confidence: sig.confidence,
                priceAtAlert: priceAtAlert ?? undefined,
                companyName: companyName ?? undefined,
              },
            });
          }
        } else if (sameSideChange) {
          // Buy -> Strong Buy (or the reverse): refresh the OPEN alert snapshot.
          await db.signalAlert.updateMany({
            where: { userId, symbol: sig.symbol, direction, status: "OPEN" },
            data: { verdict: curr, score: sig.score, confidence: sig.confidence },
          });
        }
      } else if (prevSign !== 0) {
        // Signal faded to Neutral — open alerts for this symbol are stale.
        await db.signalAlert.updateMany({
          where: { userId, symbol: sig.symbol, status: "OPEN" },
          data: { status: "STALE" },
        });
      }

      await db.signalState.upsert({
        where: { userId_symbol: { userId, symbol: sig.symbol } },
        create: { userId, symbol: sig.symbol, verdict: curr },
        update: { verdict: curr },
      });
    }
  } catch (err) {
    // Alerting must never break the signals response.
    console.error("detectSignalAlerts error:", err);
  }
}
