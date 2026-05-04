import { NextResponse } from "next/server";
import {
  createMetaAdRollupPhrase,
  deleteMetaAdRollupPhrase,
  listMetaAdRollupPhrases,
  updateMetaAdRollupPhrase,
} from "@/lib/meta-ads-store";

export async function GET() {
  return NextResponse.json(
    { phrases: await listMetaAdRollupPhrases() },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { phrase?: string };
    const phrase = await createMetaAdRollupPhrase(String(body.phrase ?? ""));
    return NextResponse.json(
      { phrase, phrases: await listMetaAdRollupPhrases() },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create rollup" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
}

export async function PATCH(req: Request) {
  try {
    const body = (await req.json()) as { id?: number; enabled?: boolean };
    const id = Number(body.id);
    if (!Number.isFinite(id)) throw new Error("Rollup id is required");
    const phrase = await updateMetaAdRollupPhrase(id, {
      enabled: body.enabled,
    });
    if (!phrase) {
      return NextResponse.json(
        { error: "Rollup not found" },
        { status: 404, headers: { "Cache-Control": "no-store" } }
      );
    }
    return NextResponse.json(
      { phrase, phrases: await listMetaAdRollupPhrases() },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update rollup" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
}

export async function DELETE(req: Request) {
  try {
    const url = new URL(req.url);
    const id = Number(url.searchParams.get("id"));
    if (!Number.isFinite(id)) throw new Error("Rollup id is required");
    await deleteMetaAdRollupPhrase(id);
    return NextResponse.json(
      { ok: true, phrases: await listMetaAdRollupPhrases() },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to delete rollup" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
}
