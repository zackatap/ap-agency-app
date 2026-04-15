import { ghlAuthHeaders } from "@/lib/ghl-oauth";

const GHL_BASE = "https://services.leadconnectorhq.com";

export interface GHLWorkflow {
  id: string;
  name: string;
  status?: string;
  url?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeWorkflow(item: unknown): GHLWorkflow | null {
  const row = asRecord(item);
  const id = String(
    row.id ??
      row._id ??
      row.workflowId ??
      row.workflow_id ??
      row.campaignId ??
      ""
  ).trim();
  const name = String(
    row.name ??
      row.workflowName ??
      row.workflow_name ??
      row.campaignName ??
      row.title ??
      ""
  ).trim();

  if (!id || !name) return null;

  const status = String(row.status ?? row.state ?? "").trim() || undefined;
  const url =
    String(
      row.url ??
        row.workflowUrl ??
        row.workflow_url ??
        row.link ??
        row.permalink ??
        ""
    ).trim() || undefined;

  return { id, name, status, url };
}

function extractWorkflowArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const data = asRecord(payload);

  if (Array.isArray(data.workflows)) return data.workflows;
  if (Array.isArray(data.campaigns)) return data.campaigns;
  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data.items)) return data.items;

  return [];
}

/**
 * Location-scoped list (same pattern as dashboard: explicit location in request).
 * Docs: https://marketplace.gohighlevel.com/docs/ghl/emails/list-workflow-campaigns-v-2
 */
async function fetchWorkflowCampaignsByLocation(
  locationId: string,
  accessToken: string
): Promise<{ ok: true; workflows: GHLWorkflow[] } | { ok: false; status: number; body: string }> {
  const endpoint = `${GHL_BASE}/emails/public/v2/locations/${encodeURIComponent(locationId)}/campaigns/workflows`;
  const res = await fetch(endpoint, {
    method: "GET",
    headers: ghlAuthHeaders(accessToken),
  });
  const body = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, body };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    return { ok: false, status: res.status, body: body.slice(0, 300) };
  }
  const rows = extractWorkflowArray(payload);
  const workflows = rows
    .map((item) => normalizeWorkflow(item))
    .filter((item): item is GHLWorkflow => item !== null);
  return { ok: true, workflows };
}

/**
 * Core workflows resource.
 * Docs: https://marketplace.gohighlevel.com/docs/ghl/workflows/get-workflow
 */
async function fetchWorkflowsRoot(
  accessToken: string
): Promise<{ ok: true; workflows: GHLWorkflow[] } | { ok: false; status: number; body: string }> {
  const endpoint = new URL("/workflows/", GHL_BASE);
  const res = await fetch(endpoint.toString(), {
    method: "GET",
    headers: ghlAuthHeaders(accessToken),
  });
  const body = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, body };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    return { ok: false, status: res.status, body: body.slice(0, 300) };
  }
  const rows = extractWorkflowArray(payload);
  const workflows = rows
    .map((item) => normalizeWorkflow(item))
    .filter((item): item is GHLWorkflow => item !== null);
  return { ok: true, workflows };
}

export async function getWorkflowCampaigns(
  locationId: string,
  accessToken: string
): Promise<GHLWorkflow[]> {
  const byLocation = await fetchWorkflowCampaignsByLocation(locationId, accessToken);
  if (byLocation.ok) {
    return byLocation.workflows;
  }

  const lowered = byLocation.body.toLowerCase();
  const scopeIssue =
    byLocation.status === 401 &&
    (lowered.includes("not authorized for this scope") ||
      lowered.includes("scope"));

  const atRoot = await fetchWorkflowsRoot(accessToken);
  if (atRoot.ok) {
    return atRoot.workflows;
  }

  throw new Error(
    `GHL workflows: location list failed (${byLocation.status} ${byLocation.body.slice(0, 200)}); ` +
      `GET /workflows/ failed (${atRoot.status} ${atRoot.body.slice(0, 200)})` +
      (scopeIssue
        ? ". Ensure Marketplace app includes campaigns.readonly (location list) or workflows.readonly works for GET /workflows/."
        : "")
  );
}

/** For debug probe only — returns raw outcomes without throwing. */
export async function probeWorkflowSources(
  locationId: string,
  accessToken: string
): Promise<{
  locationCampaignsPath: { status: number; snippet: string; count?: number };
  workflowsRoot: { status: number; snippet: string; count?: number };
}> {
  const a = await fetchWorkflowCampaignsByLocation(locationId, accessToken);
  const b = await fetchWorkflowsRoot(accessToken);

  return {
    locationCampaignsPath: a.ok
      ? { status: 200, snippet: "ok", count: a.workflows.length }
      : { status: a.status, snippet: a.body.slice(0, 280) },
    workflowsRoot: b.ok
      ? { status: 200, snippet: "ok", count: b.workflows.length }
      : { status: b.status, snippet: b.body.slice(0, 280) },
  };
}
