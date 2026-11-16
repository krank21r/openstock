/**
 * RSI vs Stochastic RSI — which one actually separates forward returns?
 *
 * Both oscillators are computed per bar on daily candles for the production
 * watchlist, then forward returns are bucketed by each indicator's reading. The
 * question is not "which looks better" but: does one of them sort future returns
 * more cleanly than the other?
 *
 * Definitions used:
 *   RSI(14)          Wilder smoothing, 0-100.
 *   StochRSI(14,14)  (RSI - min(RSI,14)) / (max - min) * 100, smoothed:
 *                    %K = SMA3 of that, %D = SMA3 of %K.
 *
 * Usage: bun scripts/rsi-vs-stochrsi.ts
 */

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
}

async function fetchDaily(symbol: string): Promise<Bar[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d&includePrePost=false`;
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

/** Wilder RSI, one value per bar (NaN until warm). */
function rsiSeries(closes: number[], period = 14): number[] {
  const out = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/** StochRSI as %K (SMA3 of the normalised RSI) and %D (SMA3 of %K). */
function stochRsiSeries(rsi: number[], lookback = 14, smooth = 3) {
  const raw = new Array(rsi.length).fill(NaN);
  for (let i = 0; i < rsi.length; i++) {
    if (i < lookback) continue;
    const window = rsi.slice(i - lookback + 1, i + 1);
    if (window.some((v) => !Number.isFinite(v))) continue;
    const lo = Math.min(...window);
    const hi = Math.max(...window);
    raw[i] = hi === lo ? 50 : ((rsi[i] - lo) / (hi - lo)) * 100;
  }
  const sma = (arr: number[], n: number) =>
    arr.map((_, i) => {
      if (i < n - 1) return NaN;
      const w = arr.slice(i - n + 1, i + 1);
      return w.some((v) => !Number.isFinite(v)) ? NaN : w.reduce((a, b) => a + b, 0) / n;
    });
  const k = sma(raw, smooth);
  const d = sma(k, smooth);
  return { k, d };
}

const mean = (xs: number[]) => {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
};
const hit = (xs: number[]) => {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? (v.filter((x) => x > 0).length / v.length) * 100 : NaN;
};

interface Row {
  rsi: number;
  stochK: number;
  fwd5: number;
  fwd10: number;
}

async function main() {
  const rows: Row[] = [];

  for (const symbol of SYMBOLS) {
    const bars = await fetchDaily(symbol);
    if (bars.length < 120) continue;
    const closes = bars.map((b) => b.c);
    const rsi = rsiSeries(closes, 14);
    const { k } = stochRsiSeries(rsi, 14, 3);

    for (let i = 20; i < bars.length - 10; i++) {
      if (!Number.isFinite(rsi[i]) || !Number.isFinite(k[i])) continue;
      rows.push({
        rsi: rsi[i],
        stochK: k[i],
        fwd5: ((closes[i + 5] - closes[i]) / closes[i]) * 100,
        fwd10: ((closes[i + 10] - closes[i]) / closes[i]) * 100,
      });
    }
    process.stdout.write(`\r${symbol}… ${rows.length} samples`);
  }

  console.log(`\n\n${rows.length} daily samples across ${SYMBOLS.length} symbols\n`);

  const table = (label: string, buckets: { name: string; test: (r: Row) => boolean }[], pick: (r: Row) => number) => {
    console.log(label);
    console.log("  bucket".padEnd(18) + "n".padStart(7) + "fwd5".padStart(9) + "hit5".padStart(8) + "fwd10".padStart(9) + "hit10".padStart(8));
    for (const b of buckets) {
      const sel = rows.filter((r) => b.test(r) && Number.isFinite(pick(r)));
      if (!sel.length) continue;
      console.log(
        `  ${b.name}`.padEnd(18) +
          String(sel.length).padStart(7) +
          mean(sel.map((r) => r.fwd5)).toFixed(2).padStart(9) +
          `${hit(sel.map((r) => r.fwd5)).toFixed(0)}%`.padStart(8) +
          mean(sel.map((r) => r.fwd10)).toFixed(2).padStart(9) +
          `${hit(sel.map((r) => r.fwd10)).toFixed(0)}%`.padStart(8),
      );
    }
    console.log();
  };

  table("RSI(14)", [
    { name: "< 30 (oversold)", test: (r) => r.rsi < 30 },
    { name: "30–50", test: (r) => r.rsi >= 30 && r.rsi < 50 },
    { name: "50–52", test: (r) => r.rsi >= 50 && r.rsi < 52 },
    { name: "52–72 (app band)", test: (r) => r.rsi >= 52 && r.rsi <= 72 },
    { name: "> 72 (overbought)", test: (r) => r.rsi > 72 },
  ], (r) => r.rsi);

  table("Stoch RSI %K(14,14,3)", [
    { name: "< 20 (oversold)", test: (r) => r.stochK < 20 },
    { name: "20–50", test: (r) => r.stochK >= 20 && r.stochK < 50 },
    { name: "50–80", test: (r) => r.stochK >= 50 && r.stochK <= 80 },
    { name: "> 80 (overbought)", test: (r) => r.stochK > 80 },
  ], (r) => r.stochK);

  // How often do they even agree that momentum is positive?
  const agree = rows.filter((r) => (r.rsi >= 50) === (r.stochK >= 50)).length / rows.length;
  console.log(`Direction agreement (RSI>=50 vs StochRSI>=50): ${(agree * 100).toFixed(0)}%`);
  console.log(`StochRSI saturates at >80 or <20 on ${((rows.filter((r) => r.stochK > 80 || r.stochK < 20).length / rows.length) * 100).toFixed(0)}% of bars`);
  console.log(`RSI saturates at >70 or <30 on ${((rows.filter((r) => r.rsi > 70 || r.rsi < 30).length / rows.length) * 100).toFixed(0)}% of bars`);
}

main();
