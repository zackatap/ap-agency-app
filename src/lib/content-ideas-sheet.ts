/**
 * Content ideas Google Sheet — read titles, append rows.
 */

import { google } from "googleapis";
import { readFileSync } from "fs";
import { join } from "path";

const DEFAULT_SHEET_ID = "1UfAuVJgqa1BsWZfpAPYLACVP9WoB6eyX2Z1q0_Zx9fE";
const DEFAULT_SHEET_GID = 0;

export type ContentIdeaRow = {
  title: string;
  type?: string;
  source: string;
  status?: string;
  hooks: string[] | string;
};

function getSheetId() {
  return process.env.GRANOLA_SHEET_ID?.trim() || DEFAULT_SHEET_ID;
}

function getSheetGid() {
  const raw = process.env.GRANOLA_SHEET_GID;
  if (raw == null || raw === "") return DEFAULT_SHEET_GID;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_SHEET_GID;
}

function getAuth() {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!json) return null;
  try {
    const credentials = JSON.parse(json);
    return new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
  } catch {
    return null;
  }
}

function normalizeHeader(h: string): string {
  const raw = String(h ?? "").trim().toLowerCase();
  if (raw === "#") return "id";
  return raw.replace(/[\s_\-./]+/g, "");
}

function colIndexToLetter(i: number): string {
  let s = "";
  do {
    s = String.fromCharCode(65 + (i % 26)) + s;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return s;
}

function quoteSheetRef(name: string): string {
  return name.includes(" ") || name.includes("'")
    ? `'${name.replace(/'/g, "''")}'`
    : name;
}

function formatHooks(hooks: string[] | string): string {
  if (typeof hooks === "string") return hooks;
  return hooks
    .filter(Boolean)
    .map((h, i) => `${i + 1}. ${String(h).replace(/^\d+\.\s*/, "")}`)
    .join("\n");
}

function buildFieldValues(record: ContentIdeaRow) {
  return {
    title: record.title ?? "",
    type: record.type ?? "One-time",
    source: record.source ?? "",
    status: record.status ?? "Saved",
    hooks: formatHooks(record.hooks),
  };
}

async function getSheetTitleByGid(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  gid: number
): Promise<string> {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties.title,sheets.properties.sheetId",
  });
  const tab = meta.data.sheets?.find(
    (s) => (s.properties?.sheetId ?? 0) === gid
  );
  return tab?.properties?.title ?? "Sheet1";
}

async function getSheetContext() {
  const auth = getAuth();
  if (!auth) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not configured");
  }
  const spreadsheetId = getSheetId();
  const gid = getSheetGid();
  const sheets = google.sheets({ version: "v4", auth });
  const title = await getSheetTitleByGid(sheets, spreadsheetId, gid);
  const sheetRef = quoteSheetRef(title);
  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetRef}!1:1`,
  });
  const headerRow = (headerRes.data.values?.[0] ?? []) as string[];
  if (headerRow.length === 0) {
    throw new Error("Sheet has no header row");
  }
  return { sheets, spreadsheetId, sheetRef, headerRow };
}

export async function fetchExistingContentTitles(): Promise<string[]> {
  const { sheets, spreadsheetId, sheetRef, headerRow } =
    await getSheetContext();
  const titleCol = headerRow.findIndex((h) => normalizeHeader(h) === "title");
  if (titleCol < 0) return [];
  const letter = colIndexToLetter(titleCol);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetRef}!${letter}2:${letter}`,
    majorDimension: "COLUMNS",
  });
  const col = (res.data.values?.[0] ?? []) as string[];
  return col.map((v) => String(v).trim()).filter(Boolean);
}

export async function appendContentIdeas(
  records: ContentIdeaRow[]
): Promise<{ appended: number }> {
  if (records.length === 0) return { appended: 0 };

  const { sheets, spreadsheetId, sheetRef, headerRow } =
    await getSheetContext();

  const idColumnIndex = headerRow.findIndex((h) => normalizeHeader(h) === "id");
  let nextId: number | null = null;
  if (idColumnIndex >= 0) {
    const letter = colIndexToLetter(idColumnIndex);
    const idRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetRef}!${letter}2:${letter}`,
      majorDimension: "COLUMNS",
    });
    const col = (idRes.data.values?.[0] ?? []) as string[];
    let max = 0;
    for (const v of col) {
      const n = Number(v);
      if (Number.isFinite(n) && n > max) max = n;
    }
    nextId = max + 1;
  }

  const rows = records.map((record) => {
    const fieldValues = buildFieldValues(record);
    const row = headerRow.map((h) => {
      const key = normalizeHeader(h);
      if (key === "id") return nextId ?? "";
      return fieldValues[key as keyof typeof fieldValues] ?? "";
    });
    if (nextId != null) nextId += 1;
    return row;
  });

  const lastCol = colIndexToLetter(headerRow.length - 1);
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetRef}!A:${lastCol}`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
  });

  return { appended: rows.length };
}

export function getContentIdeasSheetUrl(): string {
  const id = getSheetId();
  const gid = getSheetGid();
  return `https://docs.google.com/spreadsheets/d/${id}/edit#gid=${gid}`;
}

export function loadHookLibrary(): string {
  const compact = join(process.cwd(), "content", "hook-library-compact.md");
  const full = join(process.cwd(), "content", "hook-library.md");
  try {
    return readFileSync(compact, "utf8");
  } catch {
    try {
      const text = readFileSync(full, "utf8");
      // Fallback: first ~3500 chars covers swipe file only
      return text.slice(0, 3500);
    } catch {
      return "";
    }
  }
}
