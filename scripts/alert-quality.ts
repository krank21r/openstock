/**
 * Does a higher alert threshold actually help?
 *
 * Replays the DAILY signal engine over ~1 year of daily candles for the
 * production watchlist, reproduces the transition rule used by
 * lib/alerts.ts (Neutral -> actionable, or a direction flip), and measures for
 * each new alert, by score bucket:
 *
 *   - how many days the verdict stays actionable before reverting (fade)
 *   - forward return in the signal's direction at +5 and +10 sessions
 *   - hit rate (forward return positive)
 *
 * If the 1.5-2.0 bucket behaves like the 2.0+ buckets, raising the trigger is
 * cosmetic. If it fades much faster and earns less, the threshold earns its
 * place.
 *
 * Usage: bun scripts/alert-quality.ts
 */

import { computeSignal } from "../src/lib/signals";
import type { ChartPoint } from "../src/lib/yahoo";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const SYMBOLS = [
  "AAPL", "MSFT", "TSLA", "AMZN", "GOOGL", "NVDA", "AMD", "META",
  "SPCX", "BTC-USD", "ETH-USD", "XRP-USD", "GC=F", "HYUNDAI.NS",
];

interface Bar {
  t: number;
  c: number;
  h: number;
  l: number;
  v: number;
}

async function fetchDaily(symbol: string): Promise<Bar[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d&includePrePost=false`;
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
        bars.push({
          t: r.timestamp[i],
          c,
          h: typeof q.high?.[i] === "number" ? q.high[i] : c,
          l: typeof q.low?.[i] === "number" ? q.low[i] : c,
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

const signOf = (verdict: string) =>
  verdict.includes("Buy") ? 1 : verdict.includes("Sell") ? -1 : 0;
const actionable = (verdict: string) => verdict !== "Neutral";

interface Sample {
  symbol: string;
  score: number;
  dir: 1 | -1;
  /** Sessions until the verdict went Neutral (or the horizon). */
  fadeDays: number;
  faded: boolean;
  fwd5: number;
  fwd10: number;
}

const HORIZON = 10;

async function main() {
  const samples: Sample[] = [];
  const t0 = Date.now();

  for (const symbol of SYMBOLS) {
    const bars = await fetchDaily(symbol);
    if (bars.length < 120) {
      console.log(`${symbol}: skipped (${bars.length} bars)`);
      continue;
    }

    let prevVerdict: string | null = null;

    for (let i = 60; i < bars.length - 1; i++) {
      const points: ChartPoint[] = bars.slice(0, i + 1).map((b) => ({
        t: b.t,
        c: b.c,
        h: b.h,
        l: b.l,
        v: b.v,
      }));

      const sig = computeSignal({
        symbol,
        range: "1y",
        interval: "1d",
        currency: "USD",
        points,
        previousClose: bars[i - 1].c,
      });

      const curr = sig.verdict;
      const prev = prevVerdict;
      prevVerdict = curr;

      if (prev === null) continue;
      if (prev === curr) continue;

      const prevSign = signOf(prev);
      const currSign = signOf(curr);

      // New alert: Neutral -> actionable, or a direction flip.
      const isNew =
        actionable(curr) && currSign !== 0 && (prevSign === 0 || prevSign !== currSign);
      if (!isNew) continue;

      const entry = bars[i].c;
      const dir: 1 | -1 = currSign > 0 ? 1 : -1;

      // How long the verdict stays actionable.
      let fadeDays = HORIZON;
      let faded = false;
      for (let j = i + 1; j <= Math.min(i + HORIZON, bars.length - 1); j++) {
        const fwdPoints: ChartPoint[] = bars.slice(0, j + 1).map((b) => ({
          t: b.t,
          c: b.c,
          h: b.h,
          l: b.l,
          v: b.v,
        }));
        const fwd = computeSignal({
          symbol,
          range: "1y",
          interval: "1d",
          currency: "USD",
          points: fwdPoints,
          previousClose: bars[j - 1].c,
        });
        if (!actionable(fwd.verdict) || signOf(fwd.verdict) !== dir) {
          fadeDays = j - i;
          faded = true;
          break;
        }
      }

      const at = (n: number) => {
        const j = Math.min(i + n, bars.length - 1);
        return ((bars[j].c - entry) / entry) * 100 * dir;
      };

      samples.push({
        symbol,
        score: sig.score,
        dir,
        fadeDays,
        faded,
        fwd5: i + 5 < bars.length ? at(5) : NaN,
        fwd10: i + 10 < bars.length ? at(10) : NaN,
      });
    }
    process.stdout.write(`\r${symbol} done (${samples.length} alerts so far)…`);
  }

  console.log(`\n\n${samples.length} transition alerts over ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);

  const buckets: { label: string; test: (s: number) => boolean }[] = [
    { label: "|score| 1.5–2.0", test: (s) => Math.abs(s) >= 1.5 && Math.abs(s) < 2 },
    { label: "|score| 2.0–3.0", test: (s) => Math.abs(s) >= 2 && Math.abs(s) < 3 },
    { label: "|score| ≥ 3.0", test: (s) => Math.abs(s) >= 3 },
  ];

  console.log(
    "bucket".padEnd(16) +
      "n".padStart(5) +
      "faded≤3d".padStart(9) +
      "avgFade".padStart(9) +
      "fwd5".padStart(8) +
      "hit5".padStart(7) +
      "fwd10".padStart(8) +
      "hit10".padStart(7),
  );

  const mean = (xs: number[]) => {
    const v = xs.filter((x) => Number.isFinite(x));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
  };

  for (const b of buckets) {
    const rows = samples.filter((s) => b.test(s.score));
    if (rows.length === 0) continue;
    const faded3 = rows.filter((s) => s.faded && s.fadeDays <= 3).length / rows.length;
    console.log(
      b.label.padEnd(16) +
        String(rows.length).padStart(5) +
        `${(faded3 * 100).toFixed(0)}%`.padStart(9) +
        mean(rows.map((s) => s.fadeDays)).toFixed(1).padStart(9) +
        mean(rows.map((s) => s.fwd5)).toFixed(2).padStart(8) +
        `${((rows.filter((s) => s.fwd5 > 0).length / rows.length) * 100).toFixed(0)}%`.padStart(7) +
        mean(rows.map((s) => s.fwd10)).toFixed(2).padStart(8) +
        `${((rows.filter((s) => s.fwd10 > 0).length / rows.length) * 100).toFixed(0)}%`.padStart(7),
    );
  }

  const low = samples.filter((s) => Math.abs(s.score) < 2);
  const high = samples.filter((s) => Math.abs(s.score) >= 2);
  console.log(
    `\n1.5–2.0 would be dropped: ${low.length} alerts ` +
      `(fade≤3d ${((low.filter((s) => s.faded && s.fadeDays <= 3).length / Math.max(low.length, 1)) * 100).toFixed(0)}%, ` +
      `fwd5 ${mean(low.map((s) => s.fwd5)).toFixed(2)}%)`,
  );
  console.log(
    `2.0+ kept: ${high.length} alerts ` +
      `(fade≤3d ${((high.filter((s) => s.faded && s.fadeDays <= 3).length / Math.max(high.length, 1)) * 100).toFixed(0)}%, ` +
      `fwd5 ${mean(high.map((s) => s.fwd5)).toFixed(2)}%)`,
  );
}

main();
