/**
 * Day-trading backtest — does the five-check scanner actually have an edge?
 *
 * Replays ~60 trading days of 5-minute candles for the scanner universe with
 * NO lookahead:
 *   - at bar i the evaluator only sees that day's bars up to i, and daily
 *     candles strictly BEFORE the session;
 *   - a signal is filled at the NEXT bar's open (not the signal bar's close);
 *   - stop and targets are re-derived from the real fill;
 *   - one position per symbol at a time, first signal of the day only;
 *   - if a single bar spans both the stop and a target, the STOP is assumed to
 *     have been hit first (conservative, same rule as lib/trade-status.ts);
 *   - anything still open is closed at that session's last bar.
 *
 * Output: per-configuration expectancy in R, win rate, profit factor, drawdown,
 * plus a leave-one-check-out table showing what each check contributes.
 *
 * Usage: bun scripts/daytrade-backtest.ts
 */

import { evaluateDayTrade, type DayCheck } from "../src/lib/daytrade";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const STOCKS = [
  "AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "GOOGL", "META", "AMD",
  "NFLX", "ORCL", "CRM", "UBER", "PLTR", "COIN", "DIS", "INTC",
];
const CRYPTO = ["BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD", "DOGE-USD", "ADA-USD", "AVAX-USD", "LINK-USD"];
const UNIVERSE = [...STOCKS, ...CRYPTO];

interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

async function fetchBars(symbol: string, range: string, interval: string): Promise<Bar[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const result = json?.chart?.result?.[0];
      if (!result) throw new Error(json?.chart?.error?.description ?? "no result");
      const ts: number[] = result.timestamp ?? [];
      const q = result.indicators?.quote?.[0] ?? {};
      const bars: Bar[] = [];
      for (let i = 0; i < ts.length; i++) {
        const c = q.close?.[i];
        if (typeof c !== "number" || !Number.isFinite(c)) continue;
        const o = typeof q.open?.[i] === "number" ? q.open[i] : c;
        bars.push({
          t: ts[i],
          o: Math.min(o, c) === 0 ? c : o,
          h: typeof q.high?.[i] === "number" ? q.high[i] : c,
          l: typeof q.low?.[i] === "number" ? q.low[i] : c,
          c,
          v: typeof q.volume?.[i] === "number" ? q.volume[i] : 0,
        });
      }
      return bars;
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  return [];
}

const etDate = (sec: number) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(sec * 1000));

// ------------------------------ simulation ------------------------------

type ExitMode = "2R" | "split";

interface Trade {
  symbol: string;
  date: string;
  direction: "Long" | "Short";
  entry: number;
  stop: number;
  riskPerShare: number;
  r: number;
  exit: string;
}

/**
 * Fill at the next bar's open, then walk forward within the same session.
 * Returns the R multiple (risk-normalised) and how it closed.
 */
function simulate(
  bars: Bar[],
  signalIndex: number,
  direction: "Long" | "Short",
  stopLevel: number,
  mode: ExitMode,
): { r: number; exit: string } | null {
  const entryBar = bars[signalIndex + 1];
  if (!entryBar) return null;
  const entry = entryBar.o > 0 ? entryBar.o : entryBar.c;
  const long = direction === "Long";
  const risk = Math.abs(entry - stopLevel);
  if (!(risk > 0)) return null;

  const tp1 = long ? entry + 2 * risk : entry - 2 * risk;
  const tp2 = long ? entry + 3 * risk : entry - 3 * risk;
  let stop = stopLevel;
  let half = 0; // R already banked (split mode)

  for (let i = signalIndex + 1; i < bars.length; i++) {
    const b = bars[i];
    const hitStop = long ? b.l <= stop : b.h >= stop;
    const hitTp1 = long ? b.h >= tp1 : b.l <= tp1;
    const hitTp2 = long ? b.h >= tp2 : b.l <= tp2;

    // Conservative: stop before targets inside the same bar.
    if (hitStop) {
      // Half the position is only at risk AFTER TP1 — before that, the full
      // position takes the full 1R hit.
      const exposure = mode === "split" && half > 0 ? 0.5 : 1;
      const rStop = ((long ? stop - entry : entry - stop) / risk) * exposure;
      return { r: half + rStop, exit: half > 0 ? "breakeven runner" : "stop" };
    }

    if (mode === "2R") {
      if (hitTp1) return { r: 2, exit: "TP1 (2R)" };
    } else {
      if (half === 0 && hitTp1) {
        half = 1; // half the position banked at +2R
        stop = entry; // runner stop to breakeven
        if (hitTp2) return { r: half + 1.5, exit: "TP2 (3R)" };
        continue;
      }
      if (half > 0 && hitTp2) return { r: half + 1.5, exit: "TP2 (3R)" };
    }
  }

  // Still open at the session close.
  const last = bars[bars.length - 1];
  const rClose = ((long ? last.c - entry : entry - last.c) / risk) * (mode === "split" && half > 0 ? 0.5 : 1);
  return { r: half + rClose, exit: "session close" };
}

