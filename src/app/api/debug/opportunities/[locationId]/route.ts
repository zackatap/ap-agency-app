/**
 * Debug endpoint to troubleshoot opportunity data fetching.
 * GET /api/debug/opportunities/[locationId]?pipelineId=xxx
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
    const maxPages = Math.min(parseInt(searchParams.get("maxPages") ?? "5", 10), 20);

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

    // Fetch using cursor-based pagination (startAfterId) to avoid ~200 result cap
    const allOpps: Array<{
      id: string;
      dateCreated?: string;
      stageName?: string;
      dateStr?: string;
    }> = [];
    let ghlTotal: number | null = null;
    let pagesFetched = 0;
    let startAfterId: string | undefined;

    for (let i = 0; i < maxPages; i++) {
      if (i > 0) await delay(300); // Throttle to avoid 429
      const url = new URL(`${GHL_BASE}/opportunities/search`);
      url.searchParams.set("location_id", locationId);
      url.searchParams.set("pipeline_id", pipeline.id);
      url.searchParams.set("limit", "100");
      if (startAfterId) url.searchParams.set("startAfterId", startAfterId);

      const res = await fetch(url.toString(), {
        headers: authHeaders(stored.access_token),
      });
      if (res.status === 429) {
        await delay(4000);
        i--; // Retry same page
        continue;
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
      pagesFetched = i + 1;

      for (const opp of opportunities) {
        const created =
          (opp.dateCreated as string) ??
          (opp.date_created as string) ??
          (opp.createdAt as string);
        allOpps.push({
          id: (opp.id as string) ?? "",
          dateCreated: created,
          stageName: (opp.stageName as string) ?? (opp.stage_name as string),
          dateStr: created ? created.split("T")[0] : undefined,
        });
      }

      if (opportunities.length < 100) break;
      const lastId = (opportunities[opportunities.length - 1].id as string) ??
        (opportunities[opportunities.length - 1] as Record<string, unknown>).id as string;
      if (!lastId) break;
      startAfterId = lastId;
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

    return NextResponse.json({
      pipeline: { id: pipeline.id, name: pipeline.name },
      ghlTotal,
      pagesFetched,
      opportunitiesFetched: allOpps.length,
      withDateCount: withDate.length,
      withoutDateCount: withoutDate.length,
      dateRange: minDate && maxDate ? { min: minDate, max: maxDate } : null,
      countByMonth: byMonth,
      sampleDates: dates.slice(0, 10),
      sampleWithoutDate: withoutDate.slice(0, 3).map((o) => ({ id: o.id, stageName: o.stageName })),
    });
  } catch (err) {
    console.error("[debug/opportunities] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
