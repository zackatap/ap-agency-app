/**
 * Test endpoint: verify GHL date params and find opportunity by contact email.
 * GET /api/debug/test-date-params/[locationId]?email=karenae@comcast.net&pipelineId=xxx
 *
 * Runs:
 * 1. Search contacts by email -> get contactId
 * 2. Fetch opps WITHOUT date params (many pages) - does opp appear?
 * 3. Fetch opps WITH date params (startDate/endDate Feb 2026) - does date filter work?
 * 4. Fetch opps WITH contact_id - get opps for this contact
 *
 * Returns comparison so we can see if date params help find old-created opps.
 */

import { NextResponse } from "next/server";
import { getToken } from "@/lib/oauth-tokens";
import { getPipelines } from "@/lib/ghl-oauth";
import { findMatchingPipeline, PAIN_PATIENTS_CONFIG } from "@/lib/pipeline-matching";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const GHL_BASE = "https://services.leadconnectorhq.com";
const API_VERSION = "2021-07-28";

function authHeaders(token: string): HeadersInit {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    Version: API_VERSION,
  };
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ locationId: string }> }
) {
  try {
    const { locationId } = await params;
    const { searchParams } = new URL(_req.url);
    const email = searchParams.get("email")?.trim();
    const pipelineIdParam = searchParams.get("pipelineId");

    const stored = await getToken(locationId);
    if (!stored) {
      return NextResponse.json(
        { error: "Not connected", needsAuth: true },
        { status: 401 }
      );
    }

    const pipelines = await getPipelines(locationId, stored.access_token);
    const pipeline = pipelineIdParam
      ? pipelines.find((p) => p.id === pipelineIdParam)
      : findMatchingPipeline(pipelines, PAIN_PATIENTS_CONFIG) ?? pipelines[0];

    if (!pipeline) {
      return NextResponse.json({
        error: "No pipeline found",
        pipelines: pipelines.map((p) => ({ id: p.id, name: p.name })),
      });
    }

    const result: Record<string, unknown> = {
      locationId,
      pipeline: { id: pipeline.id, name: pipeline.name },
      email: email ?? "(not provided)",
    };

    let contactId: string | null = null;

    // 1. Search contacts by email
    if (email) {
      await delay(200);
      try {
        const searchRes = await fetch(`${GHL_BASE}/contacts/search`, {
          method: "POST",
          headers: authHeaders(stored.access_token),
          body: JSON.stringify({
            locationId,
            limit: 5,
            filters: [{ field: "email", operator: "eq", value: email }],
          }),
        });
        if (searchRes.ok) {
          const searchData = (await searchRes.json()) as {
            contacts?: Array<{ id?: string; email?: string }>;
            data?: { contacts?: Array<{ id?: string; email?: string }> };
          };
          const contacts =
            searchData.contacts ??
            (Array.isArray(searchData.data) ? searchData.data : (searchData.data as { contacts?: Array<{ id?: string; email?: string }> })?.contacts ?? []);
          const match = contacts.find(
            (c) => (c.email ?? "").toLowerCase() === email.toLowerCase()
          );
          if (match) {
            contactId = match.id ?? null;
            result.contactSearch = { found: true, contactId };
          } else {
            result.contactSearch = {
              found: false,
              tried: contacts.length,
              sampleEmails: contacts.slice(0, 3).map((c) => c.email),
            };
          }
        } else {
          result.contactSearch = {
            error: searchRes.status,
            body: (await searchRes.text()).slice(0, 300),
          };
        }
      } catch (e) {
        result.contactSearch = { error: String(e) };
      }
    }

    // 2. Fetch opps WITHOUT date params - go deep (50 pages) to find old-created opp
    const oppsWithoutDate: Record<string, unknown>[] = [];
    for (let page = 1; page <= 50; page++) {
      if (page > 1) await delay(250);
      const url = new URL(`${GHL_BASE}/opportunities/search`);
      url.searchParams.set("location_id", locationId);
      url.searchParams.set("pipeline_id", pipeline.id);
      url.searchParams.set("status", "all");
      url.searchParams.set("limit", "100");
      url.searchParams.set("page", String(page));
      if (contactId) url.searchParams.set("contact_id", contactId);

      const res = await fetch(url.toString(), {
        headers: authHeaders(stored.access_token),
      });
      if (res.status === 429) {
        await delay(4000);
        page--;
        continue;
      }
      if (!res.ok) {
        result.fetchWithoutDateParams = {
          error: res.status,
          body: (await res.text()).slice(0, 300),
          pagesFetched: page - 1,
        };
        break;
      }
      const data = (await res.json()) as {
        opportunities?: Array<Record<string, unknown>>;
        data?: Array<Record<string, unknown>>;
        total?: number;
      };
      const opps = data.opportunities ?? data.data ?? [];
      for (const o of opps) oppsWithoutDate.push(o);
      if (opps.length < 100) break;
      if (data.total && page * 100 >= data.total) break;
    }
    result.fetchWithoutDateParams = {
      opportunitiesFound: oppsWithoutDate.length,
      opps: oppsWithoutDate.map((o) => ({
        id: o.id,
        name: o.name,
        dateCreated: o.dateCreated ?? o.date_created,
        lastStageChangeAt: o.lastStageChangeAt ?? o.last_stage_change_at,
        contactId: o.contactId ?? o.contact_id,
      })),
    };

    // Fallback: when contact search failed, try finding opp by email via GET /contacts/{id}
    // Prefer opps with recent lastStageChangeAt first (e.g. Feb 2026) to find old-created opps quickly
    let targetOpp: Record<string, unknown> | null = null;
    if (!contactId && email && oppsWithoutDate.length > 0) {
      const sorted = [...oppsWithoutDate].sort((a, b) => {
        const da = (a.lastStageChangeAt ?? a.last_stage_change_at) as string;
        const db = (b.lastStageChangeAt ?? b.last_stage_change_at) as string;
        return (db || "").localeCompare(da || ""); // newest stage change first
      });
      const seen = new Set<string>();
      for (const o of sorted) {
        const cid = (o.contactId ?? o.contact_id) as string | undefined;
        if (!cid || seen.has(cid)) continue;
        seen.add(cid);
        if (seen.size > 150) break; // limit to avoid rate limits
        await delay(180);
        try {
          const cr = await fetch(`${GHL_BASE}/contacts/${cid}`, {
            headers: authHeaders(stored.access_token),
          });
          if (!cr.ok) continue;
          const c = (await cr.json()) as { contact?: { email?: string } };
          const contactEmail = (c.contact?.email ?? (c as Record<string, unknown>).email) as string | undefined;
          if (contactEmail?.toLowerCase() === email.toLowerCase()) {
            targetOpp = o as Record<string, unknown>;
            result.contactFallback = { found: true, contactId: cid };
            break;
          }
        } catch {
          /* skip */
        }
      }
      if (!targetOpp) result.contactFallback = { found: false, contactsChecked: seen.size };
    }
    // If still not found, search across other pipelines (opp may be in different pipeline)
    if (!targetOpp && email && pipelines.length > 1) {
      const others = pipelines.filter((p) => p.id !== pipeline.id).slice(0, 3); // max 3 extra pipelines
      for (const p of others) {
        await delay(300);
        const allOpps: Record<string, unknown>[] = [];
        for (let page = 1; page <= 5; page++) {
          if (page > 1) await delay(200);
          const url = new URL(`${GHL_BASE}/opportunities/search`);
          url.searchParams.set("location_id", locationId);
          url.searchParams.set("pipeline_id", p.id);
          url.searchParams.set("status", "all");
          url.searchParams.set("limit", "100");
          url.searchParams.set("page", String(page));
          const res = await fetch(url.toString(), { headers: authHeaders(stored.access_token) });
          if (!res.ok) break;
          const data = (await res.json()) as { opportunities?: Array<Record<string, unknown>>; data?: Array<Record<string, unknown>> };
          const opps = data.opportunities ?? data.data ?? [];
          for (const o of opps) allOpps.push(o);
          if (opps.length < 100) break;
        }
        const sorted = [...allOpps].sort((a, b) => {
          const da = (a.lastStageChangeAt ?? a.last_stage_change_at) as string;
          const db = (b.lastStageChangeAt ?? b.last_stage_change_at) as string;
          return (db || "").localeCompare(da || "");
        });
        const seen = new Set<string>();
        for (const o of sorted) {
          const cid = (o.contactId ?? o.contact_id) as string | undefined;
          if (!cid || seen.has(cid)) continue;
          seen.add(cid);
          if (seen.size > 40) break;
          await delay(150);
          try {
            const cr = await fetch(`${GHL_BASE}/contacts/${cid}`, { headers: authHeaders(stored.access_token) });
            if (!cr.ok) continue;
            const c = (await cr.json()) as { contact?: { email?: string } };
            const contactEmail = (c.contact?.email ?? (c as Record<string, unknown>).email) as string | undefined;
            if (contactEmail?.toLowerCase() === email.toLowerCase()) {
              targetOpp = o as Record<string, unknown>;
              result.contactFallback = { found: true, contactId: cid, foundInPipeline: p.name };
              break;
            }
          } catch { /* skip */ }
        }
        if (targetOpp) break;
      }
    }
    if (contactId) {
      const forContact = oppsWithoutDate.filter(
        (o) => ((o.contactId ?? o.contact_id) as string) === contactId
      );
      if (forContact.length > 0 && !targetOpp) {
        // Prefer the one with oldest dateCreated (the 2022 case)
        const byCreated = [...forContact].sort((a, b) => {
          const da = (a.dateCreated ?? a.date_created) as string;
          const db = (b.dateCreated ?? b.date_created) as string;
          return (da || "").localeCompare(db || "");
        });
        targetOpp = byCreated[0] as Record<string, unknown>;
        if (forContact.length > 1)
          result.targetOppCount = forContact.length;
      }
    }
    if (targetOpp) {
      result.targetOpp = {
        id: targetOpp.id,
        name: targetOpp.name,
        dateCreated: targetOpp.dateCreated ?? targetOpp.date_created,
        lastStageChangeAt: targetOpp.lastStageChangeAt ?? targetOpp.last_stage_change_at,
        contactId: targetOpp.contactId ?? targetOpp.contact_id,
        pipelineId: targetOpp.pipelineId ?? targetOpp.pipeline_id,
        stageName: targetOpp.stageName ?? targetOpp.stage_name,
      };
    }

    // 3. Fetch opps WITH date params - try various undocumented stage/date param variants
    const dateParamVariants = [
      { startDate: "2026-02-01", endDate: "2026-02-28" },
      { start_date: "2026-02-01", end_date: "2026-02-28" },
      { date: "2026-02" },
      { lastStageChangeFrom: "2026-02-01", lastStageChangeTo: "2026-02-28" },
      { last_stage_change_from: "2026-02-01", last_stage_change_to: "2026-02-28" },
      { stageChangeDate: "2026-02" },
      { updatedAfter: "2026-02-01", updatedBefore: "2026-02-28" },
    ];

    for (const variant of dateParamVariants) {
      const key = Object.keys(variant).join("_");
      await delay(300);
      const url = new URL(`${GHL_BASE}/opportunities/search`);
      url.searchParams.set("location_id", locationId);
      url.searchParams.set("pipeline_id", pipeline.id);
      url.searchParams.set("status", "all");
      url.searchParams.set("limit", "100");
      url.searchParams.set("page", "1");
      for (const [k, v] of Object.entries(variant)) {
        url.searchParams.set(k, v);
      }
      if (contactId) url.searchParams.set("contact_id", contactId);

      const res = await fetch(url.toString(), {
        headers: authHeaders(stored.access_token),
      });
      const data = (await res.json()) as {
        opportunities?: Array<Record<string, unknown>>;
        data?: Array<Record<string, unknown>>;
        total?: number;
      };
      const opps = data.opportunities ?? data.data ?? [];
      (result as Record<string, unknown>)[`fetchWithDateParams_${key}`] = {
        params: variant,
        status: res.status,
        opportunitiesFound: opps.length,
        total: data.total,
        opps: opps.slice(0, 5).map((o) => ({
          id: o.id,
          name: o.name,
          dateCreated: o.dateCreated ?? o.date_created,
          lastStageChangeAt: o.lastStageChangeAt ?? o.last_stage_change_at,
        })),
      };
    }

    // 4. If we have contactId and didn't find via contact_id above, try opp search with contact_id only (no pipeline filter first, then with)
    if (contactId && oppsWithoutDate.length === 0) {
      await delay(300);
      const url = new URL(`${GHL_BASE}/opportunities/search`);
      url.searchParams.set("location_id", locationId);
      url.searchParams.set("contact_id", contactId);
      url.searchParams.set("status", "all");
      url.searchParams.set("limit", "100");

      const res = await fetch(url.toString(), {
        headers: authHeaders(stored.access_token),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          opportunities?: Array<Record<string, unknown>>;
          data?: Array<Record<string, unknown>>;
        };
        const opps = data.opportunities ?? data.data ?? [];
        result.fetchByContactIdOnly = {
          opportunitiesFound: opps.length,
          opps: opps.map((o) => ({
            id: o.id,
            name: o.name,
            pipelineId: o.pipelineId ?? o.pipeline_id,
            dateCreated: o.dateCreated ?? o.date_created,
            lastStageChangeAt: o.lastStageChangeAt ?? o.last_stage_change_at,
          })),
        };
      }
    }

    return NextResponse.json(result);
  } catch (err) {
    console.error("[debug/test-date-params] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
