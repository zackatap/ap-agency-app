import { NextResponse } from "next/server";
import {
  createMetaAdTagRollup,
  deleteMetaAdTagRollup,
  listMetaAdTagRollups,
  updateMetaAdTagRollup,
} from "@/lib/meta-ads-store";
import type { MetaAdTagRollupMode } from "@/lib/meta-ad-rollups";

export async function GET() {
  return NextResponse.json(
    { tagRollups: await listMetaAdTagRollups() },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      name?: string;
      includeMode?: MetaAdTagRollupMode;
      includeTagIds?: number[];
      excludeTagIds?: number[];
    };
    const tagRollup = await createMetaAdTagRollup({
      name: String(body.name ?? ""),
      includeMode: body.includeMode === "any" ? "any" : "all",
      includeTagIds: Array.isArray(body.includeTagIds) ? body.includeTagIds : [],
      excludeTagIds: Array.isArray(body.excludeTagIds) ? body.excludeTagIds : [],
    });
    return NextResponse.json(
      { tagRollup, tagRollups: await listMetaAdTagRollups() },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create tag rollup" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
}

export async function PATCH(req: Request) {
  try {
    const body = (await req.json()) as { id?: number; enabled?: boolean };
    const id = Number(body.id);
    if (!Number.isFinite(id)) throw new Error("Tag rollup id is required");
    const tagRollup = await updateMetaAdTagRollup(id, {
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
    });
    if (!tagRollup) throw new Error("Tag rollup not found");
    return NextResponse.json(
      { tagRollup, tagRollups: await listMetaAdTagRollups() },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update tag rollup" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
}

export async function DELETE(req: Request) {
  try {
    const url = new URL(req.url);
    const id = Number(url.searchParams.get("id"));
    if (!Number.isFinite(id)) throw new Error("Tag rollup id is required");
    await deleteMetaAdTagRollup(id);
    return NextResponse.json(
      { ok: true, tagRollups: await listMetaAdTagRollups() },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to delete tag rollup" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
}
