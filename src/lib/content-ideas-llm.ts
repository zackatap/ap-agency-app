/**
 * LLM helper for content idea generation.
 * Uses Gemini if GEMINI_API_KEY is set, otherwise Anthropic.
 */

export type LlmProvider = "gemini" | "anthropic";

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

export async function generateIdeasJson(prompt: string): Promise<string> {
  const provider = resolveContentIdeasProvider();
  if (provider === "gemini") {
    return generateWithGemini(prompt);
  }
  return generateWithAnthropic(prompt);
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

async function generateWithGemini(prompt: string): Promise<string> {
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not configured");
  }

  const configured = process.env.GEMINI_MODEL?.trim();
  const modelsToTry = configured
    ? [configured, ...GEMINI_MODEL_FALLBACKS.filter((m) => m !== configured)]
    : [...GEMINI_MODEL_FALLBACKS];

  const genAI = new GoogleGenerativeAI(apiKey);
  let lastError: unknown;

  for (const modelName of modelsToTry) {
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 2048,
        responseMimeType: "application/json",
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

async function generateWithAnthropic(prompt: string): Promise<string> {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }

  const model =
    process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-20250514";
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model,
    max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Empty Anthropic response");
  }
  return textBlock.text;
}
