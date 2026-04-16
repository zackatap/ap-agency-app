"use client";

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useMemo } from "react";
import type { ClientMonthTotals } from "./types";
import { formatMonthLabel, formatPercent } from "./format";

interface Props {
  months: ClientMonthTotals[];
  /** "simple" = average of each client's rate; "weighted" = sum/sum across clients. */
  mode: "simple" | "weighted";
}

export function RatesChart({ months, mode }: Props) {
  const data = useMemo(
    () =>
      months.map((m) => ({
        monthKey: m.monthKey,
        month: formatMonthLabel(m.monthKey),
        "Booking rate":
          mode === "simple" ? m.bookingRateSimple : m.bookingRateWeighted,
        "Show rate": mode === "simple" ? m.showRateSimple : m.showRateWeighted,
        "Close rate":
          mode === "simple" ? m.closeRateSimple : m.closeRateWeighted,
      })),
    [months, mode]
  );

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 10, right: 20, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="rgba(255,255,255,0.05)" vertical={false} />
          <XAxis dataKey="month" stroke="#94a3b8" fontSize={12} />
          <YAxis
            stroke="#94a3b8"
            fontSize={12}
            width={50}
            unit="%"
            domain={[0, 100]}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "#0f172a",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 8,
              fontSize: 12,
            }}
            formatter={(value) =>
              formatPercent(value == null ? null : Number(value))
            }
          />
          <Legend wrapperStyle={{ fontSize: 12, color: "#cbd5e1" }} />
          <Line
            type="monotone"
            dataKey="Booking rate"
            stroke="#818cf8"
            strokeWidth={2}
            dot={false}
            connectNulls
          />
          <Line
            type="monotone"
            dataKey="Show rate"
            stroke="#34d399"
            strokeWidth={2}
            dot={false}
            connectNulls
          />
          <Line
            type="monotone"
            dataKey="Close rate"
            stroke="#facc15"
            strokeWidth={2}
            dot={false}
            connectNulls
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
