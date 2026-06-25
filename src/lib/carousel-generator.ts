/**
 * Break a transcript / video ad into a slide-by-slide carousel framework.
 * Each slide is a free-form block of copy that may use **bold** and "- " bullets.
 */

import { SchemaType, type ResponseSchema } from "@google/generative-ai";
import { generateIdeasJson } from "@/lib/content-ideas-llm";
import { parseJsonArrayFromLlm } from "@/lib/llm-json";

export type GenerateCarouselOptions = {
  transcript: string;
  /** Optional custom instructions; falls back to the default framework prompt. */
  instructions?: string;
  /** Minimum number of slides to produce. Defaults to 5. */
  minSlides?: number;
};

export const DEFAULT_CAROUSEL_INSTRUCTIONS = `Analyze this video ad. Break down the core marketing message into a minimum 5-slide carousel framework (1. Hook, 2. Problem Agitation, 3. Solution/Mechanism (this can be multiple slides if needed), 4. Social Proof, 5. CTA). Write punchy, concise copy for each slide.`;

const CAROUSEL_RESPONSE_SCHEMA: ResponseSchema = {
  type: SchemaType.ARRAY,
  items: { type: SchemaType.STRING },
};

export async function generateCarouselFromTranscript(
  options: GenerateCarouselOptions
): Promise<string[]> {
  const transcript = options.transcript.trim();
  if (!transcript) {
    throw new Error("Transcript is required");
  }

  const minSlides = Math.min(Math.max(options.minSlides ?? 5, 3), 12);
  const instructions =
    options.instructions?.trim() || DEFAULT_CAROUSEL_INSTRUCTIONS;

  const prompt = `You are a direct-response copywriter for Automated Practice, a marketing agency serving health practice owners.

${instructions}

Each slide becomes its own square-ish carousel image, so keep the copy short and skimmable. The first slide is the scroll-stopping hook.

Vary the slide structure. Do NOT force every slide into "headline + bullets". Some slides are a single punchy line. Some are two short sentences. Use a bullet list only when a list genuinely makes the slide land harder.

Formatting for each slide (plain text with light markdown):
- Use "**bold**" to emphasize a key phrase or number. Use it sparingly, mostly on the most important words.
- Use lines starting with "- " for bullets, only when listing.
- Use blank lines to separate a headline from supporting copy.
- No hashtags. No emojis. No slide numbers or labels inside the copy. No surrounding quotes.

Write in a confident, plain-spoken voice. Short sentences. Vary the rhythm.

Produce at least ${minSlides} slides.

Transcript:
"""
${transcript}
"""

Return ONLY a JSON array of strings, where each string is the full copy for one slide:
["slide one copy", "slide two copy", ...]`;

  const raw = await generateIdeasJson(prompt, {
    responseSchema: CAROUSEL_RESPONSE_SCHEMA,
    maxOutputTokens: 4096,
  });

  const slides = parseJsonArrayFromLlm(raw)
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);

  if (slides.length === 0) {
    throw new Error("No slides generated");
  }

  return slides;
}
