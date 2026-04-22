/**
 * Persistence layer for the agency-level rollup.
 *
 * Three tables:
 *   agency_rollup_snapshots         - one row per refresh run
 *   agency_rollup_campaigns         - current active-campaign roster
 *                                     (one row per sheet campaign row — a
 *                                      single location can contribute multiple
 *                                      rows, e.g. ACTIVE + 2ND CMPN)
 *   agency_rollup_campaign_months   - per-campaign per-month metrics for a
 *                                     snapshot
 *
 * Grain change (v2): previously the rollup stored one row per (snapshot,
 * locationId, monthKey). The new unit is the **campaign** — a location with
 * two active campaigns in the Client Database now contributes two rows per
 * month. The `campaign_key` from agency-clients.ts is the stable identifier
 * across snapshots; it is of the form `${locationId}:${pipelineKeywordOrStatus}`.
 *
 * Only the last 10 complete snapshots are retained; older rows are pruned on
 * each new run. The dashboard reads the most recent `complete` snapshot so
 * partial in-progress refreshes never show broken data.
 */

import { neon } from "@neondatabase/serverless";
import type { FunnelMetrics } from "@/lib/funnel-metrics";
import type { CampaignStatus } from "@/lib/agency-clients";

const SNAPSHOT_RETENTION = 10;

export type SnapshotStatus = "running" | "complete" | "failed";
export type CampaignRowStatus = "ok" | "error" | "skipped";
export type TriggerSource = "manual" | "cron";

export interface AgencySnapshot {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: SnapshotStatus;
  monthsCovered: number;
  clientsTotal: number;
  clientsIncluded: number;
  clientsFailed: number;
  errors: Array<{
    locationId?: string;
    businessName?: string;
    campaignKey?: string;
    message: string;
  }>;
  triggeredBy: TriggerSource;
  progressCurrent: number;
  progressTotal: number;
  progressLabel: string | null;
}

export interface AgencyCampaignRecord {
  campaignKey: string;
  locationId: string;
  status: CampaignStatus;
  cid: string | null;
  businessName: string | null;
  ownerFirstName: string | null;
  ownerLastName: string | null;
  pipelineKeyword: string | null;
  campaignKeyword: string | null;
  pipelineId: string | null;
  pipelineName: string | null;
  adAccountId: string | null;
  /**
   * Populated when we could not resolve the campaign to a GHL pipeline. The
   * UI surfaces these as "Needs setup" instead of silently dropping them.
   */
  needsSetupReason: string | null;
  /**
   * Data-hygiene signals used by the agency dashboard's "exclude lazy
   * updaters" toggle. All nullable — older snapshots won't have them.
   *
   * - movementRatio: fraction of appts that moved past Confirmed stage over
   *   the aged portion of the window. Low → client isn't updating.
   * - openCount / staleOpenCount: snapshot of currently-open opportunities
   *   in Requested/Confirmed stages, and how many of those have been
   *   sitting untouched for >21 days.
   * - lastManualStageChangeAt: most recent lastStageChangeAt across any opp
   *   in a manual stage (showed/noShow/closed). Old → client has stopped
   *   touching the board.
   */
  movementRatio: number | null;
  openCount: number | null;
  staleOpenCount: number | null;
  staleOpenPct: number | null;
  lastManualStageChangeAt: string | null;
  updatedAt: string;
}

export interface AgencyCampaignMonth {
  snapshotId: number;
  campaignKey: string;
  locationId: string;
  monthKey: string;
  startDate: string;
  endDate: string;
  metrics: FunnelMetrics;
  adSpend: number;
  status: CampaignRowStatus;
  errorMessage: string | null;
}

