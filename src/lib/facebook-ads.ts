/**
 * Meta (Facebook) Marketing API helpers.
 * Fetches campaigns and ad spend insights using a server-side access token.
 *
 * Requires:
 * - META_APP_ID (Meta app ID)
 * - META_APP_SECRET (Meta app secret)
 * - META_ACCESS_TOKEN (Long-lived token with ads_read permission)
 *   Generate via Graph API Explorer or System User in Business Manager.
 */

const META_GRAPH = "https://graph.facebook.com";
const META_API_VERSION = "v21.0";

function getAccessToken(): string | null {
  return process.env.META_ACCESS_TOKEN ?? null;
}

/**
 * Latest Meta API usage reading, as a 0–100 percentage of the applicable
 * rate-limit budget. Meta returns this on every Graph response via the
 * `X-App-Usage` / `X-Business-Use-Case-Usage` / `X-Ad-Account-Usage` headers,
 * so we keep the worst (highest) number from the most recent response. Used to
 * show a subtle "Meta usage" indicator so we can see a throttle coming before
 * it cuts us off. Lives in module memory — resets on cold start, which is fine
 * since the rollup repopulates it every run.
 */
export interface MetaUsageSnapshot {
  /** 0–100. Worst utilization across the app / business / ad-account buckets. */
  pct: number;
  /** Which bucket the worst number came from (for the tooltip). */
  source: "app" | "business" | "ad-account";
  /** ISO timestamp of the response we read this from. */
  at: string;
}

let latestUsage: MetaUsageSnapshot | null = null;

export function getMetaUsageSnapshot(): MetaUsageSnapshot | null {
  return latestUsage;
}

/**
 * Graph error codes that mean "you're being throttled, back off and retry":
 *   4   - application-level request limit ("Application request limit reached")
 *   17  - user-level request limit
 *   32  - page-level request limit
 *   613 - custom-level rate limit
 * Business-use-case (ads) throttling reports codes in the 80000–80014 band.
 */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

/**
 * Graph error codes that are transient server hiccups, not our fault, and
 * Meta's own docs say to just retry:
 *   1 - "An unknown error occurred"
 *   2 - "Service temporarily unavailable"
 * These spike when the rollup hammers Meta under load and clear on a retry.
 */
const TRANSIENT_CODES = new Set([1, 2]);

/** Backoff schedule. Length = max retries. Short on purpose — we're smoothing
 * transient bursts within a rollup, not waiting out a full hour-long block. */
const RETRY_DELAYS_MS = [1000, 3000];

/**
 * Per-attempt request timeout. Node's fetch has no default, so when Meta hangs
 * (degraded gateway / slow HTML error page) a single call can stall for minutes
 * and starve a rollup worker. We escalate by attempt: fail fast on the first
 * try to catch true hangs, but give a genuinely heavy query (e.g. 13 months of
 * daily ad-set insights on a big account) more room on the retry before we call
 * it dead. Indexed by attempt; falls back to the last entry.
 */
const REQUEST_TIMEOUTS_MS = [18_000, 32_000, 45_000];

function requestTimeoutFor(attempt: number): number {
  return (
    REQUEST_TIMEOUTS_MS[Math.min(attempt, REQUEST_TIMEOUTS_MS.length - 1)]
  );
}

/**
 * Run-level guard so retries can't cascade a whole rollup past the platform's
 * function timeout. The runner sets a deadline at the start of a batch; once
 * we're past it we stop spending time on backoff and fail fast, so partial
 * data still lands instead of the run getting killed with nothing.
 */
let retryDeadline: number | null = null;

export function setMetaRetryDeadline(atEpochMs: number | null): void {
  retryDeadline = atEpochMs;
}

function retriesAllowed(): boolean {
  return retryDeadline == null || Date.now() < retryDeadline;
}

function isRetryableCode(code: unknown): boolean {
  const n = typeof code === "number" ? code : Number(code);
  if (!Number.isFinite(n)) return false;
  return (
    RATE_LIMIT_CODES.has(n) ||
    TRANSIENT_CODES.has(n) ||
    (n >= 80000 && n <= 80014)
  );
}

