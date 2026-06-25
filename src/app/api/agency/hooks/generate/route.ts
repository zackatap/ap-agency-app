import { NextResponse } from "next/server";
import { generateHooksForTopic } from "@/lib/hooks-generator";

export async function POST(req: Request) {
  try {
    let body: { topic?: string; count?: number } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const topic = String(body.topic ?? "").trim();
    if (!topic) {
      return NextResponse.json({ error: "Topic is required" }, { status: 400 });
    }

    const hooks = await generateHooksForTopic({
      topic,
      count: body.count,
    });

    return NextResponse.json({ hooks, topic });
  } catch (err) {
    console.error("[hooks/generate]", err);
    const message = err instanceof Error ? err.message : "Failed to generate hooks";
    const isQuota =
      message.includes("429") ||
      message.includes("quota") ||
      message.includes("Quota");
    return NextResponse.json(
      {
        error: isQuota
          ? "API quota hit — wait a minute and try again."
          : message,
      },
      { status: isQuota ? 429 : 500 }
    );
  }
}