/**
 * Per-day funnel snapshot for a single campaign inside a rollup run.
 * Replaces the month-grained {@link AgencyCampaignMonth} as the primary
 * storage grain: KPIs can now be aggregated over any arbitrary window
 * (Last 30 days, custom range, etc.) by summing these rows.
 *
 * Only stores the 5 funnel counts + 2 value sums + ad_spend — the full
 * stage-breakdown JSON is expensive at day granularity and unused by the
 * agency UI. The counts here use the SAME semantics as FunnelMetrics:
 *   - leads          = opps attributed to this day whose stage maps to "leads"
 *   - totalAppts     = opps in requested+confirmed stages (NOT including
 *                      showed/noShow/closed — those are counted separately)
 *   - showed         = opps in showed stages
 *   - noShow         = opps in noShow stages
 *   - closed         = opps in closed/success stages
 *   - totalValue     = sum of monetaryValue across ALL stages above
 *   - successValue   = sum of monetaryValue for closed/success opps
 */
export interface AgencyCampaignDay {
  snapshotId: number;
  campaignKey: string;
  locationId: string;
  /** YYYY-MM-DD, local timezone. */
  date: string;
  leads: number;
  totalAppts: number;
  showed: number;
  noShow: number;
  closed: number;
  totalValue: number;
  successValue: number;
  adSpend: number;
}

/**
 * Per-snapshot campaign run status. One row per (snapshot, campaign). Keeps
 * status/error off the dense day rows so we don't have to insert 365+
 * empty error rows for every failed campaign.
 */
export interface AgencyCampaignRun {
  snapshotId: number;
  campaignKey: string;
  locationId: string;
  status: CampaignRowStatus;
  errorMessage: string | null;
}

function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  return neon(url);
}

type Sql = NonNullable<ReturnType<typeof getDb>>;

let schemaReady = false;

/**
 * `CREATE TABLE IF NOT EXISTS` is NOT concurrency-safe in Postgres when the
 * table involves auto-generated sequences (BIGSERIAL) — two simultaneous
 * serverless invocations can both try to create the sequence and one will
 * hit `duplicate key value violates unique constraint "pg_class_relname_nsp_index"`.
 *
 * We guard against this two ways:
 *   1. Use `to_regclass()` to skip DDL entirely when the table already exists
 *      (covers the overwhelming majority of warm-path traffic).
 *   2. Catch the 23505 race error if two cold starts collide anyway and
 *      continue — by the time the loser raises, the table has been created.
 */
async function runIfNotExists(
  sql: Sql,
  regclass: string,
  ddl: () => Promise<unknown>
): Promise<void> {
  try {
    const rows = await sql`SELECT to_regclass(${regclass}) AS oid`;
    if (rows[0]?.oid) return;
  } catch (err) {
    console.warn("[agency-rollup-store] to_regclass check failed:", err);
  }
  try {
    await ddl();
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : "";
    if (code === "23505" || code === "42P07") {
      // 23505: duplicate key (pg_class race); 42P07: relation already exists.
      return;
    }
    throw err;
  }
}

