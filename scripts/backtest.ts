/**
 * OpenStock signal backtest — v1 vs v2 engine, 1 year, long + short.
 *
 * v1 = exact port of the original 5-voter engine.
 * v2 = the REAL engine (src/lib/signals.ts) imported directly, so the
 *      backtest is perfectly faithful to what the app computes.
 *
 * Shared rules (both engines):
 *  - Entry = signal-day close (what the app records as entryPrice).
 *  - Tracking walks candles from the next day, SL-first within a candle
 *    (conservative), TP1_HIT keeps running to TP2/SL, one trade per symbol.
 *  - Setup levels identical: stop = 20d extreme or ±2*ATR (farther),
 *    TP1 = 20d extreme or ±2*ATR (farther), TP2 = ±4*ATR.
 *
 * No fees / slippage. Educational use only — NOT financial advice.
 *
 * Run: bun scripts/backtest.ts
 */

import {
  computeSignal,
  setSignalThresholds,
  SIGNAL_THRESHOLDS,
} from "../src/lib/signals";

// ---------------------------- Universe ----------------------------

const APP_UNIVERSE = ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "GOOGL", "BTC-USD"];
const EXTRA_UNIVERSE = [
  "META", "AMD", "INTC", "ORCL", "NFLX", "AVGO", "JPM",
  "XOM", "UNH", "DIS", "BA", "CAT", "WMT",
];

const WINDOW_DAYS = 365;
const FETCH_RANGE = "18mo";

// ------------------------- Yahoo fetching -------------------------

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
let hostIdx = 0;

interface RawPoint {
  t: number;
  o: number;
  c: number;
  h: number | null;
  l: number | null;
  v: number | null;
}

async function yahooFetch(path: string): Promise<any> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const base = HOSTS[hostIdx++ % HOSTS.length];
    try {
      const res = await fetch(`${base}${path}`, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Yahoo responded ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Yahoo request failed");
}

async function fetchDaily(symbol: string): Promise<RawPoint[]> {
  const s = encodeURIComponent(symbol.trim().toUpperCase());
  const json = await yahooFetch(
    `/v8/finance/chart/${s}?range=${FETCH_RANGE}&interval=1d&includePrePost=false`,
  );
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(json?.chart?.error?.description || `No data for ${symbol}`);
  const ts: number[] = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const points: RawPoint[] = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q.close?.[i];
    if (typeof c === "number" && Number.isFinite(c)) {
      points.push({
        t: ts[i],
        o: typeof q.open?.[i] === "number" ? q.open[i] : c,
        c,
        h: typeof q.high?.[i] === "number" ? q.high[i] : null,
        l: typeof q.low?.[i] === "number" ? q.low[i] : null,
        v: typeof q.volume?.[i] === "number" ? q.volume[i] : null,
      });
    }
  }
  return points;
}

async function fetchAll(symbols: string[]): Promise<Map<string, RawPoint[]>> {
  const out = new Map<string, RawPoint[]>();
  const chunk = 4;
  for (let i = 0; i < symbols.length; i += chunk) {
    const batch = symbols.slice(i, i + chunk);
    const results = await Promise.allSettled(batch.map((s) => fetchDaily(s)));
    results.forEach((r, j) => {
      if (r.status === "fulfilled") out.set(batch[j], r.value);
      else console.error(`  ! ${batch[j]}: ${r.status === "rejected" ? r.reason?.message : "failed"}`);
    });
    if (i + chunk < symbols.length) await new Promise((r) => setTimeout(r, 400));
  }
  return out;
}

// -------------------- v1 engine (exact port) ----------------------

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

function macd1(closes: number[]) {
  if (closes.length < 35) return null;
  const e12 = emaSeries(closes, 12);
  const e26 = emaSeries(closes, 26);
  const macdLine = e12.map((v, i) => v - e26[i]);
  const signalLine = emaSeries(macdLine.slice(25), 9);
  const lastMacd = macdLine[macdLine.length - 1];
  const lastSignal = signalLine[signalLine.length - 1];
  return {
    histogram: lastMacd - lastSignal,
    prevHistogram: macdLine[macdLine.length - 2] - signalLine[signalLine.length - 2],
  };
}

