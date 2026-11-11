/**
 * OpenStock signal backtest — 1 year, long + short.
 *
 * Faithfully mirrors the app:
 *  - Signal engine: exact port of src/lib/signals.ts (SMA20/50 trend ±2,
 *    golden/death cross ±0.5, MACD ±1.5/±0.5, RSI ±1 / mid-vote, 5-day
 *    momentum ±1, 20-day range position ±0.5; verdict >=1 Buy / >=2.5 Strong
 *    Buy / <=-1 Sell / <=-2.5 Strong Sell).
 *  - Setup levels: exact port (stop = 20d extreme or price-/+2*ATR whichever
 *    is FARTHER; TP1 = 20d extreme or +/-2*ATR whichever farther; TP2 = +/-4*ATR).
 *  - Tracking: exact port of src/lib/trade-status.ts walk — candles judged
 *    from the day AFTER entry (entry at signal close = app behavior), within
 *    one candle the STOP is checked first (conservative), TP1_HIT keeps
 *    running until TP2 or SL.
 *  - One active trade per symbol (app rejects duplicates).
 *
 * Entry = signal-day close (that is exactly what the app records as
 * entryPrice when the user taps "I Took This Trade").
 *
 * No fees / slippage. Educational use only — NOT financial advice.
 *
 * Run: bun scripts/backtest.ts
 */

// ---------------------------- Universe ----------------------------

/** The app's watchlist (what the user actually sees signals for) + BTC-USD. */
const APP_UNIVERSE = ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "GOOGL", "BTC-USD"];
/** Extra liquid names to enlarge the sample (reported separately). */
const EXTRA_UNIVERSE = [
  "META", "AMD", "INTC", "ORCL", "NFLX", "AVGO", "JPM",
  "XOM", "UNH", "DIS", "BA", "CAT", "WMT",
];

const WINDOW_DAYS = 365; // signals only taken in the last 365 days
const FETCH_RANGE = "18mo"; // extra history for indicator warm-up

// ------------------------- Yahoo fetching -------------------------

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
let hostIdx = 0;

