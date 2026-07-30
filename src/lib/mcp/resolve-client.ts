/**
 * Resolves a free-text client reference (business name, owner name, GHL
 * location ID, CID, Meta campaign keyword, owner email, or report email) to
 * the agency's stored campaign roster.
 *
 * Also supports an `AP_TEST:` prefix for internal Gleap testing, e.g.
 *   AP_TEST: drziayan@tcspinesport.com
 *   AP_TEST: Treasure Coast Spine
 * so you can exercise the agent without waiting on a real client ticket.
 *
 * Name/ID matches read the roster table (`agency_rollup_campaigns`). Email /
 * domain matches also check the Client DB sheet (OWNER EMAIL, CLIENT REPORT
 * EMAIL, DOMAIN PREFIX) and then join to the roster by location ID.
 */

import { listCampaigns, type AgencyCampaignRecord } from "@/lib/agency-rollup-store";
import { fetchSheetRows } from "@/lib/google-sheets";

export interface ResolvedClient {
  locationId: string;
  businessName: string;
  ownerName: string | null;
  cid: string | null;
  /** All campaign keys belonging to this location (drives rollup filtering). */
  campaignKeys: string[];
  /** Unique non-null ad account IDs across this location's campaigns. */
  adAccountIds: string[];
  /** Meta campaign-name keywords (substring filters) for this location. */
  campaignKeywords: string[];
  pipelineNames: string[];
  /** How confident the match is, 0..100. Exact ID/CID/email hits score highest. */
  score: number;
  /** Which field produced the strongest match (for debugging / transparency). */
  matchedOn: string;
}

const COL_OWNER_EMAIL = 15; // P — OWNER EMAIL
const COL_REPORT_EMAIL = 16; // Q — CLIENT REPORT EMAIL
const COL_LOCATION_ID = 40; // AO
const COL_DOMAIN_PREFIX = 62; // BK — DOMAIN PREFIX

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

function ownerNameOf(r: AgencyCampaignRecord): string | null {
  const name = [r.ownerFirstName, r.ownerLastName].filter(Boolean).join(" ").trim();
  return name || null;
}

