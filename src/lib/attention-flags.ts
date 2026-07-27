/**
 * Replicates the agency's "Attention Dashboard" flag logic that used to live in
 * the KpiDynamic sheet (column CI) plus the AD_VLOOKUP reason map.
 *
 * Two parallel signals per campaign:
 *   1. Performance (R/O/Y) — CPL, spend, CRM lead volume. GHL/CRM is the
 *      source of truth for lead counts and CPL (ad spend still comes from Meta).
 *   2. Data (urgency 3) — Meta vs CRM lead discrepancy ≥ 15%. Surfaced as a
 *      Data badge alongside any performance flag, not instead of one.
 *
 * The original sheet was a 15-deep nested IF (first match wins) for a single
 * code. Codes encode severity in the middle letter: R = red (0), O = orange
 * (1), Y = yellow (2). Data codes use D and always map to urgency 3.
 *
 * Number guards matter: the sheet bails to "-" (no flag) when the 14d/7d/3d CPL
 * deltas aren't numbers. CPL = spend / CRM leads.
 */

/** Performance flags (media buyer). Lead-mismatch codes live in {@link LeadDataCode}. */
export type AttentionCode =
  | "S_R4"
  | "S_R3"
  | "S_R2"
  | "S_R1"
  | "S_O4"
  | "S_O3"
  | "S_O2"
  | "S_O1"
  | "S_Y3"
  | "S_Y2"
  | "S_Y5"
  | "S_Y1";

/** Meta↔CRM sync flags — always urgency 3 (Data), never R/O/Y. */
export type LeadDataCode = "S_D1" | "S_D2";

/**
 * Code → human reason sentence. S_R1..S_Y5 are verbatim from the original sheet.
 * S_D1 / S_D2 reasons are built dynamically in {@link computeLeadDataFlag}.
 */
export const ATTENTION_REASONS: Record<AttentionCode, string> = {
  S_R1: "No Leads in 7 days.",
  S_R2: "No Leads in 3 days + CPL risen $20+ in last 7 days",
  S_R3: "No Leads in 3 days + CPL risen $35+ in last 14 days",
  S_R4: "CPL > $80 in last 7 days",
  S_O1: "No Leads in 3 days + CPL risen $10+ in last 7 days",
  S_O2: "CPL risen $35+ in last 7 days.",
  S_O3: "CPL is over $65 and is not Neuropathy",
  S_O4: "Ad spend is $0 in last 3 days",
  S_Y1: "No Leads in 3 days.",
  S_Y2: "CPL risen $20+ in last 3 days.",
  S_Y3: "CPL (cost per lead) has increased in 20% in last 30 days",
  S_Y5: "Ad spend > $2,000 in last 30 days.",
};

/** Fallback copy; live reasons include the CRM/Meta counts. */
export const LEAD_DATA_REASONS: Record<LeadDataCode, string> = {
  S_D1: "Meta leads exceed CRM by 15% or more — paid leads may not be reaching the CRM.",
  S_D2: "CRM leads exceed Meta by 15% or more — Meta may be under-counting.",
};

/** Relative gap vs CRM (SoT). Flag when this or higher. */
const LEAD_GAP_PCT = 0.15;
/** Ignore tiny volumes (e.g. 1 vs 0) — need a real signal on at least one side. */
const LEAD_GAP_MIN_VOLUME = 3;

export interface AttentionMetrics {
  businessName: string | null;
  /** Meta campaign name — the Neuropathy exclusion checks this. */
  campaignName: string | null;
  /** GHL/CRM pipeline leads (source of truth for performance flags). */
  crmLeads3d: number;
  crmLeads7d: number;
  crmLeads30d: number;
  /** Meta-attributed leads — used only for Meta↔CRM Data flags. */
  metaLeads7d: number;
  metaLeads30d: number;
  /** CPL = Meta spend / CRM leads. */
  cpl7d: number | null;
  cpl30d: number | null;
  cpl30dPrev: number | null;
  /** CPL dollar deltas (current minus prior period) per window. */
  cplDelta14d: number | null;
  cplDelta7d: number | null;
  cplDelta3d: number | null;
  adSpend3d: number;
  adSpend30d: number;
}

export interface AttentionFlag {
  code: AttentionCode | LeadDataCode;
  reason: string;
  /** 0 = red, 1 = orange, 2 = yellow, 3 = data hygiene. */
  urgency: number;
}

function isNum(x: number | null | undefined): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/** R = 0, O = 1, Y = 2 — taken from the code's middle letter, as the sheet did. */
export function urgencyForCode(code: AttentionCode): number {
  const c = code.charAt(2);
  return c === "R" ? 0 : c === "O" ? 1 : 2;
}

