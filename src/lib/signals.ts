/**
 * Technical-analysis signal engine v2 (server-side only).
 *
 * v2 keeps the five v1 voters (trend, MACD, RSI, momentum, range position)
 * and adds six price-action / smart-money confluence voters, all mechanically
 * defined from daily OHLCV (no look-ahead — swings need k confirmed bars,
 * blocks/pools are built only from past data):
 *
 *  6. Market structure (BOS)      ±1   — direction of the last break of structure
 *  7. Order block confluence      ±1   — price pulling back into the nearest
 *                                        unmitigated bullish/bearish order block
 *  8. Liquidity sweep             ±1   — stop-run through an equal-highs/lows
 *                                        pool that closed back inside (reversal)
 *  9. Tested S/R reaction         ±1   — reaction at a multi-touch swing level
 * 10. Volume confirmation        ±0.5  — volume >= 1.4x 20-day average on an
 *                                        up/down close
 * 11. RSI divergence              ±1   — price/RSI divergence at the last two
 *                                        confirmed swings
 *
 * Every nonzero vote is emitted in `factors` so the UI can show exactly why a
 * signal fired. Entry / TP1 / TP2 are unchanged from v1 so backtests stay
 * comparable. Stop-loss placement is selectable per request (StopMode):
 *
 *  - "balanced" (default / v1 rule): SL = the FARTHER of the 20-day S/R level
 *    and entry ∓ 2×ATR — wide, structure-respecting room.
 *  - "tight": SL = the CLOSER of entry ∓ 1×ATR and just-below the last
 *    confirmed swing pivot (∓ 0.15×ATR buffer), floored so it is never
 *    tighter than 0.5×ATR from entry. Targets stay fixed, so R:R expands.
 *
 * Educational use only — NOT financial advice.
 */

import type { ChartData, ChartPoint } from "@/lib/yahoo";
import type { StopMode } from "@/lib/stock-types";

export type { StopMode };

// ---------------------------- Types ----------------------------

export type Verdict = "Strong Buy" | "Buy" | "Neutral" | "Sell" | "Strong Sell";

export interface PriceZone {
  top: number;
  bottom: number;
  createdAt: number; // epoch ms
}

export interface SrLevel {
  price: number;
  touches: number;
}

export interface SignalFactor {
  key: string;
  label: string;
  /** Signed contribution to the composite score. */
  weight: number;
  detail: string;
}

export interface SignalIndicators {
  rsi: number | null;
  sma20: number | null;
  sma50: number | null;
  macd: { macd: number; signal: number; histogram: number } | null;
  atr: number | null;
  trend: "Uptrend" | "Downtrend" | "Sideways";
  volatilityPct: number | null; // annualized %
  // ---- v2 fields ----
  structure?: "Bullish" | "Bearish" | "Range" | null;
  orderBlocks?: { bullish: PriceZone[]; bearish: PriceZone[] } | null;
  liquidity?: {
    equalHighs: number | null;
    equalLows: number | null;
    sweep: "bullish" | "bearish" | null;
  } | null;
  sr?: { support: SrLevel | null; resistance: SrLevel | null } | null;
  volumeRatio?: number | null;
  divergence?: "bullish" | "bearish" | null;
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
  /** Which stop-placement rule produced `stop` (absent on pre-tight payloads). */
  stopMode?: StopMode;
  /** Stop distance expressed in ATR multiples, e.g. 1.2 = 1.2×ATR. */
  stopAtrDist?: number | null;
}

export interface SignalResult {
  symbol: string;
  verdict: Verdict;
  score: number;
  confidence: number; // 0–100 (indicator agreement)
  indicators: SignalIndicators;
  setup: TradeSetup;
  asOf: number;
  /** v2: per-factor breakdown behind the score. */
  factors?: SignalFactor[];
  engine?: "v1" | "v2";
}

export interface SignalSummary {
  symbol: string;
  verdict: Verdict;
  score: number;
  confidence: number;
  trend: SignalIndicators["trend"];
  rsi: number | null;
  /** Average true range of the daily candles — used to judge entry distance. */
  atr: number | null;
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

/** Wilder's RSI (single latest value). */
function rsi(closes: number[], period = 14): number | null {
  const series = rsiSeries(closes, period);
  const last = series[series.length - 1];
  return Number.isFinite(last) ? last : null;
}

/** Wilder's RSI full series (NaN where not yet computable). */
function rsiSeries(closes: number[], period = 14): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = rsiFromAverages(avgGain, avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    out[i] = rsiFromAverages(avgGain, avgLoss);
  }
  return out;
}