interface RawPoint {
  t: number; // epoch seconds
  o: number; // open (unused for entry, kept for completeness)
  c: number;
  h: number | null;
  l: number | null;
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

// -------------------- Indicators (exact port) ---------------------

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

function macd(closes: number[]) {
  if (closes.length < 35) return null;
  const e12 = emaSeries(closes, 12);
  const e26 = emaSeries(closes, 26);
  const macdLine = e12.map((v, i) => v - e26[i]);
  const signalLine = emaSeries(macdLine.slice(25), 9);
  const lastMacd = macdLine[macdLine.length - 1];
  const lastSignal = signalLine[signalLine.length - 1];
  return {
    macd: lastMacd,
    signal: lastSignal,
    histogram: lastMacd - lastSignal,
    prevHistogram: macdLine[macdLine.length - 2] - signalLine[signalLine.length - 2],
  };
}

function atr(points: RawPoint[], period = 14): number | null {
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

// -------------------- Signal engine (exact port) -------------------

const MIN_POINTS = 36;

type Direction = "Long" | "Short" | "Wait";
type Verdict = "Strong Buy" | "Buy" | "Neutral" | "Sell" | "Strong Sell";

interface Setup {
  direction: Direction;
  verdict: Verdict;
  entry: number;
  stop: number;
  target1: number;
  target2: number;
}

function computeSetupAt(points: RawPoint[], i: number): Setup | null {
  const slice = points.slice(0, i + 1);
  const closes = slice.map((p) => p.c);
  const price = closes[closes.length - 1] ?? 0;

  if (slice.length < MIN_POINTS || price <= 0) return null;

  const s20 = sma(closes, 20);
  const s50 = sma(closes, 50);
  const r = rsi(closes);
  const m = macd(closes);
  const a = atr(slice);

  const lookback = slice.slice(-20);
  const lows = lookback.map((p) => p.l ?? p.c);
  const highs = lookback.map((p) => p.h ?? p.c);
  const support = Math.min(...lows);
  const resistance = Math.max(...highs);

  // Trend via SMA20/50 (same null-tolerant comparisons as the app)
  const s20v = s20 ?? NaN;
  const s50v = s50 ?? NaN;
  const prev20 = sma(closes.slice(0, -5), 20);
  const prev50 = sma(closes.slice(0, -5), 50);
  const goldenCross =
    prev20 != null && prev50 != null && prev20 <= prev50 && s20v > s50v;
  const deathCross =
    prev20 != null && prev50 != null && prev20 >= prev50 && s20v < s50v;

  let trend: "Uptrend" | "Downtrend" | "Sideways" = "Sideways";
  if (price > s20v && s20v > s50v) trend = "Uptrend";
  else if (price < s20v && s20v < s50v) trend = "Downtrend";

  // ---- Composite score (exact weights) ----
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

  const r5 =
    (closes[closes.length - 1] - closes[closes.length - 6]) /
    closes[closes.length - 6];
  if (r5 > 0.01) score += 1;
  else if (r5 < -0.01) score -= 1;

  const range = resistance - support;
  if (range > 0) {
    const pos = (price - support) / range;
    if (pos < 0.2) score += 0.5;
    else if (pos > 0.8) score -= 0.5;
  }

  let verdict: Verdict = "Neutral";
  if (score >= 2.5) verdict = "Strong Buy";
  else if (score >= 1) verdict = "Buy";
  else if (score <= -2.5) verdict = "Strong Sell";
  else if (score <= -1) verdict = "Sell";

  const bullish = verdict === "Strong Buy" || verdict === "Buy";
  const bearish = verdict === "Sell" || verdict === "Strong Sell";

  const twoAtr = a != null ? 2 * a : price * 0.04;
  const fourAtr = a != null ? 4 * a : price * 0.08;

  let direction: Direction = "Wait";
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
  const setup: Setup = {
    direction,
    verdict,
    entry,
    stop: round2(stop),
    target1: round2(t1),
    target2: round2(t2),
  };

  // App guard: refuses degenerate setups
  if (direction === "Wait" || setup.stop === entry || setup.target1 === entry) return null;
  return setup;
}

// --------------------- Trade simulation ---------------------------

type Outcome = "TP2_HIT" | "SL_HIT_TP1" | "SL_HIT" | "OPEN";

interface Trade {
  symbol: string;
  direction: "Long" | "Short";
  verdict: Verdict;
  signalDate: string;
  entryDate: string;
  exitDate: string | null;
  entry: number;
  stop: number;
  target1: number;
  target2: number;
  outcome: Outcome;
  hitTp1: boolean;
  /** signed % using the TP1 Playbook "scale-half" for TP1->SL trades */
  playbookPnlPct: number;
  /** signed % if the whole position simply road to the terminal level */
  rawPnlPct: number;
  rMultiple: number; // playbook pnl / initial risk
  daysHeld: number;
}

const pct = (a: number, b: number) => (b !== 0 ? ((a - b) / b) * 100 : 0);

function signedPct(direction: "Long" | "Short", level: number, entry: number): number {
  return direction === "Long" ? pct(level, entry) : pct(entry, level);
}

function simulate(symbol: string, points: RawPoint[], windowStartMs: number): Trade[] {
  const trades: Trade[] = [];

  interface Active {
    entryIdx: number;
    direction: "Long" | "Short";
    verdict: Verdict;
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
    // TP1 Playbook: scale-half at TP1, remainder rides; if SL after TP1 the
    // remaining half stops out.
    const playbookPnlPct =
      outcome === "SL_HIT_TP1" ? 0.5 * a.tp1PnlPct + 0.5 * rawPnlPct : rawPnlPct;
    const riskPct = Math.abs(signedPct(a.direction, a.stop, a.entry));
    trades.push({
      symbol,
      direction: a.direction,
      verdict: a.verdict,
      signalDate: fmtDate(points[a.entryIdx].t),
      entryDate: fmtDate(points[a.entryIdx].t),
      exitDate: fmtDate(exitT),
      entry: a.entry,
      stop: a.stop,
      target1: a.target1,
      target2: a.target2,
      outcome,
      hitTp1: a.hitTp1,
      playbookPnlPct: round2(playbookPnlPct),
      rawPnlPct: round2(rawPnlPct),
      rMultiple: riskPct > 0 ? round2(playbookPnlPct / riskPct) : 0,
      daysHeld: Math.max(
        0,
        Math.round((exitT - points[a.entryIdx].t) / 86400),
      ),
    });
  };

  for (let i = 0; i < points.length; i++) {
    // 1) Evaluate the active trade on this candle (day AFTER entry onward —
    //    the entry day is judged only by its close, exactly like the app).
    if (active && i > active.entryIdx) {
      const c = points[i];
      const high = c.h ?? c.c;
      const low = c.l ?? c.c;
      const a = active;
      if (a.direction === "Long") {
        // Conservative: stop first within the same candle (app rule).
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

    // 2) Look for a new signal at this candle's close (one trade per symbol).
    if (!active && points[i].t * 1000 >= windowStartMs) {
      const setup = computeSetupAt(points, i);
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

function fmtDate(tSec: number): string {
  return new Date(tSec * 1000).toISOString().slice(0, 10);
}

// -------------------------- Aggregation ---------------------------

interface Stats {
  total: number;
  fullWins: number;
  partials: number; // TP1 then SL
  losses: number; // SL before TP1
  open: number;
  tp1Rate: number;
  fullWinRate: number;
  slFirstRate: number;
  avgPnlPct: number;
  avgR: number;
  sumR: number;
  avgDays: number;
}

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

const pctOf = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

function printStats(label: string, s: Stats) {
  console.log(
    `  ${label.padEnd(28)} trades=${String(s.total).padStart(3)}  ` +
      `TP2win=${String(s.fullWins).padStart(3)} (${s.fullWinRate}%)  ` +
      `TP1->SL=${String(s.partials).padStart(3)}  ` +
      `SLfirst=${String(s.losses).padStart(3)} (${s.slFirstRate}%)  ` +
      `open=${s.open}  TP1hit=${s.tp1Rate}%  ` +
      `avgPnL=${s.avgPnlPct}%  avgR=${s.avgR}  sumR=${s.sumR}  avgDays=${s.avgDays}`,
  );
}

// ----------------------------- Main -------------------------------

async function main() {
  console.log(`OpenStock backtest — signals in the last ${WINDOW_DAYS} days\n`);
  const windowStartMs = Date.now() - WINDOW_DAYS * 86400 * 1000;

  const all = [...APP_UNIVERSE, ...EXTRA_UNIVERSE];
  console.log(`Fetching ${FETCH_RANGE} daily data for ${all.length} symbols...`);
  const data = await fetchAll(all);
  console.log(`Got data for ${data.size}/${all.length} symbols.\n`);

  const bySymbolTrades = new Map<string, Trade[]>();
  for (const [symbol, points] of data) {
    if (points.length < 120) {
      console.error(`  ! ${symbol}: only ${points.length} candles, skipping`);
      continue;
    }
    bySymbolTrades.set(symbol, simulate(symbol, points, windowStartMs));
  }

  const allTrades = [...bySymbolTrades.values()].flat();
  const appTrades = allTrades.filter((t) => APP_UNIVERSE.includes(t.symbol));

  // ---- Per-symbol detail ----
  console.log("=== Per-symbol ===");
  const symbols = [...bySymbolTrades.keys()].sort();
  for (const s of symbols) {
    const ts = bySymbolTrades.get(s)!;
    const longs = ts.filter((t) => t.direction === "Long");
    const shorts = ts.filter((t) => t.direction === "Short");
    console.log(
      `${s.padEnd(8)} trades=${String(ts.length).padStart(3)}  ` +
        `L=${String(longs.length).padStart(3)} (W${longs.filter((t) => t.outcome === "TP2_HIT").length}/P${longs.filter((t) => t.outcome === "SL_HIT_TP1").length}/L${longs.filter((t) => t.outcome === "SL_HIT").length}/O${longs.filter((t) => t.outcome === "OPEN").length})  ` +
        `S=${String(shorts.length).padStart(3)} (W${shorts.filter((t) => t.outcome === "TP2_HIT").length}/P${shorts.filter((t) => t.outcome === "SL_HIT_TP1").length}/L${shorts.filter((t) => t.outcome === "SL_HIT").length}/O${shorts.filter((t) => t.outcome === "OPEN").length})  ` +
        `sumR=${round2(ts.reduce((a, t) => a + t.rMultiple, 0))}`,
    );
  }

  // ---- Aggregates ----
  console.log("\n=== APP WATCHLIST universe (AAPL MSFT NVDA TSLA AMZN GOOGL BTC-USD) ===");
  printStats("LONG (Buy+StrongBuy)", statsOf(appTrades.filter((t) => t.direction === "Long")));
  printStats("SHORT (Sell+StrongSell)", statsOf(appTrades.filter((t) => t.direction === "Short")));

  console.log("\n=== BROAD universe (all 20 symbols) ===");
  printStats("LONG (Buy+StrongBuy)", statsOf(allTrades.filter((t) => t.direction === "Long")));
  printStats("SHORT (Sell+StrongSell)", statsOf(allTrades.filter((t) => t.direction === "Short")));

  console.log("\n=== BROAD universe — Strong signals only (score >= ±2.5) ===");
  printStats("LONG StrongBuy", statsOf(allTrades.filter((t) => t.direction === "Long" && t.verdict === "Strong Buy")));
  printStats("SHORT StrongSell", statsOf(allTrades.filter((t) => t.direction === "Short" && t.verdict === "Strong Sell")));

  // ---- Trade log for the app watchlist ----
  console.log("\n=== Trade log (app watchlist) ===");
  for (const s of APP_UNIVERSE) {
    const ts = bySymbolTrades.get(s) ?? [];
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
