import { NextResponse } from "next/server";
import {
  createMetaAdTag,
  deleteMetaAdTag,
  listMetaAdTags,
} from "@/lib/meta-ads-store";

export async function GET() {
  return NextResponse.json(
    { tags: await listMetaAdTags() },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { name?: string };
    const tag = await createMetaAdTag(String(body.name ?? ""));
    return NextResponse.json(
      { tag, tags: await listMetaAdTags() },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create tag" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
}

export async function DELETE(req: Request) {
  try {
    const url = new URL(req.url);
    const id = Number(url.searchParams.get("id"));
    if (!Number.isFinite(id)) throw new Error("Tag id is required");
    await deleteMetaAdTag(id);
    return NextResponse.json(
      { ok: true, tags: await listMetaAdTags() },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to delete tag" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
}