async function ensureSchema(sql: Sql): Promise<void> {
  if (schemaReady) return;
  await runIfNotExists(sql, "agency_rollup_snapshots", async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS agency_rollup_snapshots (
        id BIGSERIAL PRIMARY KEY,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'running',
        months_covered INT NOT NULL DEFAULT 13,
        clients_total INT NOT NULL DEFAULT 0,
        clients_included INT NOT NULL DEFAULT 0,
        clients_failed INT NOT NULL DEFAULT 0,
        errors JSONB NOT NULL DEFAULT '[]'::jsonb,
        triggered_by TEXT NOT NULL DEFAULT 'manual',
        progress_current INT NOT NULL DEFAULT 0,
        progress_total INT NOT NULL DEFAULT 0,
        progress_label TEXT
      )
    `;
  });
  await runIfNotExists(sql, "agency_rollup_campaigns", async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS agency_rollup_campaigns (
        campaign_key TEXT PRIMARY KEY,
        location_id TEXT NOT NULL,
        status TEXT NOT NULL,
        cid TEXT,
        business_name TEXT,
        owner_first_name TEXT,
        owner_last_name TEXT,
        pipeline_keyword TEXT,
        campaign_keyword TEXT,
        pipeline_id TEXT,
        pipeline_name TEXT,
        ad_account_id TEXT,
        needs_setup_reason TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_agency_campaigns_location
        ON agency_rollup_campaigns (location_id)
    `;
  });
  // Additive data-quality columns. Nullable so they can be back-filled on the
  // next refresh without breaking older snapshots. Runs every warm start but
  // is cheap: Postgres short-circuits `ADD COLUMN IF NOT EXISTS` when the
  // column already exists.
  try {
    await sql`
      ALTER TABLE agency_rollup_campaigns
        ADD COLUMN IF NOT EXISTS movement_ratio NUMERIC,
        ADD COLUMN IF NOT EXISTS open_count INTEGER,
        ADD COLUMN IF NOT EXISTS stale_open_count INTEGER,
        ADD COLUMN IF NOT EXISTS stale_open_pct NUMERIC,
        ADD COLUMN IF NOT EXISTS last_manual_stage_change TIMESTAMPTZ
    `;
  } catch (err) {
    console.warn("[agency-rollup-store] ADD COLUMN quality failed:", err);
  }
  await runIfNotExists(sql, "agency_rollup_campaign_months", async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS agency_rollup_campaign_months (
        snapshot_id BIGINT NOT NULL REFERENCES agency_rollup_snapshots(id) ON DELETE CASCADE,
        campaign_key TEXT NOT NULL,
        location_id TEXT NOT NULL,
        month_key TEXT NOT NULL,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        metrics JSONB NOT NULL,
        ad_spend NUMERIC NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'ok',
        error_message TEXT,
        PRIMARY KEY (snapshot_id, campaign_key, month_key)
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_agency_campaign_months_snapshot
        ON agency_rollup_campaign_months (snapshot_id)
    `;
  });
  await runIfNotExists(sql, "agency_rollup_campaign_days", async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS agency_rollup_campaign_days (
        snapshot_id BIGINT NOT NULL REFERENCES agency_rollup_snapshots(id) ON DELETE CASCADE,
        campaign_key TEXT NOT NULL,
        location_id TEXT NOT NULL,
        date DATE NOT NULL,
        leads INTEGER NOT NULL DEFAULT 0,
        total_appts INTEGER NOT NULL DEFAULT 0,
        showed INTEGER NOT NULL DEFAULT 0,
        no_show INTEGER NOT NULL DEFAULT 0,
        closed INTEGER NOT NULL DEFAULT 0,
        total_value NUMERIC(14,2) NOT NULL DEFAULT 0,
        success_value NUMERIC(14,2) NOT NULL DEFAULT 0,
        ad_spend NUMERIC(14,2) NOT NULL DEFAULT 0,
        PRIMARY KEY (snapshot_id, campaign_key, date)
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_agency_campaign_days_snapshot_date
        ON agency_rollup_campaign_days (snapshot_id, date)
    `;
  });
  await runIfNotExists(sql, "agency_rollup_campaign_runs", async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS agency_rollup_campaign_runs (
        snapshot_id BIGINT NOT NULL REFERENCES agency_rollup_snapshots(id) ON DELETE CASCADE,
        campaign_key TEXT NOT NULL,
        location_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ok',
        error_message TEXT,
        PRIMARY KEY (snapshot_id, campaign_key)
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_agency_campaign_runs_snapshot
        ON agency_rollup_campaign_runs (snapshot_id)
    `;
  });
  schemaReady = true;
}

function mapSnapshotRow(row: Record<string, unknown>): AgencySnapshot {
  return {
    id: Number(row.id),
    startedAt:
      row.started_at instanceof Date
        ? (row.started_at as Date).toISOString()
        : String(row.started_at),
    finishedAt:
      row.finished_at == null
        ? null
        : row.finished_at instanceof Date
          ? (row.finished_at as Date).toISOString()
          : String(row.finished_at),
    status: (row.status as SnapshotStatus) ?? "running",
    monthsCovered: Number(row.months_covered ?? 0),
    clientsTotal: Number(row.clients_total ?? 0),
    clientsIncluded: Number(row.clients_included ?? 0),
    clientsFailed: Number(row.clients_failed ?? 0),
    errors: Array.isArray(row.errors) ? (row.errors as AgencySnapshot["errors"]) : [],
    triggeredBy: ((row.triggered_by as TriggerSource) ?? "manual"),
    progressCurrent: Number(row.progress_current ?? 0),
    progressTotal: Number(row.progress_total ?? 0),
    progressLabel: (row.progress_label as string) ?? null,
  };
}

export async function createSnapshot(params: {
  monthsCovered: number;
  triggeredBy: TriggerSource;
}): Promise<AgencySnapshot | null> {
  const sql = getDb();
  if (!sql) return null;
  await ensureSchema(sql);
  const rows = await sql`
    INSERT INTO agency_rollup_snapshots
      (status, months_covered, triggered_by, progress_total, progress_label)
    VALUES
      ('running', ${params.monthsCovered}, ${params.triggeredBy}, 0, 'Starting')
    RETURNING *
  `;
  return rows[0] ? mapSnapshotRow(rows[0]) : null;
}

export async function updateSnapshotProgress(
  snapshotId: number,
  patch: {
    progressCurrent?: number;
    progressTotal?: number;
    progressLabel?: string;
    clientsTotal?: number;
    clientsIncluded?: number;
    clientsFailed?: number;
  }
): Promise<void> {
  const sql = getDb();
  if (!sql) return;
  await ensureSchema(sql);
  await sql`
    UPDATE agency_rollup_snapshots
    SET
      progress_current = COALESCE(${patch.progressCurrent ?? null}, progress_current),
      progress_total = COALESCE(${patch.progressTotal ?? null}, progress_total),
      progress_label = COALESCE(${patch.progressLabel ?? null}, progress_label),
      clients_total = COALESCE(${patch.clientsTotal ?? null}, clients_total),
      clients_included = COALESCE(${patch.clientsIncluded ?? null}, clients_included),
      clients_failed = COALESCE(${patch.clientsFailed ?? null}, clients_failed)
    WHERE id = ${snapshotId}
  `;
}

export async function finishSnapshot(
  snapshotId: number,
  params: {
    status: "complete" | "failed";
    clientsIncluded: number;
    clientsFailed: number;
    errors: AgencySnapshot["errors"];
  }
): Promise<void> {
  const sql = getDb();
  if (!sql) return;
  await ensureSchema(sql);
  await sql`
    UPDATE agency_rollup_snapshots
    SET
      status = ${params.status},
      finished_at = NOW(),
      clients_included = ${params.clientsIncluded},
      clients_failed = ${params.clientsFailed},
      errors = ${JSON.stringify(params.errors)}::jsonb,
      progress_label = ${params.status === "complete" ? "Complete" : "Failed"}
    WHERE id = ${snapshotId}
  `;
  await pruneOldSnapshots(sql);
}

async function pruneOldSnapshots(sql: Sql): Promise<void> {
  try {
    await sql`
      DELETE FROM agency_rollup_snapshots
      WHERE id IN (
        SELECT id FROM agency_rollup_snapshots
        WHERE status IN ('complete', 'failed')
        ORDER BY started_at DESC
        OFFSET ${SNAPSHOT_RETENTION}
      )
    `;
  } catch (err) {
    console.error("[agency-rollup-store] pruneOldSnapshots error:", err);
  }
}

export async function getSnapshotById(
  snapshotId: number
): Promise<AgencySnapshot | null> {
  const sql = getDb();
  if (!sql) return null;
  await ensureSchema(sql);
  const rows = await sql`
    SELECT * FROM agency_rollup_snapshots WHERE id = ${snapshotId}
  `;
  return rows[0] ? mapSnapshotRow(rows[0]) : null;
}

/** Most recent snapshot regardless of status (used by the refresh button). */
export async function getLatestSnapshot(): Promise<AgencySnapshot | null> {
  const sql = getDb();
  if (!sql) return null;
  await ensureSchema(sql);
  const rows = await sql`
    SELECT * FROM agency_rollup_snapshots
    ORDER BY started_at DESC
    LIMIT 1
  `;
  return rows[0] ? mapSnapshotRow(rows[0]) : null;
}

/** Latest snapshot that finished successfully — drives the dashboard view. */
export async function getLatestCompleteSnapshot(): Promise<AgencySnapshot | null> {
  const sql = getDb();
  if (!sql) return null;
  await ensureSchema(sql);
  const rows = await sql`
    SELECT * FROM agency_rollup_snapshots
    WHERE status = 'complete'
    ORDER BY started_at DESC
    LIMIT 1
  `;
  return rows[0] ? mapSnapshotRow(rows[0]) : null;
}

export async function listRecentSnapshots(
  limit = SNAPSHOT_RETENTION
): Promise<AgencySnapshot[]> {
  const sql = getDb();
  if (!sql) return [];
  await ensureSchema(sql);
  const rows = await sql`
    SELECT * FROM agency_rollup_snapshots
    ORDER BY started_at DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => mapSnapshotRow(r as Record<string, unknown>));
}

