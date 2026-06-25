/**
 * Tolerant JSON array extraction from LLM responses (truncation, bad escapes, trailing commas).
 */

import { jsonrepair } from "jsonrepair";

function stripCodeFence(raw: string): string {
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  }
  return text.trim();
}

function extractArraySlice(raw: string): string {
  const trimmed = stripCodeFence(raw);
  const start = trimmed.indexOf("[");
  if (start < 0) {
    throw new Error("Model did not return a JSON array");
  }
  const end = trimmed.lastIndexOf("]");
  if (end > start) {
    return trimmed.slice(start, end + 1);
  }
  return trimmed.slice(start);
}

function removeTrailingCommas(json: string): string {
  return json.replace(/,\s*([}\]])/g, "$1");
}

/** Pull complete top-level objects out of a broken/truncated array. */
function salvageCompleteObjects(slice: string): unknown[] {
  const inner = slice.startsWith("[") ? slice.slice(1) : slice;
  const objects: unknown[] = [];
  let depth = 0;
  let objStart = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === "\\") {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }

    if (c === '"') {
      inString = true;
      continue;
    }

    if (c === "{") {
      if (depth === 0) objStart = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && objStart >= 0) {
        const chunk = removeTrailingCommas(inner.slice(objStart, i + 1));
        try {
          objects.push(JSON.parse(chunk));
        } catch {
          try {
            objects.push(JSON.parse(jsonrepair(chunk)));
          } catch {
            /* skip malformed object */
          }
        }
        objStart = -1;
      }
    }
  }

  return objects;
}

function parseArrayJson(slice: string): unknown[] {
  const attempts = [
    () => JSON.parse(slice),
    () => JSON.parse(removeTrailingCommas(slice)),
    () => JSON.parse(jsonrepair(slice)),
  ];

  for (const attempt of attempts) {
    try {
      const parsed = attempt();
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* try next */
    }
  }

  const salvaged = salvageCompleteObjects(slice);
  if (salvaged.length > 0) {
    console.warn(
      `[llm-json] Salvaged ${salvaged.length} object(s) from truncated/invalid JSON`
    );
    return salvaged;
  }

  throw new Error(
    "Model returned invalid JSON. Try again — if it keeps failing, use fewer meetings at once."
  );
}

export function parseJsonArrayFromLlm(raw: string): unknown[] {
  const slice = extractArraySlice(raw);
  return parseArrayJson(slice);
}
