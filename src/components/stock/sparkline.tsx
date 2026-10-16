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
  const id = `spark-${up ? "up" : "down"}`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="overflow-visible"
      aria-hidden
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon
        points={`${pad},${height - pad} ${points} ${width - pad},${height - pad}`}
        fill={`url(#${id})`}
        stroke="none"
      />
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
