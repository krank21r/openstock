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
