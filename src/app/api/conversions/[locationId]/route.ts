import { NextResponse } from "next/server";
import { getToken } from "@/lib/oauth-tokens";
import { getPipelines, getOpportunityCountsByStage } from "@/lib/ghl-oauth";
import { findMatchingPipeline, PAIN_PATIENTS_CONFIG } from "@/lib/pipeline-matching";
import { calculateFunnelMetrics, getUnmappedStages, getEffectiveMapping, getStageKeysForMetric } from "@/lib/funnel-metrics";
import { STATUS_WON_KEY } from "@/lib/ghl-oauth";
import {
  getDateRangeForPreset,
  type DateRangePreset,
} from "@/lib/date-ranges";
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
    const dateRangePreset = (searchParams.get("dateRange") ?? "last_30") as DateRangePreset;
    const dateFrom = searchParams.get("dateFrom") ?? undefined;
    const dateTo = searchParams.get("dateTo") ?? undefined;
    const clientDate = searchParams.get("clientDate") ?? undefined; // YYYY-MM-DD from user's timezone

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
        pipeline: null,
        metrics: null,
        pipelines: pipelines.map((p) => ({ id: p.id, name: p.name })),
        message: pipelineId
          ? "Pipeline not found"
          : "No pipeline matching 'pain' found. Select a pipeline from the dropdown.",
      });
    }

    const dateRange = getDateRangeForPreset(
      dateRangePreset,
      dateFrom,
      dateTo,
      clientDate
    );

    const { counts: stageCounts, values: stageValues } =
      await getOpportunityCountsByStage(
        locationId,
        pipeline,
        stored.access_token,
        dateRange
      );
    const customMappings = settings?.stageMappings?.[pipeline.id];
    const funnel = calculateFunnelMetrics(
      stageCounts,
      stageValues,
      pipeline.stages ?? undefined,
      customMappings
    );
    const allStages = pipeline.stages ?? [];
    const allStageNames = [
      ...allStages.map((s) => s.name),
      ...Object.keys(stageCounts).filter((k) => k !== STATUS_WON_KEY),
    ];
    const uniqueStageNames = [...new Set(allStageNames)];
    const unmappedNames = getUnmappedStages(uniqueStageNames, customMappings);
    const allStageMappings = uniqueStageNames.map((name) => ({
      name,
      count: stageCounts[name] ?? 0,
      mapping: getEffectiveMapping(name, customMappings),
    }));

    const leadStageKeys = getStageKeysForMetric(
      "leads",
      uniqueStageNames,
      customMappings,
      pipeline.stages ?? undefined
    );
    const leadsBreakdown: Record<string, number> = {};
    for (const key of leadStageKeys) {
      const c = stageCounts[key] ?? 0;
      if (c > 0) leadsBreakdown[key] = c;
    }

    return NextResponse.json({
      pipeline: {
        id: pipeline.id,
        name: pipeline.name,
        stages: pipeline.stages ?? [],
      },
      metrics: funnel,
      stageCounts,
      leadsBreakdown,
      dateRange,
      pipelines: pipelines.map((p) => ({ id: p.id, name: p.name })),
      allStageMappings,
      unmappedStages: unmappedNames.map((name) => ({
        name,
        count: stageCounts[name] ?? 0,
      })),
    });
  } catch (err) {
    console.error("[conversions] Error:", err);
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Failed to fetch conversions",
      },
      { status: 500 }
    );
  }
}
