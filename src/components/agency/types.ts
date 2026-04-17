/** Client-side mirror of the types returned by /api/agency/rollup/latest. */

import type { MetricKey } from "@/lib/agency-rollup-view";

export type { MetricKey };

export type CampaignStatusLabel = "ACTIVE" | "2ND CMPN";

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

export interface ClientCampaignMonth {
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

export interface ClientCampaignSummary {
  campaignKey: string;
  locationId: string;
  status: CampaignStatusLabel;
  cid: string | null;
  businessName: string;
  ownerName: string | null;
  pipelineId: string | null;
  pipelineName: string | null;
  pipelineKeyword: string | null;
  campaignKeyword: string | null;
  adAccountId: string | null;
  included: boolean;
  errorMessage: string | null;
  needsSetupReason: string | null;
  totals: Omit<ClientCampaignMonth, "monthKey">;
  latestMonth: ClientCampaignMonth | null;
  months: ClientCampaignMonth[];
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
  errors: Array<{
    locationId?: string;
    businessName?: string;
    campaignKey?: string;
    message: string;
  }>;
  triggeredBy: "manual" | "cron";
  progressCurrent: number;
  progressTotal: number;
  progressLabel: string | null;
}

export interface ClientRollupView {
  snapshot: ClientAgencySnapshot;
  months: ClientMonthTotals[];
  campaigns: ClientCampaignSummary[];
}

export interface ClientRollupStatus {
  latest: ClientAgencySnapshot | null;
  recent: ClientAgencySnapshot[];
}

/**
 * A display row in the leaderboard/distribution/charts. Either a single
 * campaign or a CID rollup combining multiple campaigns. When `children` is
 * populated, this row is an aggregation; the UI can show an accordion toggle.
 */
export interface ClientLeaderboardRow {
  rowKey: string;
  /** true when this row aggregates multiple campaigns (e.g. CID rollup). */
  isGroup: boolean;
  displayName: string;
  subLabel: string | null;
  cid: string | null;
  locationId: string | null;
  campaignKey: string | null;
  pipelineName: string | null;
  statuses: CampaignStatusLabel[];
  included: boolean;
  errorMessage: string | null;
  totals: Omit<ClientCampaignMonth, "monthKey">;
  months: ClientCampaignMonth[];
  children: ClientCampaignSummary[];
}