/**
 * Best-effort classifier for a Meta error *message* (what we persist). Lets the
 * UI tell a throttle apart from a real "app not assigned" disconnect without
 * plumbing structured error codes all the way through the rollup store.
 */
export function isMetaRateLimitError(message: string | null | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes("request limit reached") ||
    m.includes("rate limit") ||
    m.includes("too many calls") ||
    m.includes("user request limit") ||
    m.includes("calls to this api have exceeded")
  );
}

/**
 * Transient Meta/network failures that self-heal: server hiccups, gateway
 * pages, timeouts. Distinct from a rate limit (see {@link isMetaRateLimitError})
 * and from a real "app not assigned / no permission" disconnect. Used by the UI
 * so these don't masquerade as "Meta not connected".
 */
export function isMetaTransientError(message: string | null | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes("temporarily unavailable") ||
    m.includes("unknown error") ||
    m.includes("non-json response") ||
    m.includes("not valid json") ||
    m.includes("unexpected token") ||
    m.includes("timeout") ||
    m.includes("timed out") ||
    m.includes("please reduce the amount of data") ||
    m.includes("try again")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usagePctFromAppHeader(raw: string | null): number | null {
  if (!raw) return null;
  try {
    const u = JSON.parse(raw) as {
      call_count?: number;
      total_time?: number;
      total_cputime?: number;
    };
    return Math.max(u.call_count ?? 0, u.total_time ?? 0, u.total_cputime ?? 0);
  } catch {
    return null;
  }
}

function usagePctFromBucHeader(raw: string | null): number | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<
      string,
      Array<{ call_count?: number; total_time?: number; total_cputime?: number }>
    >;
    let worst = 0;
    for (const entries of Object.values(parsed)) {
      for (const e of entries ?? []) {
        worst = Math.max(
          worst,
          e.call_count ?? 0,
          e.total_time ?? 0,
          e.total_cputime ?? 0
        );
      }
    }
    return worst;
  } catch {
    return null;
  }
}

function usagePctFromAdAccountHeader(raw: string | null): number | null {
  if (!raw) return null;
  try {
    const u = JSON.parse(raw) as { acc_id_util_pct?: number };
    return u.acc_id_util_pct ?? null;
  } catch {
    return null;
  }
}

/** Read Meta's usage headers off a response and keep the worst reading. */
function recordUsage(headers: Headers): void {
  const candidates: Array<[MetaUsageSnapshot["source"], number | null]> = [
    ["app", usagePctFromAppHeader(headers.get("x-app-usage"))],
    ["business", usagePctFromBucHeader(headers.get("x-business-use-case-usage"))],
    ["ad-account", usagePctFromAdAccountHeader(headers.get("x-ad-account-usage"))],
  ];
  let worst: MetaUsageSnapshot | null = null;
  for (const [source, pct] of candidates) {
    if (pct == null) continue;
    if (!worst || pct > worst.pct) {
      worst = { pct: Math.round(pct), source, at: new Date().toISOString() };
    }
  }
  if (worst) latestUsage = worst;
}

interface MetaGraphError {
  message?: string;
  code?: number;
  error_subcode?: number;
  type?: string;
}

/** Build a synthetic Graph response carrying just an error message. */
function graphErrorResult<T>(message: string): T {
  return { error: { message } } as unknown as T;
}

async function backoff(attempt: number, reason: string): Promise<void> {
  console.warn(
    `[facebook-ads] Meta transient error (${reason}) — retry ${
      attempt + 1
    }/${RETRY_DELAYS_MS.length} in ${RETRY_DELAYS_MS[attempt]}ms`
  );
  return sleep(RETRY_DELAYS_MS[attempt]);
}

