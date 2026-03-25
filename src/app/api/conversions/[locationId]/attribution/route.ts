import { NextResponse } from "next/server";
import { getToken } from "@/lib/oauth-tokens";
import { getPipelines } from "@/lib/ghl-oauth";
import { findMatchingPipeline, PAIN_PATIENTS_CONFIG } from "@/lib/pipeline-matching";
import {
  getDateRangeForPreset,
  type DateRangePreset,
} from "@/lib/date-ranges";
import { getLocationSettings } from "@/lib/location-settings";
import {
  getAttributionBreakdown,
  type AttributionBreakdownRow,
  type AttributionBreakdownRowInternal,
  type AttributionDimension,
} from "@/lib/ghl-attribution";
import {
  fetchCampaigns,
  fetchSpendByInsightsLevel,
  normalizeAdAccountId,
  type MetaInsightsLevel,
} from "@/lib/facebook-ads";

function dimensionToInsightsLevel(
  dimension: AttributionDimension
): MetaInsightsLevel | null {
  if (dimension === "content") return "ad";
  if (dimension === "medium") return "adset";
  if (dimension === "campaign") return "campaign";
  return null;
}

function mergeSpendIntoRows(
  rows: AttributionBreakdownRowInternal[],
  spendByObjectId: Record<string, number>,
  dimension: AttributionDimension
): AttributionBreakdownRow[] {
  return rows.map((r) => {
    const { spendJoinIds, ...rest } = r;
    if (dimension === "source" || spendJoinIds.length === 0) {
      return { ...rest, spend: null };
    }
    let total = 0;
    let any = false;
    for (const id of spendJoinIds) {
      const v = spendByObjectId[id];
      if (v != null) {
        total += v;
        any = true;
      }
    }
    return {
      ...rest,
      spend: any ? Math.round(total * 100) / 100 : null,
    };
  });
}

const DIMENSIONS: AttributionDimension[] = [
  "content",
  "medium",
  "campaign",
  "source",
];

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
        { status: 401 }
      );
    }

    const { searchParams } = new URL(req.url);
    const pipelineId = searchParams.get("pipelineId");
    const dateRangePreset = (searchParams.get("dateRange") ?? "last_30") as DateRangePreset;
    const dateFrom = searchParams.get("dateFrom") ?? undefined;
    const dateTo = searchParams.get("dateTo") ?? undefined;
    const clientDate = searchParams.get("clientDate") ?? undefined;
    const attributionParam = searchParams.get("attribution");
    const attributionMode =
      attributionParam === "created" ? "created" : "lastUpdated";
    const dimRaw = (searchParams.get("dimension") ?? "content").toLowerCase();
    const dimension: AttributionDimension = DIMENSIONS.includes(
      dimRaw as AttributionDimension
    )
      ? (dimRaw as AttributionDimension)
      : "content";

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
        rows: [],
        meta: null,
        message: pipelineId
          ? "Pipeline not found"
          : "No pipeline found. Select a pipeline.",
        pipelines: pipelines.map((p) => ({ id: p.id, name: p.name })),
      });
    }

    const dateRange = getDateRangeForPreset(
      dateRangePreset,
      dateFrom,
      dateTo,
      clientDate
    );

    const customMappings = settings?.stageMappings?.[pipeline.id];

    const { rows: rowsInternal, meta } = await getAttributionBreakdown({
      locationId,
      pipeline,
      accessToken: stored.access_token,
      dateRange,
      attributionMode,
      dimension,
      customMappings,
    });

    const adAccountRaw = settings?.facebookAdAccountId?.trim() ?? "";
    const campaignKeyword = settings?.facebookCampaignKeyword?.trim() ?? "";

    let rows: AttributionBreakdownRow[] = rowsInternal.map(
      ({ spendJoinIds: _j, ...rest }) => rest
    );
    let metaSpendError: string | undefined;

    const insightsLevel = dimensionToInsightsLevel(dimension);
    const normalizedAccount = normalizeAdAccountId(adAccountRaw);

    if (insightsLevel && normalizedAccount) {
      let campaignIdsForFilter: string[] | undefined;

      if (campaignKeyword) {
        const { campaigns, error: campErr } =
          await fetchCampaigns(normalizedAccount);
        if (campErr) {
          metaSpendError = campErr;
        } else {
          const kw = campaignKeyword.toLowerCase();
          const matching = campaigns.filter((c) =>
            c.name.toLowerCase().includes(kw)
          );
          campaignIdsForFilter =
            matching.length > 0 ? matching.map((c) => c.id) : [];
        }
      }

      if (!metaSpendError && campaignIdsForFilter?.length === 0 && campaignKeyword) {
        metaSpendError = `No campaigns match keyword "${campaignKeyword}"`;
      }

      if (!metaSpendError) {
        const { spendByObjectId, error: spendErr } =
          await fetchSpendByInsightsLevel(
            normalizedAccount,
            insightsLevel,
            dateRange.startDate,
            dateRange.endDate,
            campaignIdsForFilter?.length
              ? { campaignIds: campaignIdsForFilter }
              : undefined
          );
        if (spendErr) {
          metaSpendError = spendErr;
        } else {
          rows = mergeSpendIntoRows(
            rowsInternal,
            spendByObjectId,
            dimension
          );
        }
      }
    }

    return NextResponse.json({
      pipeline: { id: pipeline.id, name: pipeline.name },
      rows,
      meta: {
        ...meta,
        dateRange,
        attributionMode,
        ...(metaSpendError ? { metaSpendError } : {}),
      },
      pipelines: pipelines.map((p) => ({ id: p.id, name: p.name })),
    });
  } catch (err) {
    console.error("[conversions/attribution] Error:", err);
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to fetch attribution",
      },
      { status: 500 }
    );
  }
}
