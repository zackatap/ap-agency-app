/**
 * Replicates the agency's "Attention Dashboard" flag logic that used to live in
 * the KpiDynamic sheet (column CI) plus the AD_VLOOKUP reason map.
 *
 * The original was a 15-deep nested IF evaluated top-to-bottom (first match
 * wins). Codes encode severity in the middle letter: R = red (0), O = orange
 * (1), Y = yellow (2), which is exactly how the sheet's Urgency column derived
 * its value: SWITCH(MID(code, 3, 1), "R",0, "O",1, "Y",2).
 *
 * Number guards matter: the sheet bails to "-" (no flag) when the 14d/7d/3d CPL
 * deltas aren't numbers. In the sheet CPL = spend/leads, so it's a numeric $0
 * (not blank) when spend is $0 but leads exist — which is why the feed builds
 * these metrics with a sheet-faithful CPL (see `sheetCpl` in attention-feed).
 * Otherwise a paused campaign's null CPL would short-circuit the guards and the
 * "$0 ad spend in 3 days" (S_O4) flag could never fire.
 */

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

/** AD_VLOOKUP: code → human reason sentence (verbatim from the sheet). */
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

export interface AttentionMetrics {
  businessName: string | null;
  /** Meta campaign name — the Neuropathy exclusion checks this. */
  campaignName: string | null;
  leads3d: number;
  leads7d: number;
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
  code: AttentionCode;
  reason: string;
  /** 0 = red (most urgent), 1 = orange, 2 = yellow. */
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
 * Returns the attention flag for a campaign, or null when nothing fires (the
 * sheet's "-"). Priority order matches the sheet's nested IF (first match wins).
 *
 * Unlike the literal sheet, the lead-count and pure-spend rules (S_R1, S_Y1,
 * S_Y5) fire off their own raw numbers rather than sitting behind the CPL-delta
 * ISNUMBER guards — a zero-lead campaign has an undefined CPL, so gating those
 * rules on a CPL delta made them unreachable (the sheet's old blind spot). The
 * CPL-trend rules still self-guard via {@link isNum}, so they only fire when
 * their delta is real. The caller is expected to only flag active campaigns
 * (the feed gates on `included`) so paused/needs-setup rows don't alert.
 */
export function computeAttentionFlag(m: AttentionMetrics): AttentionFlag | null {
  if (!m.businessName || !m.businessName.trim()) return null;

  const neuropathy = (m.campaignName ?? "").toLowerCase().includes("neuropathy");
  const d14 = m.cplDelta14d;
  const d7 = m.cplDelta7d;
  const d3 = m.cplDelta3d;

  let code: AttentionCode | null = null;
  // Red (most urgent first).
  if (isNum(m.cpl7d) && m.cpl7d > 80) code = "S_R4";
  else if (m.leads3d === 0 && isNum(d14) && d14 > 35) code = "S_R3";
  else if (m.leads3d === 0 && isNum(d7) && d7 > 20) code = "S_R2";
  else if (m.leads7d === 0) code = "S_R1";
  // Orange.
  else if (m.adSpend3d === 0) code = "S_O4";
  else if (isNum(m.cpl30d) && m.cpl30d > 65 && !neuropathy) code = "S_O3";
  else if (isNum(d7) && d7 > 35) code = "S_O2";
  else if (m.leads3d === 0 && isNum(d7) && d7 > 10) code = "S_O1";
  // Yellow.
  else {
    const pctUp =
      isNum(m.cpl30d) && isNum(m.cpl30dPrev) && m.cpl30dPrev !== 0
        ? (m.cpl30d - m.cpl30dPrev) / m.cpl30dPrev
        : -1;
    if (pctUp > 0.2) code = "S_Y3";
    else if (isNum(d3) && d3 > 20) code = "S_Y2";
    else if (m.adSpend30d > 2000) code = "S_Y5";
    else if (m.leads3d === 0) code = "S_Y1";
    else return null;
  }

  return { code, reason: ATTENTION_REASONS[code], urgency: urgencyForCode(code) };
}
