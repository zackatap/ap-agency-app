import { neon } from "@neondatabase/serverless";
import type { DateRangePreset } from "@/lib/date-ranges";
import type {
  MetaAdPerformanceMetrics,
  MetaAdRollupPhrase,
} from "@/lib/meta-ad-rollups";

export interface MetaAdsRange {
  preset: DateRangePreset;
  startDate: string;
  endDate: string;
  label: string;
}

export interface MetaAdsWarning {
  adAccountId?: string;
  campaignKey?: string;
  message: string;
}

export interface MetaAdsCachedRow extends MetaAdPerformanceMetrics {
  rowKey: string;
  adId: string;
  adName: string;
  adsetId: string | null;
  adsetName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  thumbnailUrl: string | null;
  adsManagerUrl: string | null;
  locationId: string;
  campaignKey: string;
  cid: string | null;
  businessName: string;
  ownerName: string | null;
  status: "ACTIVE" | "2ND CMPN";
  pipelineKeyword: string | null;
  campaignKeyword: string | null;
  adAccountId: string;
}

export interface MetaAdsSnapshotPayload {
  range: MetaAdsRange;
  recentSpendMonths: number;
  accountCount: number;
  eligibleAccountCount: number;
  sheetCampaignCount: number;
  eligibleCampaignCount: number;
  rowCount: number;
  totals: MetaAdPerformanceMetrics;
  rows: MetaAdsCachedRow[];
  warnings: MetaAdsWarning[];
}

export interface MetaAdsSnapshot extends MetaAdsSnapshotPayload {
  id: number;
  rangeKey: string;
  refreshedAt: string;
}

function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  return neon(url);
}

type Sql = NonNullable<ReturnType<typeof getDb>>;

let schemaReady = false;

function rangeKey(range: Pick<MetaAdsRange, "startDate" | "endDate">): string {
  return `${range.startDate}:${range.endDate}`;
}

