/**
 * Location-level settings persisted in Neon Postgres.
 * - Stage mappings (unmapped GHL stages → our funnel stages)
 * - Default pipeline, campaign
 * - Ad spend per pipeline per month
 */

import { neon } from "@neondatabase/serverless";

export type FunnelStage = "requested" | "confirmed" | "showed" | "noShow" | "closed";
export type MappableStage = FunnelStage | "lead";

/** Stage mappings per pipeline: GHL stage name -> our funnel stage (includes "lead") */
export type StageMappings = Record<string, Record<string, MappableStage>>;

/** Ad spend: pipelineId -> monthKey (YYYY-MM) -> amount */
export type AdSpend = Record<string, Record<string, number>>;

export type AttributionMode = "created" | "lastUpdated";

export interface LocationSettings {
  locationId: string;
  defaultPipelineId: string | null;
  defaultCampaignId: string | null;
  facebookAdAccountId: string | null;
  facebookCampaignKeyword: string | null;
  stageMappings: StageMappings;
  adSpend: AdSpend;
  rollupAssumptions: boolean;
  attributionMode: AttributionMode;
  updatedAt: string;
}

const DEFAULT_SETTINGS: Omit<LocationSettings, "locationId" | "updatedAt"> = {
  defaultPipelineId: null,
  defaultCampaignId: null,
  facebookAdAccountId: null,
  facebookCampaignKeyword: null,
  stageMappings: {},
  adSpend: {},
  rollupAssumptions: true, // "On Totals" default
  attributionMode: "lastUpdated",
};

function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  return neon(url);
}

export async function getLocationSettings(
  locationId: string
): Promise<LocationSettings | null> {
  const sql = getDb();
  if (!sql) return null;

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS location_settings (
        location_id TEXT PRIMARY KEY,
        default_pipeline_id TEXT,
        default_campaign_id TEXT,
        facebook_ad_account_id TEXT,
        facebook_campaign_keyword TEXT,
        stage_mappings JSONB DEFAULT '{}',
        ad_spend JSONB DEFAULT '{}',
        rollup_assumptions BOOLEAN DEFAULT false,
        attribution_mode TEXT DEFAULT 'lastUpdated',
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`ALTER TABLE location_settings ADD COLUMN IF NOT EXISTS facebook_ad_account_id TEXT`;
    await sql`ALTER TABLE location_settings ADD COLUMN IF NOT EXISTS facebook_campaign_keyword TEXT`;
    await sql`ALTER TABLE location_settings ADD COLUMN IF NOT EXISTS rollup_assumptions BOOLEAN DEFAULT false`;
    await sql`ALTER TABLE location_settings ADD COLUMN IF NOT EXISTS attribution_mode TEXT DEFAULT 'lastUpdated'`;
    const rows = await sql`
      SELECT default_pipeline_id, default_campaign_id, facebook_ad_account_id, facebook_campaign_keyword, stage_mappings, ad_spend, rollup_assumptions, attribution_mode, updated_at
      FROM location_settings
      WHERE location_id = ${locationId}
    `;
    const row = rows[0];
    if (!row) {
      return {
        locationId,
        ...DEFAULT_SETTINGS,
        updatedAt: new Date().toISOString(),
      };
    }

    return {
      locationId,
      defaultPipelineId: (row.default_pipeline_id as string) ?? null,
      defaultCampaignId: (row.default_campaign_id as string) ?? null,
      facebookAdAccountId: (row.facebook_ad_account_id as string) ?? null,
      facebookCampaignKeyword: (row.facebook_campaign_keyword as string) ?? null,
      stageMappings: (row.stage_mappings as StageMappings) ?? {},
      adSpend: (row.ad_spend as AdSpend) ?? {},
      rollupAssumptions: (row.rollup_assumptions as boolean) ?? true, // null => "On Totals" default
      attributionMode: ((row.attribution_mode as string) === "created" ? "created" : "lastUpdated") as AttributionMode,
      updatedAt: (row.updated_at as string) ?? new Date().toISOString(),
    };
  } catch (err) {
    console.error("[location-settings] getLocationSettings error:", err);
    return null;
  }
}

export async function updateLocationSettings(
  locationId: string,
  patch: Partial<Omit<LocationSettings, "locationId" | "updatedAt">>
): Promise<LocationSettings | null> {
  const sql = getDb();
  if (!sql) return null;

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS location_settings (
        location_id TEXT PRIMARY KEY,
        default_pipeline_id TEXT,
        default_campaign_id TEXT,
        facebook_ad_account_id TEXT,
        stage_mappings JSONB DEFAULT '{}',
        ad_spend JSONB DEFAULT '{}',
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    const existing = await getLocationSettings(locationId);
    const merged: Omit<LocationSettings, "locationId" | "updatedAt"> = {
      ...DEFAULT_SETTINGS,
      ...(existing
        ? {
            defaultPipelineId: existing.defaultPipelineId,
            defaultCampaignId: existing.defaultCampaignId,
            facebookAdAccountId: existing.facebookAdAccountId,
            facebookCampaignKeyword: existing.facebookCampaignKeyword,
            stageMappings: existing.stageMappings,
            adSpend: existing.adSpend,
            rollupAssumptions: existing.rollupAssumptions,
            attributionMode: existing.attributionMode,
          }
        : {}),
      ...patch,
    };

    await sql`
      INSERT INTO location_settings (
        location_id, default_pipeline_id, default_campaign_id, facebook_ad_account_id, facebook_campaign_keyword,
        stage_mappings, ad_spend, rollup_assumptions, attribution_mode, updated_at
      )
      VALUES (
        ${locationId},
        ${merged.defaultPipelineId ?? null},
        ${merged.defaultCampaignId ?? null},
        ${merged.facebookAdAccountId ?? null},
        ${merged.facebookCampaignKeyword ?? null},
        ${JSON.stringify(merged.stageMappings)}::jsonb,
        ${JSON.stringify(merged.adSpend)}::jsonb,
        ${merged.rollupAssumptions ?? false},
        ${merged.attributionMode ?? "lastUpdated"},
        NOW()
      )
      ON CONFLICT (location_id) DO UPDATE SET
        default_pipeline_id = EXCLUDED.default_pipeline_id,
        default_campaign_id = EXCLUDED.default_campaign_id,
        facebook_ad_account_id = EXCLUDED.facebook_ad_account_id,
        facebook_campaign_keyword = EXCLUDED.facebook_campaign_keyword,
        stage_mappings = EXCLUDED.stage_mappings,
        ad_spend = EXCLUDED.ad_spend,
        rollup_assumptions = EXCLUDED.rollup_assumptions,
        attribution_mode = EXCLUDED.attribution_mode,
        updated_at = NOW()
    `;

    return getLocationSettings(locationId);
  } catch (err) {
    console.error("[location-settings] updateLocationSettings error:", err);
    throw err;
  }
}