function atr1(points: RawPoint[], period = 14): number | null {
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

const round2 = (n: number) => Math.round(n * 100) / 100;

interface Setup {
  direction: "Long" | "Short" | "Wait";
  verdict: string;
  entry: number;
  stop: number;
  target1: number;
  target2: number;
}

const MIN_POINTS = 36;

function v1SetupAt(points: RawPoint[], i: number): Setup | null {
  const slice = points.slice(0, i + 1);
  const closes = slice.map((p) => p.c);
  const price = closes[closes.length - 1] ?? 0;
  if (slice.length < MIN_POINTS || price <= 0) return null;

  const s20 = sma(closes, 20);
  const s50 = sma(closes, 50);
  const r = rsi(closes);
  const m = macd1(closes);
  const a = atr1(slice);

  const lookback = slice.slice(-20);
  const lows = lookback.map((p) => p.l ?? p.c);
  const highs = lookback.map((p) => p.h ?? p.c);
  const support = Math.min(...lows);
  const resistance = Math.max(...highs);

  const s20v = s20 ?? NaN;
  const s50v = s50 ?? NaN;
  const prev20 = sma(closes.slice(0, -5), 20);
  const prev50 = sma(closes.slice(0, -5), 50);
  const goldenCross = prev20 != null && prev50 != null && prev20 <= prev50 && s20v > s50v;
  const deathCross = prev20 != null && prev50 != null && prev20 >= prev50 && s20v < s50v;

  let trend: "Uptrend" | "Downtrend" | "Sideways" = "Sideways";
  if (price > s20v && s20v > s50v) trend = "Uptrend";
  else if (price < s20v && s20v < s50v) trend = "Downtrend";

  let score = 0;
  if (trend === "Uptrend") score += 2;
  else if (trend === "Downtrend") score -= 2;
  else if (s50 != null) score += price > s50 ? 1 : -1;
  if (goldenCross) score += 0.5;
  else if (deathCross) score -= 0.5;
  if (m) {
    if (m.histogram > 0 && m.histogram > m.prevHistogram) score += 1.5;
    else if (m.histogram > 0) score += 0.5;
    else if (m.histogram < 0 && m.histogram < m.prevHistogram) score -= 1.5;
    else score -= 0.5;
  }
  if (r != null) {
    if (r >= 70) score -= 1;
    else if (r <= 30) score += 1;
    else score += (r - 50) / 50;
  }
  const r5 = (closes[closes.length - 1] - closes[closes.length - 6]) / closes[closes.length - 6];
  if (r5 > 0.01) score += 1;
  else if (r5 < -0.01) score -= 1;
  const range = resistance - support;
  if (range > 0) {
    const pos = (price - support) / range;
    if (pos < 0.2) score += 0.5;
    else if (pos > 0.8) score -= 0.5;
  }

  let verdict = "Neutral";
  if (score >= 2.5) verdict = "Strong Buy";
  else if (score >= 1) verdict = "Buy";
  else if (score <= -2.5) verdict = "Strong Sell";
  else if (score <= -1) verdict = "Sell";

  const bullish = verdict === "Strong Buy" || verdict === "Buy";
  const bearish = verdict === "Sell" || verdict === "Strong Sell";
  const twoAtr = a != null ? 2 * a : price * 0.04;
  const fourAtr = a != null ? 4 * a : price * 0.08;

  let direction: Setup["direction"] = "Wait";
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
  }

  const entry = round2(price);
  const setup: Setup = { direction, verdict, entry, stop: round2(stop), target1: round2(t1), target2: round2(t2) };
  if (direction === "Wait" || setup.stop === entry || setup.target1 === entry) return null;
  return setup;
}

// ---------------------- v2 provider (real engine) -----------------

// Stop-placement style for this run — set via env, e.g.:
//   SL_MODE=tight bun scripts/backtest.ts
const SL_MODE: "tight" | "balanced" =
  process.env.SL_MODE === "tight" ? "tight" : "balanced";

