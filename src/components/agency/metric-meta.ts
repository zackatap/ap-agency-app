import type { MetricKey } from "./types";

export interface MetricMeta {
  label: string;
  kind: "count" | "money" | "rate" | "ratio";
  higherIsBetter: boolean;
}

export const METRIC_META: Record<MetricKey, MetricMeta> = {
  leads: { label: "Leads", kind: "count", higherIsBetter: true },
  totalAppts: { label: "Appointments", kind: "count", higherIsBetter: true },
  showed: { label: "Showed", kind: "count", higherIsBetter: true },
  closed: { label: "Closed", kind: "count", higherIsBetter: true },
  totalValue: { label: "Pipeline value", kind: "money", higherIsBetter: true },
  successValue: { label: "Closed value", kind: "money", higherIsBetter: true },
  adSpend: { label: "Ad spend", kind: "money", higherIsBetter: false },
  bookingRate: { label: "Booking rate", kind: "rate", higherIsBetter: true },
  showRate: { label: "Show rate", kind: "rate", higherIsBetter: true },
  closeRate: { label: "Close rate", kind: "rate", higherIsBetter: true },
  cpl: { label: "Cost / Lead", kind: "money", higherIsBetter: false },
  cps: { label: "Cost / Show", kind: "money", higherIsBetter: false },
  cpClose: { label: "Cost / Close", kind: "money", higherIsBetter: false },
  roas: { label: "ROAS", kind: "ratio", higherIsBetter: true },
};

export const METRIC_ORDER: MetricKey[] = [
  "leads",
  "totalAppts",
  "showed",
  "closed",
  "bookingRate",
  "showRate",
  "closeRate",
  "successValue",
  "adSpend",
  "cpl",
  "cps",
  "cpClose",
  "roas",
];
