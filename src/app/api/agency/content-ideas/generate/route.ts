import { NextResponse } from "next/server";
import { generateContentIdeas, type GenerateScope } from "@/lib/content-ideas-generator";

export async function POST(req: Request) {
  try {
    let body: {
      scope?: GenerateScope;
      meetingIds?: string[];
      count?: number;
      daysBack?: number;
    } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const scope = body.scope ?? "recent";
    if (!["recent", "all", "selected"].includes(scope)) {
      return NextResponse.json({ error: "Invalid scope" }, { status: 400 });
    }
    if (scope === "selected" && (!body.meetingIds || body.meetingIds.length === 0)) {
      return NextResponse.json(
        { error: "meetingIds required for selected scope" },
        { status: 400 }
      );
    }

    const result = await generateContentIdeas({
      scope,
      meetingIds: body.meetingIds,
      count: body.count ?? 5,
      daysBack: body.daysBack ?? 7,
    });

    return NextResponse.json(result);
  } catch (err) {
    console.error("[content-ideas/generate]", err);
    const message =
      err instanceof Error ? err.message : "Failed to generate ideas";
    const isQuota =
      message.includes("429") ||
      message.includes("quota") ||
      message.includes("Quota");
    const status = message.includes("not connected")
      ? 401
      : isQuota
        ? 429
        : message.includes("ANTHROPIC") ||
            message.includes("GEMINI") ||
            message.includes("LLM configured")
          ? 503
          : 500;
    return NextResponse.json(
      {
        error: isQuota
          ? "Gemini free-tier quota hit. Wait a minute and retry, or use a key from aistudio.google.com/apikey (starts with AIza)."
          : message,
      },
      { status }
    );
  }
}
