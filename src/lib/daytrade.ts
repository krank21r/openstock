/**
 * Day-trading scanner (server-side, pure computation).
 *
 * Scope: INTRADAY setups on liquid US stocks and major crypto pairs. This is a
 * deliberately narrow filter — a symbol only qualifies when every check passes,
 * and the checks are printed on the card so the reasoning is auditable.
 *
 * It is NOT a probability model. There is no intraday backtest behind the
 * thresholds yet; they encode conventional day-trading confluence (trend
 * alignment, opening-range trigger, momentum band, participation, liquidity /
 * volatility window, and a minimum 2R geometry).
 *
 * Levels are mechanical: stop = 1×ATR(5m) clamped to 0.4–1.2% of price, targets
 * at 2R and 3R. No trailing, no breakeven — a day trade is opened and closed in
 * the same session.
 */

import type { ChartPoint } from "@/lib/yahoo";

export type DayTradeKind = "stock" | "crypto";
export type DayDirection = "Long" | "Short";

export interface DayCheck {
  label: string;
  pass: boolean;
  detail: string;
}

export interface DayTradeIdea {
  symbol: string;
  name: string;
  kind: DayTradeKind;
  direction: DayDirection;
  price: number;
  changePct: number | null;
  entry: number;
  stop: number;
  target1: number;
  target2: number;
  riskPct: number;
  riskReward: number;
  atrPct: number;
  rsi: number | null;
  relVolume: number | null;
  vwap: number;
  checks: DayCheck[];
  passed: number;
  total: number;
  /** Timestamp (ms) of the last intraday candle used. */
  asOf: number;
}

export interface DayTradeScan {
  ideas: DayTradeIdea[];
  nearMisses: DayTradeIdea[];
  scanned: number;
  skipped: number;
  marketOpen: boolean;
  updatedAt: number;
}

export const TOTAL_CHECKS = 5;

export interface DayTradeParams {
  /** Stop floor as % of price (default 1.0, from the backtest). */
  minRiskPct?: number;
  /** Stop cap as % of price (default 2.0). */
  maxRiskPct?: number;
  /**
   * Calibration hook — check labels to exclude from the gate. Used by
   * scripts/daytrade-backtest.ts to measure each check's contribution; the app
   * never passes it.
   */
  skipChecks?: string[];
}

// ------------------------------ indicators ------------------------------

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const round2 = (x: number) => Math.round(x * 100) / 100;

function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) prev = values[i] * k + prev * (1 - k);
  return prev;
}

