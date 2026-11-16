/**
 * Generates src/data/signal-accuracy.json — the measured hit rate and expectancy
 * of the daily engine, per symbol and side, so the UI can state what the signals
 * have actually done instead of implying they work.
 *
 * Method matches scripts/signal-lab.ts: signal at the close, fill at the next
 * open, engine's own stop and target1, stop counted before target inside a bar,
 * 10-session horizon, time exit at the horizon close.
 *
 * Usage: bun scripts/accuracy-report.ts
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { computeSignal } from "../src/lib/signals";
import type { ChartPoint } from "../src/lib/yahoo";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const SYMBOLS = [
  "AAPL", "MSFT", "TSLA", "AMZN", "GOOGL", "NVDA", "AMD", "META",
  "BTC-USD", "ETH-USD", "XRP-USD", "GC=F", "HYUNDAI.NS",
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
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  const json = await res.json();
  const r = json?.chart?.result?.[0];
  if (!r) return [];
  const q = r.indicators?.quote?.[0] ?? {};
  const bars: Bar[] = [];
  for (let i = 0; i < (r.timestamp ?? []).length; i++) {
    const c = q.close?.[i];
    if (typeof c !== "number" || !Number.isFinite(c)) continue;
    bars.push({
      t: r.timestamp[i],
      o: typeof q.open?.[i] === "number" ? q.open[i] : c,
      h: typeof q.high?.[i] === "number" ? q.high[i] : c,
      l: typeof q.low?.[i] === "number" ? q.low[i] : c,
      c,
      v: typeof q.volume?.[i] === "number" ? q.volume[i] : 0,
    });
  }
  return bars;
}

interface Bucket {
  n: number;
  wins: number;
  rSum: number;
}

const empty = (): Bucket => ({ n: 0, wins: 0, rSum: 0 });
const add = (b: Bucket, r: number) => {
  b.n += 1;
  if (r > 0) b.wins += 1;
  b.rSum += r;
};
const finish = (b: Bucket) => ({
  n: b.n,
  winPct: b.n ? Math.round((b.wins / b.n) * 100) : null,
  expR: b.n ? Math.round((b.rSum / b.n) * 1000) / 1000 : null,
});

async function main() {
  const bySymbol: Record<string, { long: Bucket; short: Bucket }> = {};
  const overall = { long: empty(), short: empty() };
  const from = new Date(Date.now() - 3 * 365 * 86_400_000).toISOString().slice(0, 10);

  for (const symbol of SYMBOLS) {
    const bars = await fetchBars(symbol);
    if (bars.length < 260) continue;
    bySymbol[symbol] = { long: empty(), short: empty() };

    for (let i = 210; i < bars.length - HORIZON - 1; i++) {
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

      if (sig.setup.direction === "Wait") continue;
      const long = sig.setup.direction === "Long";
      const entry = bars[i + 1].o;
      const stop = sig.setup.stop;
      const target = sig.setup.target1;
      const risk = Math.abs(entry - stop);
      const reward = Math.abs(target - entry);
      if (!(risk > 0) || !(reward > 0)) continue;

      let r: number | null = null;
      for (let j = i + 1; j <= Math.min(i + HORIZON, bars.length - 1); j++) {
        const b = bars[j];
        if (long ? b.l <= stop : b.h >= stop) {
          r = -1;
          break;
        }
        if (long ? b.h >= target : b.l <= target) {
          r = reward / risk;
          break;
        }
      }
      if (r === null) {
        const exit = bars[Math.min(i + HORIZON, bars.length - 1)].c;
        r = (long ? exit - entry : entry - exit) / risk;
      }

      const side = long ? "long" : "short";
      add(bySymbol[symbol][side], r);
      add(overall[side], r);
    }
    process.stdout.write(`\r${symbol} scanned…`);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    horizonDays: HORIZON,
    method:
      "Signal at the close, fill at the next open, the engine's own stop and Target 1, stop counted before target inside a bar, 10-session horizon.",
    sample: { symbols: SYMBOLS.length, from },
    overall: { long: finish(overall.long), short: finish(overall.short) },
    bySymbol: Object.fromEntries(
      Object.entries(bySymbol).map(([sym, b]) => [sym, { long: finish(b.long), short: finish(b.short) }]),
    ),
  };

  mkdirSync("src/data", { recursive: true });
  writeFileSync("src/data/signal-accuracy.json", JSON.stringify(payload, null, 2) + "\n", "utf8");

  const totalLong = overall.long.n + overall.short.n;
  console.log(
    `\n${totalLong} signals → src/data/signal-accuracy.json ` +
      `(long ${overall.long.n}, short ${overall.short.n})`,
  );
}

main();
