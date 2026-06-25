import { NextResponse } from "next/server";
import { generateCarouselFromTranscript } from "@/lib/carousel-generator";

export async function POST(req: Request) {
  try {
    let body: {
      transcript?: string;
      instructions?: string;
      minSlides?: number;
    } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const transcript = String(body.transcript ?? "").trim();
    if (!transcript) {
      return NextResponse.json(
        { error: "Transcript is required" },
        { status: 400 }
      );
    }

    const slides = await generateCarouselFromTranscript({
      transcript,
      instructions: body.instructions,
      minSlides: body.minSlides,
    });

    return NextResponse.json({ slides, script: slides.join("\n\n---\n\n") });
  } catch (err) {
    console.error("[carousel/generate]", err);
    const message =
      err instanceof Error ? err.message : "Failed to generate carousel";
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