function rsiFromAverages(avgGain: number, avgLoss: number): number {
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

// ------------------ v2: price-structure analytics ----------------

const SWING_K = 3; // bars left/right required to confirm a pivot

interface Swing {
  type: "high" | "low";
  idx: number;
  price: number;
}

/** Confirmed pivot highs/lows (k bars on each side — strictly causal). */
function findSwings(points: ChartPoint[], k = SWING_K): Swing[] {
  const swings: Swing[] = [];
  const n = points.length;
  for (let i = k; i < n - k; i++) {
    const h = points[i].h ?? points[i].c;
    const l = points[i].l ?? points[i].c;
    let isHigh = true;
    let isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      const hj = points[j].h ?? points[j].c;
      const lj = points[j].l ?? points[j].c;
      if (hj >= h) isHigh = false;
      if (lj <= l) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) swings.push({ type: "high", idx: i, price: h });
    if (isLow) swings.push({ type: "low", idx: i, price: l });
  }
  return swings.sort((a, b) => a.idx - b.idx);
}

interface BosEvent {
  dir: "up" | "down";
  atIdx: number; // bar whose close broke the swing
  brokenIdx: number; // the swing bar that was broken
  brokenPrice: number;
}

/**
 * Breaks of structure: a close beyond the most recent confirmed swing
 * high (bullish BOS) or swing low (bearish BOS). Each swing can be broken
 * once; a newer swing re-arms the level.
 */
function detectBosEvents(points: ChartPoint[], swings: Swing[]): BosEvent[] {
  const events: BosEvent[] = [];
  let hi: Swing | null = null;
  let lo: Swing | null = null;
  let hiBroken = false;
  let loBroken = false;
  let si = 0;
  const n = points.length;

  for (let j = 0; j < n; j++) {
    // Arm swings once confirmed (idx + k <= j)
    while (si < swings.length && swings[si].idx + SWING_K <= j) {
      const s = swings[si];
      if (s.type === "high") {
        if (!hi || s.price >= hi.price || s.idx > hi.idx) hi = s;
        hiBroken = false;
      } else {
        if (!lo || s.price <= lo.price || s.idx > lo.idx) lo = s;
        loBroken = false;
      }
      si++;
    }

    const c = points[j].c;
    if (hi && !hiBroken && c > hi.price) {
      events.push({ dir: "up", atIdx: j, brokenIdx: hi.idx, brokenPrice: hi.price });
      hiBroken = true;
    }
    if (lo && !loBroken && c < lo.price) {
      events.push({ dir: "down", atIdx: j, brokenIdx: lo.idx, brokenPrice: lo.price });
      loBroken = true;
    }
  }
  return events;
}

interface OrderBlock {
  dir: "bullish" | "bearish";
  top: number;
  bottom: number;
  createdIdx: number; // BOS bar that minted the block
}

/**
 * Order blocks: the last opposite-color candle before the impulse that broke
 * structure (classic SMC definition). A block is invalidated once price
 * CLOSES through its far side.
 */
function findOrderBlocks(points: ChartPoint[], events: BosEvent[]): OrderBlock[] {
  const blocks: OrderBlock[] = [];

  for (const ev of events) {
    const from = Math.max(0, ev.atIdx - 10);
    let zone: OrderBlock | null = null;
    if (ev.dir === "up") {
      for (let i = ev.atIdx - 1; i >= from; i--) {
        if (i > 0 && points[i].c < points[i - 1].c) {
          zone = {
            dir: "bullish",
            top: points[i].h ?? points[i].c,
            bottom: points[i].l ?? points[i].c,
            createdIdx: ev.atIdx,
          };
          break;
        }
      }
    } else {
      for (let i = ev.atIdx - 1; i >= from; i--) {
        if (i > 0 && points[i].c > points[i - 1].c) {
          zone = {
            dir: "bearish",
            top: points[i].h ?? points[i].c,
            bottom: points[i].l ?? points[i].c,
            createdIdx: ev.atIdx,
          };
          break;
        }
      }
    }
    if (zone) blocks.push(zone);
  }

  // Drop invalidated blocks: price closed through the far side after creation.
  const valid = blocks.filter((b) => {
    for (let j = b.createdIdx + 1; j < points.length; j++) {
      const c = points[j].c;
      if (b.dir === "bullish" && c < b.bottom) return false;
      if (b.dir === "bearish" && c > b.top) return false;
    }
    return true;
  });

  const bullish = valid.filter((b) => b.dir === "bullish").slice(-2);
  const bearish = valid.filter((b) => b.dir === "bearish").slice(-2);
  return [...bullish, ...bearish];
}

