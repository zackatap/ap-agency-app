/**
 * Debug endpoint to troubleshoot opportunity data fetching.
 * GET /api/debug/opportunities/[locationId]?pipelineId=xxx
 * Query params:
 *   - name=...  (optional) Find and return full raw opportunity for contact/opp matching this name
 *   - last=N    (optional) Return last N opportunities by date updated (table view, max 100)
 *
 * Returns diagnostics: GHL total, pagination, date distribution, sample records.
 */

import { NextResponse } from "next/server";
import { getToken } from "@/lib/oauth-tokens";
import { getPipelines } from "@/lib/ghl-oauth";
import { findMatchingPipeline, PAIN_PATIENTS_CONFIG } from "@/lib/pipeline-matching";
import { getMonthsBack } from "@/lib/date-ranges";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const GHL_BASE = "https://services.leadconnectorhq.com";
const API_VERSION = "2021-07-28";

function authHeaders(token: string): HeadersInit {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    Version: API_VERSION,
  };
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ locationId: string }> }
) {
  try {
    const { locationId } = await params;
    const { searchParams } = new URL(_req.url);
    const pipelineIdParam = searchParams.get("pipelineId");
    const searchName = searchParams.get("name")?.trim();
    const lastN = Math.min(Math.max(parseInt(searchParams.get("last") ?? "0", 10), 0), 250);
    const tableMode = lastN > 0;
    // Fetch extra pages so we can sort by dateUpdated and take top N (API returns creation order)
    const maxPages = searchName ? 20 : tableMode ? 12 : Math.min(parseInt(searchParams.get("maxPages") ?? "5", 10), 20);

    const stored = await getToken(locationId);
    if (!stored) {
      return NextResponse.json(
        { error: "Not connected", needsAuth: true },
        { status: 401 }
      );
    }

    const pipelines = await getPipelines(locationId, stored.access_token);
    const pipeline = pipelineIdParam
      ? pipelines.find((p) => p.id === pipelineIdParam)
      : findMatchingPipeline(pipelines, PAIN_PATIENTS_CONFIG) ?? pipelines[0];

    if (!pipeline) {
      return NextResponse.json({
        error: "No pipeline found",
        pipelines: pipelines.map((p) => ({ id: p.id, name: p.name })),
      });
    }

    // Use page-based pagination (matches production ghl-oauth). startAfterId caused 100-result cap.
    const allOpps: Array<{
      id: string;
      dateCreated?: string;
      stageName?: string;
      status?: string;
      dateStr?: string;
    }> = [];
    let ghlTotal: number | null = null;
    let pagesFetched = 0;
    let firstRawOpp: Record<string, unknown> | null = null;
    const allRawOpps: Record<string, unknown>[] = searchName || tableMode ? [] : [];
    let page = 1;

    while (page <= maxPages) {
      if (page > 1) await delay(300); // Throttle to avoid 429
      const url = new URL(`${GHL_BASE}/opportunities/search`);
      url.searchParams.set("location_id", locationId);
      url.searchParams.set("pipeline_id", pipeline.id);
      url.searchParams.set("status", "all");
      url.searchParams.set("limit", "100");
      url.searchParams.set("page", String(page));

      const res = await fetch(url.toString(), {
        headers: authHeaders(stored.access_token),
      });
      if (res.status === 429) {
        await delay(4000);
        continue; // Retry same page
      }
      if (!res.ok) {
        return NextResponse.json({
          error: `GHL API error: ${res.status}`,
          body: await res.text(),
        });
      }

      const data = (await res.json()) as {
        opportunities?: Array<Record<string, unknown>>;
        data?: Array<Record<string, unknown>>;
        total?: number;
        totalCount?: number;
      };
      const opportunities = data.opportunities ?? data.data ?? [];
      ghlTotal = data.total ?? data.totalCount ?? null;
      pagesFetched = page;
      if (!firstRawOpp && opportunities.length > 0) {
        firstRawOpp = opportunities[0] as Record<string, unknown>;
      }
      if (searchName || tableMode) {
        for (const opp of opportunities) {
          allRawOpps.push(opp as Record<string, unknown>);
        }
        if (searchName && allRawOpps.length >= 100) break;
      }

      for (const opp of opportunities) {
        const created =
          (opp.dateCreated as string) ??
          (opp.date_created as string) ??
          (opp.createdAt as string);
        const status =
          (opp.status as string) ??
          (opp.opportunity_status as string) ??
          (opp.opportunityStatus as string);
        allOpps.push({
          id: (opp.id as string) ?? "",
          dateCreated: created,
          stageName: (opp.stageName as string) ?? (opp.stage_name as string),
          status: status ?? "(none)",
          dateStr: created ? created.split("T")[0] : undefined,
        });
      }

      if (opportunities.length < 100) break;
      if (ghlTotal && page * 100 >= ghlTotal) break;
      page += 1;
    }

    const withDate = allOpps.filter((o) => o.dateStr);
    const withoutDate = allOpps.filter((o) => !o.dateStr);
    const dates = withDate.map((o) => o.dateStr!);
    const minDate = dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null;
    const maxDate = dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null;

    const monthRanges = getMonthsBack(3); // sample 3 months
    const byMonth: Record<string, number> = {};
    for (const range of monthRanges) {
      byMonth[range.monthKey] = withDate.filter(
        (o) => o.dateStr! >= range.startDate && o.dateStr! <= range.endDate
      ).length;
    }

    const byStatus = allOpps.reduce<Record<string, number>>((acc, o) => {
      const s = o.status ?? "(none)";
      acc[s] = (acc[s] ?? 0) + 1;
      return acc;
    }, {});
    const wonOpps = allOpps.filter((o) => (o.status ?? "").toLowerCase() === "won");

    // When name= param provided, find matching opps and optionally fetch contact to match by contact name
    let opportunityByName: Record<string, unknown>[] = [];
    if (searchName && allRawOpps.length > 0) {
      const term = searchName.toLowerCase();
      const byOppName = allRawOpps.filter((opp) => {
        const n =
          (opp.name as string) ??
          (opp.opportunityName as string) ??
          (opp.oppName as string) ??
          "";
        return n.toLowerCase().includes(term);
      });
      if (byOppName.length > 0) {
        opportunityByName = byOppName;
      } else {
        // Try matching by contact name - fetch contact for opps (limit to first 25 to avoid rate limits)
        const toCheck = allRawOpps.slice(0, 25);
        for (const opp of toCheck) {
          const cid = (opp.contactId as string) ?? (opp.contact_id as string);
          if (!cid) continue;
          await delay(200);
          try {
            const cr = await fetch(`${GHL_BASE}/contacts/${cid}`, {
              headers: authHeaders(stored.access_token),
            });
            if (!cr.ok) continue;
            const c = (await cr.json()) as { contact?: Record<string, unknown> };
            const contact = (c.contact ?? c) as Record<string, unknown>;
            const fullName = [
              contact.firstName ?? contact.first_name,
              contact.lastName ?? contact.last_name,
              contact.name,
            ]
              .filter(Boolean)
              .join(" ")
              .toLowerCase();
            if (fullName.includes(term)) {
              opportunityByName.push({ ...opp, _contact: contact });
            }
          } catch {
            // skip
          }
        }
      }
    }

    const payload: Record<string, unknown> = {
      pipeline: { id: pipeline.id, name: pipeline.name },
      ghlTotal,
      pagesFetched,
      opportunitiesFetched: allOpps.length,
      withDateCount: withDate.length,
      withoutDateCount: withoutDate.length,
      dateRange: minDate && maxDate ? { min: minDate, max: maxDate } : null,
      countByMonth: byMonth,
      countByStatus: byStatus,
      wonCount: wonOpps.length,
      sampleWithStatus: allOpps.slice(0, 5).map((o) => ({
        id: o.id,
        stageName: o.stageName,
        status: o.status,
      })),
      rawOppKeys: firstRawOpp ? Object.keys(firstRawOpp) : [],
      sampleDates: dates.slice(0, 10),
      sampleWithoutDate: withoutDate.slice(0, 3).map((o) => ({ id: o.id, stageName: o.stageName })),
    };
    if (searchName) {
      payload.opportunityByName = opportunityByName;
      payload.searchName = searchName;
    }
    if (tableMode) {
      // Dedupe by opportunity id (API can return same opp across pages)
      const seen = new Set<string>();
      const unique: Record<string, unknown>[] = [];
      for (const o of allRawOpps) {
        const id = (o.id as string) ?? (o.opportunity_id as string) ?? "";
        if (id && !seen.has(id)) {
          seen.add(id);
          unique.push(o);
        }
      }
      // Sort by date updated (desc), fallback to date created. Take top N.
      const getUpdated = (o: Record<string, unknown>): string =>
        (o.dateUpdated as string) ??
        (o.date_updated as string) ??
        (o.lastStatusChangeAt as string) ??
        (o.last_status_change_at as string) ??
        (o.lastStageChangeAt as string) ??
        (o.last_stage_change_at as string) ??
        (o.dateCreated as string) ??
        (o.date_created as string) ??
        (o.createdAt as string) ??
        "";
      const sorted = unique.sort((a, b) => {
        const da = getUpdated(a);
        const db = getUpdated(b);
        return db.localeCompare(da); // descending (newest first)
      });
      // Enrich with stage name from pipeline (GHL search may not include stageName)
      const stageIdToName = new Map<string, string>();
      for (const s of pipeline.stages ?? []) {
        stageIdToName.set(s.id, s.name);
      }
      const enriched = sorted.slice(0, lastN).map((o) => {
        const stageId = (o.pipelineStageId as string) ?? (o.pipeline_stage_id as string);
        const stageName =
          (o.stageName as string) ??
          (o.stage_name as string) ??
          (stageId ? stageIdToName.get(stageId) : null);
        return { ...o, _stageName: stageName ?? "—" };
      });
      payload.opportunities = enriched;
    }

    return NextResponse.json(payload);
  } catch (err) {
    console.error("[debug/opportunities] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
