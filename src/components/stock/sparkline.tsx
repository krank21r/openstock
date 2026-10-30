"use client";

interface SparklineProps {
  data: number[];
  up: boolean;
  width?: number;
  height?: number;
}

/** Lightweight inline-SVG sparkline for table rows. */
export function Sparkline({ data, up, width = 104, height = 32 }: SparklineProps) {
  if (!data || data.length < 2) {
    return <div style={{ width, height }} className="text-muted-foreground/40" aria-hidden />;
  }
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pad = 2;
  const stepX = (width - pad * 2) / (data.length - 1);
  const points = data
    .map(
      (v, i) =>
        `${(pad + i * stepX).toFixed(2)},${(pad + (height - pad * 2) * (1 - (v - min) / span)).toFixed(2)}`,
    )
    .join(" ");
  const color = up ? "#10b981" : "#ef4444";

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="overflow-visible"
      aria-hidden
    >
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeOpacity="0.85"
        strokeWidth="1.25"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
