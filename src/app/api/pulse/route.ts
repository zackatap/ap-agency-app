import { NextResponse } from "next/server";
import { appendPulseResponse } from "@/lib/pulse-sheet";

export const runtime = "nodejs";

type Sentiment = "good" | "bad";
type IssueTag = "Quality" | "Quantity" | "Service" | "ROI";

interface PulseBody {
  clientName?: string | null;
  locationId?: string | null;
  cid?: string | null;
  score?: number;
  sentiment?: Sentiment;
  wins?: string | null;
  issues?: IssueTag[];
  issueDetail?: string | null;
  wantsZoom?: boolean;
  submittedAt?: string;
}

const ALLOWED_ISSUES: IssueTag[] = ["Quality", "Quantity", "Service", "ROI"];

export async function POST(req: Request) {
  let body: PulseBody;
  try {
    body = (await req.json()) as PulseBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const score = Number(body.score);
  if (!Number.isInteger(score) || score < 0 || score > 10) {
    return NextResponse.json(
      { error: "score must be an integer between 0 and 10" },
      { status: 400 }
    );
  }

  const sentiment: Sentiment = score >= 6 ? "good" : "bad";
  const issues = Array.isArray(body.issues)
    ? body.issues.filter((t): t is IssueTag =>
        ALLOWED_ISSUES.includes(t as IssueTag)
      )
    : [];

  const record = {
    clientName: (body.clientName || "").toString().trim() || null,
    locationId: (body.locationId || "").toString().trim() || null,
    cid: (body.cid || "").toString().trim() || null,
    score,
    sentiment,
    wins:
      sentiment === "good"
        ? (body.wins || "").toString().trim() || null
        : null,
    issues: sentiment === "bad" ? issues : [],
    issueDetail:
      sentiment === "bad"
        ? (body.issueDetail || "").toString().trim() || null
        : null,
    wantsZoom: sentiment === "bad" ? Boolean(body.wantsZoom) : false,
    userAgent: req.headers.get("user-agent") || null,
    submittedAt:
      body.submittedAt && !Number.isNaN(Date.parse(body.submittedAt))
        ? new Date(body.submittedAt).toISOString()
        : new Date().toISOString(),
  };

  const result = await appendPulseResponse(record);

  if (!result.ok) {
    console.error("[monthly-pulse] append failed", result.error);
    return NextResponse.json(
      { error: "Failed to save response" },
      { status: 500 }
    );
  }

  if (!result.stored) {
    console.log(
      "[monthly-pulse] response not stored:",
      result.reason,
      record
    );
  }

  return NextResponse.json({ ok: true, stored: result.stored });
}
