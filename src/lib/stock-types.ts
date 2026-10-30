/** Shared client-side types mirroring the API responses. */

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
  spark: number[];
}

export interface MarketResponse {
  indices: (Quote | null)[];
  movers: { gainers: Quote[]; losers: Quote[] };
  status: { open: boolean; label: string };
  updatedAt: number;
}

export interface ChartPoint {
  t: number;
  c: number;
}

export interface ChartResponse {
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

export interface WatchlistItem {
  id: string;
  symbol: string;
  createdAt: string;
}

export const RANGE_TABS = ["1D", "5D", "1M", "6M", "1Y", "5Y"] as const;
export type RangeTab = (typeof RANGE_TABS)[number];

// ------------------------ Trade signals ------------------------

export type Verdict = "Strong Buy" | "Buy" | "Neutral" | "Sell" | "Strong Sell";

export interface SignalIndicators {
  rsi: number | null;
  sma20: number | null;
  sma50: number | null;
  macd: { macd: number; signal: number; histogram: number } | null;
  atr: number | null;
  trend: "Uptrend" | "Downtrend" | "Sideways";
  volatilityPct: number | null;
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
  confidence: number;
  indicators: SignalIndicators;
  setup: TradeSetup;
  asOf: number;
}

export interface SignalSummary {
  symbol: string;
  verdict: Verdict;
  score: number;
  confidence: number;
  trend: "Uptrend" | "Downtrend" | "Sideways";
  rsi: number | null;
}

// ------------------------ Traded (tracked) positions ------------------------

export type TradeStatus = "OPEN" | "TP1_HIT" | "TP2_HIT" | "SL_HIT";

export interface TrackedTradeView {
  id: string;
  symbol: string;
  companyName: string | null;
  direction: "Long" | "Short";
  entryPrice: number;
  stopLoss: number;
  target1: number;
  target2: number;
  riskReward: number | null;
  riskLevel: string | null;
  confidence: number | null;
  verdict: string | null;
  status: TradeStatus;
  hitTp1: boolean;
  currentPrice: number | null;
  pnlPct: number | null;
  pnlAtClosePct: number | null;
  progressPct: number | null;
  highWater: number | null;
  lowWater: number | null;
  openedAt: string;
  closedAt: string | null;
  hitTp1At: string | null;
  closedReason: string | null;
  message: string;
}