// ------------------------------ metrics ------------------------------

interface Stats {
  trades: number;
  signals: number;
  winRate: number;
  expectancy: number;
  stdev: number;
  standardError: number;
  /** Expectancy / standard error — how many SEs away from zero. */
  tStat: number;
  profitFactor: number;
  maxDrawdown: number;
  totalR: number;
  exits: Record<string, number>;
}

function statsOf(trades: Trade[]): Stats {
  const r = trades.map((t) => t.r);
  const wins = r.filter((x) => x > 0);
  const losses = r.filter((x) => x <= 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  let peak = 0;
  let cum = 0;
  let maxDd = 0;
  for (const x of r) {
    cum += x;
    peak = Math.max(peak, cum);
    maxDd = Math.max(maxDd, peak - cum);
  }
  const mean = r.length ? cum / r.length : 0;
  const variance = r.length > 1 ? r.reduce((a, x) => a + (x - mean) ** 2, 0) / (r.length - 1) : 0;
  const stdev = Math.sqrt(variance);
  const se = r.length > 1 ? stdev / Math.sqrt(r.length) : 0;
  const exits: Record<string, number> = {};
  for (const t of trades) exits[t.exit] = (exits[t.exit] ?? 0) + 1;
  return {
    trades: r.length,
    signals: r.length,
    winRate: r.length ? (wins.length / r.length) * 100 : 0,
    expectancy: mean,
    stdev,
    standardError: se,
    tStat: se > 0 ? mean / se : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    maxDrawdown: maxDd,
    totalR: cum,
    exits,
  };
}

const pad = (s: string, n: number) => s.padEnd(n);
const pct = (x: number) => `${x.toFixed(1)}%`;
const r2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "∞");

// ------------------------------ main ------------------------------

interface Series {
  symbol: string;
  kind: "stock" | "crypto";
  days: { date: string; bars: Bar[] }[];
  daily: Bar[];
}

async function load(symbol: string): Promise<Series | null> {
  try {
    const [intraday, daily] = await Promise.all([
      fetchBars(symbol, "60d", "5m"),
      fetchBars(symbol, "2y", "1d"),
    ]);
    if (intraday.length < 200 || daily.length < 30) return null;

    const byDate = new Map<string, Bar[]>();
    for (const b of intraday) {
      const key = etDate(b.t);
      if (!byDate.has(key)) byDate.set(key, []);
      byDate.get(key)!.push(b);
    }
    const days = [...byDate.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, bars]) => ({ date, bars }));

    return {
      symbol,
      kind: symbol.includes("-USD") ? "crypto" : "stock",
      days,
      daily,
    };
  } catch {
    return null;
  }
}

/** Deterministic hash so the control arm is reproducible. */
function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/**
 * Control arm: enter at a pseudo-random bar of each session, direction from
 * 3-bar momentum, a fixed 0.8% stop and the same 2R/3R exit rules. If the
 * scanner cannot beat this, the "checks" are decoration.
 */
function runControl(seriesList: Series[], mode: ExitMode): Trade[] {
  const trades: Trade[] = [];
  for (const s of seriesList) {
    for (const day of s.days) {
      if (day.bars.length < 20) continue;
      const idx = 8 + (hash(s.symbol + day.date) % (day.bars.length - 10));
      const bar = day.bars[idx];
      const prev = day.bars[idx - 3];
      const direction: "Long" | "Short" = bar.c >= prev.c ? "Long" : "Short";
      const stop = direction === "Long" ? bar.c * 0.992 : bar.c * 1.008;
      const sim = simulate(day.bars, idx, direction, stop, mode);
      if (!sim) continue;
      const entryBar = day.bars[idx + 1];
      const entry = entryBar.o > 0 ? entryBar.o : entryBar.c;
      trades.push({
        symbol: s.symbol,
        date: day.date,
        direction,
        entry,
        stop,
        riskPerShare: Math.abs(entry - stop),
        r: sim.r,
        exit: sim.exit,
      });
    }
  }
  return trades;
}