/** fetch + read body under one abort timeout so a hung call can't stall a worker. */
async function fetchTextWithTimeout(
  url: string,
  timeoutMs: number
): Promise<{ status: number; headers: Headers; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Single choke point for every Graph API request. Enforces a per-request
 * timeout, records usage headers, and retries with bounded backoff on the
 * things that self-heal — rate-limit codes, transient Meta errors (codes 1/2),
 * 5xx responses, HTML/gateway pages that aren't valid JSON, timeouts, and
 * network failures — so a blip during a rollup doesn't leave an account showing
 * 0 spend / "not connected". Retries stop once the run-level deadline passes so
 * they can never cascade the whole batch past the platform timeout. A
 * retried-to-death failure returns a clean message, never a raw parse exception.
 */
async function metaGraphFetch<T extends { error?: MetaGraphError }>(
  url: string
): Promise<T> {
  let lastMessage = "Meta request failed";
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const canRetry = attempt < RETRY_DELAYS_MS.length && retriesAllowed();

    let response: { status: number; headers: Headers; text: string };
    try {
      response = await fetchTextWithTimeout(url, requestTimeoutFor(attempt));
    } catch (err) {
      // Abort can surface as a DOMException (not instanceof Error), so read the
      // name defensively. Either way it's transient — retry, then fail soft.
      const name = (err as { name?: string } | null)?.name;
      const aborted = name === "AbortError" || name === "TimeoutError";
      lastMessage = aborted
        ? "Meta API request timed out"
        : "Meta API temporarily unavailable (network error)";
      if (canRetry) {
        await backoff(attempt, aborted ? "timeout" : "network error");
        continue;
      }
      return graphErrorResult<T>(lastMessage);
    }

    recordUsage(response.headers);

    let json: T;
    try {
      json = JSON.parse(response.text) as T;
    } catch {
      // Meta returned an HTML error / gateway page instead of JSON — transient.
      lastMessage = `Meta API temporarily unavailable (non-JSON response, HTTP ${response.status})`;
      if (canRetry) {
        await backoff(attempt, `HTTP ${response.status} non-JSON`);
        continue;
      }
      return graphErrorResult<T>(lastMessage);
    }

    const err = json.error;
    const serverError = response.status >= 500 && response.status < 600;
    const retryable = serverError || (err != null && isRetryableCode(err.code));
    if (retryable && canRetry) {
      lastMessage = err?.message ?? `HTTP ${response.status}`;
      await backoff(
        attempt,
        err?.code ? `code ${err.code}` : `HTTP ${response.status}`
      );
      continue;
    }
    return json;
  }
  return graphErrorResult<T>(lastMessage);
}

/** Ensure ad account ID has act_ prefix */
export function normalizeAdAccountId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("act_") ? trimmed : `act_${trimmed}`;
}

export interface FacebookCampaign {
  id: string;
  name: string;
}

/**
 * Fetch campaigns for an ad account.
 * Returns ACTIVE and PAUSED campaigns.
 */
export async function fetchCampaigns(
  adAccountId: string
): Promise<{ campaigns: FacebookCampaign[]; error?: string }> {
  const token = getAccessToken();
  if (!token) {
    return { campaigns: [], error: "META_ACCESS_TOKEN not configured" };
  }

  const normalized = normalizeAdAccountId(adAccountId);
  if (!normalized) {
    return { campaigns: [], error: "Invalid ad account ID" };
  }

  const params = new URLSearchParams({
    fields: "id,name",
    effective_status: '["ACTIVE","PAUSED"]',
    access_token: token,
  });

  const url = `${META_GRAPH}/${META_API_VERSION}/${normalized}/campaigns?${params}`;

  try {
    const json = await metaGraphFetch<{
      data?: Array<{ id: string; name: string }>;
      error?: { message?: string };
    }>(url);

    if (json.error) {
      return {
        campaigns: [],
        error: json.error.message ?? String(json.error),
      };
    }

    const data = Array.isArray(json.data) ? json.data : [];
    const campaigns: FacebookCampaign[] = data.map((c: { id: string; name: string }) => ({
      id: c.id,
      name: c.name ?? "(Unnamed)",
    }));

    return { campaigns };
  } catch (err) {
    return {
      campaigns: [],
      error: err instanceof Error ? err.message : "Failed to fetch campaigns",
    };
  }
}

/**
 * Fetch ad spend by month for an ad account or a specific campaign.
 * @param nodeId - act_123456789 (account) or 123456789 (campaign ID)
 * @param isCampaign - true if nodeId is a campaign ID (no act_ prefix)
 * @param monthKeys - e.g. ["2024-01", "2024-02"]
 */
