/** Client-side mirror of the types returned by /api/agency/rollup/latest. */

import type { MetricKey } from "@/lib/agency-rollup-view";

export type { MetricKey };

export interface ClientMonthTotals {
  monthKey: string;
  startDate: string;
  endDate: string;
  leads: number;
  totalAppts: number;
  showed: number;
  closed: number;
  totalValue: number;
  successValue: number;
  adSpend: number;
  clientCount: number;
  bookingRateSimple: number | null;
  bookingRateWeighted: number | null;
  showRateSimple: number | null;
  showRateWeighted: number | null;
  closeRateSimple: number | null;
  closeRateWeighted: number | null;
  cpl: number | null;
  cps: number | null;
  cpClose: number | null;
  roas: number | null;
}

export interface ClientLocationMonth {
  monthKey: string;
  leads: number;
  totalAppts: number;
  showed: number;
  closed: number;
  totalValue: number;
  successValue: number;
  adSpend: number;
  bookingRate: number | null;
  showRate: number | null;
  closeRate: number | null;
  cpl: number | null;
  cps: number | null;
  cpClose: number | null;
  roas: number | null;
}

export interface ClientLocationSummary {
  locationId: string;
  cid: string | null;
  businessName: string;
  ownerName: string | null;
  statuses: string[];
  pipelineName: string | null;
  included: boolean;
  errorMessage: string | null;
  totals: Omit<ClientLocationMonth, "monthKey">;
  latestMonth: ClientLocationMonth | null;
  months: ClientLocationMonth[];
}

export interface ClientAgencySnapshot {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "complete" | "failed";
  monthsCovered: number;
  clientsTotal: number;
  clientsIncluded: number;
  clientsFailed: number;
  errors: Array<{ locationId?: string; businessName?: string; message: string }>;
  triggeredBy: "manual" | "cron";
  progressCurrent: number;
  progressTotal: number;
  progressLabel: string | null;
}

export interface ClientRollupView {
  snapshot: ClientAgencySnapshot;
  months: ClientMonthTotals[];
  locations: ClientLocationSummary[];
}

export interface ClientRollupStatus {
  latest: ClientAgencySnapshot | null;
  recent: ClientAgencySnapshot[];
}
