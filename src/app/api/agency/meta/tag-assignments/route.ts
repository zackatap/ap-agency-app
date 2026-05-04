import { NextResponse } from "next/server";
import {
  assignMetaAdTags,
  listMetaAdTagAssignments,
  removeMetaAdTags,
} from "@/lib/meta-ads-store";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const adIds = url.searchParams.get("adIds")?.split(",") ?? undefined;
  return NextResponse.json(
    { assignments: await listMetaAdTagAssignments(adIds) },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { adIds?: string[]; tagIds?: number[] };
    await assignMetaAdTags({
      adIds: Array.isArray(body.adIds) ? body.adIds : [],
      tagIds: Array.isArray(body.tagIds) ? body.tagIds : [],
    });
    return NextResponse.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to assign tags" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
}

export async function DELETE(req: Request) {
  try {
    const body = (await req.json()) as { adIds?: string[]; tagIds?: number[] };
    await removeMetaAdTags({
      adIds: Array.isArray(body.adIds) ? body.adIds : [],
      tagIds: Array.isArray(body.tagIds) ? body.tagIds : [],
    });
    return NextResponse.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to remove tags" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
}
