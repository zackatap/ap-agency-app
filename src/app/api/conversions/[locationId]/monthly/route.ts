import { NextResponse } from "next/server";
import { getToken } from "@/lib/oauth-tokens";
import { getPipelines, getOpportunityCountsByStage } from "@/lib/ghl-oauth";
import { findMatchingPipeline, PAIN_PATIENTS_CONFIG } from "@/lib/pipeline-matching";
import { calculateFunnelMetrics, getUnmappedStages, getEffectiveMapping } from "@/lib/funnel-metrics";
import { getMonthsBack } from "@/lib/date-ranges";
import { getLocationSettings } from "@/lib/location-settings";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ locationId: string }> }
) {
  try {
    const { locationId } = await params;
    if (!locationId) {
      return NextResponse.json(
        { error: "locationId is required" },
        { status: 400 }
      );
    }

    const stored = await getToken(locationId);
    if (!stored) {
      return NextResponse.json(
        { error: "Not connected", needsAuth: true },
        {
          status: 401,
          headers: {
            "Cache-Control": "no-store, no-cache, must-revalidate",
            Pragma: "no-cache",
          },
        }
      );
    }

    const { searchParams } = new URL(req.url);
    const pipelineId = searchParams.get("pipelineId");
    const monthsParam = searchParams.get("months");
    const monthsCount = Math.min(Math.max(parseInt(monthsParam ?? "13", 10), 1), 24);
    const clientDate = searchParams.get("clientDate") ?? undefined;

    const pipelines = await getPipelines(locationId, stored.access_token);
    const settings = await getLocationSettings(locationId);
    const pipeline =
      pipelineId
        ? pipelines.find((p) => p.id === pipelineId)
        : (settings?.defaultPipelineId
            ? pipelines.find((p) => p.id === settings.defaultPipelineId)
            : null) ?? findMatchingPipeline(pipelines, PAIN_PATIENTS_CONFIG);

    if (!pipeline) {
      return NextResponse.json({
        months: [],
        pipelines: pipelines.map((p) => ({ id: p.id, name: p.name })),
        message: pipelineId ? "Pipeline not found" : "No matching pipeline found.",
      });
    }

    const monthRanges = getMonthsBack(monthsCount, clientDate);
    const customMappings = settings?.stageMappings?.[pipeline.id];

    const monthsWithCounts = await Promise.all(
      monthRanges.map(async (range) => {
        const { counts, values } = await getOpportunityCountsByStage(
          locationId,
          pipeline,
          stored.access_token,
          { startDate: range.startDate, endDate: range.endDate }
        );
        const metrics = calculateFunnelMetrics(
          counts,
          values,
          pipeline.stages ?? undefined,
          customMappings
        );
        return {
          monthKey: range.monthKey,
          startDate: range.startDate,
          endDate: range.endDate,
          metrics,
          stageCounts: counts,
        };
      })
    );
    const months = monthsWithCounts.map(({ stageCounts: _, ...m }) => m);
    const latestCounts = monthsWithCounts[monthsWithCounts.length - 1]?.stageCounts ?? {};
    const stageNames = [
      ...new Set([
        ...(pipeline.stages ?? []).map((s) => s.name),
        ...Object.keys(latestCounts),
      ]),
    ];
    const unmappedNames = getUnmappedStages(stageNames, customMappings);
    const allStageMappings = stageNames.map((name) => ({
      name,
      count: latestCounts[name] ?? 0,
      mapping: getEffectiveMapping(name, customMappings),
    }));

    return NextResponse.json({
      months,
      pipelines: pipelines.map((p) => ({ id: p.id, name: p.name })),
      allStageMappings,
      unmappedStages: unmappedNames.map((name) => ({
        name,
        count: latestCounts[name] ?? 0,
      })),
      adSpend: settings?.adSpend?.[pipeline.id] ?? {},
    });
  } catch (err) {
    console.error("[conversions/monthly] Error:", err);
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Failed to fetch monthly metrics",
      },
      { status: 500 }
    );
  }
}
