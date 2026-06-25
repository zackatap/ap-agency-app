/**
 * LLM helper for content idea generation.
 * Uses Gemini if GEMINI_API_KEY is set, otherwise Anthropic.
 */

import { SchemaType, type ResponseSchema } from "@google/generative-ai";

export type LlmProvider = "gemini" | "anthropic";

export type GenerateJsonOptions = {
  maxOutputTokens?: number;
  responseSchema?: ResponseSchema;
};

export function resolveContentIdeasProvider(): LlmProvider {
  const explicit = process.env.CONTENT_IDEAS_LLM?.trim().toLowerCase();
  if (explicit === "gemini" || explicit === "anthropic") {
    return explicit;
  }
  if (process.env.GEMINI_API_KEY?.trim()) return "gemini";
  if (process.env.ANTHROPIC_API_KEY?.trim()) return "anthropic";
  throw new Error(
    "No LLM configured. Set GEMINI_API_KEY or ANTHROPIC_API_KEY (or CONTENT_IDEAS_LLM)."
  );
}

export const CONTENT_IDEA_RESPONSE_SCHEMA: ResponseSchema = {
  type: SchemaType.ARRAY,
  items: {
    type: SchemaType.OBJECT,
    properties: {
      title: { type: SchemaType.STRING },
      type: { type: SchemaType.STRING },
      source: { type: SchemaType.STRING },
      status: { type: SchemaType.STRING },
      hooks: {
        type: SchemaType.ARRAY,
        items: { type: SchemaType.STRING },
      },
    },
    required: ["title", "type", "source", "status", "hooks"],
  },
};

export const HOOKS_RESPONSE_SCHEMA: ResponseSchema = {
  type: SchemaType.ARRAY,
  items: { type: SchemaType.STRING },
};

export async function generateIdeasJson(
  prompt: string,
  options: GenerateJsonOptions = {}
): Promise<string> {
  const provider = resolveContentIdeasProvider();
  if (provider === "gemini") {
    return generateWithGemini(prompt, options);
  }
  return generateWithAnthropic(prompt, options);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("429") || msg.includes("quota") || msg.includes("Quota");
}

function isModelNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("404") || msg.includes("not found") || msg.includes("no longer available");
}

/** Models in preference order. 2.0 flash-lite shut down 2026-06-01 — see ai.google.dev/gemini-api/docs/models */
const GEMINI_MODEL_FALLBACKS = [
  "gemini-2.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash",
] as const;

async function generateWithGemini(
  prompt: string,
  options: GenerateJsonOptions
): Promise<string> {
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not configured");
  }

  const configured = process.env.GEMINI_MODEL?.trim();
  const modelsToTry = configured
    ? [configured, ...GEMINI_MODEL_FALLBACKS.filter((m) => m !== configured)]
    : [...GEMINI_MODEL_FALLBACKS];

  const maxOutputTokens =
    options.maxOutputTokens ??
    (Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 8192);

  const genAI = new GoogleGenerativeAI(apiKey);
  let lastError: unknown;

  for (const modelName of modelsToTry) {
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens,
        responseMimeType: "application/json",
        ...(options.responseSchema
          ? { responseSchema: options.responseSchema }
          : {}),
      },
    });

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        if (!text?.trim()) {
          throw new Error("Empty Gemini response");
        }
        if (modelName !== modelsToTry[0]) {
          console.warn(`[gemini] Used fallback model: ${modelName}`);
        }
        return text;
      } catch (err) {
        lastError = err;
        if (isModelNotFoundError(err)) {
          console.warn(`[gemini] Model unavailable: ${modelName}`);
          break;
        }
        if (isRateLimitError(err) && attempt < 2) {
          const waitMs = 50_000 * (attempt + 1);
          console.warn(`[gemini] Rate limited on ${modelName}, retry in ${waitMs / 1000}s…`);
          await sleep(waitMs);
          continue;
        }
        throw err;
      }
    }
  }

  throw lastError ?? new Error("All Gemini models failed");
}

async function generateWithAnthropic(
  prompt: string,
  options: GenerateJsonOptions
): Promise<string> {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }

  const model =
    process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-20250514";
  const maxTokens =
    options.maxOutputTokens ??
    (Number(process.env.ANTHROPIC_MAX_OUTPUT_TOKENS) || 8192);

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Empty Anthropic response");
  }
  return textBlock.text;
}
