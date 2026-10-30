/**
 * Technical-analysis signal engine (server-side only).
 * Computes indicators from daily candles and derives a composite verdict
 * plus a basic trade setup (entry / stop / targets).
 *
 * Educational use only — NOT financial advice.
 */

import type { ChartData, ChartPoint } from "@/lib/yahoo";

// ---------------------------- Types ----------------------------

export type Verdict = "Strong Buy" | "Buy" | "Neutral" | "Sell" | "Strong Sell";

export interface SignalIndicators {
  rsi: number | null;
  sma20: number | null;
  sma50: number | null;
  macd: { macd: number; signal: number; histogram: number } | null;
  atr: number | null;
  trend: "Uptrend" | "Downtrend" | "Sideways";
  volatilityPct: number | null; // annualized %
}

export interface TradeSetup {
  direction: "Long" | "Short" | "Wait";
  entry: number;
  stop: number;
  target1: number;
  target2: number;
  riskReward: number | null;
  support: number | null;
  resistance: number | null;
  riskLevel: "Low" | "Medium" | "High";
  notes: string[];
}

export interface SignalResult {
  symbol: string;
  verdict: Verdict;
  score: number;
  confidence: number; // 0–100 (indicator agreement)
  indicators: SignalIndicators;
  setup: TradeSetup;
  asOf: number;
}

export interface SignalSummary {
  symbol: string;
  verdict: Verdict;
  score: number;
  confidence: number;
  trend: SignalIndicators["trend"];
  rsi: number | null;
}

// -------------------------- Math helpers -----------------------

