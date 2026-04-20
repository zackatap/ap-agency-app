import { NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

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

function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  return neon(url);
}

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

  const payload = {
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
    submittedAt:
      body.submittedAt && !Number.isNaN(Date.parse(body.submittedAt))
        ? new Date(body.submittedAt).toISOString()
        : new Date().toISOString(),
    userAgent: req.headers.get("user-agent") || null,
  };

  const sql = getDb();
  if (!sql) {
    // No DB configured — log the response so dev still works end-to-end.
    console.log("[monthly-pulse] (no DATABASE_URL) response:", payload);
    return NextResponse.json({ ok: true, stored: false });
  }

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS monthly_pulse_responses (
        id BIGSERIAL PRIMARY KEY,
        client_name TEXT,
        location_id TEXT,
        cid TEXT,
        score SMALLINT NOT NULL,
        sentiment TEXT NOT NULL,
        wins TEXT,
        issues JSONB DEFAULT '[]',
        issue_detail TEXT,
        wants_zoom BOOLEAN DEFAULT false,
        user_agent TEXT,
        submitted_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS monthly_pulse_submitted_at_idx ON monthly_pulse_responses (submitted_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS monthly_pulse_location_idx ON monthly_pulse_responses (location_id)`;

    await sql`
      INSERT INTO monthly_pulse_responses (
        client_name, location_id, cid, score, sentiment,
        wins, issues, issue_detail, wants_zoom, user_agent, submitted_at
      ) VALUES (
        ${payload.clientName},
        ${payload.locationId},
        ${payload.cid},
        ${payload.score},
        ${payload.sentiment},
        ${payload.wins},
        ${JSON.stringify(payload.issues)}::jsonb,
        ${payload.issueDetail},
        ${payload.wantsZoom},
        ${payload.userAgent},
        ${payload.submittedAt}
      )
    `;

    return NextResponse.json({ ok: true, stored: true });
  } catch (err) {
    console.error("[monthly-pulse] failed to persist", err);
    return NextResponse.json(
      { error: "Failed to save response" },
      { status: 500 }
    );
  }
}
