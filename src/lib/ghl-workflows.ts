import { ghlAuthHeadersGet } from "@/lib/ghl-oauth";

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
 * Official Workflows API — list workflows.
 * Docs: https://marketplace.gohighlevel.com/docs/ghl/workflows/get-workflow
 * Scopes: https://marketplace.gohighlevel.com/docs/Authorization/Scopes (workflows.readonly → GET /workflows/)
 */
export interface GhlWorkflowsFetchDebug {
  requestUrl: string;
  totalRecordsFromApi: number;
  responseTopLevelKeys: string[];
  /** First N raw workflow objects as returned by GHL (before normalization). */
  rawSamples: unknown[];
}

async function fetchWorkflowsOnce(
  accessToken: string,
  searchParams?: URLSearchParams,
  options?: { rawSampleLimit?: number }
): Promise<
  | { ok: true; workflows: GHLWorkflow[]; ghlDebug?: GhlWorkflowsFetchDebug }
  | { ok: false; status: number; body: string }
> {
  const url = new URL("/workflows/", GHL_BASE);
  if (searchParams) {
    searchParams.forEach((v, k) => url.searchParams.set(k, v));
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: ghlAuthHeadersGet(accessToken),
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

  const limit = options?.rawSampleLimit ?? 0;
  const ghlDebug: GhlWorkflowsFetchDebug | undefined =
    limit > 0
      ? {
          requestUrl: url.toString(),
          totalRecordsFromApi: rows.length,
          responseTopLevelKeys: Object.keys(asRecord(payload)).sort(),
          rawSamples: rows.slice(0, limit),
        }
      : undefined;

  return { ok: true, workflows, ghlDebug };
}

export async function getWorkflowCampaigns(
  locationId: string,
  accessToken: string,
  options?: { rawSampleLimit?: number }
): Promise<{
  workflows: GHLWorkflow[];
  ghlDebug?: GhlWorkflowsFetchDebug;
}> {
  const withLoc = new URLSearchParams();
  withLoc.set("locationId", locationId);

  const tryWithQuery = await fetchWorkflowsOnce(
    accessToken,
    withLoc,
    options?.rawSampleLimit ? { rawSampleLimit: options.rawSampleLimit } : undefined
  );
  if (tryWithQuery.ok) {
    return {
      workflows: tryWithQuery.workflows,
      ghlDebug: tryWithQuery.ghlDebug,
    };
  }

  const plain = await fetchWorkflowsOnce(
    accessToken,
    undefined,
    options?.rawSampleLimit ? { rawSampleLimit: options.rawSampleLimit } : undefined
  );
  if (plain.ok) {
    return { workflows: plain.workflows, ghlDebug: plain.ghlDebug };
  }

  throw new Error(
    `GHL GET /workflows/ failed with locationId query (${tryWithQuery.status} ${tryWithQuery.body.slice(0, 220)}); ` +
      `without query (${plain.status} ${plain.body.slice(0, 220)}). ` +
      `Docs: https://marketplace.gohighlevel.com/docs/ghl/workflows/get-workflow — requires Sub-Account token with workflows.readonly.`
  );
}

export type WorkflowProbeRow = { status: number; snippet: string; count?: number };

/** Diagnostics: workflows API only (no campaigns / emails). */
export async function probeWorkflowSources(
  locationId: string,
  accessToken: string
): Promise<{
  workflowsWithLocationIdQuery: WorkflowProbeRow;
  workflowsPlain: WorkflowProbeRow;
}> {
  const q = new URLSearchParams();
  q.set("locationId", locationId);

  const a = await fetchWorkflowsOnce(accessToken, q);
  const b = await fetchWorkflowsOnce(accessToken);

  return {
    workflowsWithLocationIdQuery: a.ok
      ? { status: 200, snippet: "ok", count: a.workflows.length }
      : { status: a.status, snippet: a.body.slice(0, 280) },
    workflowsPlain: b.ok
      ? { status: 200, snippet: "ok", count: b.workflows.length }
      : { status: b.status, snippet: b.body.slice(0, 280) },
  };
}
