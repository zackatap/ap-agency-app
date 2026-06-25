/**
 * Generate social hooks for a topic using the full hook library.
 */

import { loadFullHookLibrary } from "@/lib/content-ideas-sheet";
import { generateIdeasJson } from "@/lib/content-ideas-llm";

export type GenerateHooksOptions = {
  topic: string;
  count?: number;
};

function parseHooksJson(raw: string): string[] {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start < 0 || end <= start) {
    throw new Error("Model did not return a JSON array");
  }
  const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Expected JSON array of hooks");
  }
  return parsed
    .map((item) => String(item).trim())
    .filter(Boolean);
}

export async function generateHooksForTopic(
  options: GenerateHooksOptions
): Promise<string[]> {
  const topic = options.topic.trim();
  if (!topic) {
    throw new Error("Topic is required");
  }

  const count = Math.min(Math.max(options.count ?? 10, 3), 20);
  const hookLibrary = loadFullHookLibrary();

  const prompt = `You write scroll-stopping social media hooks for Automated Practice, a digital marketing agency serving health practice owners (especially chiropractors).

Topic: "${topic}"

Using the hook templates in the library below, write exactly ${count} unique hooks tailored to this topic and avatar. Each hook should be ready to read aloud on camera or paste as ad copy — one or two sentences max per hook.

Rules:
- Adapt template patterns from the library; don't copy them verbatim without filling in the topic.
- Mix styles: contrarian, how-to, story, question, "most people don't know…", etc.
- Speak to practice owners: patients, Meta ads, lead quality, systems, ROI, automations.
- No hashtags. No emojis unless essential.
- Every hook must clearly relate to the topic.

Hook library:
${hookLibrary}

Return ONLY a JSON array of ${count} strings:
["hook one", "hook two", ...]`;

  const raw = await generateIdeasJson(prompt);
  const hooks = parseHooksJson(raw);

  if (hooks.length === 0) {
    throw new Error("No hooks generated");
  }

  return hooks.slice(0, count);
}