/**
 * Relative lead gap vs CRM (source of truth). Returns null when there's no
 * signal (both zero, or volume too thin). One-sided zeros count as 100%.
 */
export function leadCountGapPct(crm: number, meta: number): number | null {
  if (crm === 0 && meta === 0) return null;
  if (Math.max(crm, meta) < LEAD_GAP_MIN_VOLUME) return null;
  if (crm === 0) return 1;
  return Math.abs(meta - crm) / crm;
}

/**
 * Meta vs CRM lead discrepancy (15% or more). Independent of performance flags
 * so a sync/attribution gap never hides a real CPL / lead-volume problem.
 */
export function computeLeadDataFlag(m: AttentionMetrics): AttentionFlag | null {
  if (!m.businessName || !m.businessName.trim()) return null;

  // Prefer the window with the larger gap (7d catches fresh breaks; 30d matches
  // what the KPI chip often shows on accounts like CRM 18 · Meta 0).
  const candidates: Array<{ crm: number; meta: number; gap: number }> = [];
  for (const [crm, meta] of [
    [m.crmLeads7d, m.metaLeads7d],
    [m.crmLeads30d, m.metaLeads30d],
  ] as const) {
    const gap = leadCountGapPct(crm, meta);
    if (gap != null && gap >= LEAD_GAP_PCT) {
      candidates.push({ crm, meta, gap });
    }
  }
  if (candidates.length === 0) return null;

  // Larger gap wins; on a tie prefer the bigger volume (usually 30d).
  candidates.sort(
    (a, b) =>
      b.gap - a.gap ||
      Math.max(b.crm, b.meta) - Math.max(a.crm, a.meta)
  );
  const { crm, meta } = candidates[0];
  const code: LeadDataCode = meta > crm ? "S_D1" : "S_D2";
  const reason =
    code === "S_D1"
      ? `Meta leads (${meta}) exceed CRM (${crm}) by 15% or more — paid leads may not be reaching the CRM.`
      : `CRM leads (${crm}) exceed Meta (${meta}) by 15% or more — Meta may be under-counting.`;

  return { code, reason, urgency: 3 };
}

/**
 * Returns the performance attention flag for a campaign, or null when nothing
 * fires (the sheet's "-"). Priority order matches the sheet's nested IF (first
 * match wins). Lead-mismatch / sync gaps are handled separately by
 * {@link computeLeadDataFlag}.
 *
 * Lead counts and CPL use GHL/CRM as the source of truth (spend stays Meta).
 * The lead-count and pure-spend rules (S_R1, S_Y1, S_Y5) fire off their own
 * raw numbers rather than sitting behind the CPL-delta ISNUMBER guards — a
 * zero-lead campaign has an undefined CPL, so gating those rules on a CPL
 * delta made them unreachable (the sheet's old blind spot). The CPL-trend
 * rules still self-guard via {@link isNum}. The caller is expected to only
 * flag active campaigns (the feed gates on `included`).
 */
export function computeAttentionFlag(m: AttentionMetrics): AttentionFlag | null {
  if (!m.businessName || !m.businessName.trim()) return null;

  const neuropathy = (m.campaignName ?? "").toLowerCase().includes("neuropathy");
  const d14 = m.cplDelta14d;
  const d7 = m.cplDelta7d;
  const d3 = m.cplDelta3d;

  let code: AttentionCode | null = null;
  // Red (most urgent first). CRM lead counts.
  if (isNum(m.cpl7d) && m.cpl7d > 80) code = "S_R4";
  else if (m.crmLeads3d === 0 && isNum(d14) && d14 > 35) code = "S_R3";
  else if (m.crmLeads3d === 0 && isNum(d7) && d7 > 20) code = "S_R2";
  else if (m.crmLeads7d === 0) code = "S_R1";
  // Orange.
  else if (m.adSpend3d === 0) code = "S_O4";
  else if (isNum(m.cpl30d) && m.cpl30d > 65 && !neuropathy) code = "S_O3";
  else if (isNum(d7) && d7 > 35) code = "S_O2";
  else if (m.crmLeads3d === 0 && isNum(d7) && d7 > 10) code = "S_O1";
  // Yellow.
  else {
    const pctUp =
      isNum(m.cpl30d) && isNum(m.cpl30dPrev) && m.cpl30dPrev !== 0
        ? (m.cpl30d - m.cpl30dPrev) / m.cpl30dPrev
        : -1;
    if (pctUp > 0.2) code = "S_Y3";
    else if (isNum(d3) && d3 > 20) code = "S_Y2";
    else if (m.adSpend30d > 2000) code = "S_Y5";
    else if (m.crmLeads3d === 0) code = "S_Y1";
    else return null;
  }

  return { code, reason: ATTENTION_REASONS[code], urgency: urgencyForCode(code) };
}
