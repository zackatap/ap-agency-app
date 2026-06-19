import { NextResponse } from "next/server";
import { generateContentIdeas } from "@/lib/content-ideas-generator";

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await generateContentIdeas({
      scope: "recent",
      count: 5,
      daysBack: 7,
    });
    return NextResponse.json({
      ok: true,
      appended: result.appended,
      meetingCount: result.meetingCount,
      titles: result.ideas.map((i) => i.title),
    });
  } catch (err) {
    console.error("[cron/content-ideas]", err);
    const message = err instanceof Error ? err.message : "Cron failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
