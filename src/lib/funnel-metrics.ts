/**
 * Funnel metrics calculation from stage counts/values.
 * Stage names are matched flexibly (case-insensitive, partial match).
 * Supports custom stage mappings for GHL stages that don't match built-in patterns.
 * Opportunities with status "won" count as closed regardless of stage.
 */

import { STATUS_WON_KEY } from "@/lib/ghl-oauth";

export type FunnelStage = "requested" | "confirmed" | "showed" | "noShow" | "closed";

/** Custom mappings: GHL stage name (exact) -> our funnel stage or "lead" */
export type CustomStageMappings = Record<string, FunnelStage | "lead">;

function stageMatchesBuiltIn(stageName: string, stageNames: string[]): boolean {
  const stageLower = stageName.toLowerCase().trim();
  for (const target of stageNames) {
    const targetLower = target.toLowerCase();
    if (
      stageLower === targetLower ||
      stageLower.includes(targetLower) ||
      targetLower.includes(stageLower)
    )
      return true;
  }
  return false;
}

function sumStages(
  counts: Record<string, number>,
  values: Record<string, number>,
  stageNames: string[],
  customMappings?: CustomStageMappings,
  targetStage?: FunnelStage,
  excludeStageNames?: string[]
): { count: number; value: number } {
  let count = 0;
  let value = 0;
  for (const [stageName, c] of Object.entries(counts)) {
    // Custom mapping takes precedence (exact stage name match)
    if (customMappings && targetStage && customMappings[stageName] === targetStage) {
      count += c;
      value += values[stageName] ?? 0;
      continue;
    }
    // Exclude stages that match the exclude list (e.g. "Show" matches both showed and noShow)
    if (excludeStageNames?.length && stageMatches(stageName, excludeStageNames)) continue;
    // Built-in matching
    const stageLower = stageName.toLowerCase().trim();
    for (const target of stageNames) {
      const targetLower = target.toLowerCase();
      if (
        stageLower === targetLower ||
        stageLower.includes(targetLower) ||
        targetLower.includes(stageLower)
      ) {
        count += c;
        value += values[stageName] ?? 0;
        break;
      }
    }
  }
  return { count, value };
}

/** Stage names that count as "appointment requested" (unconfirmed) */
const REQUESTED_STAGES = [
  "appointment unconfirmed",
  "appointment requested",
  "appt unconfirmed",
  "appt requested",
  "prepay",
];

/** Stage names that count as "appointment confirmed" */
const CONFIRMED_STAGES = ["appointment confirmed", "appt confirmed"];

/** Stage names for "showed up" */
const SHOWED_STAGES = ["showed up", "showed", "did not sign on", "report of findings"];

/** Stage names for "success" / closed */
const SUCCESS_STAGES = ["success", "closed", "won", "pay per visit"];

/** Stage names for "no show" / cancelled */
const NO_SHOW_STAGES = ["no show", "no-show", "cancelled", "canceled"];

/** Stage names for "lead" - fallback when pipeline order unknown */
const LEAD_STAGES = [
  "lead",
  "new lead",
  "contact",
  "prospect",
  "new patient",
  "inquiry",
  "connected",
  "replied",
];

/** Stages that start the "appointment" phase - we count everything BEFORE these as leads */
const FIRST_APPT_STAGES = [
  "appointment unconfirmed",
  "appointment requested",
  "appt unconfirmed",
  "appt requested",
  "prepay"
];

function stageMatches(name: string, targets: string[]): boolean {
  const lower = name.toLowerCase().trim();
  for (const t of targets) {
    const tLower = t.toLowerCase();
    if (lower === tLower || lower.includes(tLower) || tLower.includes(lower))
      return true;
  }
  return false;
}

export interface PipelineStageForOrder {
  name: string;
  position?: number;
}

export interface FunnelMetrics {
  // Counts
  leads: number;
  requested: number;
  confirmed: number;
  totalAppts: number; // requested + confirmed
  totalApptsRaw?: number; // requested + confirmed + showed
  showed: number;
  noShow: number;
  success: number;
  closed: number; // same as success for now
  total: number;
  // Rates
  bookingRate: number | null; // totalAppts / leads (or total if no leads)
  confirmationRate: number | null; // confirmed / totalAppts
  showRate: number | null; // showed / totalAppts
  showedConversionRate: number | null; // success / showed
  // Values ($)
  totalValue: number;
  showedValue: number;
  successValue: number;
  requestedValue: number;
  confirmedValue: number;
}

/** Effective mapping = "lead" | FunnelStage. Lead stages use built-in order or name match. */
export type EffectiveMapping = FunnelStage | "lead";

