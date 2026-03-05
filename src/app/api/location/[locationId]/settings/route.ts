import { NextResponse } from "next/server";
import { getToken } from "@/lib/oauth-tokens";
import {
  getLocationSettings,
  updateLocationSettings,
  type MappableStage,
  type StageMappings,
  type AdSpend,
} from "@/lib/location-settings";

export async function GET(
  _req: Request,
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

    const settings = await getLocationSettings(locationId);
    if (!settings) {
    return NextResponse.json({
      locationId,
      defaultPipelineId: null,
      defaultCampaignId: null,
      facebookAdAccountId: null,
      facebookCampaignKeyword: null,
      stageMappings: {},
      adSpend: {},
      rollupAssumptions: true,
      attributionMode: "lastUpdated",
    });
    }

    return NextResponse.json({
      locationId: settings.locationId,
      defaultPipelineId: settings.defaultPipelineId,
      defaultCampaignId: settings.defaultCampaignId,
      facebookAdAccountId: settings.facebookAdAccountId,
      facebookCampaignKeyword: settings.facebookCampaignKeyword,
      stageMappings: settings.stageMappings,
      adSpend: settings.adSpend,
      rollupAssumptions: settings.rollupAssumptions,
      attributionMode: settings.attributionMode,
    });
  } catch (err) {
    console.error("[location/settings] GET error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch settings" },
      { status: 500 }
    );
  }
}

export async function PATCH(
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

    const body = await req.json().catch(() => ({}));
    const patch: {
      defaultPipelineId?: string | null;
      defaultCampaignId?: string | null;
      facebookAdAccountId?: string | null;
      facebookCampaignKeyword?: string | null;
      stageMappings?: StageMappings;
      adSpend?: AdSpend;
      rollupAssumptions?: boolean;
      attributionMode?: "created" | "lastUpdated";
      stageMapping?: {
        pipelineId: string;
        stageName: string;
        mapTo: MappableStage | null;
      };
    } = body;

    let finalPatch: Partial<{
      defaultPipelineId: string | null;
      defaultCampaignId: string | null;
      facebookAdAccountId: string | null;
      facebookCampaignKeyword: string | null;
      stageMappings: StageMappings;
      adSpend: AdSpend;
      rollupAssumptions: boolean;
      attributionMode: "created" | "lastUpdated";
    }> = {};

    if (patch.defaultPipelineId !== undefined) {
      finalPatch.defaultPipelineId = patch.defaultPipelineId;
    }
    if (patch.defaultCampaignId !== undefined) {
      finalPatch.defaultCampaignId = patch.defaultCampaignId;
    }
    if (patch.facebookAdAccountId !== undefined) {
      finalPatch.facebookAdAccountId = patch.facebookAdAccountId;
    }
    if (patch.facebookCampaignKeyword !== undefined) {
      finalPatch.facebookCampaignKeyword = patch.facebookCampaignKeyword;
    }
    if (patch.stageMappings !== undefined) {
      finalPatch.stageMappings = patch.stageMappings;
    }
    if (patch.adSpend !== undefined) {
      finalPatch.adSpend = patch.adSpend;
    }
    if (patch.rollupAssumptions !== undefined) {
      finalPatch.rollupAssumptions = patch.rollupAssumptions;
    }
    if (patch.attributionMode !== undefined) {
      finalPatch.attributionMode = patch.attributionMode;
    }

    if (patch.stageMapping) {
      const { pipelineId, stageName, mapTo } = patch.stageMapping;
      const settings = await getLocationSettings(locationId);
      const prev = settings?.stageMappings ?? {};
      const pipelineMappings = { ...(prev[pipelineId] ?? {}) };
      if (mapTo) {
        pipelineMappings[stageName] = mapTo;
      } else {
        delete pipelineMappings[stageName];
      }
      finalPatch.stageMappings = { ...prev, [pipelineId]: pipelineMappings };
    }

    const updated = await updateLocationSettings(locationId, finalPatch);
    if (!updated) {
      return NextResponse.json(
        { error: "Failed to update settings" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      locationId: updated.locationId,
      defaultPipelineId: updated.defaultPipelineId,
      defaultCampaignId: updated.defaultCampaignId,
      facebookAdAccountId: updated.facebookAdAccountId,
      facebookCampaignKeyword: updated.facebookCampaignKeyword,
      stageMappings: updated.stageMappings,
      adSpend: updated.adSpend,
      rollupAssumptions: updated.rollupAssumptions,
      attributionMode: updated.attributionMode,
    });
  } catch (err) {
    console.error("[location/settings] PATCH error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update settings" },
      { status: 500 }
    );
  }
}
