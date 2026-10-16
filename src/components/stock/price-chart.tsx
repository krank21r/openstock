"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fmtPrice, fmtTick, fmtTooltipTime } from "@/lib/format";
import type { ChartPoint } from "@/lib/stock-types";

interface PriceChartProps {
  points: ChartPoint[];
  range: string;
  up: boolean;
}

interface TooltipEntry {
  active?: boolean;
  payload?: { payload: ChartPoint }[];
}

function ChartTooltip({ active, payload, range }: TooltipEntry & { range: string }) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-popover-foreground shadow-md">
      <div className="text-xs text-muted-foreground">{fmtTooltipTime(point.t, range)}</div>
      <div className="tabular text-sm font-semibold">{fmtPrice(point.c)}</div>
    </div>
  );
}

export function PriceChart({ points, range, up }: PriceChartProps) {
  const color = up ? "#10b981" : "#ef4444";
  const data = points.map((p) => ({ ...p }));

  return (
    <div className="h-64 w-full sm:h-72" role="img" aria-label={`Price chart, ${range} range`}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
          <defs>
            <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.28} />
              <stop offset="100%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border" vertical={false} />
          <XAxis
            dataKey="t"
            tickFormatter={(t: number) => fmtTick(t, range)}
            tick={{ fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            minTickGap={48}
            stroke="currentColor"
            className="text-muted-foreground"
          />
          <YAxis
            domain={["auto", "auto"]}
            tickFormatter={(v: number) => fmtPrice(v)}
            tick={{ fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={72}
            stroke="currentColor"
            className="text-muted-foreground"
          />
          <Tooltip
            content={<ChartTooltip range={range} />}
            cursor={{ stroke: color, strokeDasharray: "4 4", strokeOpacity: 0.5 }}
          />
          <Area
            type="monotone"
            dataKey="c"
            stroke={color}
            strokeWidth={2}
            fill="url(#priceFill)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
