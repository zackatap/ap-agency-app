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
import { formatCount, formatMonthLabel } from "./format";

interface Props {
  months: ClientMonthTotals[];
}

/** Totals across all clients per month for the four biggest volume metrics. */
export function MonthlyTotalsChart({ months }: Props) {
  const data = useMemo(
    () =>
      months.map((m) => ({
        monthKey: m.monthKey,
        month: formatMonthLabel(m.monthKey),
        Leads: m.leads,
        Appointments: m.totalAppts,
        Showed: m.showed,
        Closed: m.closed,
      })),
    [months]
  );

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 10, right: 20, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="rgba(255,255,255,0.05)" vertical={false} />
          <XAxis dataKey="month" stroke="#94a3b8" fontSize={12} />
          <YAxis stroke="#94a3b8" fontSize={12} width={50} />
          <Tooltip
            wrapperStyle={{ zIndex: 50, outline: "none" }}
            contentStyle={{
              backgroundColor: "#0f172a",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 8,
              fontSize: 12,
            }}
            formatter={(value) => formatCount(Number(value))}
          />
          <Legend wrapperStyle={{ fontSize: 12, color: "#cbd5e1" }} />
          <Line
            type="monotone"
            dataKey="Leads"
            stroke="#818cf8"
            strokeWidth={2}
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="Appointments"
            stroke="#38bdf8"
            strokeWidth={2}
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="Showed"
            stroke="#34d399"
            strokeWidth={2}
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="Closed"
            stroke="#facc15"
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