interface LiquidityPool {
  side: "above" | "below";
  price: number;
  touches: number;
}

/**
 * Liquidity pools: equal highs (buy-side liquidity above) and equal lows
 * (sell-side liquidity below) among confirmed swings — the classic
 * stop-cluster / liquidation zones.
 */
function findLiquidityPools(
  swings: Swing[],
  atrValue: number,
  price: number,
  maxAgeBars = 60,
): LiquidityPool[] {
  const n = swings.length;
  const lastIdx = swings.length ? swings[n - 1].idx : 0;
  const recent = swings.filter((s) => lastIdx - s.idx <= maxAgeBars);
  const tol = 0.2 * atrValue;
  const pools: LiquidityPool[] = [];

  const cluster = (type: "high" | "low") => {
    const items = recent.filter((s) => s.type === type);
    let i = 0;
    while (i < items.length) {
      let j = i + 1;
      const group = [items[i]];
      while (j < items.length && Math.abs(items[j].price - items[i].price) <= tol) {
        group.push(items[j]);
        j++;
      }
      if (group.length >= 2) {
        const prices = group.map((g) => g.price);
        const price = type === "high" ? Math.max(...prices) : Math.min(...prices);
        pools.push({
          side: type === "high" ? "above" : "below",
          price,
          touches: group.length,
        });
      }
      i = j;
    }
  };

  cluster("high");
  cluster("low");

  // Keep the nearest pool above and below the current price.
  const above = pools
    .filter((p) => p.side === "above" && p.price > price)
    .sort((a, b) => a.price - b.price)[0];
  const below = pools
    .filter((p) => p.side === "below" && p.price < price)
    .sort((a, b) => b.price - a.price)[0];
  return [above, below].filter(Boolean) as LiquidityPool[];
}

/**
 * Liquidity sweep: within the last `lookback` bars price WICKED through a
 * pool but CLOSED back inside — a stop-run / liquidation grab. The side of
 * the sweep hints at the reversal direction.
 */
function detectSweep(
  points: ChartPoint[],
  pools: LiquidityPool[],
  lookback = 10,
): "bullish" | "bearish" | null {
  const n = points.length;
  let result: "bullish" | "bearish" | null = null;
  for (let i = Math.max(0, n - lookback); i < n; i++) {
    const h = points[i].h ?? points[i].c;
    const l = points[i].l ?? points[i].c;
    const c = points[i].c;
    const above = pools.find((p) => p.side === "above");
    const below = pools.find((p) => p.side === "below");
    if (above && h > above.price && c < above.price) result = "bearish";
    if (below && l < below.price && c > below.price) result = "bullish";
  }
  return result;
}

/** Merge swing prices into multi-touch S/R levels. */
function clusterSrLevels(
  swings: Swing[],
  atrValue: number,
  price: number,
  maxAgeBars = 120,
): { support: SrLevel | null; resistance: SrLevel | null } {
  const n = swings.length;
  const lastIdx = swings.length ? swings[n - 1].idx : 0;
  const prices = swings
    .filter((s) => lastIdx - s.idx <= maxAgeBars)
    .map((s) => s.price)
    .sort((a, b) => a - b);

  const tol = 0.35 * atrValue;
  const levels: SrLevel[] = [];
  let i = 0;
  while (i < prices.length) {
    let j = i + 1;
    let sum = prices[i];
    let count = 1;
    while (j < prices.length && prices[j] - prices[j - 1] <= tol) {
      sum += prices[j];
      count++;
      j++;
    }
    levels.push({ price: sum / count, touches: count });
    i = j;
  }

  const support =
    levels
      .filter((l) => l.price < price && l.touches >= 2)
      .sort((a, b) => b.price - a.price)[0] ?? null;
  const resistance =
    levels
      .filter((l) => l.price > price && l.touches >= 2)
      .sort((a, b) => a.price - b.price)[0] ?? null;
  return { support, resistance };
}