function v2SetupAt(symbol: string, points: RawPoint[], i: number): Setup | null {
  const slice = points.slice(0, i + 1);
  const chart = {
    symbol,
    range: "1y",
    interval: "1d",
    currency: "USD",
    points: slice,
    previousClose: slice[0]?.c ?? 0,
  };
  const sig = computeSignal(chart, { stopMode: SL_MODE });
  const { direction, entry, stop, target1, target2 } = sig.setup;
  if (direction === "Wait" || stop === entry || target1 === entry) return null;
  return { direction, verdict: sig.verdict, entry, stop, target1, target2 };
}

// --------------------- Trade simulation ---------------------------

type Outcome = "TP2_HIT" | "SL_HIT_TP1" | "SL_HIT" | "OPEN";

interface Trade {
  symbol: string;
  direction: "Long" | "Short";
  verdict: string;
  entryDate: string;
  exitDate: string | null;
  entry: number;
  stop: number;
  target1: number;
  target2: number;
  outcome: Outcome;
  hitTp1: boolean;
  playbookPnlPct: number;
  rMultiple: number;
  daysHeld: number;
}

const pct = (a: number, b: number) => (b !== 0 ? ((a - b) / b) * 100 : 0);
const signedPct = (direction: "Long" | "Short", level: number, entry: number) =>
  direction === "Long" ? pct(level, entry) : pct(entry, level);
const fmtDate = (tSec: number) => new Date(tSec * 1000).toISOString().slice(0, 10);

function simulate(
  symbol: string,
  points: RawPoint[],
  windowStartMs: number,
  provider: (points: RawPoint[], i: number) => Setup | null,
): Trade[] {
  const trades: Trade[] = [];

  interface Active {
    entryIdx: number;
    direction: "Long" | "Short";
    verdict: string;
    entry: number;
    stop: number;
    target1: number;
    target2: number;
    hitTp1: boolean;
    tp1PnlPct: number;
  }
  let active: Active | null = null;

  const closeTrade = (a: Active, outcome: Outcome, exitIdx: number | null) => {
    const exitT = exitIdx != null ? points[exitIdx].t : points[points.length - 1].t;
    const exitPrice =
      outcome === "TP2_HIT"
        ? a.target2
        : outcome === "OPEN"
          ? points[points.length - 1].c
          : a.stop;
    const rawPnlPct = signedPct(a.direction, exitPrice, a.entry);
    const playbookPnlPct =
      outcome === "SL_HIT_TP1" ? 0.5 * a.tp1PnlPct + 0.5 * rawPnlPct : rawPnlPct;
    const riskPct = Math.abs(signedPct(a.direction, a.stop, a.entry));
    trades.push({
      symbol,
      direction: a.direction,
      verdict: a.verdict,
      entryDate: fmtDate(points[a.entryIdx].t),
      exitDate: fmtDate(exitT),
      entry: a.entry,
      stop: a.stop,
      target1: a.target1,
      target2: a.target2,
      outcome,
      hitTp1: a.hitTp1,
      playbookPnlPct: round2(playbookPnlPct),
      rMultiple: riskPct > 0 ? round2(playbookPnlPct / riskPct) : 0,
      daysHeld: Math.max(0, Math.round((exitT - points[a.entryIdx].t) / 86400)),
    });
  };

  for (let i = 0; i < points.length; i++) {
    if (active && i > active.entryIdx) {
      const c = points[i];
      const high = c.h ?? c.c;
      const low = c.l ?? c.c;
      const a = active;
      if (a.direction === "Long") {
        if (low <= a.stop) {
          closeTrade(a, a.hitTp1 ? "SL_HIT_TP1" : "SL_HIT", i);
          active = null;
        } else if (high >= a.target2) {
          a.hitTp1 = true;
          closeTrade(a, "TP2_HIT", i);
          active = null;
        } else if (high >= a.target1 && !a.hitTp1) {
          a.hitTp1 = true;
          a.tp1PnlPct = round2(signedPct("Long", a.target1, a.entry));
        }
      } else {
        if (high >= a.stop) {
          closeTrade(a, a.hitTp1 ? "SL_HIT_TP1" : "SL_HIT", i);
          active = null;
        } else if (low <= a.target2) {
          a.hitTp1 = true;
          closeTrade(a, "TP2_HIT", i);
          active = null;
        } else if (low <= a.target1 && !a.hitTp1) {
          a.hitTp1 = true;
          a.tp1PnlPct = round2(signedPct("Short", a.target1, a.entry));
        }
      }
    }

    if (!active && points[i].t * 1000 >= windowStartMs) {
      const setup = provider(points, i);
      if (setup && (setup.direction === "Long" || setup.direction === "Short")) {
        active = {
          entryIdx: i,
          direction: setup.direction,
          verdict: setup.verdict,
          entry: setup.entry,
          stop: setup.stop,
          target1: setup.target1,
          target2: setup.target2,
          hitTp1: false,
          tp1PnlPct: 0,
        };
      }
    }
  }

  if (active) closeTrade(active, "OPEN", null);
  return trades;
}

