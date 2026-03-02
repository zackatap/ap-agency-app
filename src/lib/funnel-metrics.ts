/**
 * Funnel metrics calculation from stage counts/values.
 * Stage names are matched flexibly (case-insensitive, partial match).
 */

function sumStages(
  counts: Record<string, number>,
  values: Record<string, number>,
  stageNames: string[]
): { count: number; value: number } {
  let count = 0;
  let value = 0;
  for (const [stageName, c] of Object.entries(counts)) {
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
];

/** Stage names that count as "appointment confirmed" */
const CONFIRMED_STAGES = ["appointment confirmed", "appt confirmed"];

/** Stage names for "showed up" */
const SHOWED_STAGES = ["showed up", "showed"];

/** Stage names for "success" / closed */
const SUCCESS_STAGES = ["success", "closed", "won"];

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
];

/** Stages that start the "appointment" phase - we count everything BEFORE these as leads */
const FIRST_APPT_STAGES = [
  "appointment unconfirmed",
  "appointment requested",
  "appt unconfirmed",
  "appt requested",
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

export function calculateFunnelMetrics(
  counts: Record<string, number>,
  values: Record<string, number>,
  pipelineStages?: PipelineStageForOrder[]
): FunnelMetrics {
  const requested = sumStages(counts, values, REQUESTED_STAGES);
  const confirmed = sumStages(counts, values, CONFIRMED_STAGES);
  const showed = sumStages(counts, values, SHOWED_STAGES);
  const noShow = sumStages(counts, values, NO_SHOW_STAGES);
  const success = sumStages(counts, values, SUCCESS_STAGES);

  // Leads = all stages before first "Appointment Unconfirmed/Requested" (by pipeline order)
  let leads: { count: number; value: number };
  if (pipelineStages?.length) {
    const sorted = [...pipelineStages].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    let count = 0;
    let value = 0;
    for (const stage of sorted) {
      if (stageMatches(stage.name, FIRST_APPT_STAGES)) break; // stop at first appt stage
      count += counts[stage.name] ?? 0;
      value += values[stage.name] ?? 0;
    }
    leads = { count, value };
  } else {
    leads = sumStages(counts, values, LEAD_STAGES); // fallback to name matching
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
    totalAppts: r + c,
    totalApptsRaw: r + c + s,
    bookingRate,
    confirmationRate,
    showRate,
    showedConversionRate,
  };
}
