/**
 * Track which Granola meetings have already been processed for content ideas.
 */

import { neon } from "@neondatabase/serverless";
import type { GranolaMeetingOption } from "@/lib/granola-service";

function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  return neon(url);
}

let tableReady = false;

type Sql = NonNullable<ReturnType<typeof getDb>>;

async function ensureTable(sql: Sql): Promise<void> {
  if (tableReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS granola_processed_meetings (
      meeting_id TEXT PRIMARY KEY,
      processed_at TIMESTAMPTZ DEFAULT NOW(),
      ideas_appended INT DEFAULT 0
    )
  `;
  tableReady = true;
}

export async function getProcessedMeetingIds(): Promise<Set<string>> {
  const sql = getDb();
  if (!sql) return new Set();
  await ensureTable(sql);
  const rows = await sql`SELECT meeting_id FROM granola_processed_meetings`;
  return new Set(rows.map((r) => String(r.meeting_id)));
}

export async function filterUnprocessedMeetings(
  meetings: GranolaMeetingOption[]
): Promise<GranolaMeetingOption[]> {
  const processed = await getProcessedMeetingIds();
  return meetings.filter((m) => !processed.has(m.id));
}

export async function countUnprocessedMeetings(
  daysBack: number
): Promise<number> {
  const { listGranolaMeetings } = await import("@/lib/granola-service");
  const meetings = await listGranolaMeetings({ daysBack });
  const unprocessed = await filterUnprocessedMeetings(meetings);
  return unprocessed.length;
}

export async function markMeetingsProcessed(
  meetingIds: string[],
  ideasAppended: number
): Promise<void> {
  if (meetingIds.length === 0) return;
  const sql = getDb();
  if (!sql) throw new Error("DATABASE_URL not configured");
  await ensureTable(sql);

  for (const meetingId of meetingIds) {
    await sql`
      INSERT INTO granola_processed_meetings (meeting_id, ideas_appended)
      VALUES (${meetingId}, ${ideasAppended})
      ON CONFLICT (meeting_id) DO UPDATE SET
        processed_at = NOW(),
        ideas_appended = EXCLUDED.ideas_appended
    `;
  }
}
