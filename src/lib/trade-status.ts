/**
 * Trade tracking engine (server-side only).
 *
 * Given a tracked trade and the daily candles since it was opened,
 * determines whether the trade has hit TP1, TP2, or Stop Loss —
 * walking candles chronologically so the FIRST level touched wins.
 *
 * Conservative rule: if a single candle's range spans both the stop
 * and a target, the STOP is assumed to have been hit first.
 *
 * TP1 playbook (automatic, see closedPnlPctFor): once TP1 is tagged,
 * half the position is banked at TP1 and the runner's stop moves to
 * breakeven (entry). The breakeven stop applies from the candle AFTER
 * the TP1-tagging candle onward (stops are moved after the level
 * prints on the daily close) and to the live price immediately.
 * Result: every exit after TP1 is in profit — worst case is the
 * breakeven exit which nets +TP1/2.
 *
 * Evaluation sources:
 *  - Daily candles from the day AFTER the trade was opened (their
 *    high/low may include pre-entry movement on the opening day, so
 *    the opening day is judged only by the live price).
 *  - The live current price for everything after the last candle.
 *
 * Educational use only — NOT financial advice.
 */

import type { ChartPoint } from "@/lib/yahoo";

export type TradeStatus = "OPEN" | "TP1_HIT" | "TP2_HIT" | "SL_HIT";

export interface TradeLevels {
  direction: "Long" | "Short";
  entryPrice: number;
  stopLoss: number;
  target1: number;
  target2: number;
}

export interface TradeEvaluation {
  status: TradeStatus;
  hitTp1: boolean;
  /** Live / last known price used for the evaluation. */
  currentPrice: number;
  /** P&L vs entry, signed for the trade direction, in %. */
  pnlPct: number | null;
  /** P&L locked in at the terminal level (TP2 / SL), in %. */
  pnlAtClosePct: number | null;
  /** 0–100+ progress from entry toward target2. */
  progressPct: number | null;
  highWater: number | null;
  lowWater: number | null;
  closedAt: number | null; // epoch ms
  hitTp1At: number | null; // epoch ms
  closedReason: string | null;
  /** Human-readable status line. */
  message: string;
}

const pct = (a: number, b: number) => (b !== 0 ? ((a - b) / b) * 100 : 0);

/**
 * Signed % P&L of exiting at `exit`, always divided by ENTRY capital:
 * Long (exit-entry)/entry, Short (entry-exit)/entry.
 */
const pctFromEntry = (t: TradeLevels, exit: number) =>
  t.direction === "Long"
    ? ((exit - t.entryPrice) / t.entryPrice) * 100
    : ((t.entryPrice - exit) / t.entryPrice) * 100;
const signedPct = (t: TradeLevels, price: number) => pctFromEntry(t, price);
const tp1PctOf = (t: TradeLevels) => pctFromEntry(t, t.target1);
const tp2PctOf = (t: TradeLevels) => pctFromEntry(t, t.target2);

/** Round to 2 decimals. */
const r2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Locked-in P&L at a terminal level, under the TP1 playbook:
 *
 *  - TP2_HIT            -> blended exit: (TP1% + TP2%) / 2
 *                          (half scaled at TP1, runner filled at TP2)
 *  - SL_HIT after TP1   -> breakeven exit on the runner: TP1% / 2
 *                          (half banked at TP1, runner flat at entry) —
 *                          always positive, i.e. closed in profit
 *  - SL_HIT before TP1  -> full loss at the original stop
 *
 * `hitTp1` distinguishes the two SL_HIT flavors (it is persisted on the
 * tracked trade, so this works for both live evaluations and frozen
 * terminal rows served from the DB).
 */
export function closedPnlPctFor(
  t: TradeLevels,
  status: TradeStatus,
  hitTp1: boolean,
): number | null {
  if (status === "TP2_HIT") return r2((tp1PctOf(t) + tp2PctOf(t)) / 2);
  if (status === "SL_HIT") {
    if (hitTp1) return r2(tp1PctOf(t) / 2);
    return r2(pctFromEntry(t, t.stopLoss));
  }
  return null;
}

/** Progress from entry toward TP2 (can exceed 100 or go negative). */
function progress(t: TradeLevels, price: number): number | null {
  const span =
    t.direction === "Long" ? t.target2 - t.entryPrice : t.entryPrice - t.target2;
  if (span === 0) return null;
  const moved =
    t.direction === "Long" ? price - t.entryPrice : t.entryPrice - price;
  return Math.round((moved / span) * 100);
}