/** Check for any snapshot still in 'running' state (UI disables the refresh button). */
export async function getRunningSnapshot(): Promise<AgencySnapshot | null> {
  const sql = getDb();
  if (!sql) return null;
  await ensureSchema(sql);
  const rows = await sql`
    SELECT * FROM agency_rollup_snapshots
    WHERE status = 'running'
    ORDER BY started_at DESC
    LIMIT 1
  `;
  return rows[0] ? mapSnapshotRow(rows[0]) : null;
}

/** Mark stale 'running' snapshots as failed (recovers from crashes between requests). */
export async function expireStaleRunningSnapshots(
  maxAgeMinutes = 20
): Promise<void> {
  const sql = getDb();
  if (!sql) return;
  await ensureSchema(sql);
  await sql`
    UPDATE agency_rollup_snapshots
    SET
      status = 'failed',
      finished_at = NOW(),
      progress_label = 'Timed out'
    WHERE status = 'running'
      AND started_at < NOW() - (${maxAgeMinutes}::text || ' minutes')::interval
  `;
}

export async function upsertCampaigns(
  campaigns: Array<Omit<AgencyCampaignRecord, "updatedAt">>
): Promise<void> {
  const sql = getDb();
  if (!sql) return;
  await ensureSchema(sql);
  for (const c of campaigns) {
    await sql`
      INSERT INTO agency_rollup_campaigns (
        campaign_key, location_id, status, cid, business_name,
        owner_first_name, owner_last_name, pipeline_keyword, campaign_keyword,
        pipeline_id, pipeline_name, ad_account_id, needs_setup_reason,
        movement_ratio, open_count, stale_open_count, stale_open_pct,
        last_manual_stage_change, updated_at
      ) VALUES (
        ${c.campaignKey},
        ${c.locationId},
        ${c.status},
        ${c.cid},
        ${c.businessName},
        ${c.ownerFirstName},
        ${c.ownerLastName},
        ${c.pipelineKeyword},
        ${c.campaignKeyword},
        ${c.pipelineId},
        ${c.pipelineName},
        ${c.adAccountId},
        ${c.needsSetupReason},
        ${c.movementRatio},
        ${c.openCount},
        ${c.staleOpenCount},
        ${c.staleOpenPct},
        ${c.lastManualStageChangeAt},
        NOW()
      )
      ON CONFLICT (campaign_key) DO UPDATE SET
        location_id = EXCLUDED.location_id,
        status = EXCLUDED.status,
        cid = EXCLUDED.cid,
        business_name = EXCLUDED.business_name,
        owner_first_name = EXCLUDED.owner_first_name,
        owner_last_name = EXCLUDED.owner_last_name,
        pipeline_keyword = EXCLUDED.pipeline_keyword,
        campaign_keyword = EXCLUDED.campaign_keyword,
        pipeline_id = EXCLUDED.pipeline_id,
        pipeline_name = EXCLUDED.pipeline_name,
        ad_account_id = EXCLUDED.ad_account_id,
        needs_setup_reason = EXCLUDED.needs_setup_reason,
        movement_ratio = EXCLUDED.movement_ratio,
        open_count = EXCLUDED.open_count,
        stale_open_count = EXCLUDED.stale_open_count,
        stale_open_pct = EXCLUDED.stale_open_pct,
        last_manual_stage_change = EXCLUDED.last_manual_stage_change,
        updated_at = NOW()
    `;
  }
}