interface Config {
  label: string;
  minRiskPct: number;
  maxRiskPct: number;
  skipChecks?: string[];
  mode: ExitMode;
}

/** One pass over every symbol/day/bar for a configuration. */
function runConfig(seriesList: Series[], cfg: Config): Trade[] {
  const trades: Trade[] = [];

  for (const s of seriesList) {
    for (const day of s.days) {
      // Daily context: strictly previous sessions only (no lookahead).
      const dailyBefore = s.daily.filter((d) => etDate(d.t) < day.date);
      if (dailyBefore.length < 25) continue;

      let taken = false;
      for (let i = 7; i < day.bars.length - 1 && !taken; i++) {
        const slice = day.bars.slice(0, i + 1);
        const idea = evaluateDayTrade(
          {
            symbol: s.symbol,
            name: s.symbol,
            kind: s.kind,
            intraday: slice.map((b) => ({ t: b.t, c: b.c, h: b.h, l: b.l, v: b.v })),
            daily: dailyBefore.map((b) => ({ t: b.t, c: b.c, h: b.h, l: b.l, v: b.v })),
          },
          { minRiskPct: cfg.minRiskPct, maxRiskPct: cfg.maxRiskPct, skipChecks: cfg.skipChecks },
        );
        if (!idea || idea.passed !== idea.total) continue;

        const sim = simulate(day.bars, i, idea.direction, idea.stop, cfg.mode);
        if (!sim) continue;

        const entryBar = day.bars[i + 1];
        const entry = entryBar.o > 0 ? entryBar.o : entryBar.c;
        trades.push({
          symbol: s.symbol,
          date: day.date,
          direction: idea.direction,
          entry,
          stop: idea.stop,
          riskPerShare: Math.abs(entry - idea.stop),
          r: sim.r,
          exit: sim.exit,
        });
        taken = true; // one position per symbol per session
      }
    }
  }
  return trades;
}

/** For signals that failed exactly one check, which check was binding? */
function bindingChecks(seriesList: Series[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of seriesList) {
    for (const day of s.days) {
      const dailyBefore = s.daily.filter((d) => etDate(d.t) < day.date);
      if (dailyBefore.length < 25) continue;
      for (let i = 7; i < day.bars.length - 1; i++) {
        const slice = day.bars.slice(0, i + 1);
        const idea = evaluateDayTrade({
          symbol: s.symbol,
          name: s.symbol,
          kind: s.kind,
          intraday: slice.map((b) => ({ t: b.t, c: b.c, h: b.h, l: b.l, v: b.v })),
          daily: dailyBefore.map((b) => ({ t: b.t, c: b.c, h: b.h, l: b.l, v: b.v })),
        });
        if (!idea || idea.passed !== idea.total - 1) continue;
        const failed = idea.checks.filter((c: DayCheck) => !c.pass);
        if (failed.length === 1) {
          counts.set(failed[0].label, (counts.get(failed[0].label) ?? 0) + 1);
        }
      }
    }
  }
  return counts;
}

