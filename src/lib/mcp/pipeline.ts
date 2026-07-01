/**
 * Lead-flow health for a single client, built for the Gleap MCP server.
 *
 * Answers the "are leads actually coming in / showing up?" question directly:
 *   - a day-by-day lead count for the trailing window (spot a sudden drop to
 *     zero, i.e. ads off or tracking broken), and
 *   - the current open pipeline with the stale-opportunity count (leads that
 *     arrived but were never worked).
 *
 * Reads the latest complete snapshot's day rows (fast Neon read) plus the
 * roster's data-quality columns. Snapshot data is as fresh as the last rollup
 * refresh, so `snapshotAgeHours` is returned for the agent to caveat with.
 */

import {
  getLatestCompleteSnapshot,
  listSnapshotCampaignDays,
  listCampaigns,
  type AgencyCampaignRecord,
} from "@/lib/agency-rollup-store";
import { getTodayLocal, isoToLocalDateString, shiftDateString } from "@/lib/date-ranges";
import { resolveSingleClient, type ResolvedClient } from "@/lib/mcp/resolve-client";

export interface LeadDay {
  date: string;
  leads: number;
  appointments: number;
  adSpend: number;
}

export interface PipelineStatus {
  status: "ok";
  client: {
    locationId: string;
    businessName: string;
    ownerName: string | null;
  };
  window: { days: number; startDate: string; endDate: string };
  snapshot: { id: number; finishedAt: string | null; ageHours: number | null };
  totals: { leads: number; appointments: number; adSpend: number };
  /** Most recent day first is false here — chronological for easy charting. */
  daily: LeadDay[];
  /** Trailing days with zero leads at the end of the window. */
  daysSinceLastLead: number | null;
  openPipeline: {
    openCount: number | null;
    staleOpenCount: number | null;
    staleOpenPct: number | null;
    lastBoardMovementAt: string | null;
  };
  findings: string[];
}

export type PipelineResult =
  | PipelineStatus
  | { status: "not_found"; query: string }
  | { status: "ambiguous"; matches: Array<{ locationId: string; businessName: string }> }
  | { status: "no_snapshot" };

function hoursSince(iso: string | null): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.round(((Date.now() - then) / (1000 * 60 * 60)) * 10) / 10;
}

function aggregateDataQuality(records: AgencyCampaignRecord[]) {
  let openCount: number | null = null;
  let staleOpenCount: number | null = null;
  let lastBoardMovementAt: string | null = null;
  for (const r of records) {
    if (r.openCount != null) openCount = (openCount ?? 0) + r.openCount;
    if (r.staleOpenCount != null) staleOpenCount = (staleOpenCount ?? 0) + r.staleOpenCount;
    if (r.lastManualStageChangeAt) {
      if (!lastBoardMovementAt || r.lastManualStageChangeAt > lastBoardMovementAt) {
        lastBoardMovementAt = r.lastManualStageChangeAt;
      }
    }
  }
  const staleOpenPct =
    openCount != null && openCount > 0 && staleOpenCount != null
      ? Math.round((staleOpenCount / openCount) * 1000) / 10
      : null;
  return { openCount, staleOpenCount, staleOpenPct, lastBoardMovementAt };
}

/**
 * Lead-flow health for the best client match of `query` over the trailing
 * `days` (default 14). Anchored to the snapshot's refresh date so the daily
 * series lines up with the data that actually exists.
 */
