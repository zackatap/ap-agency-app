/**
 * Quality attention flags — the account-manager counterpart to the media
 * buyer's lead/CPL flags in {@link file:./attention-flags.ts}.
 *
 * Where the Quantity engine watches spend, leads, and CPL, this one watches the
 * post-lead funnel: booking rate, show rate, no-show rate, and sign-on (close)
 * rate. The goal is to catch a patient-quality problem before the client does.
 *
 * The wrinkle: stages auto-advance only through "Appt Confirmed". Everything
 * after that (showed, no-show, success/closed) depends on the client updating
 * the CRM. So a low show/close rate is ambiguous — a real quality collapse, or
 * a client who never touches the board. We split those:
 *   - Healthy top funnel + zero logged outcomes  -> Q_DATA (a hygiene nudge).
 *   - Enough logged outcomes to trust the rates   -> real Q_R/Q_O/Q_Y flags.
 *
 * Urgency mirrors the Quantity engine (R=0, O=1, Y=2) with a fourth level for
 * the data-hygiene flag (3 = "Data"), so the two columns can share a badge.
 */

export type QualityCode =
  | "Q_R1"
  | "Q_R2"
  | "Q_O1"
  | "Q_O2"
  | "Q_O3"
  | "Q_Y1"
  | "Q_Y2"
  | "Q_Y3"
  | "Q_DATA";

/** Code → human reason sentence shown in the KPI tab's Reason column. */
export const QUALITY_REASONS: Record<QualityCode, string> = {
  Q_R1: "Show rate under 20% over 30 days (booked patients aren't showing).",
  Q_R2: "Sign-on rate under 15% over 30 days (shows aren't converting to patients).",
  Q_O1: "No-show rate over 40% over 30 days.",
  Q_O2: "Show rate dropped 15+ points vs the prior 14 days.",
  Q_O3: "Show rate under 30% over 30 days.",
  Q_Y1: "Show rate under 40% over 30 days.",
  Q_Y2: "Sign-on rate under 25% over 30 days.",
  Q_Y3: "Booking rate under 30% over 30 days (leads aren't turning into appointments).",
  Q_DATA:
    "Appointments booked but CRM barely updated past Appt Confirmed (few/no shows or sign-ons logged).",
};

/**
 * Tunable thresholds. Kept together so a calibration pass can adjust day-one
 * flagging without hunting through the rule tree.
 *
 * Rate thresholds are in **percentage points** (0–100), matching
 * `rateOrNull` in agency-rollup-view (e.g. 40 = 40%). Do not use 0–1 fractions.
 *
 * Show-rate bars are calibrated to this agency's book: among clients who
 * actually log outcomes, median 30d show rate sits around the low-to-mid 30s.
 * A 40% "red" bar was flagging half the roster.
 */
const HYGIENE_APPTS_MIN = 5; // booked appts needed before "no outcomes" is suspicious
const RESOLVED_MIN = 5; // logged show/no-show outcomes needed to trust the rates
/** Share of booked appts that have a show/no-show logged before we trust rates. */
const COVERAGE_MIN = 0.4;
/** Below this coverage (with enough appts), treat as sparse CRM hygiene, not a real rate. */
const SPARSE_COVERAGE = 0.25;
const APPTS_VOLUME_MIN = 10; // appt volume needed for a show/no-show rate flag
const SHOWED_VOLUME_MIN = 10; // show volume needed for a sign-on rate flag
const LEADS_VOLUME_MIN = 10; // lead volume needed for a booking rate flag
/** Both sides of the 14d trend need enough appts or the drop is noise. */
const TREND_APPTS_MIN = 8;

const SHOW_RATE_RED = 20;
const SHOW_RATE_ORANGE = 30;
const SHOW_RATE_YELLOW = 40;
const CLOSE_RATE_RED = 15;
const CLOSE_RATE_YELLOW = 25;
const NO_SHOW_RATE_ORANGE = 40;
const BOOKING_RATE_YELLOW = 30;
const SHOW_RATE_DROP_PTS = 15; // 14d vs prior-14d drop in show rate (pp)

/**
 * Metrics fed to the flag logic. Counts are "On Totals" shaped (a later-stage
 * opportunity also counts in earlier stages), matching what the rollup view
 * hands the feed: `showed` already includes `closed`, and `totalAppts` is the
 * full booked pool. Rates are the pre-computed ratios from the same totals.
 */
