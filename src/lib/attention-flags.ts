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
 * deltas aren't numbers. Our `cpl` is null when leads or spend is 0, so a null
 * delta reproduces that ISNUMBER short-circuit faithfully.
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
 * sheet's "-"). Order mirrors the nested IF exactly.
 */
export function computeAttentionFlag(m: AttentionMetrics): AttentionFlag | null {
  if (!m.businessName || !m.businessName.trim()) return null;
  // ISNUMBER(CK) / ISNUMBER(CL) guards: 14d and 7d CPL deltas must be real.
  if (!isNum(m.cplDelta14d)) return null;
  if (!isNum(m.cplDelta7d)) return null;

  const neuropathy = (m.campaignName ?? "").toLowerCase().includes("neuropathy");

  let code: AttentionCode | null = null;
  if (isNum(m.cpl7d) && m.cpl7d > 80) code = "S_R4";
  else if (m.leads3d === 0 && m.cplDelta14d > 35) code = "S_R3";
  else if (m.leads3d === 0 && m.cplDelta7d > 20) code = "S_R2";
  else if (m.leads7d === 0) code = "S_R1";
  else if (m.adSpend3d === 0) code = "S_O4";
  else if (isNum(m.cpl30d) && m.cpl30d > 65 && !neuropathy) code = "S_O3";
  else if (m.cplDelta7d > 35) code = "S_O2";
  else if (m.leads3d === 0 && m.cplDelta7d > 10) code = "S_O1";
  else {
    // ISNUMBER(CM) guard before the yellow tier.
    if (!isNum(m.cplDelta3d)) return null;
    const pctUp =
      isNum(m.cpl30d) && isNum(m.cpl30dPrev) && m.cpl30dPrev !== 0
        ? (m.cpl30d - m.cpl30dPrev) / m.cpl30dPrev
        : -1;
    if (pctUp > 0.2) code = "S_Y3";
    else if (m.cplDelta3d > 20) code = "S_Y2";
    else if (m.adSpend30d > 2000) code = "S_Y5";
    else if (m.leads3d === 0) code = "S_Y1";
    else return null;
  }

  return { code, reason: ATTENTION_REASONS[code], urgency: urgencyForCode(code) };
}
