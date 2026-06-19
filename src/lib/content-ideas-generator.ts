/**
 * Generate content ideas from Granola meeting context + LLM (Gemini or Claude).
 */

import { fetchMeetingContext } from "@/lib/granola-service";
import {
  appendContentIdeas,
  fetchExistingContentTitles,
  loadHookLibrary,
  type ContentIdeaRow,
} from "@/lib/content-ideas-sheet";
import { generateIdeasJson } from "@/lib/content-ideas-llm";

export type GenerateScope = "recent" | "all" | "selected";

export type GenerateOptions = {
  scope: GenerateScope;
  meetingIds?: string[];
  count?: number;
  daysBack?: number;
};

export type GeneratedIdea = ContentIdeaRow;

export type GenerateResult = {
  ideas: GeneratedIdea[];
  appended: number;
  meetingCount: number;
};

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
  count: number;
  existingTitles: string[];
  hookLibrary: string;
  querySummary: string;
  meetings: { sourceLabel: string }[];
}): string {
  const { count, existingTitles, hookLibrary, querySummary, meetings } =
    options;

  return `You are a content strategist for Automated Practice, a digital marketing agency for health practice owners (especially chiropractors).

Using the meeting analysis below, create exactly ${count} NEW content ideas for short-form video or social posts.

Rules:
- Each idea must be grounded in something actually discussed in the meetings.
- Titles: exactly 2 sentences that explain the content idea — what you'd teach and why it matters to a practice owner. Not a clickbait headline. Sentence 1 = the core idea or tactic. Sentence 2 = the payoff, context, or who it's for. Example: "Raw iPhone footage often outperforms polished video ads for chiropractic practices because it feels authentic to patients scrolling Meta. We saw this across multiple accounts where UGC-style creatives beat studio shoots on cost per booked appointment."
- Source: meeting attribution like "Weekly Huddle - All Team (Jun 2)" or "Sean Sheridan - Zoom (Jun 10)".
- Type: always "One-time".
- Status: always "Saved".
- Hooks: exactly 3 per idea. Use hook templates from the hook library — adapt them to the idea and avatar. Make them spoken-word ready.
- Do NOT duplicate or closely paraphrase existing titles.
- Focus on: patient growth, Meta ads, lead quality, systems, automations, GHL, ROI, creative testing, practice owner pain points.

Existing titles already in the sheet (avoid duplicates):
${existingTitles.slice(-40).map((t) => `- ${t}`).join("\n") || "(none yet)"}

Hook library (use as templates):
${hookLibrary}

Meeting analysis from Granola:
${querySummary.slice(0, 6000)}

Meetings in scope (${meetings.length}):
${meetings.map((m) => `- ${m.sourceLabel}`).join("\n") || "(none listed)"}

Return ONLY a JSON array with ${count} objects:
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

export async function generateContentIdeas(
  options: GenerateOptions
): Promise<GenerateResult> {
  const count = options.count ?? 5;
  const { meetings, querySummary } = await fetchMeetingContext({
    scope: options.scope,
    meetingIds: options.meetingIds,
    daysBack: options.daysBack,
  });

  const existingTitles = await fetchExistingContentTitles();
  const hookLibrary = loadHookLibrary();

  const prompt = buildPrompt({
    count,
    existingTitles,
    hookLibrary,
    querySummary,
    meetings,
  });

  const raw = await generateIdeasJson(prompt);
  const ideas = parseIdeasJson(raw).filter(
    (idea) => idea.title && idea.source && idea.hooks.length >= 2
  );

  if (ideas.length === 0) {
    throw new Error("No valid ideas generated");
  }

  const { appended } = await appendContentIdeas(ideas.slice(0, count));

  return {
    ideas: ideas.slice(0, count),
    appended,
    meetingCount: meetings.length,
  };
}