/**
 * Evaluate a trade against daily candles (epoch-seconds timestamps).
 * `openedAtMs` is the trade's open time in epoch-milliseconds.
 */
export function evaluateTrade(
  trade: TradeLevels,
  candles: ChartPoint[],
  openedAtMs: number,
  livePrice: number | null,
): TradeEvaluation {
  const long = trade.direction === "Long";

  // Candles from the day after opening (t is epoch seconds).
  const nextDayStartSec = Math.floor(openedAtMs / 1000) + 86400;
  const future = candles.filter((c) => c.t >= nextDayStartSec && c.c > 0);

  const priceNow =
    livePrice != null && Number.isFinite(livePrice) && livePrice > 0
      ? livePrice
      : (future[future.length - 1]?.c ?? trade.entryPrice);

  let status: TradeStatus = "OPEN";
  let hitTp1 = false;
  let closedAt: number | null = null;
  let hitTp1At: number | null = null;
  let closedReason: string | null = null;

  // Walk candles chronologically — first level touched wins.
  for (const c of future) {
    const high = c.h ?? c.c;
    const low = c.l ?? c.c;
    if (long) {
      if (hitTp1) {
        // Runner phase: stop lives at breakeven (entry). Conservative:
        // breakeven stop checked before TP2 within the same candle.
        if (low <= trade.entryPrice) {
          status = "SL_HIT";
          closedAt = c.t * 1000;
          closedReason = `Runner stopped at breakeven ${trade.entryPrice.toFixed(2)} on ${fmtDate(closedAt)} — TP1 was banked, trade closed in profit`;
          break;
        }
        if (high >= trade.target2) {
          status = "TP2_HIT";
          closedAt = c.t * 1000;
          closedReason = `Target 2 achieved at ${high.toFixed(2)} on ${fmtDate(closedAt)}`;
          break;
        }
      } else {
        // Conservative: original stop checked before targets within the same candle.
        if (low <= trade.stopLoss) {
          status = "SL_HIT";
          closedAt = c.t * 1000;
          closedReason = `Stop loss hit at ${low.toFixed(2)} on ${fmtDate(closedAt)}`;
          break;
        }
        if (high >= trade.target2) {
          status = "TP2_HIT";
          hitTp1 = true;
          if (!hitTp1At) hitTp1At = c.t * 1000;
          closedAt = c.t * 1000;
          closedReason = `Target 2 achieved at ${high.toFixed(2)} on ${fmtDate(closedAt)}`;
          break;
        }
        if (high >= trade.target1) {
          hitTp1 = true;
          if (!hitTp1At) hitTp1At = c.t * 1000;
          status = "TP1_HIT";
          // Breakeven protection starts with the NEXT candle — the stop is
          // moved after TP1 prints (daily-candle management).
        }
      }
    } else {
      if (hitTp1) {
        if (high >= trade.entryPrice) {
          status = "SL_HIT";
          closedAt = c.t * 1000;
          closedReason = `Runner stopped at breakeven ${trade.entryPrice.toFixed(2)} on ${fmtDate(closedAt)} — TP1 was banked, trade closed in profit`;
          break;
        }
        if (low <= trade.target2) {
          status = "TP2_HIT";
          closedAt = c.t * 1000;
          closedReason = `Target 2 achieved at ${low.toFixed(2)} on ${fmtDate(closedAt)}`;
          break;
        }
      } else {
        if (high >= trade.stopLoss) {
          status = "SL_HIT";
          closedAt = c.t * 1000;
          closedReason = `Stop loss hit at ${high.toFixed(2)} on ${fmtDate(closedAt)}`;
          break;
        }
        if (low <= trade.target2) {
          status = "TP2_HIT";
          hitTp1 = true;
          if (!hitTp1At) hitTp1At = c.t * 1000;
          closedAt = c.t * 1000;
          closedReason = `Target 2 achieved at ${low.toFixed(2)} on ${fmtDate(closedAt)}`;
          break;
        }
        if (low <= trade.target1) {
          hitTp1 = true;
          if (!hitTp1At) hitTp1At = c.t * 1000;
          status = "TP1_HIT";
        }
      }
    }
  }

  // Also judge the live price (today, or after the last candle).
  if (status === "OPEN" || status === "TP1_HIT") {
    if (long) {
      if (hitTp1 && priceNow <= trade.entryPrice) {
        status = "SL_HIT";
        closedAt = Date.now();
        closedReason = `Runner stopped at breakeven ${trade.entryPrice.toFixed(2)} (live price) — TP1 was banked, trade closed in profit`;
      } else if (!hitTp1 && priceNow <= trade.stopLoss) {
        status = "SL_HIT";
        closedAt = Date.now();
        closedReason = `Stop loss hit at ${priceNow.toFixed(2)} (live price)`;
      } else if (priceNow >= trade.target2) {
        status = "TP2_HIT";
        hitTp1 = true;
        if (!hitTp1At) hitTp1At = Date.now();
        closedAt = Date.now();
        closedReason = `Target 2 achieved at ${priceNow.toFixed(2)} (live price)`;
      } else if (priceNow >= trade.target1) {
        hitTp1 = true;
        if (!hitTp1At) hitTp1At = Date.now();
        status = "TP1_HIT";
      }
    } else {
      if (hitTp1 && priceNow >= trade.entryPrice) {
        status = "SL_HIT";
        closedAt = Date.now();
        closedReason = `Runner stopped at breakeven ${trade.entryPrice.toFixed(2)} (live price) — TP1 was banked, trade closed in profit`;
      } else if (!hitTp1 && priceNow >= trade.stopLoss) {
        status = "SL_HIT";
        closedAt = Date.now();
        closedReason = `Stop loss hit at ${priceNow.toFixed(2)} (live price)`;
      } else if (priceNow <= trade.target2) {
        status = "TP2_HIT";
        hitTp1 = true;
        if (!hitTp1At) hitTp1At = Date.now();
        closedAt = Date.now();
        closedReason = `Target 2 achieved at ${priceNow.toFixed(2)} (live price)`;
      } else if (priceNow <= trade.target1) {
        hitTp1 = true;
        if (!hitTp1At) hitTp1At = Date.now();
        status = "TP1_HIT";
      }
    }
  }

  // High/low water marks from candles since entry + live price.
  const highs = future.map((c) => c.h ?? c.c);
  const lows = future.map((c) => c.l ?? c.c);
  const highWater = highs.length ? Math.max(...highs, priceNow) : priceNow;
  const lowWater = lows.length ? Math.min(...lows, priceNow) : priceNow;

  // P&L
  const pnlPct = signedPct(trade, priceNow);
  const pnlAtClosePct = closedPnlPctFor(trade, status, hitTp1);

  const message = buildMessage({
    status,
    hitTp1,
    direction: trade.direction,
    priceNow,
    pnlPct,
    pnlAtClosePct,
    entryPrice: trade.entryPrice,
    target1: trade.target1,
    target2: trade.target2,
  });

  return {
    status,
    hitTp1,
    currentPrice: priceNow,
    pnlPct: Math.round(pnlPct * 100) / 100,
    pnlAtClosePct,
    progressPct: progress(trade, priceNow),
    highWater: Math.round(highWater * 100) / 100,
    lowWater: Math.round(lowWater * 100) / 100,
    closedAt,
    hitTp1At,
    closedReason,
    message,
  };
}

