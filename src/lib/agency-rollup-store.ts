/**
 * Persistence layer for the agency-level rollup.
 *
 * Three tables:
 *   agency_rollup_snapshots         - one row per refresh run
 *   agency_rollup_clients           - current active-client roster (rebuilt each run)
 *   agency_rollup_location_months   - per-location per-month metrics captured in a snapshot
 *
 * Only the last 10 complete snapshots are retained; older rows are pruned on each
 * new run. The dashboard reads the most recent `complete` snapshot so partial
 * in-progress refreshes never show broken data.
 */

import { neon } from "@neondatabase/serverless";
import type { FunnelMetrics } from "@/lib/funnel-metrics";

const SNAPSHOT_RETENTION = 10;

export type SnapshotStatus = "running" | "complete" | "failed";
export type ClientRowStatus = "ok" | "error" | "skipped";
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
  errors: Array<{ locationId?: string; businessName?: string; message: string }>;
  triggeredBy: TriggerSource;
  progressCurrent: number;
  progressTotal: number;
  progressLabel: string | null;
}

export interface AgencyClientRecord {
  locationId: string;
  cid: string | null;
  businessName: string | null;
  ownerFirstName: string | null;
  ownerLastName: string | null;
  statuses: string[];
  pipelineId: string | null;
  pipelineName: string | null;
  adAccountId: string | null;
  updatedAt: string;
}

export interface AgencyLocationMonth {
  snapshotId: number;
  locationId: string;
  monthKey: string;
  startDate: string;
  endDate: string;
  metrics: FunnelMetrics;
  adSpend: number;
  status: ClientRowStatus;
  errorMessage: string | null;
}

function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  return neon(url);
}

type Sql = NonNullable<ReturnType<typeof getDb>>;

let schemaReady = false;

async function ensureSchema(sql: Sql): Promise<void> {
  if (schemaReady) return;
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
  await sql`
    CREATE TABLE IF NOT EXISTS agency_rollup_clients (
      location_id TEXT PRIMARY KEY,
      cid TEXT,
      business_name TEXT,
      owner_first_name TEXT,
      owner_last_name TEXT,
      statuses TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      pipeline_id TEXT,
      pipeline_name TEXT,
      ad_account_id TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS agency_rollup_location_months (
      snapshot_id BIGINT NOT NULL REFERENCES agency_rollup_snapshots(id) ON DELETE CASCADE,
      location_id TEXT NOT NULL,
      month_key TEXT NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      metrics JSONB NOT NULL,
      ad_spend NUMERIC NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ok',
      error_message TEXT,
      PRIMARY KEY (snapshot_id, location_id, month_key)
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_agency_months_snapshot
      ON agency_rollup_location_months (snapshot_id)
  `;
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

export async function upsertClients(
  clients: Array<Omit<AgencyClientRecord, "updatedAt">>
): Promise<void> {
  const sql = getDb();
  if (!sql) return;
  await ensureSchema(sql);
  for (const client of clients) {
    await sql`
      INSERT INTO agency_rollup_clients (
        location_id, cid, business_name, owner_first_name, owner_last_name,
        statuses, pipeline_id, pipeline_name, ad_account_id, updated_at
      ) VALUES (
        ${client.locationId},
        ${client.cid},
        ${client.businessName},
        ${client.ownerFirstName},
        ${client.ownerLastName},
        ${client.statuses as unknown as string[]},
        ${client.pipelineId},
        ${client.pipelineName},
        ${client.adAccountId},
        NOW()
      )
      ON CONFLICT (location_id) DO UPDATE SET
        cid = EXCLUDED.cid,
        business_name = EXCLUDED.business_name,
        owner_first_name = EXCLUDED.owner_first_name,
        owner_last_name = EXCLUDED.owner_last_name,
        statuses = EXCLUDED.statuses,
        pipeline_id = EXCLUDED.pipeline_id,
        pipeline_name = EXCLUDED.pipeline_name,
        ad_account_id = EXCLUDED.ad_account_id,
        updated_at = NOW()
    `;
  }
}

export async function listClients(
  locationIds?: string[]
): Promise<AgencyClientRecord[]> {
  const sql = getDb();
  if (!sql) return [];
  await ensureSchema(sql);
  const rows = locationIds && locationIds.length
    ? await sql`
        SELECT * FROM agency_rollup_clients
        WHERE location_id = ANY(${locationIds as unknown as string[]})
        ORDER BY business_name NULLS LAST
      `
    : await sql`
        SELECT * FROM agency_rollup_clients
        ORDER BY business_name NULLS LAST
      `;
  return rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      locationId: String(r.location_id),
      cid: (r.cid as string) ?? null,
      businessName: (r.business_name as string) ?? null,
      ownerFirstName: (r.owner_first_name as string) ?? null,
      ownerLastName: (r.owner_last_name as string) ?? null,
      statuses: Array.isArray(r.statuses) ? (r.statuses as string[]) : [],
      pipelineId: (r.pipeline_id as string) ?? null,
      pipelineName: (r.pipeline_name as string) ?? null,
      adAccountId: (r.ad_account_id as string) ?? null,
      updatedAt:
        r.updated_at instanceof Date
          ? (r.updated_at as Date).toISOString()
          : String(r.updated_at ?? ""),
    };
  });
}

export async function insertLocationMonths(
  rows: AgencyLocationMonth[]
): Promise<void> {
  const sql = getDb();
  if (!sql || rows.length === 0) return;
  await ensureSchema(sql);
  for (const row of rows) {
    await sql`
      INSERT INTO agency_rollup_location_months (
        snapshot_id, location_id, month_key, start_date, end_date,
        metrics, ad_spend, status, error_message
      ) VALUES (
        ${row.snapshotId},
        ${row.locationId},
        ${row.monthKey},
        ${row.startDate},
        ${row.endDate},
        ${JSON.stringify(row.metrics)}::jsonb,
        ${row.adSpend},
        ${row.status},
        ${row.errorMessage}
      )
      ON CONFLICT (snapshot_id, location_id, month_key) DO UPDATE SET
        metrics = EXCLUDED.metrics,
        ad_spend = EXCLUDED.ad_spend,
        status = EXCLUDED.status,
        error_message = EXCLUDED.error_message
    `;
  }
}

export async function listSnapshotLocationMonths(
  snapshotId: number
): Promise<AgencyLocationMonth[]> {
  const sql = getDb();
  if (!sql) return [];
  await ensureSchema(sql);
  const rows = await sql`
    SELECT snapshot_id, location_id, month_key, start_date, end_date,
           metrics, ad_spend, status, error_message
    FROM agency_rollup_location_months
    WHERE snapshot_id = ${snapshotId}
    ORDER BY location_id, month_key
  `;
  return rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      snapshotId: Number(r.snapshot_id),
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
      status: (r.status as ClientRowStatus) ?? "ok",
      errorMessage: (r.error_message as string) ?? null,
    };
  });
}
