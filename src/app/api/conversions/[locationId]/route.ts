import { NextResponse } from "next/server";
import { getToken } from "@/lib/oauth-tokens";
import { getPipelines, getOpportunityCountsByStage } from "@/lib/ghl-oauth";
import {
  findMatchingPipeline,
  calculateConversion,
  PAIN_PATIENTS_CONFIG,
} from "@/lib/pipeline-matching";

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
        {
          status: 401,
          headers: {
            "Cache-Control": "no-store, no-cache, must-revalidate",
            Pragma: "no-cache",
          },
        }
      );
    }

    const pipelines = await getPipelines(locationId, stored.access_token);
    const painPipeline = findMatchingPipeline(pipelines, PAIN_PATIENTS_CONFIG);

    if (!painPipeline) {
      return NextResponse.json({
        pipeline: null,
        metrics: null,
        message: "No pipeline matching 'pain' found",
      });
    }

    const stageCounts = await getOpportunityCountsByStage(
      locationId,
      painPipeline,
      stored.access_token
    );
    const conversion = calculateConversion(stageCounts, PAIN_PATIENTS_CONFIG);

    return NextResponse.json({
      pipeline: {
        id: painPipeline.id,
        name: painPipeline.name,
      },
      metrics: {
        shown: conversion.shown,
        success: conversion.success,
        conversionPercent: conversion.conversionPercent,
        stageCounts, // Include raw counts for debugging
      },
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
