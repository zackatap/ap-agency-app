/**
 * Shared Zapier / ClickUp attention row shape. Used by
 * GET /api/integrations/attention and the Catch Hook one-off payload so both
 * bulk and single-task flows expose the same fields under `rows`.
 */

export type ZapierAttentionItem = {
  reason: string;
  client: string;
  pipeline: string;
  status: string;
  urgency: number | null;
  client_relationship_id: string;
};

export function toZapierAttentionItem(
  r: Record<string, unknown>
): ZapierAttentionItem {
  const perfReason = String(r.reason ?? "").trim();
  const dataReason = String(r.data_reason ?? "").trim();
  const qualityReason = String(r.quality_reason ?? "").trim();
  const perfCode = String(r.attention_code ?? "-");
  const dataCode = String(r.data_code ?? "-");
  const qualityCode = String(r.quality_code ?? "-");

  // Prefer Ads performance fields (bulk zap). Fall back so a one-off on a
  // Data/Appts-only (or clean) row still carries a usable reason + status.
  const reason =
    perfReason ||
    dataReason ||
    qualityReason ||
    "Manual one-off attention task";
  const status =
    perfCode !== "-" ? perfCode : dataCode !== "-" ? dataCode : qualityCode;
  const urgency =
    typeof r.urgency === "number"
      ? r.urgency
      : typeof r.data_urgency === "number"
        ? r.data_urgency
        : typeof r.quality_urgency === "number"
          ? r.quality_urgency
          : null;

  return {
    reason,
    client: String(r.client_name ?? ""),
    pipeline: String(r.pipeline_name ?? ""),
    status: status === "-" ? "" : status,
    urgency,
    client_relationship_id: String(r.clickup_relation_id ?? ""),
  };
}
