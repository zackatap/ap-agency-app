/**
 * Decode GHL access token JWT payload for diagnostics only (no verification).
 */
export function decodeGhlJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = parts[1];
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "="
    );
    const json = Buffer.from(padded, "base64").toString("utf-8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Safe primitives only — for debug endpoints. */
export function summarizeGhlJwtForDebug(token: string): {
  keys: string[];
  primitives: Record<string, string | number | boolean>;
} | null {
  const payload = decodeGhlJwtPayload(token);
  if (!payload) return null;
  const primitives: Record<string, string | number | boolean> = {};
  for (const key of Object.keys(payload).sort()) {
    const v = payload[key];
    if (typeof v === "string") {
      primitives[key] = v.length > 120 ? `${v.slice(0, 120)}…` : v;
    } else if (typeof v === "number" || typeof v === "boolean") {
      primitives[key] = v;
    }
  }
  return { keys: Object.keys(payload).sort(), primitives };
}