async function ensureSchema(sql: Sql): Promise<void> {
  if (schemaReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS agency_meta_ads_snapshots (
      id BIGSERIAL PRIMARY KEY,
      range_key TEXT UNIQUE NOT NULL,
      preset TEXT NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      label TEXT NOT NULL,
      recent_spend_months INT NOT NULL,
      account_count INT NOT NULL DEFAULT 0,
      eligible_account_count INT NOT NULL DEFAULT 0,
      sheet_campaign_count INT NOT NULL DEFAULT 0,
      eligible_campaign_count INT NOT NULL DEFAULT 0,
      row_count INT NOT NULL DEFAULT 0,
      totals JSONB NOT NULL,
      rows JSONB NOT NULL,
      warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
      refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_agency_meta_ads_snapshots_refreshed
      ON agency_meta_ads_snapshots (refreshed_at DESC)
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS agency_meta_ad_rollup_phrases (
      id BIGSERIAL PRIMARY KEY,
      phrase TEXT NOT NULL UNIQUE,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  schemaReady = true;
}

function asDateString(raw: unknown): string {
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  return String(raw ?? "");
}

function asIsoString(raw: unknown): string {
  if (raw instanceof Date) return raw.toISOString();
  return String(raw ?? "");
}

function mapSnapshotRow(row: Record<string, unknown>): MetaAdsSnapshot {
  const startDate = asDateString(row.start_date);
  const endDate = asDateString(row.end_date);
  return {
    id: Number(row.id),
    rangeKey: String(row.range_key),
    range: {
      preset: String(row.preset) as DateRangePreset,
      startDate,
      endDate,
      label: String(row.label ?? ""),
    },
    recentSpendMonths: Number(row.recent_spend_months ?? 0),
    accountCount: Number(row.account_count ?? 0),
    eligibleAccountCount: Number(row.eligible_account_count ?? 0),
    sheetCampaignCount: Number(row.sheet_campaign_count ?? 0),
    eligibleCampaignCount: Number(row.eligible_campaign_count ?? 0),
    rowCount: Number(row.row_count ?? 0),
    totals: row.totals as MetaAdPerformanceMetrics,
    rows: Array.isArray(row.rows) ? (row.rows as MetaAdsCachedRow[]) : [],
    warnings: Array.isArray(row.warnings)
      ? (row.warnings as MetaAdsWarning[])
      : [],
    refreshedAt: asIsoString(row.refreshed_at),
  };
}

function mapRollupPhrase(row: Record<string, unknown>): MetaAdRollupPhrase {
  return {
    id: Number(row.id),
    phrase: String(row.phrase ?? ""),
    enabled: Boolean(row.enabled),
    createdAt: asIsoString(row.created_at),
    updatedAt: asIsoString(row.updated_at),
  };
}

export async function getMetaAdsSnapshot(range: {
  startDate: string;
  endDate: string;
}): Promise<MetaAdsSnapshot | null> {
  const sql = getDb();
  if (!sql) return null;
  await ensureSchema(sql);
  const rows = await sql`
    SELECT *
    FROM agency_meta_ads_snapshots
    WHERE range_key = ${rangeKey(range)}
    LIMIT 1
  `;
  return rows[0] ? mapSnapshotRow(rows[0] as Record<string, unknown>) : null;
}

export async function upsertMetaAdsSnapshot(
  snapshot: MetaAdsSnapshotPayload
): Promise<MetaAdsSnapshot | null> {
  const sql = getDb();
  if (!sql) return null;
  await ensureSchema(sql);
  const key = rangeKey(snapshot.range);
  const rows = await sql`
    INSERT INTO agency_meta_ads_snapshots (
      range_key, preset, start_date, end_date, label,
      recent_spend_months, account_count, eligible_account_count,
      sheet_campaign_count, eligible_campaign_count, row_count,
      totals, rows, warnings, refreshed_at
    ) VALUES (
      ${key},
      ${snapshot.range.preset},
      ${snapshot.range.startDate},
      ${snapshot.range.endDate},
      ${snapshot.range.label},
      ${snapshot.recentSpendMonths},
      ${snapshot.accountCount},
      ${snapshot.eligibleAccountCount},
      ${snapshot.sheetCampaignCount},
      ${snapshot.eligibleCampaignCount},
      ${snapshot.rowCount},
      ${JSON.stringify(snapshot.totals)}::jsonb,
      ${JSON.stringify(snapshot.rows)}::jsonb,
      ${JSON.stringify(snapshot.warnings)}::jsonb,
      NOW()
    )
    ON CONFLICT (range_key) DO UPDATE SET
      preset = EXCLUDED.preset,
      start_date = EXCLUDED.start_date,
      end_date = EXCLUDED.end_date,
      label = EXCLUDED.label,
      recent_spend_months = EXCLUDED.recent_spend_months,
      account_count = EXCLUDED.account_count,
      eligible_account_count = EXCLUDED.eligible_account_count,
      sheet_campaign_count = EXCLUDED.sheet_campaign_count,
      eligible_campaign_count = EXCLUDED.eligible_campaign_count,
      row_count = EXCLUDED.row_count,
      totals = EXCLUDED.totals,
      rows = EXCLUDED.rows,
      warnings = EXCLUDED.warnings,
      refreshed_at = NOW()
    RETURNING *
  `;
  return rows[0] ? mapSnapshotRow(rows[0] as Record<string, unknown>) : null;
}

export async function listMetaAdRollupPhrases(): Promise<MetaAdRollupPhrase[]> {
  const sql = getDb();
  if (!sql) return [];
  await ensureSchema(sql);
  const rows = await sql`
    SELECT id, phrase, enabled, created_at, updated_at
    FROM agency_meta_ad_rollup_phrases
    ORDER BY created_at ASC
  `;
  return rows.map((row) => mapRollupPhrase(row as Record<string, unknown>));
}

export async function createMetaAdRollupPhrase(
  phrase: string
): Promise<MetaAdRollupPhrase> {
  const cleaned = phrase.trim();
  if (!cleaned) throw new Error("Phrase is required");
  const sql = getDb();
  if (!sql) throw new Error("DATABASE_URL not configured");
  await ensureSchema(sql);
  const rows = await sql`
    INSERT INTO agency_meta_ad_rollup_phrases (phrase)
    VALUES (${cleaned})
    ON CONFLICT (phrase) DO UPDATE SET
      enabled = TRUE,
      updated_at = NOW()
    RETURNING id, phrase, enabled, created_at, updated_at
  `;
  return mapRollupPhrase(rows[0] as Record<string, unknown>);
}

export async function updateMetaAdRollupPhrase(
  id: number,
  patch: { enabled?: boolean }
): Promise<MetaAdRollupPhrase | null> {
  const sql = getDb();
  if (!sql) throw new Error("DATABASE_URL not configured");
  await ensureSchema(sql);
  const rows = await sql`
    UPDATE agency_meta_ad_rollup_phrases
    SET enabled = COALESCE(${patch.enabled ?? null}, enabled),
        updated_at = NOW()
    WHERE id = ${id}
    RETURNING id, phrase, enabled, created_at, updated_at
  `;
  return rows[0] ? mapRollupPhrase(rows[0] as Record<string, unknown>) : null;
}

export async function deleteMetaAdRollupPhrase(id: number): Promise<void> {
  const sql = getDb();
  if (!sql) throw new Error("DATABASE_URL not configured");
  await ensureSchema(sql);
  await sql`
    DELETE FROM agency_meta_ad_rollup_phrases
    WHERE id = ${id}
  `;
}