function mapCampaignRow(row: Record<string, unknown>): AgencyCampaignRecord {
  return {
    campaignKey: String(row.campaign_key),
    locationId: String(row.location_id),
    status: ((row.status as string) ?? "ACTIVE") as CampaignStatus,
    cid: (row.cid as string) ?? null,
    businessName: (row.business_name as string) ?? null,
    ownerFirstName: (row.owner_first_name as string) ?? null,
    ownerLastName: (row.owner_last_name as string) ?? null,
    pipelineKeyword: (row.pipeline_keyword as string) ?? null,
    campaignKeyword: (row.campaign_keyword as string) ?? null,
    pipelineId: (row.pipeline_id as string) ?? null,
    pipelineName: (row.pipeline_name as string) ?? null,
    adAccountId: (row.ad_account_id as string) ?? null,
    needsSetupReason: (row.needs_setup_reason as string) ?? null,
    movementRatio:
      row.movement_ratio == null ? null : Number(row.movement_ratio),
    openCount: row.open_count == null ? null : Number(row.open_count),
    staleOpenCount:
      row.stale_open_count == null ? null : Number(row.stale_open_count),
    staleOpenPct:
      row.stale_open_pct == null ? null : Number(row.stale_open_pct),
    lastManualStageChangeAt:
      row.last_manual_stage_change == null
        ? null
        : row.last_manual_stage_change instanceof Date
          ? (row.last_manual_stage_change as Date).toISOString()
          : String(row.last_manual_stage_change),
    updatedAt:
      row.updated_at instanceof Date
        ? (row.updated_at as Date).toISOString()
        : String(row.updated_at ?? ""),
  };
}