export async function fetchSpendByMonth(
  nodeId: string,
  isCampaign: boolean,
  monthKeys: string[]
): Promise<{ spendByMonth: Record<string, number>; error?: string }> {
  const token = getAccessToken();
  if (!token) {
    return { spendByMonth: {}, error: "META_ACCESS_TOKEN not configured" };
  }

  const graphId = isCampaign ? nodeId : normalizeAdAccountId(nodeId);
  if (!graphId) {
    return { spendByMonth: {}, error: "Invalid ad account or campaign ID" };
  }

  const spendByMonth: Record<string, number> = {};
  for (const monthKey of monthKeys) {
    spendByMonth[monthKey] = 0;
  }

  // Meta API: use time_range spanning all months + time_increment=monthly
  const sorted = [...monthKeys].sort();
  const [firstY, firstM] = sorted[0].split("-").map(Number);
  const [lastY, lastM] = sorted[sorted.length - 1].split("-").map(Number);
  const since = `${firstY}-${String(firstM).padStart(2, "0")}-01`;
  const lastDay = new Date(lastY, lastM, 0).getDate();
  const until = `${lastY}-${String(lastM).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  const params = new URLSearchParams({
    fields: "spend",
    access_token: token,
    time_range: JSON.stringify({ since, until }),
    time_increment: "monthly",
  });

  const url = `${META_GRAPH}/${META_API_VERSION}/${graphId}/insights?${params}`;

  try {
    const json = await metaGraphFetch<{
      data?: Array<Record<string, unknown>>;
      error?: { message?: string };
    }>(url);

    if (json.error) {
      return { spendByMonth, error: json.error.message ?? String(json.error) };
    }

    const data = Array.isArray(json.data) ? json.data : [];
    for (const row of data) {
      const start = (row as { date_start?: string }).date_start;
      const spendVal = (row as { spend?: string }).spend;
      if (start && spendVal != null) {
        const monthKey = start.slice(0, 7);
        const val = parseFloat(String(spendVal));
        if (monthKeys.includes(monthKey)) {
          spendByMonth[monthKey] = isNaN(val) ? 0 : val;
        }
      }
    }

    return { spendByMonth };
  } catch (err) {
    return {
      spendByMonth,
      error: err instanceof Error ? err.message : "Failed to fetch insights",
    };
  }
}

/**
 * Fetch ad spend bucketed by DAY over an inclusive `[since, until]` window.
 * Returns a map keyed by YYYY-MM-DD (empty object on error). Used by the
 * agency rollup so KPIs can be sliced to arbitrary ranges.
 */
export async function fetchSpendByDay(
  nodeId: string,
  isCampaign: boolean,
  since: string,
  until: string
): Promise<{ spendByDate: Record<string, number>; error?: string }> {
  const token = getAccessToken();
  if (!token) {
    return { spendByDate: {}, error: "META_ACCESS_TOKEN not configured" };
  }

  const graphId = isCampaign ? nodeId : normalizeAdAccountId(nodeId);
  if (!graphId) {
    return { spendByDate: {}, error: "Invalid ad account or campaign ID" };
  }

  const params = new URLSearchParams({
    fields: "spend",
    access_token: token,
    time_range: JSON.stringify({ since, until }),
    time_increment: "1", // daily
  });

  let url: string | null = `${META_GRAPH}/${META_API_VERSION}/${graphId}/insights?${params}`;
  const spendByDate: Record<string, number> = {};

  try {
    // Meta paginates day-bucket responses — follow `paging.next` until exhausted.
    while (url) {
      const json: {
        data?: Array<{ date_start?: string; spend?: string }>;
        paging?: { next?: string };
        error?: { message?: string };
      } = await metaGraphFetch(url);
      if (json.error) {
        return {
          spendByDate,
          error: json.error.message ?? String(json.error),
        };
      }
      const data = Array.isArray(json.data) ? json.data : [];
      for (const row of data) {
        const day = row.date_start;
        const spendVal = row.spend;
        if (day && spendVal != null) {
          const val = parseFloat(String(spendVal));
          if (!Number.isNaN(val) && val > 0) {
            spendByDate[day] = (spendByDate[day] ?? 0) + val;
          }
        }
      }
      url = json.paging?.next ?? null;
    }
    return { spendByDate };
  } catch (err) {
    return {
      spendByDate,
      error: err instanceof Error ? err.message : "Failed to fetch daily insights",
    };
  }
}

/** Per-day Meta insight bucket. All fields are additive across days/campaigns. */
export interface DailyInsight {
  spend: number;
  impressions: number;
  clicks: number;
  linkClicks: number;
  /**
   * Leads Meta attributed on this day — matched to Ads Manager's Results column
   * (Instant Form / lead-gen objective), not the broad `lead` action rollup.
   */
  metaLeads: number;
}

/**
 * Fetch Meta insights bucketed by DAY over an inclusive `[since, until]`
 * window. Like {@link fetchSpendByDay} but also returns impressions, clicks,
 * and inline link clicks so the agency rollup can derive CPLC / CTR. Returns a
 * sparse map keyed by YYYY-MM-DD (empty object on error). Follows pagination.
 */
export async function fetchDailyInsights(
  nodeId: string,
  isCampaign: boolean,
  since: string,
  until: string
): Promise<{ insightsByDate: Record<string, DailyInsight>; error?: string }> {
  const token = getAccessToken();
  if (!token) {
    return { insightsByDate: {}, error: "META_ACCESS_TOKEN not configured" };
  }

  const graphId = isCampaign ? nodeId : normalizeAdAccountId(nodeId);
  if (!graphId) {
    return { insightsByDate: {}, error: "Invalid ad account or campaign ID" };
  }

  const params = new URLSearchParams({
    fields: "spend,impressions,clicks,inline_link_clicks,actions,results",
    access_token: token,
    time_range: JSON.stringify({ since, until }),
    time_increment: "1", // daily
    // Break down by ad set. The `results` field (Ads Manager's Results column)
    // only populates at the ad-set level — at campaign / account level Meta
    // can't pick one indicator across mixed optimization goals and returns it
    // empty, which forced the old buggy guess-the-custom-event fallback. Rows
    // are re-bucketed by day below, so spend / leads still sum to the campaign
    // total.
    level: "adset",
  });

  let url: string | null = `${META_GRAPH}/${META_API_VERSION}/${graphId}/insights?${params}`;
  const insightsByDate: Record<string, DailyInsight> = {};

  const bucketFor = (day: string): DailyInsight =>
    (insightsByDate[day] ??= {
      spend: 0,
      impressions: 0,
      clicks: 0,
      linkClicks: 0,
      metaLeads: 0,
    });

  const add = (day: string, key: keyof DailyInsight, raw: unknown) => {
    const val = parseFloat(String(raw ?? ""));
    if (Number.isNaN(val)) return;
    bucketFor(day)[key] += val;
  };

  try {
    // Meta paginates day-bucket responses — follow `paging.next` until exhausted.
    while (url) {
      const json: {
        data?: Array<{
          date_start?: string;
          spend?: string;
          impressions?: string;
          clicks?: string;
          inline_link_clicks?: string;
          actions?: MetaAction[];
          results?: MetaResult[];
        }>;
        paging?: { next?: string };
        error?: { message?: string };
      } = await metaGraphFetch(url);
      if (json.error) {
        return {
          insightsByDate,
          error: json.error.message ?? String(json.error),
        };
      }
      const data = Array.isArray(json.data) ? json.data : [];
      for (const row of data) {
        const day = row.date_start;
        if (!day) continue;
        add(day, "spend", row.spend);
        add(day, "impressions", row.impressions);
        add(day, "clicks", row.clicks);
        add(day, "linkClicks", row.inline_link_clicks);
        const metaLeads = parseMetaLeads(row.results, row.actions);
        if (metaLeads) bucketFor(day).metaLeads += metaLeads;
      }
      url = json.paging?.next ?? null;
    }
    return { insightsByDate };
  } catch (err) {
    return {
      insightsByDate,
      error: err instanceof Error ? err.message : "Failed to fetch daily insights",
    };
  }
}

export type MetaInsightsLevel = "campaign" | "adset" | "ad";

export interface MetaAdInsight {
  adId: string;
  adName: string;
  adsetId: string | null;
  adsetName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  spend: number;
  impressions: number;
  reach: number;
  frequency: number | null;
  clicks: number;
  inlineLinkClicks: number;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  leads: number;
}

type MetaAction = {
  action_type?: string;
  value?: string;
};

type MetaResult = {
  indicator?: string;
  values?: Array<{ value?: string }>;
};

function parseNumber(raw: unknown): number {
  const n = Number.parseFloat(String(raw ?? ""));
  return Number.isFinite(n) ? n : 0;
}

function parseNullableNumber(raw: unknown): number | null {
  const n = Number.parseFloat(String(raw ?? ""));
  return Number.isFinite(n) ? n : null;
}

/** Action types in priority order — matches Ads Manager "Leads (Form)" / Results. */
const LEAD_ACTION_PRIORITY = [
  "onsite_conversion.lead_grouped",
  "leadgen.other",
  "leadgen_grouped",
  "onsite_web_lead",
  "offsite_conversion.fb_pixel_lead",
  "lead",
] as const;

function actionMaxForType(actions: MetaAction[], actionType: string): number {
  const wanted = actionType.toLowerCase();
  let best = 0;
  for (const action of actions) {
    if (String(action?.action_type ?? "").toLowerCase() !== wanted) continue;
    best = Math.max(best, parseNumber(action?.value));
  }
  return best;
}

/** Pick the first lead action type present — never max across overlapping types. */
function leadsFromActions(actions: MetaAction[]): number {
  for (const preferred of LEAD_ACTION_PRIORITY) {
    const count = actionMaxForType(actions, preferred);
    if (count > 0) return count;
  }
  return 0;
}

/** Ads Manager Results column — match specific lead indicators in priority order. */
const LEAD_RESULT_PRIORITY = [
  "actions:onsite_conversion.lead_grouped",
  "actions:leadgen.other",
  "actions:leadgen_grouped",
  "actions:offsite_conversion.fb_pixel_lead",
  "actions:lead",
] as const;

function valueForResultIndicator(rows: MetaResult[], indicator: string): number {
  let best = 0;
  for (const result of rows) {
    if (String(result?.indicator ?? "").toLowerCase() !== indicator) continue;
    for (const entry of result?.values ?? []) {
      best = Math.max(best, parseNumber(entry?.value));
    }
  }
  return best;
}

/**
 * Read leads straight from Ads Manager's Results column (the `results` field).
 *
 * At the ad-set level Meta reports exactly one result indicator per ad set —
 * whatever the ad set optimizes for. Trust it. For standard lead objectives
 * that's a `..._lead` indicator; LP conversion campaigns report a named custom
 * conversion (e.g. `actions:offsite_conversion.custom.<id>` = "Casper Sport -
 * Decomp Targeting"). Both are the correct lead count, so we accept lead
 * indicators first, then any custom-conversion indicator. Non-lead goals
 * (link clicks, landing page views, engagement) are ignored.
 */
function parseResultLeads(raw: unknown): number {
  if (!Array.isArray(raw)) return 0;
  const rows = raw as MetaResult[];

  for (const pref of LEAD_RESULT_PRIORITY) {
    const value = valueForResultIndicator(rows, pref);
    if (value > 0) return value;
  }

  // Custom-conversion goal: the indicator is the campaign's own optimization
  // event, so it's the real lead count even though the id is arbitrary.
  let best = 0;
  for (const result of rows) {
    const indicator = String(result?.indicator ?? "").toLowerCase();
    if (!indicator.includes("custom")) continue;
    for (const entry of result?.values ?? []) {
      best = Math.max(best, parseNumber(entry?.value));
    }
  }
  return best;
}

/**
 * Count Meta leads the way Ads Manager's Results column does.
 *
 * The `results` field IS that column, so it's authoritative — it already covers
 * both standard lead objectives and LP custom-conversion goals (see
 * {@link parseResultLeads}). When Meta doesn't provide a results breakdown
 * (older data, or a non-ad-set fetch) we fall back to standard lead *actions*
 * only, in priority order. We deliberately do NOT guess at custom-conversion
 * `actions` / `conversions` here: those arrays carry shared agency pixel events
 * (e.g. a template "book a call" custom conversion firing 500+ times across
 * every client) that have nothing to do with this campaign's leads and wildly
 * inflate the count. If it's a real lead, it shows up in `results`.
 */
function parseMetaLeads(results: unknown, actions: unknown): number {
  const fromResults = parseResultLeads(results);
  if (fromResults > 0) return fromResults;
  if (Array.isArray(actions)) {
    return leadsFromActions(actions as MetaAction[]);
  }
  return 0;
}

function mergeAdInsight(
  existing: MetaAdInsight | undefined,
  row: MetaAdInsight
): MetaAdInsight {
  if (!existing) return row;
  const spend = existing.spend + row.spend;
  const impressions = existing.impressions + row.impressions;
  const clicks = existing.clicks + row.clicks;
  return {
    ...existing,
    spend,
    impressions,
    reach: existing.reach + row.reach,
    clicks,
    inlineLinkClicks: existing.inlineLinkClicks + row.inlineLinkClicks,
    leads: existing.leads + row.leads,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
    cpc: clicks > 0 ? spend / clicks : null,
    cpm: impressions > 0 ? (spend / impressions) * 1000 : null,
  };
}

/**
 * Fetch Meta Insights at the AD level over an inclusive date range (YYYY-MM-DD).
 * Returns one aggregate row per ad and follows Meta pagination.
 */
export async function fetchAdInsights(
  adAccountId: string,
  since: string,
  until: string,
  options?: { campaignIds?: string[] }
): Promise<{ ads: MetaAdInsight[]; error?: string }> {
  const token = getAccessToken();
  if (!token) {
    return { ads: [], error: "META_ACCESS_TOKEN not configured" };
  }

  const graphId = normalizeAdAccountId(adAccountId);
  if (!graphId) {
    return { ads: [], error: "Invalid ad account ID" };
  }

  const params = new URLSearchParams({
    fields:
      "ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,spend,impressions,reach,frequency,clicks,inline_link_clicks,ctr,cpc,cpm,actions,results",
    level: "ad",
    time_range: JSON.stringify({ since, until }),
    access_token: token,
    limit: "500",
  });

  if (options?.campaignIds?.length) {
    params.set(
      "filtering",
      JSON.stringify([
        {
          field: "campaign.id",
          operator: "IN",
          value: options.campaignIds,
        },
      ])
    );
  }

  let url: string | null = `${META_GRAPH}/${META_API_VERSION}/${graphId}/insights?${params}`;
  const byAdId = new Map<string, MetaAdInsight>();

  try {
    while (url) {
      const json: {
        data?: Array<Record<string, unknown>>;
        paging?: { next?: string };
        error?: { message?: string };
      } = await metaGraphFetch(url);

      if (json.error) {
        return { ads: Array.from(byAdId.values()), error: json.error.message ?? "Insights error" };
      }

      const rows = Array.isArray(json.data) ? json.data : [];
      for (const row of rows) {
        const adId = String(row.ad_id ?? "").trim();
        if (!adId) continue;
        const next: MetaAdInsight = {
          adId,
          adName: String(row.ad_name ?? "(Unnamed ad)"),
          adsetId: row.adset_id ? String(row.adset_id) : null,
          adsetName: row.adset_name ? String(row.adset_name) : null,
          campaignId: row.campaign_id ? String(row.campaign_id) : null,
          campaignName: row.campaign_name ? String(row.campaign_name) : null,
          spend: parseNumber(row.spend),
          impressions: parseNumber(row.impressions),
          reach: parseNumber(row.reach),
          frequency: parseNullableNumber(row.frequency),
          clicks: parseNumber(row.clicks),
          inlineLinkClicks: parseNumber(row.inline_link_clicks),
          ctr: parseNullableNumber(row.ctr),
          cpc: parseNullableNumber(row.cpc),
          cpm: parseNullableNumber(row.cpm),
          leads: parseMetaLeads(row.results, row.actions),
        };
        byAdId.set(adId, mergeAdInsight(byAdId.get(adId), next));
      }

      url = json.paging?.next ?? null;
    }

    return { ads: Array.from(byAdId.values()) };
  } catch (err) {
    return {
      ads: Array.from(byAdId.values()),
      error: err instanceof Error ? err.message : "Failed to fetch ad insights",
    };
  }
}

/**
 * Resolve creative thumbnail URLs for Meta ad IDs. Uses Graph `ids=...` to
 * batch lookups in chunks so the Ads tab does not make one request per row.
 */
export async function fetchAdCreativeThumbnails(
  adIds: string[]
): Promise<{ thumbnailsByAdId: Record<string, string>; error?: string }> {
  const token = getAccessToken();
  if (!token) {
    return { thumbnailsByAdId: {}, error: "META_ACCESS_TOKEN not configured" };
  }

  const uniqueAdIds = Array.from(new Set(adIds.map((id) => id.trim()).filter(Boolean)));
  const thumbnailsByAdId: Record<string, string> = {};
  const chunkSize = 50;

  try {
    for (let i = 0; i < uniqueAdIds.length; i += chunkSize) {
      const chunk = uniqueAdIds.slice(i, i + chunkSize);
      const params = new URLSearchParams({
        ids: chunk.join(","),
        fields: "creative{thumbnail_url}",
        access_token: token,
      });
      const url = `${META_GRAPH}/${META_API_VERSION}/?${params}`;
      const json = await metaGraphFetch<
        Record<
          string,
          { creative?: { thumbnail_url?: string }; error?: { message?: string } }
        > & { error?: { message?: string } }
      >(url);

      if (json.error) {
        return {
          thumbnailsByAdId,
          error: json.error.message ?? "Creative thumbnail lookup failed",
        };
      }

      for (const adId of chunk) {
        const thumbnail = json[adId]?.creative?.thumbnail_url;
        if (thumbnail) thumbnailsByAdId[adId] = thumbnail;
      }
    }

    return { thumbnailsByAdId };
  } catch (err) {
    return {
      thumbnailsByAdId,
      error: err instanceof Error ? err.message : "Failed to fetch creative thumbnails",
    };
  }
}

/**
 * Spend for each object at the given insights level over an inclusive date range (YYYY-MM-DD).
 * Paginates all results. Optionally restrict to specific campaign IDs (keyword filter flow).
 */
export async function fetchSpendByInsightsLevel(
  adAccountId: string,
  level: MetaInsightsLevel,
  since: string,
  until: string,
  options?: { campaignIds?: string[] }
): Promise<{ spendByObjectId: Record<string, number>; error?: string }> {
  const token = getAccessToken();
  if (!token) {
    return { spendByObjectId: {}, error: "META_ACCESS_TOKEN not configured" };
  }

  const graphId = normalizeAdAccountId(adAccountId);
  if (!graphId) {
    return { spendByObjectId: {}, error: "Invalid ad account ID" };
  }

  const idField =
    level === "campaign"
      ? "campaign_id"
      : level === "adset"
        ? "adset_id"
        : "ad_id";

  const spendByObjectId: Record<string, number> = {};
  let url: string | null =
    `${META_GRAPH}/${META_API_VERSION}/${graphId}/insights?${new URLSearchParams({
      fields: `spend,${idField}`,
      level,
      time_range: JSON.stringify({ since, until }),
      access_token: token,
      limit: "500",
    }).toString()}`;

  if (options?.campaignIds?.length) {
    const u = new URL(url);
    u.searchParams.set(
      "filtering",
      JSON.stringify([
        {
          field: "campaign.id",
          operator: "IN",
          value: options.campaignIds,
        },
      ])
    );
    url = u.toString();
  }

  try {
    while (url) {
      const json: {
        data?: Array<Record<string, string | undefined>>;
        paging?: { next?: string };
        error?: { message?: string };
      } = await metaGraphFetch(url);

      if (json.error) {
        return {
          spendByObjectId,
          error: json.error.message ?? "Insights error",
        };
      }

      const rows = Array.isArray(json.data) ? json.data : [];
      for (const row of rows) {
        const oid = row[idField];
        const spendVal = row.spend;
        if (oid != null && spendVal != null) {
          const id = String(oid);
          const val = parseFloat(String(spendVal));
          if (!isNaN(val)) {
            spendByObjectId[id] = (spendByObjectId[id] ?? 0) + val;
          }
        }
      }

      url = json.paging?.next ?? null;
    }

    return { spendByObjectId };
  } catch (err) {
    return {
      spendByObjectId: {},
      error: err instanceof Error ? err.message : "Failed to fetch insights",
    };
  }
}
