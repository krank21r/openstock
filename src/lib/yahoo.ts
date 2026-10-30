/**
 * Server-side Yahoo Finance (unofficial) client with in-memory caching.
 * Only used from API routes — never import this in client code.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];

// ---------------------------- Types ----------------------------

export interface Quote {
  symbol: string;
  shortName: string;
  longName: string;
  exchange: string;
  currency: string;
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  dayHigh: number | null;
  dayLow: number | null;
  volume: number | null;
  yearHigh: number | null;
  yearLow: number | null;
  marketTime: number;
  /** Downsampled intraday closes for sparkline (may be empty) */
  spark: number[];
}

export interface ChartPoint {
  t: number; // epoch seconds
  c: number; // close
  h: number | null; // high
  l: number | null; // low
  v: number | null; // volume
}

export interface ChartData {
  symbol: string;
  range: string;
  interval: string;
  currency: string;
  points: ChartPoint[];
  previousClose: number;
}

export interface SearchResult {
  symbol: string;
  name: string;
  exchange: string;
  type: string;
}

// --------------------------- Cache -----------------------------

type CacheEntry = { at: number; data: unknown };
const cache = new Map<string, CacheEntry>();

const QUOTE_TTL_MS = 30_000;
const CHART_TTL_MS = 60_000;
const SEARCH_TTL_MS = 5 * 60_000;

async function cached<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < ttl) return hit.data as T;
  const data = await fn();
  cache.set(key, { at: now, data });
  if (cache.size > 500) {
    // Drop oldest entries to bound memory
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100);
    for (const [k] of oldest) cache.delete(k);
  }
  return data;
}

// ------------------------- Fetch helper ------------------------

let hostIdx = 0;

