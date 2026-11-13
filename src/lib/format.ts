const usd = (min = 2, max = 2) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: min,
    maximumFractionDigits: max,
  });

export function fmtPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 10000) return usd(0, 0).format(value);
  return usd().format(value);
}

export function fmtChange(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${fmtPrice(Math.abs(value))}`;
}

export function fmtPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${Math.abs(value).toFixed(2)}%`;
}

export function fmtCompact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(
    value,
  );
}

/** Format a chart timestamp tick according to the selected range. */
export function fmtTick(epochSec: number, range: string): string {
  const d = new Date(epochSec * 1000);
  if (range === "1D" || range === "5D") {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: false,
      ...(range === "5D" ? { weekday: "short" as const } : {}),
    }).format(d);
  }
  if (range === "5Y") {
    return new Intl.DateTimeFormat("en-US", { month: "short", year: "2-digit" }).format(d);
  }
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(d);
}

export function fmtTooltipTime(epochSec: number, range: string): string {
  const d = new Date(epochSec * 1000);
  if (range === "1D") {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(d);
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(range === "5D" ? { hour: "numeric", minute: "2-digit", hour12: false } : {}),
  }).format(d);
}

export function fmtClock(ms: number): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(new Date(ms));
}

/** Human "time ago" for alert/trade timestamps (ISO strings or epoch ms). */
export function fmtTimeAgo(input: string | number): string {
  const t = typeof input === "number" ? input : Date.parse(input);
  if (!Number.isFinite(t)) return "—";
  const diff = Math.max(0, Date.now() - t);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(t));
}