// -------------------------- Aggregation ---------------------------

interface Stats {
  total: number;
  fullWins: number;
  partials: number;
  losses: number;
  open: number;
  tp1Rate: number;
  fullWinRate: number;
  slFirstRate: number;
  avgPnlPct: number;
  avgR: number;
  sumR: number;
  avgDays: number;
}

const pctOf = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

function statsOf(trades: Trade[]): Stats {
  const n = trades.length || 1;
  const fullWins = trades.filter((t) => t.outcome === "TP2_HIT").length;
  const partials = trades.filter((t) => t.outcome === "SL_HIT_TP1").length;
  const losses = trades.filter((t) => t.outcome === "SL_HIT").length;
  const open = trades.filter((t) => t.outcome === "OPEN").length;
  const tp1 = trades.filter((t) => t.hitTp1).length;
  return {
    total: trades.length,
    fullWins,
    partials,
    losses,
    open,
    tp1Rate: pctOf(tp1, trades.length),
    fullWinRate: pctOf(fullWins, trades.length),
    slFirstRate: pctOf(losses, trades.length),
    avgPnlPct: round2(trades.reduce((a, t) => a + t.playbookPnlPct, 0) / n),
    avgR: round2(trades.reduce((a, t) => a + t.rMultiple, 0) / n),
    sumR: round2(trades.reduce((a, t) => a + t.rMultiple, 0)),
    avgDays: Math.round(trades.reduce((a, t) => a + t.daysHeld, 0) / n),
  };
}

function fmtStats(s: Stats): string {
  return (
    `trades=${String(s.total).padStart(3)}  TP2win=${String(s.fullWins).padStart(3)} (${String(s.fullWinRate).padStart(5)}%)  ` +
    `TP1->SL=${String(s.partials).padStart(3)}  SLfirst=${String(s.losses).padStart(3)} (${String(s.slFirstRate).padStart(5)}%)  ` +
    `open=${String(s.open).padStart(3)}  TP1hit=${String(s.tp1Rate).padStart(5)}%  ` +
    `avgPnL=${String(s.avgPnlPct).padStart(6)}%  sumR=${String(s.sumR).padStart(6)}`
  );
}

// ----------------------------- Main -------------------------------

interface EngineConfig {
  label: string;
  run: (symbol: string, points: RawPoint[], windowStartMs: number) => Trade[];
}