/** Get the effective mapping for a stage (custom overrides built-in) */
export function getEffectiveMapping(
  stageName: string,
  customMappings?: CustomStageMappings
): EffectiveMapping | null {
  if (customMappings?.[stageName]) return customMappings[stageName];
  if (stageMatches(stageName, REQUESTED_STAGES)) return "requested";
  if (stageMatches(stageName, CONFIRMED_STAGES)) return "confirmed";
  // Check noShow before showed so "Show" (matches both) maps to noShow
  if (stageMatches(stageName, NO_SHOW_STAGES)) return "noShow";
  if (stageMatches(stageName, SHOWED_STAGES)) return "showed";
  if (stageMatches(stageName, SUCCESS_STAGES)) return "closed";
  if (stageMatches(stageName, LEAD_STAGES)) return "lead";
  return null;
}

/** Get pipeline stage names that are not mapped (built-in or custom) */
/**
 * Returns stage keys (from counts) that contribute to the given metric. Used for drill-down.
 */
export function getStageKeysForMetric(
  metric: string,
  stageKeys: string[],
  customMappings?: CustomStageMappings,
  pipelineStages?: PipelineStageForOrder[]
): string[] {
  const result: string[] = [];
  for (const key of stageKeys) {
    if (key === STATUS_WON_KEY) {
      if (metric === "closed") result.push(key);
      continue;
    }
    if (customMappings?.[key]) {
      const m = customMappings[key];
      if (metric === "totalAppts" && (m === "requested" || m === "confirmed" || m === "showed")) result.push(key);
      else if (m === metric) result.push(key);
      continue;
    }
    if (metric === "leads") {
      if (pipelineStages?.length) {
        const sorted = [...pipelineStages].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
        const beforeFirstAppt = sorted.findIndex((s) => stageMatches(s.name, FIRST_APPT_STAGES));
        const leadStageNames = beforeFirstAppt >= 0 ? sorted.slice(0, beforeFirstAppt).map((s) => s.name) : sorted.map((s) => s.name);
        if (leadStageNames.some((n) => n.toLowerCase().trim() === key.toLowerCase().trim())) result.push(key);
      } else if (stageMatches(key, LEAD_STAGES)) result.push(key);
    } else if (metric === "requested" && stageMatches(key, REQUESTED_STAGES)) result.push(key);
    else if (metric === "confirmed" && stageMatches(key, CONFIRMED_STAGES)) result.push(key);
    else if (metric === "showed" && stageMatches(key, SHOWED_STAGES) && !stageMatches(key, NO_SHOW_STAGES)) result.push(key);
    else if (metric === "noShow" && stageMatches(key, NO_SHOW_STAGES)) result.push(key);
    else if (metric === "closed" && stageMatches(key, SUCCESS_STAGES)) result.push(key);
    else if (metric === "totalAppts" && (stageMatches(key, REQUESTED_STAGES) || stageMatches(key, CONFIRMED_STAGES) || stageMatches(key, SHOWED_STAGES))) result.push(key);
  }
  return result;
}

/** Metric -> which sub-metrics (in order) contribute to its rollup */
const ROLLUP_METRIC_GROUPS: Record<string, string[]> = {
  leads: ["leads", "requested", "confirmed", "showed", "noShow", "closed"],
  requested: ["requested", "confirmed", "showed", "noShow", "closed"],
  confirmed: ["confirmed", "showed", "noShow", "closed"],
  showed: ["showed", "closed"],
  noShow: ["noShow"],
  closed: ["closed"],
  totalAppts: ["requested", "confirmed", "showed", "noShow", "closed"],
};

export interface RollupGroup {
  label: string;
  stageKeys: string[];
}

/**
 * Returns groups for drill-down with each actual stage broken out (Replied, Connected,
 * Appointment Requested, etc.) so users see the breakdown instead of aggregated labels.
 * Used for both "On Totals" and "Current Stage Counts".
 */
export function getBreakdownGroupsForMetric(
  metric: string,
  stageKeys: string[],
  customMappings?: CustomStageMappings,
  pipelineStages?: PipelineStageForOrder[],
  rollup?: boolean
): RollupGroup[] {
  let keys: string[];
  if (rollup) {
    const subMetrics = ROLLUP_METRIC_GROUPS[metric];
    if (!subMetrics) return [];
    keys = subMetrics.flatMap((sub) =>
      getStageKeysForMetric(sub, stageKeys, customMappings, pipelineStages)
    );
    // Dedupe while preserving order
    const seen = new Set<string>();
    keys = keys.filter((k) => {
      const lower = k.toLowerCase();
      if (seen.has(lower)) return false;
      seen.add(lower);
      return true;
    });
  } else {
    keys = getStageKeysForMetric(metric, stageKeys, customMappings, pipelineStages);
  }
  return keys.map((key) => ({ label: key, stageKeys: [key] }));
}

export function getUnmappedStages(
  stageNames: string[],
  customMappings?: CustomStageMappings
): string[] {
  return stageNames.filter((n) => getEffectiveMapping(n, customMappings) === null);
}