async function yahooFetch(path: string): Promise<any> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const base = HOSTS[hostIdx++ % HOSTS.length];
    try {
      const res = await fetch(`${base}${path}`, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`Yahoo responded ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Yahoo request failed");
}

// --------------------------- Quotes ----------------------------

function downsample(values: number[], max = 32): number[] {
  if (values.length <= max) return values;
  const step = values.length / max;
  const out: number[] = [];
  for (let i = 0; i < max; i++) out.push(values[Math.floor(i * step)]);
  out.push(values[values.length - 1]);
  return out;
}

/** Fetch a single symbol's quote (from the chart endpoint, which needs no auth). */
async function fetchQuote(symbol: string): Promise<Quote> {
  const s = encodeURIComponent(symbol.trim().toUpperCase());
  const json = await yahooFetch(`/v8/finance/chart/${s}?range=1d&interval=5m&includePrePost=false`);
  const result = json?.chart?.result?.[0];
  if (!result) {
    const errDesc = json?.chart?.error?.description || "Unknown symbol";
    throw new Error(errDesc);
  }
  const meta = result.meta ?? {};
  const closes: number[] = (result.indicators?.quote?.[0]?.close ?? []).filter(
    (c: unknown) => typeof c === "number" && Number.isFinite(c),
  );
  const price = Number(meta.regularMarketPrice ?? closes[closes.length - 1] ?? 0);
  const previousClose = Number(
    meta.chartPreviousClose ?? meta.previousClose ?? closes[0] ?? price,
  );
  return {
    symbol: meta.symbol ?? symbol.toUpperCase(),
    shortName: meta.shortName ?? meta.symbol ?? symbol.toUpperCase(),
    longName: meta.longName ?? meta.shortName ?? meta.symbol ?? symbol.toUpperCase(),
    exchange: meta.fullExchangeName ?? meta.exchangeName ?? "",
    currency: meta.currency ?? "USD",
    price,
    previousClose,
    change: price - previousClose,
    changePercent: previousClose ? ((price - previousClose) / previousClose) * 100 : 0,
    dayHigh: typeof meta.regularMarketDayHigh === "number" ? meta.regularMarketDayHigh : null,
    dayLow: typeof meta.regularMarketDayLow === "number" ? meta.regularMarketDayLow : null,
    volume: typeof meta.regularMarketVolume === "number" ? meta.regularMarketVolume : null,
    yearHigh: typeof meta.fiftyTwoWeekHigh === "number" ? meta.fiftyTwoWeekHigh : null,
    yearLow: typeof meta.fiftyTwoWeekLow === "number" ? meta.fiftyTwoWeekLow : null,
    marketTime: typeof meta.regularMarketTime === "number" ? meta.regularMarketTime : 0,
    spark: downsample(closes),
  };
}

/** Quotes for many symbols; failed symbols come back as null entries. */
export async function getQuotes(symbols: string[]): Promise<(Quote | null)[]> {
  const uniq = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(0, 40);
  return Promise.all(
    uniq.map((symbol) =>
      cached(`quote:${symbol}`, QUOTE_TTL_MS, () => fetchQuote(symbol)).catch(() => null),
    ),
  );
}

// --------------------------- Chart -----------------------------

export const RANGE_OPTIONS = {
  "1D": { range: "1d", interval: "5m" },
  "5D": { range: "5d", interval: "15m" },
  "1M": { range: "1mo", interval: "1d" },
  "6M": { range: "6mo", interval: "1d" },
  "1Y": { range: "1y", interval: "1d" },
  "5Y": { range: "5y", interval: "1wk" },
} as const;

export type RangeKey = keyof typeof RANGE_OPTIONS;

export async function getChart(symbol: string, rangeKey: RangeKey): Promise<ChartData> {
  const { range, interval } = RANGE_OPTIONS[rangeKey] ?? RANGE_OPTIONS["1M"];
  const s = encodeURIComponent(symbol.trim().toUpperCase());
  return cached(`chart:${s}:${range}:${interval}`, CHART_TTL_MS, async () => {
    const json = await yahooFetch(
      `/v8/finance/chart/${s}?range=${range}&interval=${interval}&includePrePost=false`,
    );
    const result = json?.chart?.result?.[0];
    if (!result) throw new Error(json?.chart?.error?.description || "Unknown symbol");
    const ts: number[] = result.timestamp ?? [];
    const quote = result.indicators?.quote?.[0] ?? {};
    const closes: (number | null)[] = quote.close ?? [];
    const highs: (number | null)[] = quote.high ?? [];
    const lows: (number | null)[] = quote.low ?? [];
    const volumes: (number | null)[] = quote.volume ?? [];
    const points: ChartPoint[] = [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (typeof c === "number" && Number.isFinite(c)) {
        points.push({
          t: ts[i],
          c,
          h: typeof highs[i] === "number" && Number.isFinite(highs[i]) ? highs[i] : null,
          l: typeof lows[i] === "number" && Number.isFinite(lows[i]) ? lows[i] : null,
          v: typeof volumes[i] === "number" && Number.isFinite(volumes[i]) ? volumes[i] : null,
        });
      }
    }
    const meta = result.meta ?? {};
    return {
      symbol: meta.symbol ?? symbol.toUpperCase(),
      range,
      interval,
      currency: meta.currency ?? "USD",
      points,
      previousClose: Number(meta.chartPreviousClose ?? points[0]?.c ?? 0),
    };
  });
}

// --------------------------- Search ----------------------------

const VALID_TYPES = new Set(["EQUITY", "ETF", "INDEX", "CRYPTOCURRENCY", "CURRENCY", "FUTURE"]);

export async function searchSymbols(q: string): Promise<SearchResult[]> {
  const query = q.trim();
  if (!query) return [];
  return cached(`search:${query.toLowerCase()}`, SEARCH_TTL_MS, async () => {
    const json = await yahooFetch(
      `/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0&listsCount=0`,
    );
    const quotes: any[] = json?.quotes ?? [];
    return quotes
      .filter((item) => VALID_TYPES.has(item?.quoteType) && item?.symbol)
      .map((item) => ({
        symbol: String(item.symbol),
        name: String(item.shortname ?? item.longname ?? item.symbol),
        exchange: String(item.exchDisp ?? item.exchange ?? ""),
        type: String(item.typeDisp ?? item.quoteType ?? ""),
      }))
      .slice(0, 8);
  });
}

// ------------------------ Market status ------------------------

/** US market open/closed status based on New York time (9:30–16:00 ET, Mon–Fri). */
export function getMarketStatus(): { open: boolean; label: string } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = get("weekday");
  const hour = parseInt(get("hour"), 10) % 24;
  const minute = parseInt(get("minute"), 10);
  const minutes = hour * 60 + minute;
  const isWeekday = !["Sat", "Sun"].includes(weekday);
  const open = isWeekday && minutes >= 570 && minutes < 960; // 9:30–16:00
  return {
    open,
    label: open ? "Market Open" : "Market Closed",
  };
}
