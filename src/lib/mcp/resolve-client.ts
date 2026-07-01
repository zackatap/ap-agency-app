/**
 * Resolves a free-text client reference (business name, owner name, GHL
 * location ID, CID, or Meta campaign keyword) to the agency's stored campaign
 * roster. A single client/location can own several campaign rows (ACTIVE +
 * 2ND CMPN, Pain vs Decompression, etc.), so matches are grouped by location.
 *
 * Reads the roster table (`agency_rollup_campaigns`) via {@link listCampaigns},
 * which is a single fast Neon read — no Google Sheet or external API calls.
 * Used by the Gleap MCP tools to turn a support ticket's client mention into a
 * concrete location + ad account before pulling performance data.
 */

import { listCampaigns, type AgencyCampaignRecord } from "@/lib/agency-rollup-store";

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
  /** How confident the match is, 0..100. Exact ID/CID hits score highest. */
  score: number;
  /** Which field produced the strongest match (for debugging / transparency). */
  matchedOn: string;
}

function ownerNameOf(r: AgencyCampaignRecord): string | null {
  const name = [r.ownerFirstName, r.ownerLastName].filter(Boolean).join(" ").trim();
  return name || null;
}

function norm(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
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

export interface ResolveResult {
  status: "ok" | "not_found";
  matches: ResolvedClient[];
}

/**
 * Resolve a query to one or more clients, best match first. Returns up to
 * `limit` distinct locations. `status` is `not_found` when nothing scored.
 */
export async function resolveClient(
  query: string,
  limit = 5
): Promise<ResolveResult> {
  const q = norm(query);
  if (!q) return { status: "not_found", matches: [] };

  const records = await listCampaigns();
  if (records.length === 0) return { status: "not_found", matches: [] };

  // Best score + match reason per location.
  const byLocation = new Map<
    string,
    { records: AgencyCampaignRecord[]; best: Scored }
  >();

  for (const record of records) {
    const scored = scoreRecord(record, q);
    if (scored.score <= 0) continue;
    const existing = byLocation.get(record.locationId);
    if (!existing) {
      byLocation.set(record.locationId, { records: [record], best: scored });
    } else {
      existing.records.push(record);
      if (scored.score > existing.best.score) existing.best = scored;
    }
  }

  const matches: ResolvedClient[] = [...byLocation.entries()]
    .map(([locationId, { records: rows, best }]) => {
      const primary = rows[0]!;
      const adAccountIds = [
        ...new Set(rows.map((r) => r.adAccountId).filter((v): v is string => !!v)),
      ];
      const campaignKeywords = [
        ...new Set(rows.map((r) => r.campaignKeyword).filter((v): v is string => !!v)),
      ];
      const pipelineNames = [
        ...new Set(rows.map((r) => r.pipelineName).filter((v): v is string => !!v)),
      ];
      return {
        locationId,
        businessName: primary.businessName || ownerNameOf(primary) || locationId,
        ownerName: ownerNameOf(primary),
        cid: primary.cid,
        campaignKeys: rows.map((r) => r.campaignKey),
        adAccountIds,
        campaignKeywords,
        pipelineNames,
        score: best.score,
        matchedOn: best.matchedOn,
      };
    })
    .sort((a, b) => b.score - a.score || a.businessName.localeCompare(b.businessName))
    .slice(0, limit);

  return { status: matches.length ? "ok" : "not_found", matches };
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
