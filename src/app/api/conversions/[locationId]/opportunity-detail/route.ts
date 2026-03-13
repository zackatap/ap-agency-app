import { NextResponse } from "next/server";
import { getToken } from "@/lib/oauth-tokens";
import { getPipelines, getOpportunityNamesForCell, STATUS_WON_KEY } from "@/lib/ghl-oauth";
import { findMatchingPipeline, PAIN_PATIENTS_CONFIG } from "@/lib/pipeline-matching";
import { getMonthsBack } from "@/lib/date-ranges";
import { getLocationSettings } from "@/lib/location-settings";
import { getStageKeysForMetric, getRollupGroupsForMetric } from "@/lib/funnel-metrics";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ locationId: string }> }
) {
  try {
    const { locationId } = await params;
    if (!locationId) {
      return NextResponse.json({ error: "locationId required" }, { status: 400 });
    }

    const stored = await getToken(locationId);
    if (!stored) {
      return NextResponse.json(
        { error: "Not connected", needsAuth: true },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(req.url);
    const pipelineId = searchParams.get("pipelineId");
    const monthKey = searchParams.get("monthKey");
    const metric = searchParams.get("metric");
    const attribution = searchParams.get("attribution") === "created" ? "created" : "lastUpdated";
    const onTotals = searchParams.get("onTotals") === "true";

    if (!pipelineId || !monthKey || !metric) {
      return NextResponse.json(
        { error: "pipelineId, monthKey, and metric are required" },
        { status: 400 }
      );
    }

    const pipelines = await getPipelines(locationId, stored.access_token);
    const settings = await getLocationSettings(locationId);
    const pipeline =
      pipelines.find((p) => p.id === pipelineId) ??
      (settings?.defaultPipelineId ? pipelines.find((p) => p.id === settings.defaultPipelineId) : null) ??
      findMatchingPipeline(pipelines, PAIN_PATIENTS_CONFIG);

    if (!pipeline) {
      return NextResponse.json({ error: "Pipeline not found", names: [] }, { status: 404 });
    }

    const monthRanges = getMonthsBack(13);
    const rangeForMonth = monthRanges.find((r) => r.monthKey === monthKey);
    if (!rangeForMonth) {
      return NextResponse.json({ error: "Invalid monthKey", names: [] }, { status: 400 });
    }

    const customMappings = settings?.stageMappings?.[pipeline.id];
    const allStageKeys = [
      ...(pipeline.stages ?? []).map((s) => s.name),
      ...Object.keys(customMappings ?? {}),
      STATUS_WON_KEY,
    ];

    let contributingKeys: string[];
    let rollupGroups: { label: string; stageKeys: string[] }[] | undefined;

    if (onTotals) {
      rollupGroups = getRollupGroupsForMetric(
        metric,
        allStageKeys,
        customMappings,
        pipeline.stages ?? undefined
      );
      contributingKeys = rollupGroups.flatMap((g) => g.stageKeys);
    } else {
      contributingKeys = getStageKeysForMetric(
        metric,
        allStageKeys,
        customMappings,
        pipeline.stages ?? undefined
      );
    }

    const result = await getOpportunityNamesForCell(
      locationId,
      pipeline,
      stored.access_token,
      monthRanges,
      attribution,
      monthKey,
      contributingKeys,
      rollupGroups
    );

    return NextResponse.json({
      names: result.names,
      namesByStage: result.namesByStage,
      metric,
      monthKey,
    });
  } catch (err) {
    console.error("[opportunity-detail] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch" },
      { status: 500 }
    );
  }
}