/** RSI divergence between the last two confirmed swing lows/highs. */
function detectDivergence(
  swings: Swing[],
  rsiVals: number[],
  atrValue: number,
  maxAgeBars = 60,
): "bullish" | "bearish" | null {
  const n = swings.length;
  if (!n) return null;
  const lastIdx = swings[n - 1].idx;
  const recent = swings.filter((s) => lastIdx - s.idx <= maxAgeBars);

  const check = (type: "high" | "low", bullish: boolean): boolean => {
    const items = recent.filter((s) => s.type === type);
    if (items.length < 2) return false;
    const a = items[items.length - 2];
    const b = items[items.length - 1];
    const ra = rsiVals[a.idx];
    const rb = rsiVals[b.idx];
    if (!Number.isFinite(ra) || !Number.isFinite(rb)) return false;
    if (bullish) {
      return b.price < a.price - 0.1 * atrValue && rb > ra + 2;
    }
    return b.price > a.price + 0.1 * atrValue && rb < ra - 2;
  };

  if (check("low", true)) return "bullish";
  if (check("high", false)) return "bearish";
  return null;
}

// --------------------------- Engine ----------------------------

const MIN_POINTS = 36; // enough for SMA20/50 + MACD warm-up

/**
 * Verdict thresholds. v2 adds up to ±4.5 of new confluence votes, so the
 * bands are wider than v1 (±1 / ±2.5). Calibrated on 1-year backtests —
 * see scripts/backtest.ts.
 */
export const SIGNAL_THRESHOLDS = {
  buy: 1.5,
  strongBuy: 3.5,
  sell: -1.5,
  strongSell: -3.5,
};

/** Backtest calibration hook (not used by the app). */
export function setSignalThresholds(t: Partial<typeof SIGNAL_THRESHOLDS>): void {
  Object.assign(SIGNAL_THRESHOLDS, t);
}