function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function emaSeries(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/** Wilder's RSI. */
function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function macd(closes: number[]) {
  if (closes.length < 35) return null;
  const e12 = emaSeries(closes, 12);
  const e26 = emaSeries(closes, 26);
  const macdLine = e12.map((v, i) => v - e26[i]);
  const signalLine = emaSeries(macdLine.slice(25), 9); // align after EMA26 warms up
  const lastMacd = macdLine[macdLine.length - 1];
  const lastSignal = signalLine[signalLine.length - 1];
  return {
    macd: lastMacd,
    signal: lastSignal,
    histogram: lastMacd - lastSignal,
    prevHistogram:
      macdLine[macdLine.length - 2] - signalLine[signalLine.length - 2],
  };
}

/** Wilder's ATR using daily high/low/close. */
function atr(points: ChartPoint[], period = 14): number | null {
  if (points.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const h = points[i].h ?? points[i].c;
    const l = points[i].l ?? points[i].c;
    const pc = points[i - 1].c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let value = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    value = (value * (period - 1) + trs[i]) / period;
  }
  return value;
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// --------------------------- Engine ----------------------------

const MIN_POINTS = 36; // enough for SMA20/50 + MACD warm-up

export function computeSignal(chart: ChartData): SignalResult {
  const points = chart.points;
  const closes = points.map((p) => p.c);
  const price = closes[closes.length - 1] ?? 0;

  if (points.length < MIN_POINTS || price <= 0) {
    // Graceful fallback — not enough history to analyze
    return {
      symbol: chart.symbol,
      verdict: "Neutral",
      score: 0,
      confidence: 0,
      indicators: {
        rsi: null,
        sma20: null,
        sma50: null,
        macd: null,
        atr: null,
        trend: "Sideways",
        volatilityPct: null,
      },
      setup: {
        direction: "Wait",
        entry: price,
        stop: price,
        target1: price,
        target2: price,
        riskReward: null,
        support: null,
        resistance: null,
        riskLevel: "Medium",
        notes: ["Not enough price history for a reliable signal."],
      },
      asOf: Date.now(),
    };
  }

  // ---- Indicators ----
  const s20 = sma(closes, 20);
  const s50 = sma(closes, 50);
  const r = rsi(closes);
  const m = macd(closes);
  const a = atr(points);

  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  const dailyVol = stdev(returns);
  const annualVol = dailyVol * Math.sqrt(252) * 100;

  const lookback = points.slice(-20);
  const lows = lookback.map((p) => p.l ?? p.c);
  const highs = lookback.map((p) => p.h ?? p.c);
  const support = Math.min(...lows);
  const resistance = Math.max(...highs);

  // Trend via SMA20/50 cross state
  const prev20 = sma(closes.slice(0, -5), 20);
  const prev50 = sma(closes.slice(0, -5), 50);
  const goldenCross = prev20 != null && prev50 != null && prev20 <= prev50 && s20! > s50!;
  const deathCross = prev20 != null && prev50 != null && prev20 >= prev50 && s20! < s50!;

  let trend: SignalIndicators["trend"] = "Sideways";
  if (price > s20! && s20! > s50!) trend = "Uptrend";
  else if (price < s20! && s20! < s50!) trend = "Downtrend";

  // ---- Composite score ----
  let score = 0;
  const notes: string[] = [];

  // 1) Trend structure (weight: highest)
  if (trend === "Uptrend") {
    score += 2;
    notes.push("Price above both SMA20 and SMA50 — bullish structure.");
  } else if (trend === "Downtrend") {
    score -= 2;
    notes.push("Price below both SMA20 and SMA50 — bearish structure.");
  } else if (s50 != null) {
    score += price > s50 ? 1 : -1;
    notes.push(
      price > s50
        ? "Price above SMA50 — mild bullish bias inside a mixed trend."
        : "Price below SMA50 — mild bearish bias inside a mixed trend.",
    );
  }
  if (goldenCross) {
    score += 0.5;
    notes.push("Recent SMA20/SMA50 golden cross.");
  } else if (deathCross) {
    score -= 0.5;
    notes.push("Recent SMA20/SMA50 death cross.");
  }

  // 2) MACD momentum
  if (m) {
    if (m.histogram > 0 && m.histogram > m.prevHistogram) {
      score += 1.5;
      notes.push("MACD histogram positive and rising — momentum building.");
    } else if (m.histogram > 0) {
      score += 0.5;
      notes.push("MACD positive but fading.");
    } else if (m.histogram < 0 && m.histogram < m.prevHistogram) {
      score -= 1.5;
      notes.push("MACD histogram negative and falling — selling pressure.");
    } else {
      score -= 0.5;
      notes.push("MACD negative but improving.");
    }
  }

  // 3) RSI bands
  if (r != null) {
    if (r >= 70) {
      score -= 1;
      notes.push(`RSI ${r.toFixed(0)} — overbought, pullback risk.`);
    } else if (r <= 30) {
      score += 1;
      notes.push(`RSI ${r.toFixed(0)} — oversold, bounce potential.`);
    } else {
      const midVote = (r - 50) / 50;
      score += midVote;
      notes.push(`RSI ${r.toFixed(0)} — ${r >= 50 ? "bullish" : "bearish"} momentum zone.`);
    }
  }

  // 4) Short-term momentum (5-day)
  const r5 = (closes[closes.length - 1] - closes[closes.length - 6]) / closes[closes.length - 6];
  if (r5 > 0.01) {
    score += 1;
    notes.push(`+${(r5 * 100).toFixed(1)}% over 5 sessions — short-term strength.`);
  } else if (r5 < -0.01) {
    score -= 1;
    notes.push(`${(r5 * 100).toFixed(1)}% over 5 sessions — short-term weakness.`);
  }

  // 5) Position within 20-day range
  const range = resistance - support;
  if (range > 0) {
    const pos = (price - support) / range;
    if (pos < 0.2) {
      score += 0.5;
      notes.push("Trading near 20-day support.");
    } else if (pos > 0.8) {
      score -= 0.5;
      notes.push("Trading near 20-day resistance.");
    }
  }

  // ---- Verdict ----
  let verdict: Verdict = "Neutral";
  if (score >= 2.5) verdict = "Strong Buy";
  else if (score >= 1) verdict = "Buy";
  else if (score <= -2.5) verdict = "Strong Sell";
  else if (score <= -1) verdict = "Sell";

  // Confidence = share of casting votes that agree with the verdict direction
  const votes = [trend, m?.histogram, r, r5, range > 0 ? (price - support) / range : null];
  let agree = 0;
  let total = 0;
  const bullish = verdict === "Strong Buy" || verdict === "Buy";
  const bearish = verdict === "Sell" || verdict === "Strong Sell";

  if (trend === "Uptrend" || trend === "Downtrend") {
    total++;
    if ((trend === "Uptrend") === bullish && bullish) agree++;
    if ((trend === "Downtrend") === bearish && bearish) agree++;
  }
  if (m) {
    total++;
    if (bullish && m.histogram > 0) agree++;
    if (bearish && m.histogram < 0) agree++;
  }
  if (r != null) {
    total++;
    if (bullish && r > 50) agree++;
    if (bearish && r < 50) agree++;
  }
  {
    total++;
    if (bullish && r5 > 0) agree++;
    if (bearish && r5 < 0) agree++;
  }
  const confidence = verdict === "Neutral" ? 40 : Math.round((agree / Math.max(total, 1)) * 100);

  // ---- Trade setup ----
  const riskLevel: TradeSetup["riskLevel"] =
    annualVol < 25 ? "Low" : annualVol < 45 ? "Medium" : "High";

  const twoAtr = a != null ? 2 * a : price * 0.04;
  const fourAtr = a != null ? 4 * a : price * 0.08;

  let direction: TradeSetup["direction"] = "Wait";
  let entry = price;
  let stop = price;
  let t1 = price;
  let t2 = price;

  if (bullish) {
    direction = "Long";
    stop = Math.min(support, price - twoAtr);
    t1 = Math.max(resistance, price + twoAtr);
    t2 = price + fourAtr;
  } else if (bearish) {
    direction = "Short";
    stop = Math.max(resistance, price + twoAtr);
    t1 = Math.min(support, price - twoAtr);
    t2 = price - fourAtr;
  } else {
    notes.push("No clear edge — wait for trend or momentum confirmation.");
  }

  const risk = Math.abs(entry - stop);
  const reward = Math.abs(t1 - entry);
  const riskReward = risk > 0 ? round2(reward / risk) : null;

  return {
    symbol: chart.symbol,
    verdict,
    score: round2(score),
    confidence,
    indicators: {
      rsi: r != null ? round2(r) : null,
      sma20: s20 != null ? round2(s20) : null,
      sma50: s50 != null ? round2(s50) : null,
      macd: m
        ? {
            macd: round2(m.macd),
            signal: round2(m.signal),
            histogram: round2(m.histogram),
          }
        : null,
      atr: a != null ? round2(a) : null,
      trend,
      volatilityPct: round2(annualVol),
    },
    setup: {
      direction,
      entry: round2(entry),
      stop: round2(stop),
      target1: round2(t1),
      target2: round2(t2),
      riskReward,
      support: round2(support),
      resistance: round2(resistance),
      riskLevel,
      notes,
    },
    asOf: Date.now(),
  };
}

export function toSummary(result: SignalResult): SignalSummary {
  return {
    symbol: result.symbol,
    verdict: result.verdict,
    score: result.score,
    confidence: result.confidence,
    trend: result.indicators.trend,
    rsi: result.indicators.rsi,
  };
}