export interface QualityMetrics {
  businessName: string | null;
  /** Booked-appointment pool over 30 days (requested + confirmed + showed + no-show + closed). */
  appts30d: number;
  /** Showed pool over 30 days (includes closed). */
  showed30d: number;
  noShow30d: number;
  closed30d: number;
  /** Lead pool over 30 days. */
  leads30d: number;
  /**
   * Rates are percentage points (0–100), matching the rollup view.
   * e.g. bookingRate30d = 45 means 45%.
   */
  bookingRate30d: number | null;
  showRate30d: number | null;
  closeRate30d: number | null;
  /** Show rate over the last 14 days and the 14 days before that, for the trend flag. */
  showRate14d: number | null;
  showRate14dPrev: number | null;
  /** Appt volume on each side of the 14d trend — gates the drop flag. */
  appts14d: number;
  appts14dPrev: number;
}

export interface QualityFlag {
  code: QualityCode;
  reason: string;
  /** 0 = red (most urgent), 1 = orange, 2 = yellow, 3 = data hygiene. */
  urgency: number;
}

function isNum(x: number | null | undefined): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/** R = 0, O = 1, Y = 2, DATA = 3. */
export function urgencyForQualityCode(code: QualityCode): number {
  if (code === "Q_DATA") return 3;
  const c = code.charAt(2);
  return c === "R" ? 0 : c === "O" ? 1 : 2;
}

function build(code: QualityCode): QualityFlag {
  return { code, reason: QUALITY_REASONS[code], urgency: urgencyForQualityCode(code) };
}

/**
 * Returns the quality flag for a campaign, or null when nothing fires. Priority
 * is first-match-wins (red → orange → yellow), matching the Quantity engine.
 *
 * The caller is expected to only pass active/included campaigns; paused or
 * needs-setup rows carry no real funnel signal.
 */
export function computeQualityFlag(m: QualityMetrics): QualityFlag | null {
  if (!m.businessName || !m.businessName.trim()) return null;

  const appts = m.appts30d;
  // Show + no-show is the proof the client logs outcomes at all (closed is a
  // subset of showed in On-Totals shape, so it can't stand in for tracking).
  const resolved = m.showed30d + m.noShow30d;
  const coverage = appts > 0 ? resolved / appts : 0;

  // Data hygiene: appointments are booking (automated) but almost nothing past
  // "Appt Confirmed" is logged. Account manager's cue to nudge the client —
  // kept separate from a real quality problem.
  if (
    (appts >= HYGIENE_APPTS_MIN && resolved === 0) ||
    (appts >= APPTS_VOLUME_MIN && coverage < SPARSE_COVERAGE)
  ) {
    return build("Q_DATA");
  }

  // Don't score real quality until the client is logging outcomes with enough
  // coverage. Sparse boards read as awful show rates and cry wolf.
  if (resolved < RESOLVED_MIN || coverage < COVERAGE_MIN) return null;

  const showRate = m.showRate30d;
  const closeRate = m.closeRate30d;
  // Match rollup scale (0–100 pp), not a 0–1 fraction.
  const noShowRate = appts > 0 ? (m.noShow30d / appts) * 100 : null;

  let code: QualityCode | null = null;
  // Red (most urgent first).
  if (isNum(showRate) && showRate < SHOW_RATE_RED && appts >= APPTS_VOLUME_MIN) {
    code = "Q_R1";
  } else if (
    isNum(closeRate) &&
    closeRate < CLOSE_RATE_RED &&
    m.showed30d >= SHOWED_VOLUME_MIN
  ) {
    code = "Q_R2";
  }
  // Orange.
  else if (
    isNum(noShowRate) &&
    noShowRate > NO_SHOW_RATE_ORANGE &&
    appts >= APPTS_VOLUME_MIN
  ) {
    code = "Q_O1";
  } else if (
    isNum(m.showRate14d) &&
    isNum(m.showRate14dPrev) &&
    m.showRate14dPrev - m.showRate14d >= SHOW_RATE_DROP_PTS &&
    m.appts14d >= TREND_APPTS_MIN &&
    m.appts14dPrev >= TREND_APPTS_MIN
  ) {
    code = "Q_O2";
  } else if (
    isNum(showRate) &&
    showRate < SHOW_RATE_ORANGE &&
    appts >= APPTS_VOLUME_MIN
  ) {
    code = "Q_O3";
  }
  // Yellow.
  else if (isNum(showRate) && showRate < SHOW_RATE_YELLOW && appts >= APPTS_VOLUME_MIN) {
    code = "Q_Y1";
  } else if (
    isNum(closeRate) &&
    closeRate < CLOSE_RATE_YELLOW &&
    m.showed30d >= SHOWED_VOLUME_MIN
  ) {
    code = "Q_Y2";
  } else if (
    isNum(m.bookingRate30d) &&
    m.bookingRate30d < BOOKING_RATE_YELLOW &&
    m.leads30d >= LEADS_VOLUME_MIN
  ) {
    code = "Q_Y3";
  } else {
    return null;
  }

  return build(code);
}