function norm(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Strip the internal test prefix and return the usable query.
 * Accepts: "AP_TEST: foo", "AP_TEST foo", "ap_test:foo".
 */
export function stripTestPrefix(raw: string): string {
  return raw.replace(/^\s*AP_TEST\s*:?\s*/i, "").trim();
}

function isEmail(q: string): boolean {
  return EMAIL_RE.test(q);
}

interface Scored {
  score: number;
  matchedOn: string;
}

/** Score a single roster row against the normalized query. Higher = better. */
function scoreRecord(record: AgencyCampaignRecord, q: string): Scored {
  const businessName = norm(record.businessName);
  const owner = norm(ownerNameOf(record));
  const locationId = norm(record.locationId);
  const cid = norm(record.cid);
  const keyword = norm(record.campaignKeyword);
  const pipeline = norm(record.pipelineName);
  const pipelineKw = norm(record.pipelineKeyword);

  // Exact identifier hits are unambiguous.
  if (q === locationId) return { score: 100, matchedOn: "locationId" };
  if (cid && q === cid) return { score: 95, matchedOn: "cid" };

  // Exact business / owner name.
  if (businessName && q === businessName) return { score: 90, matchedOn: "businessName" };
  if (owner && q === owner) return { score: 85, matchedOn: "ownerName" };

  // Substring matches (either direction) on the human-facing names.
  if (businessName && (businessName.includes(q) || q.includes(businessName))) {
    return { score: 70, matchedOn: "businessName" };
  }
  if (owner && (owner.includes(q) || q.includes(owner))) {
    return { score: 60, matchedOn: "ownerName" };
  }
  if (keyword && (keyword.includes(q) || q.includes(keyword))) {
    return { score: 50, matchedOn: "campaignKeyword" };
  }
  if (pipeline && (pipeline.includes(q) || q.includes(pipeline))) {
    return { score: 45, matchedOn: "pipelineName" };
  }
  if (pipelineKw && (pipelineKw.includes(q) || q.includes(pipelineKw))) {
    return { score: 40, matchedOn: "pipelineKeyword" };
  }

  // Token overlap fallback: every query word appears in the business name.
  if (businessName) {
    const words = q.split(" ").filter((w) => w.length >= 3);
    if (words.length && words.every((w) => businessName.includes(w))) {
      return { score: 35, matchedOn: "businessName" };
    }
  }

  return { score: 0, matchedOn: "" };
}

/**
 * Look up location IDs from the Client DB sheet by owner/report email or
 * domain prefix. Returns the best match reason for scoring.
 */
async function locationIdsFromSheetEmail(
  emailOrDomain: string
): Promise<Array<{ locationId: string; matchedOn: string; score: number }>> {
  const q = norm(emailOrDomain);
  if (!q) return [];

  const { rows, error } = await fetchSheetRows({ columnEnd: "BK" });
  if (error || rows.length < 2) {
    if (error) console.warn("[mcp/resolve-client] sheet email lookup failed:", error);
    return [];
  }

  const email = isEmail(q) ? q : null;
  const domain = email ? email.split("@")[1]! : q.replace(/^@/, "");
  const domainPrefix = domain.split(".")[0] ?? domain;

  const hits = new Map<string, { matchedOn: string; score: number }>();

  for (const row of rows.slice(1)) {
    const locationId = String(row[COL_LOCATION_ID] ?? "").trim();
    if (!locationId) continue;

    const ownerEmail = norm(row[COL_OWNER_EMAIL]);
    const reportEmail = norm(row[COL_REPORT_EMAIL]);
    const prefix = norm(row[COL_DOMAIN_PREFIX]);

    let matchedOn = "";
    let score = 0;
    if (email && (ownerEmail === email || reportEmail === email)) {
      matchedOn = ownerEmail === email ? "ownerEmail" : "reportEmail";
      score = 98;
    } else if (prefix && (prefix === domainPrefix || prefix === domain)) {
      matchedOn = "domainPrefix";
      score = 80;
    } else if (
      !email &&
      (ownerEmail.includes(q) || reportEmail.includes(q))
    ) {
      matchedOn = "ownerEmail";
      score = 70;
    }

    if (score <= 0) continue;
    const existing = hits.get(locationId);
    if (!existing || score > existing.score) {
      hits.set(locationId, { matchedOn, score });
    }
  }

  return [...hits.entries()].map(([locationId, v]) => ({ locationId, ...v }));
}

function buildResolved(
  locationId: string,
  rows: AgencyCampaignRecord[],
  best: Scored
): ResolvedClient {
  const primary = rows[0]!;
  return {
    locationId,
    businessName: primary.businessName || ownerNameOf(primary) || locationId,
    ownerName: ownerNameOf(primary),
    cid: primary.cid,
    campaignKeys: rows.map((r) => r.campaignKey),
    adAccountIds: [
      ...new Set(rows.map((r) => r.adAccountId).filter((v): v is string => !!v)),
    ],
    campaignKeywords: [
      ...new Set(rows.map((r) => r.campaignKeyword).filter((v): v is string => !!v)),
    ],
    pipelineNames: [
      ...new Set(rows.map((r) => r.pipelineName).filter((v): v is string => !!v)),
    ],
    score: best.score,
    matchedOn: best.matchedOn,
  };
}

export interface ResolveResult {
  status: "ok" | "not_found";
  matches: ResolvedClient[];
  /** Original query after stripping AP_TEST: (useful in tool logs). */
  query: string;
}

/**
 * Resolve a query to one or more clients, best match first. Returns up to
 * `limit` distinct locations. `status` is `not_found` when nothing scored.
 */
export async function resolveClient(
  rawQuery: string,
  limit = 5
): Promise<ResolveResult> {
  const cleaned = stripTestPrefix(rawQuery);
  const q = norm(cleaned);
  if (!q) return { status: "not_found", matches: [], query: cleaned };

  const records = await listCampaigns();
  const byLocation = new Map<
    string,
    { records: AgencyCampaignRecord[]; best: Scored }
  >();

  const addHit = (record: AgencyCampaignRecord, scored: Scored) => {
    if (scored.score <= 0) return;
    const existing = byLocation.get(record.locationId);
    if (!existing) {
      byLocation.set(record.locationId, { records: [record], best: scored });
    } else {
      if (!existing.records.some((r) => r.campaignKey === record.campaignKey)) {
        existing.records.push(record);
      }
      if (scored.score > existing.best.score) existing.best = scored;
    }
  };

  // Email / domain path: sheet lookup → join to roster by locationId.
  if (isEmail(q) || q.includes("@") || q.endsWith(".com") || q.endsWith(".net") || q.endsWith(".org")) {
    const sheetHits = await locationIdsFromSheetEmail(q);
    const recordByLocation = new Map<string, AgencyCampaignRecord[]>();
    for (const r of records) {
      const list = recordByLocation.get(r.locationId) ?? [];
      list.push(r);
      recordByLocation.set(r.locationId, list);
    }
    for (const hit of sheetHits) {
      const rows = recordByLocation.get(hit.locationId);
      if (!rows?.length) continue;
      for (const row of rows) {
        addHit(row, { score: hit.score, matchedOn: hit.matchedOn });
      }
    }
  }

  // Name / ID / keyword path against the roster.
  for (const record of records) {
    addHit(record, scoreRecord(record, q));
  }

  const matches: ResolvedClient[] = [...byLocation.entries()]
    .map(([locationId, { records: rows, best }]) =>
      buildResolved(locationId, rows, best)
    )
    .sort((a, b) => b.score - a.score || a.businessName.localeCompare(b.businessName))
    .slice(0, limit);

  return { status: matches.length ? "ok" : "not_found", matches, query: cleaned };
}

/**
 * Pick a single confident match, or report ambiguity so the caller can ask the
 * user / list options. A query is unambiguous when there's exactly one match,
 * or the top match is an exact identifier hit, or it clearly outscores the
 * runner-up.
 */
export async function resolveSingleClient(query: string): Promise<
  | { status: "ok"; client: ResolvedClient; alternatives: ResolvedClient[] }
  | { status: "not_found" }
  | { status: "ambiguous"; matches: ResolvedClient[] }
> {
  const { status, matches } = await resolveClient(query);
  if (status === "not_found" || matches.length === 0) return { status: "not_found" };

  const [top, second] = matches;
  const decisive =
    matches.length === 1 || top.score >= 90 || !second || top.score - second.score >= 20;

  if (!decisive) return { status: "ambiguous", matches };
  return { status: "ok", client: top, alternatives: matches.slice(1) };
}
