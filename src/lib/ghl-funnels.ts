import { ghlAuthHeadersGet } from "@/lib/ghl-oauth";

const GHL_BASE = "https://services.leadconnectorhq.com";

export interface GHLFunnel {
  id: string;
  name: string;
  status?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeFunnel(item: unknown): GHLFunnel | null {
  const row = asRecord(item);
  const id = String(
    row.id ?? row._id ?? row.funnelId ?? row.funnel_id ?? ""
  ).trim();
  const name = String(
    row.name ?? row.title ?? row.funnelName ?? row.funnel_name ?? ""
  ).trim();

  if (!id || !name) return null;

  let status: string | undefined;
  if (typeof row.archived === "boolean") {
    status = row.archived ? "archived" : "active";
  } else {
    const s = String(row.status ?? row.state ?? "").trim();
    status = s || undefined;
  }

  return { id, name, status };
}

function extractFunnelArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const data = asRecord(payload);

  if (Array.isArray(data.funnels)) return data.funnels;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.data)) return data.data;

  const nested = asRecord(data.data);
  if (Array.isArray(nested.funnels)) return nested.funnels;

  return [];
}

/**
 * List funnels for a location.
 * Docs: https://marketplace.gohighlevel.com/docs/ghl/funnels/get-funnels
 * Scope: funnels/funnel.readonly → GET /funnels/funnel/list
 */
export interface GhlFunnelsFetchDebug {
  requestUrl: string;
  totalRecordsFromApi: number;
  responseTopLevelKeys: string[];
  rawSamples: unknown[];
}

async function fetchFunnelsOnce(
  accessToken: string,
  searchParams?: URLSearchParams,
  options?: { rawSampleLimit?: number }
): Promise<
  | { ok: true; funnels: GHLFunnel[]; ghlDebug?: GhlFunnelsFetchDebug }
  | { ok: false; status: number; body: string }
> {
  const url = new URL("/funnels/funnel/list", GHL_BASE);
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

  const rows = extractFunnelArray(payload);
  const funnels = rows
    .map((item) => normalizeFunnel(item))
    .filter((item): item is GHLFunnel => item !== null);

  const limit = options?.rawSampleLimit ?? 0;
  const ghlDebug: GhlFunnelsFetchDebug | undefined =
    limit > 0
      ? {
          requestUrl: url.toString(),
          totalRecordsFromApi: rows.length,
          responseTopLevelKeys: Object.keys(asRecord(payload)).sort(),
          rawSamples: rows.slice(0, limit),
        }
      : undefined;

  return { ok: true, funnels, ghlDebug };
}

export async function getFunnelsForLocation(
  locationId: string,
  accessToken: string,
  options?: { rawSampleLimit?: number }
): Promise<{
  funnels: GHLFunnel[];
  ghlDebug?: GhlFunnelsFetchDebug;
}> {
  const withLoc = new URLSearchParams();
  withLoc.set("locationId", locationId);

  const withQuery = await fetchFunnelsOnce(
    accessToken,
    withLoc,
    options?.rawSampleLimit ? { rawSampleLimit: options.rawSampleLimit } : undefined
  );
  if (withQuery.ok) {
    return { funnels: withQuery.funnels, ghlDebug: withQuery.ghlDebug };
  }

  const plain = await fetchFunnelsOnce(
    accessToken,
    undefined,
    options?.rawSampleLimit ? { rawSampleLimit: options.rawSampleLimit } : undefined
  );
  if (plain.ok) {
    return { funnels: plain.funnels, ghlDebug: plain.ghlDebug };
  }

  throw new Error(
    `GHL GET /funnels/funnel/list failed with locationId query (${withQuery.status} ${withQuery.body.slice(0, 220)}); ` +
      `without query (${plain.status} ${plain.body.slice(0, 220)}). ` +
      `Docs: https://marketplace.gohighlevel.com/docs/ghl/funnels/get-funnels — requires Sub-Account token with funnels/funnel.readonly.`
  );
}
