/**
 * Signal lab — how accurate is the daily engine, and can filters improve it?
 *
 * For every daily bar on the watchlist it asks the real engine's question, then
 * trades the answer exactly as the app would: enter at the NEXT open, stop and
 * targets taken from the setup the engine produced, walk forward 10 sessions,
 * stop-before-target inside a bar (conservative).
 *
 * Reports accuracy (win rate) and expectancy in R for:
 *   - every actionable signal
 *   - score >= 2 (the alert gate)
 *   - trend alignment (price vs SMA200)
 *   - both filters together
 *
 * Each row is reported on the first 70% of history (train) and the last 30%
 * (test). A filter only counts as an improvement if it survives the test slice —
 * otherwise it is curve fitting.
 *
 * Usage: bun scripts/signal-lab.ts
 */

import { computeSignal } from "../src/lib/signals";
import type { ChartPoint } from "../src/lib/yahoo";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const SYMBOLS = [
  "AAPL", "MSFT", "TSLA", "AMZN", "GOOGL", "NVDA", "AMD", "META",
  "SPCX", "BTC-USD", "ETH-USD", "XRP-USD", "GC=F", "HYUNDAI.NS",
];

const HORIZON = 10;

interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

async function fetchBars(symbol: string): Promise<Bar[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=3y&interval=1d&includePrePost=false`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const r = json?.chart?.result?.[0];
      if (!r) throw new Error("no result");
      const q = r.indicators?.quote?.[0] ?? {};
      const bars: Bar[] = [];
      for (let i = 0; i < (r.timestamp ?? []).length; i++) {
        const c = q.close?.[i];
        if (typeof c !== "number" || !Number.isFinite(c)) continue;
        const o = typeof q.open?.[i] === "number" ? q.open[i] : c;
        bars.push({
          t: r.timestamp[i],
          o,
          h: typeof q.high?.[i] === "number" ? q.high[i] : c,
          l: typeof q.low?.[i] === "number" ? q.low[i] : c,
          c,
          v: typeof q.volume?.[i] === "number" ? q.volume[i] : 0,
        });
      }
      return bars;
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return [];
}

interface Trade {
  symbol: string;
  index: number;
  score: number;
  direction: 1 | -1;
  entry: number;
  stop: number;
  risk: number;
  /** The bars the trade can run through, starting at the fill bar. */
  future: { h: number; l: number; c: number }[];
  aboveSma200: boolean;
}

/**
 * Walk the future bars for a given target multiple of risk.
 * Stop is checked before the target inside the same bar (conservative), and a
 * trade still open at the horizon exits at that bar's close.
 */
function realiseR(t: Trade, targetR: number, horizon: number): number {
  const long = t.direction === 1;
  const target = long ? t.entry + targetR * t.risk : t.entry - targetR * t.risk;
  const bars = t.future.slice(0, horizon);

  for (const b of bars) {
    const hitStop = long ? b.l <= t.stop : b.h >= t.stop;
    if (hitStop) return -1;
    const hitTarget = long ? b.h >= target : b.l <= target;
    if (hitTarget) return targetR;
  }

  const last = bars[bars.length - 1];
  return last ? (long ? last.c - t.entry : t.entry - last.c) / t.risk : 0;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

async function main() {
  const trades: Trade[] = [];
  const splitBySymbol = new Map<string, number>();
  const t0 = Date.now();

  for (const symbol of SYMBOLS) {
    const bars = await fetchBars(symbol);
    if (bars.length < 260) {
      console.log(`${symbol}: skipped (${bars.length} bars)`);
      continue;
    }
    splitBySymbol.set(symbol, Math.floor(bars.length * 0.7));
    const closes = bars.map((b) => b.c);

    for (let i = 200; i < bars.length - HORIZON - 1; i++) {
      const points: ChartPoint[] = bars.slice(0, i + 1).map((b) => ({
        t: b.t,
        c: b.c,
        h: b.h,
        l: b.l,
        v: b.v,
      }));

      const sig = computeSignal({
        symbol,
        range: "3y",
        interval: "1d",
        currency: "USD",
        points,
        previousClose: bars[i - 1].c,
      });

      const setup = sig.setup;
      if (setup.direction === "Wait") continue;

      const long = setup.direction === "Long";
      const entry = bars[i + 1].o;
      if (!(entry > 0)) continue;

      const stop = setup.stop;
      const risk = Math.abs(entry - stop);
      if (!(risk > 0)) continue;

      const sma200 = closes.slice(Math.max(0, i - 199), i + 1);
      const sma = sma200.reduce((a, b) => a + b, 0) / sma200.length;

      trades.push({
        symbol,
        index: i,
        score: sig.score,
        direction: long ? 1 : -1,
        entry,
        stop,
        risk,
        future: bars
          .slice(i + 1, i + 1 + HORIZON)
          .map((b) => ({ h: b.h, l: b.l, c: b.c })),
        aboveSma200: long ? bars[i].c > sma : bars[i].c < sma,
      });
    }
    process.stdout.write(`\r${symbol} done (${trades.length} trades)…`);
  }

  console.log(`\n\n${trades.length} actionable signals over ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);

  const testOf = (t: Trade) => t.index >= (splitBySymbol.get(t.symbol) ?? Infinity);
  const wr = (xs: Trade[], targetR: number, h: number) =>
    xs.length ? (xs.filter((t) => realiseR(t, targetR, h) > 0).length / xs.length) * 100 : NaN;
  const exp = (xs: Trade[], targetR: number, h: number) =>
    mean(xs.map((t) => realiseR(t, targetR, h)));

  // ---- Exit geometry: does the target the engine picks leak edge? ----
  console.log("Exit geometry — same entries, different target multiples");
  console.log(
    "target".padEnd(10) +
      "horizon".padStart(9) +
      "train n".padStart(9) +
      "train win".padStart(11) +
      "train R".padStart(9) +
      "test n".padStart(9) +
      "test win".padStart(10) +
      "test R".padStart(9),
  );
  for (const targetR of [1, 1.5, 2, 3]) {
    for (const h of [5, 10]) {
      const train = trades.filter((t) => !testOf(t));
      const test = trades.filter(testOf);
      console.log(
        `${targetR}R`.padEnd(10) +
          String(h).padStart(9) +
          String(train.length).padStart(9) +
          `${wr(train, targetR, h).toFixed(0)}%`.padStart(11) +
          exp(train, targetR, h).toFixed(2).padStart(9) +
          String(test.length).padStart(9) +
          `${wr(test, targetR, h).toFixed(0)}%`.padStart(10) +
          exp(test, targetR, h).toFixed(2).padStart(9),
      );
    }
  }
  console.log();

  // ---- Entry filters, evaluated on the engine's own targets ----
  const filterRows: { label: string; test: (t: Trade) => boolean }[] = [
    { label: "all signals", test: () => true },
    { label: "score ≥ 2", test: (t) => Math.abs(t.score) >= 2 },
    { label: "trend-aligned (SMA200)", test: (t) => t.aboveSma200 },
    { label: "score ≥ 2 + trend", test: (t) => Math.abs(t.score) >= 2 && t.aboveSma200 },
  ];

  console.log("Entry filters — engine targets, 10-session horizon");
  console.log(
    "filter".padEnd(26) +
      "train n".padStart(9) +
      "win".padStart(6) +
      "expR".padStart(8) +
      "test n".padStart(9) +
      "win".padStart(6) +
      "expR".padStart(8),
  );

  for (const row of filterRows) {
    const train = trades.filter((t) => !testOf(t) && row.test(t));
    const test = trades.filter((t) => testOf(t) && row.test(t));
    const win = (xs: Trade[]) =>
      xs.length ? (xs.filter((t) => realiseR(t, 2, HORIZON) > 0).length / xs.length) * 100 : NaN;
    console.log(
      row.label.padEnd(26) +
        String(train.length).padStart(9) +
        `${win(train).toFixed(0)}%`.padStart(6) +
        mean(train.map((t) => realiseR(t, 2, HORIZON))).toFixed(2).padStart(8) +
        String(test.length).padStart(9) +
        `${win(test).toFixed(0)}%`.padStart(6) +
        mean(test.map((t) => realiseR(t, 2, HORIZON))).toFixed(2).padStart(8),
    );
  }

  const longs = trades.filter((t) => t.direction === 1);
  const shorts = trades.filter((t) => t.direction === -1);
  console.log(
    `\nlongs ${longs.length} (exp ${mean(longs.map((t) => realiseR(t, 2, HORIZON))).toFixed(2)}R) · ` +
      `shorts ${shorts.length} (exp ${mean(shorts.map((t) => realiseR(t, 2, HORIZON))).toFixed(2)}R)`,
  );
}

main();