export function computeSignal(chart: ChartData, opts?: { stopMode?: StopMode }): SignalResult {
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
        structure: null,
        orderBlocks: null,
        liquidity: null,
        sr: null,
        volumeRatio: null,
        divergence: null,
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
      factors: [],
      engine: "v2",
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

  // ---- v2 structure analytics (all causal) ----
  const swings = findSwings(points);
  const bosEvents = detectBosEvents(points, swings);
  const lastEvent = bosEvents[bosEvents.length - 1] ?? null;
  const structure: SignalIndicators["structure"] = lastEvent
    ? lastEvent.dir === "up"
      ? "Bullish"
      : "Bearish"
    : "Range";

  const blocks = a ? findOrderBlocks(points, bosEvents) : [];
  const atrForZones = a ?? price * 0.02;
  const nearZone = 0.25 * atrForZones;
  const activeBullOb = blocks
    .filter((b) => b.dir === "bullish")
    .reverse()
    .find(
      (b) =>
        price >= b.bottom - nearZone && price <= b.top + nearZone,
    );
  const activeBearOb = blocks
    .filter((b) => b.dir === "bearish")
    .reverse()
    .find(
      (b) =>
        price >= b.bottom - nearZone && price <= b.top + nearZone,
    );

  const pools = a ? findLiquidityPools(swings, a, price) : [];
  const sweep = a ? detectSweep(points, pools) : null;
  const srClusters = a
    ? clusterSrLevels(swings, a, price)
    : { support: null, resistance: null };
  const rsiVals = rsiSeries(closes);
  const divergence = a ? detectDivergence(swings, rsiVals, a) : null;

  const volumes = points.map((p) => p.v).filter((v): v is number => typeof v === "number" && v > 0);
  const volAvg20 = volumes.length >= 5 ? volumes.slice(-21, -1).reduce((x, y) => x + y, 0) / Math.min(20, volumes.slice(0, -1).length) : null;
  const lastVol = typeof points[points.length - 1].v === "number" ? (points[points.length - 1].v as number) : null;
  const volumeRatio = lastVol && volAvg20 ? lastVol / volAvg20 : null;
  const upBar = closes[closes.length - 1] > closes[closes.length - 2];
  const downBar = closes[closes.length - 1] < closes[closes.length - 2];

  const srSupportNear =
    srClusters.support != null && a != null && price - srClusters.support.price <= 0.5 * a;
  const srResistanceNear =
    srClusters.resistance != null && a != null && srClusters.resistance.price - price <= 0.5 * a;

  // ---- Composite score (factor list drives notes + UI) ----
  const factors: SignalFactor[] = [];
  const add = (key: string, label: string, weight: number, detail: string) => {
    if (weight !== 0) factors.push({ key, label, weight: round2(weight), detail });
  };

  // 1) Trend structure
  if (trend === "Uptrend") {
    add("trend", "Trend structure", 2, "Price above both SMA20 and SMA50 — bullish structure.");
  } else if (trend === "Downtrend") {
    add("trend", "Trend structure", -2, "Price below both SMA20 and SMA50 — bearish structure.");
  } else if (s50 != null) {
    add(
      "trend",
      "Trend structure",
      price > s50 ? 1 : -1,
      price > s50
        ? "Price above SMA50 — mild bullish bias inside a mixed trend."
        : "Price below SMA50 — mild bearish bias inside a mixed trend.",
    );
  }
  if (goldenCross) {
    add("cross", "SMA cross", 0.5, "Recent SMA20/SMA50 golden cross.");
  } else if (deathCross) {
    add("cross", "SMA cross", -0.5, "Recent SMA20/SMA50 death cross.");
  }

  // 2) MACD momentum
  if (m) {
    if (m.histogram > 0 && m.histogram > m.prevHistogram) {
      add("macd", "MACD momentum", 1.5, "MACD histogram positive and rising — momentum building.");
    } else if (m.histogram > 0) {
      add("macd", "MACD momentum", 0.5, "MACD positive but fading.");
    } else if (m.histogram < 0 && m.histogram < m.prevHistogram) {
      add("macd", "MACD momentum", -1.5, "MACD histogram negative and falling — selling pressure.");
    } else {
      add("macd", "MACD momentum", -0.5, "MACD negative but improving.");
    }
  }

  // 3) RSI bands
  if (r != null) {
    if (r >= 70) {
      add("rsi", "RSI (14)", -1, `RSI ${r.toFixed(0)} — overbought, pullback risk.`);
    } else if (r <= 30) {
      add("rsi", "RSI (14)", 1, `RSI ${r.toFixed(0)} — oversold, bounce potential.`);
    } else {
      add(
        "rsi",
        "RSI (14)",
        (r - 50) / 50,
        `RSI ${r.toFixed(0)} — ${r >= 50 ? "bullish" : "bearish"} momentum zone.`,
      );
    }
  }

  // 4) Short-term momentum (5-day)
  const r5 = (closes[closes.length - 1] - closes[closes.length - 6]) / closes[closes.length - 6];
  if (r5 > 0.01) {
    add("momentum", "5-day momentum", 1, `+${(r5 * 100).toFixed(1)}% over 5 sessions — short-term strength.`);
  } else if (r5 < -0.01) {
    add("momentum", "5-day momentum", -1, `${(r5 * 100).toFixed(1)}% over 5 sessions — short-term weakness.`);
  }

  // 5) Position within 20-day range
  const range = resistance - support;
  if (range > 0) {
    const pos = (price - support) / range;
    if (pos < 0.2) {
      add("rangePos", "20-day range", 0.5, "Trading near 20-day support.");
    } else if (pos > 0.8) {
      add("rangePos", "20-day range", -0.5, "Trading near 20-day resistance.");
    }
  }

  // 6) Market structure (BOS)
  if (structure === "Bullish") {
    add("structure", "Market structure", 1, "Bullish break of structure — higher highs in play.");
  } else if (structure === "Bearish") {
    add("structure", "Market structure", -1, "Bearish break of structure — lower lows in play.");
  }

  // 7) Order block confluence
  if (activeBullOb) {
    add(
      "orderBlock",
      "Order block",
      1,
      `Price pulled back into a bullish order block (${round2(activeBullOb.bottom)}–${round2(activeBullOb.top)}).`,
    );
  }
  if (activeBearOb) {
    add(
      "orderBlock",
      "Order block",
      -1,
      `Price rallied into a bearish order block (${round2(activeBearOb.bottom)}–${round2(activeBearOb.top)}).`,
    );
  }

  // 8) Liquidity sweep
  if (sweep === "bullish") {
    add("sweep", "Liquidity sweep", 1, "Stop-run below equal lows closed back inside — bullish reversal tell.");
  } else if (sweep === "bearish") {
    add("sweep", "Liquidity sweep", -1, "Stop-run above equal highs closed back inside — bearish reversal tell.");
  }

  // 9) Tested S/R reaction
  if (srSupportNear && upBar) {
    add(
      "sr",
      "Support / resistance",
      1,
      `Bouncing off tested support ${round2(srClusters.support!.price)} (${srClusters.support!.touches} touches).`,
    );
  } else if (srResistanceNear && downBar) {
    add(
      "sr",
      "Support / resistance",
      -1,
      `Rejected at tested resistance ${round2(srClusters.resistance!.price)} (${srClusters.resistance!.touches} touches).`,
    );
  }

  // 10) Volume confirmation
  if (volumeRatio != null && volumeRatio >= 1.4) {
    if (upBar) {
      add("volume", "Volume", 0.5, `Volume ${volumeRatio.toFixed(1)}x average on an up close — buyers participating.`);
    } else if (downBar) {
      add("volume", "Volume", -0.5, `Volume ${volumeRatio.toFixed(1)}x average on a down close — sellers participating.`);
    }
  }

  // 11) RSI divergence
  if (divergence === "bullish") {
    add("divergence", "RSI divergence", 1, "Bullish divergence — price lower low, RSI higher low.");
  } else if (divergence === "bearish") {
    add("divergence", "RSI divergence", -1, "Bearish divergence — price higher high, RSI lower high.");
  }

  const score = factors.reduce((acc, f) => acc + f.weight, 0);

  // ---- Verdict ----
  let verdict: Verdict = "Neutral";
  if (score >= SIGNAL_THRESHOLDS.strongBuy) verdict = "Strong Buy";
  else if (score >= SIGNAL_THRESHOLDS.buy) verdict = "Buy";
  else if (score <= SIGNAL_THRESHOLDS.strongSell) verdict = "Strong Sell";
  else if (score <= SIGNAL_THRESHOLDS.sell) verdict = "Sell";

  // Confidence = share of casting votes that agree with the verdict direction
  const bullish = verdict === "Strong Buy" || verdict === "Buy";
  const bearish = verdict === "Sell" || verdict === "Strong Sell";

  let agree = 0;
  let total = 0;
  const vote = (isBullishVote: boolean | null) => {
    if (isBullishVote == null) return;
    total++;
    if (bullish && isBullishVote) agree++;
    if (bearish && !isBullishVote) agree++;
  };

  if (trend === "Uptrend") vote(true);
  else if (trend === "Downtrend") vote(false);
  else if (s50 != null) vote(price > s50);
  if (m) vote(m.histogram > 0);
  if (r != null) vote(r > 50);
  vote(r5 > 0);
  if (structure !== "Range") vote(structure === "Bullish");
  if (sweep != null) vote(sweep === "bullish");
  if (divergence != null) vote(divergence === "bullish");

  const confidence =
    verdict === "Neutral" ? 40 : Math.round((agree / Math.max(total, 1)) * 100);

  // ---- Trade setup ----
  const stopMode: StopMode = opts?.stopMode ?? "balanced";
  const riskLevel: TradeSetup["riskLevel"] =
    annualVol < 25 ? "Low" : annualVol < 45 ? "Medium" : "High";

  const atrUnit = a != null ? a : price * 0.02;
  const twoAtr = 2 * atrUnit;
  const fourAtr = 4 * atrUnit;

  let direction: TradeSetup["direction"] = "Wait";
  let entry = price;
  let stop = price;
  let t1 = price;
  let t2 = price;

  if (bullish) {
    direction = "Long";
    if (stopMode === "tight") {
      // Tight long stop: closer of 1×ATR below entry and just-under the most
      // recent confirmed swing low (higher low of the uptrend), never tighter
      // than 0.5×ATR (noise floor).
      const swingLowsBelow = swings.filter((s) => s.type === "low" && s.price < price);
      const lastLow = swingLowsBelow[swingLowsBelow.length - 1];
      stop = price - atrUnit;
      if (lastLow) {
        const structStop = lastLow.price - 0.15 * atrUnit;
        if (structStop > stop && structStop < price) stop = structStop;
      }
      stop = Math.min(stop, price - 0.5 * atrUnit);
    } else {
      stop = Math.min(support, price - twoAtr);
    }
    t1 = Math.max(resistance, price + twoAtr);
    t2 = price + fourAtr;
  } else if (bearish) {
    direction = "Short";
    if (stopMode === "tight") {
      // Tight short stop: closer of 1×ATR above entry and just-over the most
      // recent confirmed swing high (lower high of the downtrend), never
      // tighter than 0.5×ATR (noise floor).
      const swingHighsAbove = swings.filter((s) => s.type === "high" && s.price > price);
      const lastHigh = swingHighsAbove[swingHighsAbove.length - 1];
      stop = price + atrUnit;
      if (lastHigh) {
        const structStop = lastHigh.price + 0.15 * atrUnit;
        if (structStop < stop && structStop > price) stop = structStop;
      }
      stop = Math.max(stop, price + 0.5 * atrUnit);
    } else {
      stop = Math.max(resistance, price + twoAtr);
    }
    t1 = Math.min(support, price - twoAtr);
    t2 = price - fourAtr;
  }

  const risk = Math.abs(entry - stop);
  const reward = Math.abs(t1 - entry);
  const riskReward = risk > 0 ? round2(reward / risk) : null;
  const stopAtrDist = a != null && risk > 0 ? round2(risk / a) : null;

  const stopNote =
    direction === "Wait"
      ? []
      : [
          stopMode === "tight"
            ? `Tight stop — closer of 1×ATR and just-below the last swing pivot${stopAtrDist != null ? ` (${stopAtrDist}×ATR from entry)` : ""}.`
            : `Balanced stop — farther of the 20-day S/R and 2×ATR${stopAtrDist != null ? ` (${stopAtrDist}×ATR from entry)` : ""}.`,
        ];

  const notes = [
    ...stopNote,
    ...factors.map((f) => f.detail),
    ...(direction === "Wait"
      ? ["No clear edge — wait for trend or momentum confirmation."]
      : []),
  ].slice(0, 8);

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
      structure,
      orderBlocks: {
        bullish: blocks
          .filter((b) => b.dir === "bullish")
          .slice(-2)
          .map((b) => ({
            top: round2(b.top),
            bottom: round2(b.bottom),
            createdAt: (points[b.createdIdx]?.t ?? 0) * 1000 || Date.now(),
          })),
        bearish: blocks
          .filter((b) => b.dir === "bearish")
          .slice(-2)
          .map((b) => ({
            top: round2(b.top),
            bottom: round2(b.bottom),
            createdAt: (points[b.createdIdx]?.t ?? 0) * 1000 || Date.now(),
          })),
      },
      liquidity: {
        equalHighs: pools.find((p) => p.side === "above")
          ? round2(pools.find((p) => p.side === "above")!.price)
          : null,
        equalLows: pools.find((p) => p.side === "below")
          ? round2(pools.find((p) => p.side === "below")!.price)
          : null,
        sweep,
      },
      sr: {
        support: srClusters.support
          ? { price: round2(srClusters.support.price), touches: srClusters.support.touches }
          : null,
        resistance: srClusters.resistance
          ? { price: round2(srClusters.resistance.price), touches: srClusters.resistance.touches }
          : null,
      },
      volumeRatio: volumeRatio != null ? round2(volumeRatio) : null,
      divergence,
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
      stopMode,
      stopAtrDist,
    },
    asOf: Date.now(),
    factors,
    engine: "v2",
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
    atr: result.indicators.atr,
  };
}