function buildMessage(s: {
  status: TradeStatus;
  hitTp1: boolean;
  direction: "Long" | "Short";
  priceNow: number;
  pnlPct: number;
  pnlAtClosePct: number | null;
  entryPrice: number;
  target1: number;
  target2: number;
}): string {
  const fmt = (n: number) => n.toFixed(2);
  const signed = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
  switch (s.status) {
    case "TP2_HIT":
      return `Target 2 hit at $${fmt(s.target2)} — playbook exit: half at TP1 + runner at TP2 = ${s.pnlAtClosePct != null ? signed(s.pnlAtClosePct) : "target achieved"} blended.`;
    case "SL_HIT":
      return s.hitTp1
        ? `Breakeven exit — runner stopped at entry $${fmt(s.entryPrice)}; TP1 was banked. Net ${s.pnlAtClosePct != null ? signed(s.pnlAtClosePct) : "in profit"} — closed in profit.`
        : `Stop loss hit — trade closed to protect capital. Review the setup before re-entering.`;
    case "TP1_HIT":
      return `Target 1 hit at $${fmt(s.target1)} ✓ — half banked, runner stop moved to breakeven $${fmt(s.entryPrice)}. Running toward TP2 at $${fmt(s.target2)}.`;
    default:
      return s.hitTp1
        ? `TP1 secured — watching for Target 2.`
        : `Trade in progress — watching for TP1 $${fmt(s.target1)} / TP2 $${fmt(s.target2)}.`;
  }
}

function fmtDate(ms: number): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(
    new Date(ms),
  );
}