async function main() {
  console.log(`Universe: ${UNIVERSE.length} symbols · 60d of 5-minute candles · fill at next bar open\n`);
  const t0 = Date.now();

  const loaded: Series[] = [];
  const chunk = 4;
  for (let i = 0; i < UNIVERSE.length; i += chunk) {
    const batch = UNIVERSE.slice(i, i + chunk);
    const res = await Promise.all(batch.map(load));
    for (const r of res) if (r) loaded.push(r);
    process.stdout.write(`\rloaded ${loaded.length}/${UNIVERSE.length}…`);
  }
  const sessions = loaded.reduce((a, s) => a + s.days.length, 0);
  console.log(`\nloaded ${loaded.length} symbols · ${sessions} symbol-days · ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  const configs: Config[] = [
    { label: "current 0.4–1.2% · full 2R", minRiskPct: 0.4, maxRiskPct: 1.2, mode: "2R" },
    { label: "current 0.4–1.2% · split 2R/3R", minRiskPct: 0.4, maxRiskPct: 1.2, mode: "split" },
    { label: "wider 0.7–1.5% · full 2R", minRiskPct: 0.7, maxRiskPct: 1.5, mode: "2R" },
    { label: "wider 0.7–1.5% · split 2R/3R", minRiskPct: 0.7, maxRiskPct: 1.5, mode: "split" },
    { label: "widest 1.0–2.0% · full 2R", minRiskPct: 1.0, maxRiskPct: 2.0, mode: "2R" },
    { label: "widest 1.0–2.0% · split 2R/3R", minRiskPct: 1.0, maxRiskPct: 2.0, mode: "split" },
  ];

  const results: { cfg: Config; stats: Stats; trades: Trade[] }[] = [];
  for (const cfg of configs) {
    const trades = runConfig(loaded, cfg);
    const st = statsOf(trades);
    results.push({ cfg, stats: st, trades });
    console.log(
      `${pad(cfg.label, 32)} trades=${pad(String(st.trades), 4)} win=${pad(pct(st.winRate), 7)} exp=${pad(r2(st.expectancy) + "R", 7)} se=${pad(r2(st.standardError), 5)} t=${pad(r2(st.tStat), 5)} PF=${pad(r2(st.profitFactor), 6)} total=${pad(r2(st.totalR) + "R", 8)} maxDD=${r2(st.maxDrawdown)}R`,
    );
  }

  const best = [...results].sort((a, b) => b.stats.expectancy - a.stats.expectancy)[0];
  console.log(`\nBest configuration: ${best.cfg.label} — expectancy ${r2(best.stats.expectancy)}R over ${best.stats.trades} trades`);
  console.log(`Exits: ${JSON.stringify(best.stats.exits)}`);

  // Control arm — same exit rules, no checklist.
  const control = statsOf(runControl(loaded, best.cfg.mode));
  console.log(
    `\nControl (random bar, 0.8% stop, ${best.cfg.mode}): trades=${control.trades} win=${pct(control.winRate)} exp=${r2(control.expectancy)}R se=${r2(control.standardError)} t=${r2(control.tStat)}`,
  );
  const edgeOverControl = best.stats.expectancy - control.expectancy;
  console.log(
    `Edge over control: ${edgeOverControl >= 0 ? "+" : ""}${r2(edgeOverControl)}R per trade ` +
      `(95% CI of scanner expectancy: ${r2(best.stats.expectancy - 1.96 * best.stats.standardError)}R to ${r2(best.stats.expectancy + 1.96 * best.stats.standardError)}R)`,
  );

  // Leave-one-check-out on the strongest configuration.
  console.log(`\nContribution of each check (dropping it from the gate):`);
  const labels = ["Trend alignment", "Opening-range trigger", "Momentum band", "Liquidity & volatility", "Risk geometry"];
  const baseExp = best.stats.expectancy;
  for (const label of labels) {
    const trades = runConfig(loaded, { ...best.cfg, skipChecks: [label] });
    const st = statsOf(trades);
    const delta = st.expectancy - baseExp;
    console.log(
      `  without ${pad(label, 24)} trades=${pad(String(st.trades), 4)} win=${pad(pct(st.winRate), 7)} exp=${pad(r2(st.expectancy) + "R", 7)} (${delta >= 0 ? "+" : ""}${r2(delta)}R vs base)`,
    );
  }

  // Sample-size reality check.
  const byDay = new Map<string, number>();
  for (const t of best.trades) byDay.set(t.date, (byDay.get(t.date) ?? 0) + 1);
  const activeDays = [...byDay.values()].filter((n) => n > 0).length;
  console.log(`\nSignal frequency: ${best.stats.trades} trades over ${activeDays} active sessions (${(best.stats.trades / Math.max(activeDays, 1)).toFixed(2)}/session)`);

  const binding = bindingChecks(loaded);
  console.log(`\nSignals blocked by exactly one check (which one):`);
  for (const [label, n] of [...binding.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(label, 24)} ${n}`);
  }
  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main();