export async function listCampaigns(
  campaignKeys?: string[]
): Promise<AgencyCampaignRecord[]> {
  const sql = getDb();
  if (!sql) return [];
  await ensureSchema(sql);
  const rows = campaignKeys && campaignKeys.length
    ? await sql`
        SELECT * FROM agency_rollup_campaigns
        WHERE campaign_key = ANY(${campaignKeys as unknown as string[]})
        ORDER BY business_name NULLS LAST
      `
    : await sql`
        SELECT * FROM agency_rollup_campaigns
        ORDER BY business_name NULLS LAST
      `;
  return rows.map((r) => mapCampaignRow(r as Record<string, unknown>));
}

export async function listCampaignsByLocation(
  locationId: string
): Promise<AgencyCampaignRecord[]> {
  const sql = getDb();
  if (!sql) return [];
  await ensureSchema(sql);
  const rows = await sql`
    SELECT * FROM agency_rollup_campaigns
    WHERE location_id = ${locationId}
    ORDER BY status ASC
  `;
  return rows.map((r) => mapCampaignRow(r as Record<string, unknown>));
}

export async function insertCampaignMonths(
  rows: AgencyCampaignMonth[]
): Promise<void> {
  const sql = getDb();
  if (!sql || rows.length === 0) return;
  await ensureSchema(sql);
  for (const row of rows) {
    await sql`
      INSERT INTO agency_rollup_campaign_months (
        snapshot_id, campaign_key, location_id, month_key,
        start_date, end_date, metrics, ad_spend, status, error_message
      ) VALUES (
        ${row.snapshotId},
        ${row.campaignKey},
        ${row.locationId},
        ${row.monthKey},
        ${row.startDate},
        ${row.endDate},
        ${JSON.stringify(row.metrics)}::jsonb,
        ${row.adSpend},
        ${row.status},
        ${row.errorMessage}
      )
      ON CONFLICT (snapshot_id, campaign_key, month_key) DO UPDATE SET
        metrics = EXCLUDED.metrics,
        ad_spend = EXCLUDED.ad_spend,
        status = EXCLUDED.status,
        error_message = EXCLUDED.error_message
    `;
  }
}