export function calculateFunnelMetrics(
  counts: Record<string, number>,
  values: Record<string, number>,
  pipelineStages?: PipelineStageForOrder[],
  customMappings?: CustomStageMappings
): FunnelMetrics {
  const requested = sumStages(counts, values, REQUESTED_STAGES, customMappings, "requested");
  const confirmed = sumStages(counts, values, CONFIRMED_STAGES, customMappings, "confirmed");
  // Exclude no-show stages from showed (e.g. "Show" matches both "showed" and "no show")
  const showed = sumStages(counts, values, SHOWED_STAGES, customMappings, "showed", NO_SHOW_STAGES);
  const noShow = sumStages(counts, values, NO_SHOW_STAGES, customMappings, "noShow");
  const successFromStages = sumStages(counts, values, SUCCESS_STAGES, customMappings, "closed");
  const statusWonCount = counts[STATUS_WON_KEY] ?? 0;
  const statusWonValue = values[STATUS_WON_KEY] ?? 0;
  const success = {
    count: successFromStages.count + statusWonCount,
    value: successFromStages.value + statusWonValue,
  };

  // Leads = pipeline order (before first appt, no custom) + custom "lead" mappings
  let leads: { count: number; value: number };
  if (pipelineStages?.length) {
    const sorted = [...pipelineStages].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    let count = 0;
    let value = 0;
    for (const stage of sorted) {
      if (stageMatches(stage.name, FIRST_APPT_STAGES)) break;
      if (customMappings?.[stage.name]) continue; // custom override: handled below
      count += counts[stage.name] ?? 0;
      value += values[stage.name] ?? 0;
    }
    for (const [stageName, c] of Object.entries(counts)) {
      if (customMappings?.[stageName] === "lead") {
        count += c;
        value += values[stageName] ?? 0;
      }
    }
    leads = { count, value };
  } else {
    leads = sumStages(counts, values, LEAD_STAGES);
    for (const [stageName, c] of Object.entries(counts)) {
      if (customMappings?.[stageName] === "lead") {
        leads.count += c;
        leads.value += values[stageName] ?? 0;
      }
    }
  }

  const totalAppts = requested.count + confirmed.count;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const totalValue = Object.values(values).reduce((a, b) => a + b, 0);

  // Booking rate = appts / (leads + appts) — of everyone in lead or appointment stage, what % have booked
  const leadPlusApptPool = leads.count + totalAppts;
  const bookingRate =
    leadPlusApptPool > 0
      ? Math.round((totalAppts / leadPlusApptPool) * 1000) / 10
      : null;
  const confirmationRate =
    totalAppts > 0
      ? Math.round((confirmed.count / totalAppts) * 1000) / 10
      : null;
  const showRate =
    totalAppts > 0 ? Math.round((showed.count / totalAppts) * 1000) / 10 : null;
  const showedConversionRate =
    showed.count > 0
      ? Math.round((success.count / showed.count) * 1000) / 10
      : null;

  return {
    leads: leads.count,
    requested: requested.count,
    confirmed: confirmed.count,
    totalAppts,
    showed: showed.count,
    noShow: noShow.count,
    success: success.count,
    closed: success.count,
    total,
    totalApptsRaw: requested.count + confirmed.count + showed.count,
    bookingRate,
    confirmationRate,
    showRate,
    showedConversionRate,
    totalValue,
    showedValue: showed.value,
    successValue: success.value,
    requestedValue: requested.value,
    confirmedValue: confirmed.value,
  };
}

/**
 * Apply rollup assumptions: people in later stages were once in earlier stages.
 * Each metric = that stage + all stages after it (showed excludes noShow - they didn't show).
 */
export function applyRollup(metrics: FunnelMetrics): FunnelMetrics {
  const l = metrics.leads;
  const r = metrics.requested;
  const c = metrics.confirmed;
  const s = metrics.showed;
  const n = metrics.noShow;
  const cl = metrics.closed;

  const leadsRollup = l + r + c + s + n + cl;
  const requestedRollup = r + c + s + n + cl;
  const confirmedRollup = c + s + n + cl;
  const showedRollup = s + cl; // exclude noShow

  const requestedRollupForTotal = r + c + s + n + cl; // everyone who reached appointment
  const totalApptsRollup = r + c + s; // requested+confirmed+showed (for rate denominators)
  const bookingRate =
    leadsRollup > 0 ? Math.round((requestedRollup / leadsRollup) * 1000) / 10 : null;
  const confirmationRate =
    requestedRollup > 0 ? Math.round((confirmedRollup / requestedRollup) * 1000) / 10 : null;
  const showRate =
    requestedRollup > 0 ? Math.round((showedRollup / requestedRollup) * 1000) / 10 : null;
  const showedConversionRate =
    showedRollup > 0 ? Math.round((cl / showedRollup) * 1000) / 10 : null;

  return {
    ...metrics,
    leads: leadsRollup,
    requested: requestedRollup,
    confirmed: confirmedRollup,
    showed: showedRollup,
    totalAppts: requestedRollupForTotal, // same as requested in rollup: everyone who reached appt stage
    totalApptsRaw: requestedRollupForTotal,
    bookingRate,
    confirmationRate,
    showRate,
    showedConversionRate,
  };
}
