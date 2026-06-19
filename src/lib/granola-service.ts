/**
 * Granola MCP client helpers for the agency content-ideas flow.
 */

import {
  GranolaClient,
  parseMeetingListFull,
  registerClient,
} from "granola-api";
import { callGranolaTool } from "@/lib/granola-mcp-client";
import {
  getGranolaOAuthClientId,
  getStoredGranolaTokens,
  granolaTokenStore,
  GRANOLA_USER_KEY,
  saveGranolaOAuthClientId,
} from "@/lib/granola-tokens";

export type GranolaMeetingOption = {
  id: string;
  title: string;
  date: string;
  attendees: string;
  sourceLabel: string;
  enhancedNotes: string;
};

function getAppBaseUrl(): string {
  const explicit = process.env.APP_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) return `https://${vercel}`;
  return "http://localhost:3000";
}

export function getGranolaRedirectUri(): string {
  return `${getAppBaseUrl()}/api/agency/granola/callback`;
}

export async function ensureGranolaOAuthClientId(): Promise<string> {
  const existing = await getGranolaOAuthClientId();
  if (existing) return existing;
  const redirectUri = getGranolaRedirectUri();
  const { clientId } = await registerClient(
    redirectUri,
    "AP Agency Content Ideas"
  );
  await saveGranolaOAuthClientId(clientId, redirectUri);
  return clientId;
}

function getClient() {
  return new GranolaClient({
    clientName: "AP Agency Content Ideas",
    clientVersion: "1.0.0",
    tokenStore: granolaTokenStore,
  });
}

export async function getGranolaAccessToken(): Promise<string | null> {
  const client = getClient();
  return client.getValidAccessToken(GRANOLA_USER_KEY);
}

export async function isGranolaConnected(): Promise<boolean> {
  const tokens = await getStoredGranolaTokens();
  return Boolean(tokens?.accessToken);
}

function formatMeetingDate(raw: string | undefined): string {
  if (!raw) return "";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "America/Chicago",
  });
}

function buildSourceLabel(
  title: string,
  dateLabel: string,
  attendees: string[]
): string {
  const people = attendees.filter(Boolean).slice(0, 3).join(", ");
  const suffix = dateLabel ? ` (${dateLabel})` : "";
  if (people) return `${title} - ${people}${suffix}`;
  return `${title}${suffix}`;
}

export async function listGranolaMeetings(options: {
  daysBack?: number;
  meetingIds?: string[];
}): Promise<GranolaMeetingOption[]> {
  const accessToken = await getGranolaAccessToken();
  if (!accessToken) {
    throw new Error("Granola not connected");
  }

  const client = getClient();
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - (options.daysBack ?? 30));

  const startDate = start.toISOString().slice(0, 10);
  const endDate = end.toISOString().slice(0, 10);
  const raw = await client.listMeetings(accessToken, startDate, endDate);
  let meetings = parseMeetingListFull(raw);

  if (options.meetingIds?.length) {
    const idSet = new Set(options.meetingIds);
    meetings = meetings.filter((m) => idSet.has(m.id));
  }

  return meetings
    .map((m) => {
      const dateLabel = formatMeetingDate(m.calendar_event_time);
      const attendeeNames = (m.attendees ?? [])
        .map((a) => a.name || a.email)
        .filter(Boolean);
      const title =
        m.calendar_event_title || m.title || "Untitled meeting";
      return {
        id: m.id,
        title,
        date: m.calendar_event_time || "",
        attendees: attendeeNames.join(", "),
        sourceLabel: buildSourceLabel(title, dateLabel, attendeeNames),
        enhancedNotes: m.enhanced_notes || m.my_notes || "",
      };
    })
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}

async function fetchDetailedNotes(
  accessToken: string,
  meetingIds: string[]
): Promise<Map<string, string>> {
  const notesById = new Map<string, string>();
  if (meetingIds.length === 0) return notesById;

  const client = getClient();
  const chunkSize = 5;
  for (let i = 0; i < meetingIds.length; i += chunkSize) {
    const chunk = meetingIds.slice(i, i + chunkSize);
    try {
      const raw = await client.getMeetings(accessToken, chunk);
      for (const id of chunk) {
        const idx = raw.indexOf(id);
        if (idx >= 0) {
          notesById.set(id, raw.slice(idx, idx + 4000));
        }
      }
    } catch (err) {
      console.warn("[granola] getMeetings chunk failed:", err);
    }
  }
  return notesById;
}

export async function queryGranolaMeetings(
  accessToken: string,
  query: string,
  documentIds?: string[]
): Promise<string> {
  const args: Record<string, unknown> = { query };
  if (documentIds?.length) {
    args.document_ids = documentIds;
  }
  return callGranolaTool(accessToken, "query_granola_meetings", args);
}

function buildNotesFallback(meetings: GranolaMeetingOption[]): string {
  const lines = meetings.slice(0, 20).map((m) => {
    const notes = m.enhancedNotes.trim();
    return `### ${m.sourceLabel}\n${notes || "(no notes captured)"}`;
  });
  return lines.join("\n\n");
}

export async function fetchMeetingContext(options: {
  scope: "recent" | "all" | "selected";
  meetingIds?: string[];
  daysBack?: number;
}): Promise<{ meetings: GranolaMeetingOption[]; querySummary: string }> {
  const accessToken = await getGranolaAccessToken();
  if (!accessToken) {
    throw new Error("Granola not connected");
  }

  const daysBack =
    options.scope === "recent"
      ? options.daysBack ?? 7
      : options.scope === "all"
        ? 90
        : 30;

  let meetings = await listGranolaMeetings({
    daysBack,
    meetingIds:
      options.scope === "selected" ? options.meetingIds : undefined,
  });

  const sparseNotes = meetings.filter((m) => !m.enhancedNotes.trim());
  if (sparseNotes.length > 0) {
    const detailMap = await fetchDetailedNotes(
      accessToken,
      sparseNotes.slice(0, 15).map((m) => m.id)
    );
    meetings = meetings.map((m) => ({
      ...m,
      enhancedNotes: m.enhancedNotes || detailMap.get(m.id) || "",
    }));
  }

  const documentIds = meetings.slice(0, 25).map((m) => m.id);
  const scopeLabel =
    options.scope === "recent"
      ? `the last ${daysBack} days`
      : options.scope === "all"
        ? "all recent accessible meetings"
        : "the selected meetings";

  const query = `What marketing tactics, ad strategies, lead quality tips, systems, automations, or growth lessons were discussed in meetings from ${scopeLabel}? List 8-12 concrete, reusable insights. For each, note which meeting it came from. Skip small talk.`;

  let querySummary: string;
  try {
    querySummary = await queryGranolaMeetings(
      accessToken,
      query,
      documentIds
    );
  } catch (err) {
    console.warn("[granola] query_granola_meetings failed, using notes fallback:", err);
    querySummary = buildNotesFallback(meetings);
  }

  return { meetings, querySummary };
}