export async function listSnapshotCampaignMonths(
  snapshotId: number
): Promise<AgencyCampaignMonth[]> {
  const sql = getDb();
  if (!sql) return [];
  await ensureSchema(sql);
  const rows = await sql`
    SELECT snapshot_id, campaign_key, location_id, month_key, start_date, end_date,
           metrics, ad_spend, status, error_message
    FROM agency_rollup_campaign_months
    WHERE snapshot_id = ${snapshotId}
    ORDER BY location_id, campaign_key, month_key
  `;
  return rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      snapshotId: Number(r.snapshot_id),
      campaignKey: String(r.campaign_key),
      locationId: String(r.location_id),
      monthKey: String(r.month_key),
      startDate:
        r.start_date instanceof Date
          ? (r.start_date as Date).toISOString().slice(0, 10)
          : String(r.start_date),
      endDate:
        r.end_date instanceof Date
          ? (r.end_date as Date).toISOString().slice(0, 10)
          : String(r.end_date),
      metrics: r.metrics as FunnelMetrics,
      adSpend: Number(r.ad_spend ?? 0),
      status: (r.status as CampaignRowStatus) ?? "ok",
      errorMessage: (r.error_message as string) ?? null,
    };
  });
}

/**
 * Bulk-insert per-day funnel counts for a snapshot. Batches into one
 * multi-row INSERT per chunk to keep 30×13 rows/campaign × ~80 campaigns
 * manageable on Neon's serverless driver.
 */
export async function insertCampaignDays(
  rows: AgencyCampaignDay[]
): Promise<void> {
  const sql = getDb();
  if (!sql || rows.length === 0) return;
  await ensureSchema(sql);
  // Neon's tagged-template driver can't splat a VALUES list in one shot, so
  // we chunk the rows and issue one INSERT per chunk with a UNION-ALL-style
  // subquery to keep round-trips down.
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    // Build parallel arrays so the driver can bind them as typed arrays.
    const snapshotIds = chunk.map((r) => r.snapshotId);
    const campaignKeys = chunk.map((r) => r.campaignKey);
    const locationIds = chunk.map((r) => r.locationId);
    const dates = chunk.map((r) => r.date);
    const leads = chunk.map((r) => r.leads);
    const totalAppts = chunk.map((r) => r.totalAppts);
    const showed = chunk.map((r) => r.showed);
    const noShow = chunk.map((r) => r.noShow);
    const closed = chunk.map((r) => r.closed);
    const totalValue = chunk.map((r) => r.totalValue);
    const successValue = chunk.map((r) => r.successValue);
    const adSpend = chunk.map((r) => r.adSpend);
    await sql`
      INSERT INTO agency_rollup_campaign_days (
        snapshot_id, campaign_key, location_id, date,
        leads, total_appts, showed, no_show, closed,
        total_value, success_value, ad_spend
      )
      SELECT * FROM UNNEST(
        ${snapshotIds}::bigint[],
        ${campaignKeys}::text[],
        ${locationIds}::text[],
        ${dates}::date[],
        ${leads}::int[],
        ${totalAppts}::int[],
        ${showed}::int[],
        ${noShow}::int[],
        ${closed}::int[],
        ${totalValue}::numeric[],
        ${successValue}::numeric[],
        ${adSpend}::numeric[]
      )
      ON CONFLICT (snapshot_id, campaign_key, date) DO UPDATE SET
        leads = EXCLUDED.leads,
        total_appts = EXCLUDED.total_appts,
        showed = EXCLUDED.showed,
        no_show = EXCLUDED.no_show,
        closed = EXCLUDED.closed,
        total_value = EXCLUDED.total_value,
        success_value = EXCLUDED.success_value,
        ad_spend = EXCLUDED.ad_spend
    `;
  }
}

