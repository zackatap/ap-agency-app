/**
 * Generate content ideas from Granola meeting context + LLM (Gemini or Claude).
 */

import {
  fetchMeetingContext,
  fetchMeetingContextForMeetings,
  listGranolaMeetings,
  type GranolaMeetingOption,
} from "@/lib/granola-service";
import {
  filterUnprocessedMeetings,
  markMeetingsProcessed,
} from "@/lib/granola-sync-state";
import {
  appendContentIdeas,
  fetchExistingContentTitles,
  loadFullHookLibrary,
  type ContentIdeaRow,
} from "@/lib/content-ideas-sheet";
import { generateIdeasJson } from "@/lib/content-ideas-llm";

export type GenerateScope = "recent" | "all" | "selected" | "new";

export type GenerateOptions = {
  scope: GenerateScope;
  meetingIds?: string[];
  /** Max ideas cap. Omit for dynamic count (1–max based on meeting density). */
  count?: number;
  daysBack?: number;
  markProcessed?: boolean;
};

export type GeneratedIdea = ContentIdeaRow;

export type GenerateResult = {
  ideas: GeneratedIdea[];
  appended: number;
  meetingCount: number;
  skipped?: boolean;
  reason?: string;
};

function getMaxIdeas(): number {
  const raw = process.env.CONTENT_IDEAS_MAX;
  if (!raw) return 12;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 20) : 12;
}

function parseIdeasJson(raw: string): GeneratedIdea[] {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start < 0 || end <= start) {
    throw new Error("Model did not return a JSON array");
  }
  const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Expected JSON array of ideas");
  }
  return parsed.map((item) => {
    const row = item as Record<string, unknown>;
    const hooksRaw = row.hooks;
    const hooks = Array.isArray(hooksRaw)
      ? hooksRaw.map(String)
      : String(hooksRaw ?? "")
          .split("\n")
          .map((h) => h.replace(/^\d+\.\s*/, "").trim())
          .filter(Boolean);
    return {
      title: String(row.title ?? "").trim(),
      type: String(row.type ?? "One-time"),
      source: String(row.source ?? "").trim(),
      status: String(row.status ?? "Saved"),
      hooks,
    };
  });
}

function buildPrompt(options: {
  count?: number;
  maxCount: number;
  existingTitles: string[];
  hookLibrary: string;
  querySummary: string;
  meetings: { sourceLabel: string }[];
}): string {
  const { count, maxCount, existingTitles, hookLibrary, querySummary, meetings } =
    options;

  const countInstruction = count
    ? `Create exactly ${count} NEW content ideas.`
    : `Decide how many content ideas to create (0 to ${maxCount}) based on how much substantive marketing content is in these meetings:
- Quick call with one clear tactic → 1–2 ideas
- Typical huddle with a few topics → 3–5 ideas
- Jam-packed strategy session → up to ${maxCount} ideas
- Small talk only, nothing post-worthy → return an empty array []
Do NOT pad with weak ideas. Quality over quantity. Return only ideas with clear grounding in the meetings.`;

  return `You are a content strategist for Automated Practice, a digital marketing agency for health practice owners (especially chiropractors).

Using the meeting analysis below, ${countInstruction}

Rules:
- Each idea must be grounded in something actually discussed in the meetings.
- Titles: exactly 2 sentences that explain the content idea — what you'd teach and why it matters to a practice owner. Sentence 1 = the core idea or tactic. Sentence 2 = the payoff, context, or who it's for.
- Source: meeting attribution like "Weekly Huddle - All Team (Jun 2)" or "Sean Sheridan - Zoom (Jun 10)".
- Type: always "One-time".
- Status: always "Saved".
- Hooks: exactly 3 per idea. Use hook templates from the hook library — adapt them to the idea and avatar. Make them spoken-word ready.
- Do NOT duplicate or closely paraphrase existing titles.
- Focus on: patient growth, Meta ads, lead quality, systems, automations, GHL, ROI, creative testing, practice owner pain points.

Existing titles already in the sheet (avoid duplicates):
${existingTitles.slice(-40).map((t) => `- ${t}`).join("\n") || "(none yet)"}

Hook library (full — use as templates):
${hookLibrary}

Meeting analysis from Granola:
${querySummary.slice(0, 8000)}

Meetings in scope (${meetings.length}):
${meetings.map((m) => `- ${m.sourceLabel}`).join("\n") || "(none listed)"}

Return ONLY a JSON array of idea objects (or [] if nothing worth adding):
[
  {
    "title": "...",
    "type": "One-time",
    "source": "...",
    "status": "Saved",
    "hooks": ["hook 1", "hook 2", "hook 3"]
  }
]`;
}

async function resolveMeetings(
  options: GenerateOptions
): Promise<{ meetings: GranolaMeetingOption[]; skipped?: boolean; reason?: string }> {
  if (options.scope === "new") {
    const daysBack = options.daysBack ?? 14;
    const batchSize = Number(process.env.GRANOLA_SYNC_BATCH_SIZE) || 5;
    const listed = await listGranolaMeetings({ daysBack });
    const unprocessed = await filterUnprocessedMeetings(listed);
    if (unprocessed.length === 0) {
      return {
        meetings: [],
        skipped: true,
        reason: "No new meetings to process",
      };
    }
    return { meetings: unprocessed.slice(0, batchSize) };
  }

  const { meetings } = await fetchMeetingContext({
    scope: options.scope,
    meetingIds: options.meetingIds,
    daysBack: options.daysBack,
  });
  return { meetings };
}

export async function generateContentIdeas(
  options: GenerateOptions
): Promise<GenerateResult> {
  const maxCount = options.count ?? getMaxIdeas();
  const markProcessed =
    options.markProcessed ?? options.scope === "new";

  const resolved = await resolveMeetings(options);
  if (resolved.skipped || resolved.meetings.length === 0) {
    return {
      ideas: [],
      appended: 0,
      meetingCount: 0,
      skipped: true,
      reason: resolved.reason ?? "No meetings in scope",
    };
  }

  const meetings = resolved.meetings;
  const { querySummary } = await fetchMeetingContextForMeetings(meetings);

  const existingTitles = await fetchExistingContentTitles();
  const hookLibrary = loadFullHookLibrary();

  const prompt = buildPrompt({
    count: options.count,
    maxCount,
    existingTitles,
    hookLibrary,
    querySummary,
    meetings,
  });

  const raw = await generateIdeasJson(prompt);
  const ideas = parseIdeasJson(raw).filter(
    (idea) => idea.title && idea.source && idea.hooks.length >= 2
  );

  const capped = options.count
    ? ideas.slice(0, options.count)
    : ideas.slice(0, maxCount);

  let appended = 0;
  if (capped.length > 0) {
    ({ appended } = await appendContentIdeas(capped));
  }

  if (markProcessed) {
    await markMeetingsProcessed(
      meetings.map((m) => m.id),
      appended
    );
  }

  return {
    ideas: capped,
    appended,
    meetingCount: meetings.length,
  };
}

/** Cron / auto-sync entry point — new meetings only, dynamic count. */
export async function processNewGranolaMeetings(): Promise<GenerateResult> {
  return generateContentIdeas({
    scope: "new",
    daysBack: 14,
    markProcessed: true,
  });
}