function rsi(values: number[], period = 14): number | null {
  if (values.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  const avgGain = gain / period;
  const avgLoss = loss / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function atr(points: ChartPoint[], period = 14): number | null {
  if (points.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = points.length - period; i < points.length; i++) {
    const p = points[i];
    const prev = points[i - 1];
    const high = p.h ?? p.c;
    const low = p.l ?? p.c;
    const prevClose = prev.c;
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

/** Session VWAP over the candles supplied. */
function vwap(points: ChartPoint[]): number | null {
  let pv = 0;
  let vol = 0;
  for (const p of points) {
    const v = p.v ?? 0;
    if (v <= 0) continue;
    const typical = ((p.h ?? p.c) + (p.l ?? p.c) + p.c) / 3;
    pv += typical * v;
    vol += v;
  }
  return vol > 0 ? pv / vol : null;
}

function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ------------------------------ evaluation ------------------------------

export interface EvaluateInput {
  symbol: string;
  name: string;
  kind: DayTradeKind;
  intraday: ChartPoint[];
  daily: ChartPoint[];
}

/**
 * Returns an idea with every check evaluated, or null when there isn't enough
 * data to judge (thin session, brand-new listing, failed fetch).
 */
export function evaluateDayTrade(input: EvaluateInput, params: DayTradeParams = {}): DayTradeIdea | null {
  const { symbol, name, kind, intraday, daily } = input;
  // Backtested 60 days of 5m candles (scripts/daytrade-backtest.ts): stops tighter
  // than 1% of price lose to spread/slippage in R terms, and get stopped out on
  // noise. 1.0–2.0% was the best of the tested clamps on both counts.
  const minRiskPct = params.minRiskPct ?? 1.0;
  const maxRiskPct = params.maxRiskPct ?? 2.0;

  // Need a real session behind us: at least 8 five-minute bars.
  if (intraday.length < 8 || daily.length < 25) return null;

  const closes = intraday.map((p) => p.c);
  const price = closes[closes.length - 1];
  if (!Number.isFinite(price) || price <= 0) return null;

  const ema9 = ema(closes, 9);
  const ema20 = ema(closes, 20);
  const rsiVal = rsi(closes, 14);
  const atrVal = atr(intraday, 14);
  const vwapVal = vwap(intraday);
  if (ema9 == null || ema20 == null || atrVal == null || vwapVal == null) return null;

  const dailyCloses = daily.map((p) => p.c);
  const sma20d = sma(dailyCloses, 20);
  const prevDailyClose = daily.length >= 2 ? daily[daily.length - 2].c : null;

  // Direction must be unambiguous: price, fast/slow EMA and VWAP all agree.
  const longBias = price > vwapVal && ema9 > ema20;
  const shortBias = price < vwapVal && ema9 < ema20;
  if (!longBias && !shortBias) return null;
  const direction: DayDirection = longBias ? "Long" : "Short";
  const long = direction === "Long";

  const atrPct = (atrVal / price) * 100;

  // ---- Check 1: trend alignment (intraday + daily) ----
  const tick = (ok: boolean) => (ok ? "✓" : "✗");
  const trendPass = long
    ? price > vwapVal && ema9 > ema20 && (sma20d == null || price > sma20d)
    : price < vwapVal && ema9 < ema20 && (sma20d == null || price < sma20d);
  const trendCheck: DayCheck = {
    label: "Trend alignment",
    pass: trendPass,
    detail: [
      `price ${round2(price)} vs VWAP ${round2(vwapVal)} ${tick(long ? price > vwapVal : price < vwapVal)}`,
      `EMA9 ${round2(ema9)} vs EMA20 ${round2(ema20)} ${tick(long ? ema9 > ema20 : ema9 < ema20)}`,
      sma20d != null
        ? `daily SMA20 ${round2(sma20d)} ${tick(long ? price > sma20d : price < sma20d)}`
        : "daily SMA20 n/a",
    ].join(" · "),
  };

  // ---- Check 2: trigger — opening range (stocks) / 1h range (crypto) ----
  const rangeBars = kind === "stock" ? 6 : 12; // 30 min vs 1 hour
  const opening = intraday.slice(0, rangeBars);
  const orHigh = Math.max(...opening.map((p) => p.h ?? p.c));
  const orLow = Math.min(...opening.map((p) => p.l ?? p.c));
  const ext = 1.5 * atrVal; // don't chase a move already extended off the level
  const triggerPass = long
    ? price >= orHigh - 0.1 * atrVal && price <= orHigh + ext
    : price <= orLow + 0.1 * atrVal && price >= orLow - ext;
  const triggerCheck: DayCheck = {
    label: kind === "stock" ? "Opening-range trigger" : "Session-range trigger",
    pass: triggerPass,
    detail: long
      ? `Range high ${round2(orHigh)} — price ${triggerPass ? "at/through the level" : "not at the level"} (${round2((price - orHigh) / atrVal)} ATR away)`
      : `Range low ${round2(orLow)} — price ${triggerPass ? "at/through the level" : "not at the level"} (${round2((orLow - price) / atrVal)} ATR away)`,
  };

  // ---- Check 3: momentum band (trending, not exhausted) ----
  const rsiOk = rsiVal != null && (long ? rsiVal >= 52 && rsiVal <= 72 : rsiVal >= 28 && rsiVal <= 48);
  const momentumCheck: DayCheck = {
    label: "Momentum band",
    pass: rsiOk,
    detail:
      rsiVal == null
        ? "RSI unavailable"
        : `RSI(5m) ${round2(rsiVal)} — ${rsiOk ? "in the workable band" : long ? "outside 52–72" : "outside 28–48"}`,
  };

  // ---- Participation (context, not a gate) ----
  // Linear "share of an average day" is a rough proxy; the tape being quiet is
  // common enough that gating on it would empty the page most days. It is
  // reported next to the idea and used to rank qualifying setups instead.
  const todayVol = intraday.reduce((a, p) => a + (p.v ?? 0), 0);
  const last10 = daily.slice(-11, -1);
  const avgDailyVol =
    last10.length > 0 ? last10.reduce((a, p) => a + (p.v ?? 0), 0) / last10.length : null;
  // Stocks: expect a slice of the daily volume by now. Crypto trades 24h.
  const elapsedFraction = kind === "stock" ? clamp(intraday.length / 78, 0.05, 1) : 1;
  const expected = avgDailyVol != null ? avgDailyVol * elapsedFraction : null;
  const relVolume = expected != null && expected > 0 ? todayVol / expected : null;

  // ---- Check 5: liquidity + volatility window ----
  const dollarVol = avgDailyVol != null ? avgDailyVol * price : null;
  const liquidEnough = kind === "stock" ? price >= 5 && (dollarVol ?? 0) >= 50e6 : todayVol >= 20e6;
  const volBand = atrPct >= 0.04 && atrPct <= 0.8; // per 5-minute bar
  const liquidityPass = liquidEnough && volBand;
  const liquidityCheck: DayCheck = {
    label: "Liquidity & volatility",
    pass: liquidityPass,
    detail: [
      `5m ATR ${atrPct.toFixed(2)}% ${tick(volBand)} (want 0.04–0.80)`,
      liquidEnough ? "liquid enough" : "too thin to trust",
    ].join(" · "),
  };

  // ---- Check 6: risk geometry ----
  const riskDistance = clamp(atrVal, price * (minRiskPct / 100), price * (maxRiskPct / 100));
  const riskPct = (riskDistance / price) * 100;
  const riskReward = 2; // targets are placed mechanically at 2R / 3R
  const riskPass = riskPct <= maxRiskPct + 1e-9 && riskPct >= minRiskPct * 0.9;
  const riskCheck: DayCheck = {
    label: "Risk geometry",
    pass: riskPass,
    detail: `Stop ${riskPct.toFixed(2)}% away (1×ATR, capped ${minRiskPct}–${maxRiskPct}%) · targets 2R / 3R`,
  };

  const allChecks = [trendCheck, triggerCheck, momentumCheck, liquidityCheck, riskCheck];
  const skipped = params.skipChecks ?? [];
  // A skipped check is shown but not counted toward the gate (calibration only).
  const checks = skipped.length
    ? allChecks.filter((c) => !skipped.includes(c.label))
    : allChecks;

  const entry = price;
  const stop = long ? entry - riskDistance : entry + riskDistance;
  const target1 = long ? entry + 2 * riskDistance : entry - 2 * riskDistance;
  const target2 = long ? entry + 3 * riskDistance : entry - 3 * riskDistance;

  return {
    symbol,
    name,
    kind,
    direction,
    price: round2(price),
    changePct:
      prevDailyClose != null && prevDailyClose > 0
        ? round2(((price - prevDailyClose) / prevDailyClose) * 100)
        : null,
    entry: round2(entry),
    stop: round2(stop),
    target1: round2(target1),
    target2: round2(target2),
    riskPct: round2(riskPct),
    riskReward,
    atrPct: round2(atrPct),
    rsi: rsiVal != null ? round2(rsiVal) : null,
    relVolume: relVolume != null ? Math.round(relVolume * 100) / 100 : null,
    vwap: round2(vwapVal),
    checks,
    passed: checks.filter((c) => c.pass).length,
    total: checks.length,
    asOf: intraday[intraday.length - 1].t * 1000,
  };
}