/**
 * Read all day rows for a snapshot, optionally filtered to a date range
 * (inclusive). When no range is passed we return every day in the snapshot
 * — used by the "Maximum" preset.
 */
export async function listSnapshotCampaignDays(
  snapshotId: number,
  range?: { startDate: string; endDate: string }
): Promise<AgencyCampaignDay[]> {
  const sql = getDb();
  if (!sql) return [];
  await ensureSchema(sql);
  const rows = range
    ? await sql`
        SELECT snapshot_id, campaign_key, location_id, date,
               leads, total_appts, showed, no_show, closed,
               total_value, success_value, ad_spend
        FROM agency_rollup_campaign_days
        WHERE snapshot_id = ${snapshotId}
          AND date >= ${range.startDate}::date
          AND date <= ${range.endDate}::date
        ORDER BY campaign_key, date
      `
    : await sql`
        SELECT snapshot_id, campaign_key, location_id, date,
               leads, total_appts, showed, no_show, closed,
               total_value, success_value, ad_spend
        FROM agency_rollup_campaign_days
        WHERE snapshot_id = ${snapshotId}
        ORDER BY campaign_key, date
      `;
  return rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      snapshotId: Number(r.snapshot_id),
      campaignKey: String(r.campaign_key),
      locationId: String(r.location_id),
      date:
        r.date instanceof Date
          ? (r.date as Date).toISOString().slice(0, 10)
          : String(r.date),
      leads: Number(r.leads ?? 0),
      totalAppts: Number(r.total_appts ?? 0),
      showed: Number(r.showed ?? 0),
      noShow: Number(r.no_show ?? 0),
      closed: Number(r.closed ?? 0),
      totalValue: Number(r.total_value ?? 0),
      successValue: Number(r.success_value ?? 0),
      adSpend: Number(r.ad_spend ?? 0),
    };
  });
}

/**
 * Upsert a campaign-run status row. Called once per (snapshot, campaign)
 * when the runner finishes with that campaign — ok / skipped / error.
 */
export async function upsertCampaignRuns(
  runs: AgencyCampaignRun[]
): Promise<void> {
  const sql = getDb();
  if (!sql || runs.length === 0) return;
  await ensureSchema(sql);
  for (const r of runs) {
    await sql`
      INSERT INTO agency_rollup_campaign_runs
        (snapshot_id, campaign_key, location_id, status, error_message)
      VALUES
        (${r.snapshotId}, ${r.campaignKey}, ${r.locationId}, ${r.status}, ${r.errorMessage})
      ON CONFLICT (snapshot_id, campaign_key) DO UPDATE SET
        location_id = EXCLUDED.location_id,
        status = EXCLUDED.status,
        error_message = EXCLUDED.error_message
    `;
  }
}

export async function listSnapshotCampaignRuns(
  snapshotId: number
): Promise<AgencyCampaignRun[]> {
  const sql = getDb();
  if (!sql) return [];
  await ensureSchema(sql);
  const rows = await sql`
    SELECT snapshot_id, campaign_key, location_id, status, error_message
    FROM agency_rollup_campaign_runs
    WHERE snapshot_id = ${snapshotId}
  `;
  return rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      snapshotId: Number(r.snapshot_id),
      campaignKey: String(r.campaign_key),
      locationId: String(r.location_id),
      status: (r.status as CampaignRowStatus) ?? "ok",
      errorMessage: (r.error_message as string) ?? null,
    };
  });
}