export async function getPipelineStatus(params: {
  query: string;
  days?: number;
}): Promise<PipelineResult> {
  const days = Math.min(Math.max(params.days ?? 14, 1), 90);

  const resolved = await resolveSingleClient(params.query);
  if (resolved.status === "not_found") return { status: "not_found", query: params.query };
  if (resolved.status === "ambiguous") {
    return {
      status: "ambiguous",
      matches: resolved.matches.map((m) => ({ locationId: m.locationId, businessName: m.businessName })),
    };
  }
  const client: ResolvedClient = resolved.client;

  const snapshot = await getLatestCompleteSnapshot();
  if (!snapshot) return { status: "no_snapshot" };

  const anchor = snapshot.finishedAt
    ? isoToLocalDateString(snapshot.finishedAt)
    : getTodayLocal();
  const startDate = shiftDateString(anchor, -(days - 1));
  const endDate = anchor;

  const rows = await listSnapshotCampaignDays(snapshot.id, { startDate, endDate });
  const keySet = new Set(client.campaignKeys);
  const clientRows = rows.filter(
    (r) => keySet.has(r.campaignKey) || r.locationId === client.locationId
  );

  // Build a dense chronological series so zero-lead days are explicit.
  const byDate = new Map<string, { leads: number; appointments: number; adSpend: number }>();
  for (let i = 0; i < days; i++) {
    const d = shiftDateString(startDate, i);
    byDate.set(d, { leads: 0, appointments: 0, adSpend: 0 });
  }
  for (const r of clientRows) {
    const bucket = byDate.get(r.date);
    if (!bucket) continue;
    bucket.leads += r.leads;
    bucket.appointments += r.totalAppts;
    bucket.adSpend += r.adSpend;
  }

  const daily: LeadDay[] = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({
      date,
      leads: v.leads,
      appointments: v.appointments,
      adSpend: Math.round(v.adSpend * 100) / 100,
    }));

  const totals = daily.reduce(
    (acc, d) => {
      acc.leads += d.leads;
      acc.appointments += d.appointments;
      acc.adSpend += d.adSpend;
      return acc;
    },
    { leads: 0, appointments: 0, adSpend: 0 }
  );
  totals.adSpend = Math.round(totals.adSpend * 100) / 100;

  // Count trailing zero-lead days (from the most recent backward).
  let daysSinceLastLead: number | null = 0;
  for (let i = daily.length - 1; i >= 0; i--) {
    if (daily[i].leads > 0) break;
    daysSinceLastLead++;
  }
  if (daysSinceLastLead === daily.length) daysSinceLastLead = daily.length; // none in window

  const roster = await listCampaigns(client.campaignKeys);
  const openPipeline = aggregateDataQuality(roster);

  const findings = buildPipelineFindings({
    days,
    totals,
    daysSinceLastLead,
    openPipeline,
    spendButNoLeads: totals.adSpend > 0 && totals.leads === 0,
  });

  return {
    status: "ok",
    client: {
      locationId: client.locationId,
      businessName: client.businessName,
      ownerName: client.ownerName,
    },
    window: { days, startDate, endDate },
    snapshot: {
      id: snapshot.id,
      finishedAt: snapshot.finishedAt,
      ageHours: hoursSince(snapshot.finishedAt),
    },
    totals,
    daily,
    daysSinceLastLead,
    openPipeline,
    findings,
  };
}

function buildPipelineFindings(args: {
  days: number;
  totals: { leads: number; appointments: number; adSpend: number };
  daysSinceLastLead: number | null;
  openPipeline: ReturnType<typeof aggregateDataQuality>;
  spendButNoLeads: boolean;
}): string[] {
  const out: string[] = [];
  const { days, totals, daysSinceLastLead, openPipeline, spendButNoLeads } = args;

  if (totals.leads === 0) {
    out.push(`No leads recorded in the last ${days} days.`);
  } else {
    out.push(`${totals.leads} leads over the last ${days} days (${totals.appointments} reached appointment stage).`);
  }

  if (daysSinceLastLead != null && daysSinceLastLead >= 3 && totals.leads > 0) {
    out.push(`${daysSinceLastLead} days since the last recorded lead — worth checking ad delivery and tracking.`);
  }

  if (spendButNoLeads) {
    out.push("Ad spend is going out but zero leads are landing. Likely a tracking/lead-capture break, not budget.");
  }

  if (openPipeline.staleOpenCount != null && openPipeline.staleOpenCount > 0) {
    const pct = openPipeline.staleOpenPct != null ? ` (${openPipeline.staleOpenPct}% of open)` : "";
    out.push(
      `${openPipeline.staleOpenCount} open opportunities are 21+ days stale${pct} — leads are likely captured but not being worked.`
    );
  }

  if (openPipeline.lastBoardMovementAt) {
    const ageDays = Math.round(
      (Date.now() - new Date(openPipeline.lastBoardMovementAt).getTime()) / (1000 * 60 * 60 * 24)
    );
    if (ageDays >= 5) {
      out.push(`The pipeline board hasn't been touched in ${ageDays} days, so "leads not showing up" may be a CRM-hygiene issue.`);
    }
  }

  return out;
}