async function main() {
  console.log(
    `OpenStock backtest — v1 vs v2, signals in the last ${WINDOW_DAYS} days [SL_MODE=${SL_MODE}]\n`,
  );
  const windowStartMs = Date.now() - WINDOW_DAYS * 86400 * 1000;

  const all = [...APP_UNIVERSE, ...EXTRA_UNIVERSE];
  console.log(`Fetching ${FETCH_RANGE} daily data for ${all.length} symbols...`);
  const data = await fetchAll(all);
  console.log(`Got data for ${data.size}/${all.length} symbols.\n`);

  const tradable = [...data.entries()].filter(([, p]) => p.length >= 120);

  // --- Engine configs ---
  const engines: EngineConfig[] = [
    {
      label: "v1 (5 voters, thr ±1/±2.5)",
      run: (s, p, w) => simulate(s, p, w, (pts, i) => v1SetupAt(pts, i)),
    },
    {
      label: `v2 default (thr ${SIGNAL_THRESHOLDS.buy}/${SIGNAL_THRESHOLDS.strongBuy})`,
      run: (s, p, w) => simulate(s, p, w, (pts, i) => v2SetupAt(s, pts, i)),
    },
  ];

  // v2 threshold calibration grid (small, disclosed)
  const grid: Array<Partial<typeof SIGNAL_THRESHOLDS>> = [
    { buy: 2, strongBuy: 4, sell: -2, strongSell: -4 },
    { buy: 1, strongBuy: 3, sell: -1, strongSell: -3 },
  ];
  grid.forEach((g, gi) => {
    engines.push({
      label: `v2 thr${gi + 1} (thr ${g.buy}/${g.strongBuy})`,
      run: (s, p, w) => {
        setSignalThresholds(g);
        const t = simulate(s, p, w, (pts, i) => v2SetupAt(s, pts, i));
        setSignalThresholds({ buy: 1.5, strongBuy: 3.5, sell: -1.5, strongSell: -3.5 });
        return t;
      },
    });
  });

  const results = new Map<string, Map<string, Trade[]>>();
  for (const eng of engines) {
    const perSymbol = new Map<string, Trade[]>();
    for (const [symbol, points] of tradable) {
      perSymbol.set(symbol, eng.run(symbol, points, windowStartMs));
    }
    results.set(eng.label, perSymbol);
    console.log(`  ran: ${eng.label}`);
  }
  console.log("");

  const agg = (label: string, filter: (t: Trade) => boolean, universe?: string[]) => {
    console.log(`--- ${label} ---`);
    for (const eng of engines) {
      const perSymbol = results.get(eng.label)!;
      let trades: Trade[] = [];
      for (const [sym, ts] of perSymbol) {
        if (universe && !universe.includes(sym)) continue;
        trades = trades.concat(ts);
      }
      const longs = statsOf(trades.filter((t) => t.direction === "Long"));
      const shorts = statsOf(trades.filter((t) => t.direction === "Short"));
      console.log(`${eng.label.padEnd(34)} LONG  ${fmtStats(longs)}`);
      console.log(`${" ".repeat(34)} SHORT ${fmtStats(shorts)}`);
    }
    console.log("");
  };

  agg("APP WATCHLIST universe (7 symbols)", () => true, APP_UNIVERSE);
  agg("BROAD universe (20 symbols)", () => true);

  // Detail: strong-only for the default v2 on broad universe
  console.log("--- BROAD universe — Strong signals only ---");
  for (const eng of engines) {
    const perSymbol = results.get(eng.label)!;
    let trades: Trade[] = [];
    for (const [, ts] of perSymbol) trades = trades.concat(ts);
    const sb = statsOf(trades.filter((t) => t.direction === "Long" && t.verdict === "Strong Buy"));
    const ss = statsOf(trades.filter((t) => t.direction === "Short" && t.verdict === "Strong Sell"));
    console.log(`${eng.label.padEnd(34)} StrongBuy  ${fmtStats(sb)}`);
    console.log(`${" ".repeat(34)} StrongSell ${fmtStats(ss)}`);
  }
  console.log("");

  // Trade log for app watchlist, v2 default engine
  const v2Label = engines[1].label;
  console.log(`=== Trade log (app watchlist, ${v2Label}) ===`);
  for (const s of APP_UNIVERSE) {
    const ts = results.get(v2Label)?.get(s) ?? [];
    for (const t of ts) {
      console.log(
        `${t.symbol.padEnd(8)} ${t.direction === "Long" ? "LONG " : "SHORT"} ${t.verdict.padEnd(11)} ` +
          `${t.entryDate} entry=${t.entry} sl=${t.stop} tp1=${t.target1} tp2=${t.target2} -> ` +
          `${t.outcome.padEnd(9)} exit=${t.exitDate} pnl=${t.playbookPnlPct}% R=${t.rMultiple}`,
      );
    }
  }
}

main().catch((e) => {
  console.error("Backtest failed:", e);
  process.exit(1);
});
