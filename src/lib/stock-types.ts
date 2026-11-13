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
}

export interface MarketResponse {
  indices: (Quote | null)[];
  movers: { gainers: Quote[]; losers: Quote[] };
  status: { open: boolean; label: string };
  updatedAt: number;
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

// ------------------------ Trade signals ------------------------

export type Verdict = "Strong Buy" | "Buy" | "Neutral" | "Sell" | "Strong Sell";

export interface PriceZone {
  top: number;
  bottom: number;
  createdAt: number;
}

export interface SrLevel {
  price: number;
  touches: number;
}

export interface SignalFactor {
  key: string;
  label: string;
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
  volatilityPct: number | null;
  // v2 smart-money fields
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

export type StopMode = "tight" | "balanced";

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

/** Fresh-signal re-entry gate state (see src/lib/reentry.ts). */
export interface ReentryGate {
  blocked: boolean;
  stoppedAt: string | null;
}

export interface SignalResult {
  symbol: string;
  verdict: Verdict;
  score: number;
  confidence: number;
  indicators: SignalIndicators;
  setup: TradeSetup;
  asOf: number;
  factors?: SignalFactor[];
  engine?: "v1" | "v2";
  /** Present on symbol-detail responses: true while re-entry is locked after a stop-out. */
  reentry?: ReentryGate;
}

export interface SignalSummary {
  symbol: string;
  verdict: Verdict;
  score: number;
  confidence: number;
  trend: "Uptrend" | "Downtrend" | "Sideways";
  rsi: number | null;
  /** Average true range of the daily candles — used to judge entry distance. */
  atr: number | null;
}

// ------------------------ Trade alerts (signal transitions) ------------------------

export type AlertStatus = "OPEN" | "STALE" | "TAKEN" | "DISMISSED";

export interface TradeAlertView {
  id: string;
  symbol: string;
  companyName: string | null;
  direction: "Long" | "Short";
  verdict: string;
  score: number;
  confidence: number;
  priceAtAlert: number | null;
  alertKey: string;
  status: AlertStatus;
  tradeId: string | null;
  createdAt: string;
  updatedAt: string;
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
