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

export async function getWorkflowCampaigns(
  locationId: string,
  accessToken: string
): Promise<GHLWorkflow[]> {
  const endpoint = `${GHL_BASE}/emails/public/v2/locations/${encodeURIComponent(locationId)}/campaigns/workflows`;
  const res = await fetch(endpoint, {
    method: "GET",
    headers: ghlAuthHeaders(accessToken),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `GHL list workflows failed: ${res.status} ${errText.slice(0, 300)}`
    );
  }

  const payload = await res.json();
  const rows = extractWorkflowArray(payload);

  return rows
    .map((item) => normalizeWorkflow(item))
    .filter((item): item is GHLWorkflow => item !== null);
}
