import { createHash } from "crypto";
import { NextResponse } from "next/server";
import sharp from "sharp";
import {
  listMetaAdThumbnailSignatures,
  upsertMetaAdThumbnailSignature,
  type MetaAdThumbnailSignature,
} from "@/lib/meta-ads-store";

interface ThumbnailRow {
  adId: string;
  adName: string;
  thumbnailUrl: string | null;
  adsManagerUrl?: string | null;
  businessName?: string;
  spend?: number;
}

interface MatchAd {
  adId: string;
  adName: string;
  thumbnailUrl: string;
  adsManagerUrl?: string | null;
  businessName?: string;
  spend?: number;
}

interface MatchGroup {
  id: string;
  matchType: "exact" | "similar";
  label: string;
  representativeThumbnailUrl: string;
  maxDistance: number;
  ads: MatchAd[];
}

const MAX_ROWS = 3000;
const FETCH_CONCURRENCY = 6;

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(limit, Math.max(items.length, 1)) },
    async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex++];
        await worker(item);
      }
    }
  );
  await Promise.all(workers);
}

function hammingDistanceHex(a: string, b: string): number {
  let distance = 0;
  const ax = BigInt(`0x${a}`);
  const bx = BigInt(`0x${b}`);
  let diff = ax ^ bx;
  while (diff > BigInt(0)) {
    distance += Number(diff & BigInt(1));
    diff >>= BigInt(1);
  }
  return distance;
}

async function computeSignature(row: ThumbnailRow): Promise<MetaAdThumbnailSignature> {
  if (!row.thumbnailUrl) {
    return {
      adId: row.adId,
      thumbnailUrl: "",
      sha256: null,
      ahash: null,
      error: "Missing thumbnail URL",
      updatedAt: new Date().toISOString(),
    };
  }

  try {
    const res = await fetch(row.thumbnailUrl, { cache: "no-store" });
    if (!res.ok) throw new Error(`Fetch failed (${res.status})`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const pixels = await sharp(buffer)
      .resize(8, 8, { fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer();
    const avg = pixels.reduce((sum, value) => sum + value, 0) / pixels.length;
    let hash = BigInt(0);
    pixels.forEach((value, idx) => {
      if (value >= avg) hash |= BigInt(1) << BigInt(63 - idx);
    });
    const ahash = hash.toString(16).padStart(16, "0");
    return {
      adId: row.adId,
      thumbnailUrl: row.thumbnailUrl,
      sha256,
      ahash,
      error: null,
      updatedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      adId: row.adId,
      thumbnailUrl: row.thumbnailUrl,
      sha256: null,
      ahash: null,
      error: err instanceof Error ? err.message : "Failed to analyze thumbnail",
      updatedAt: new Date().toISOString(),
    };
  }
}

function toMatchAd(row: ThumbnailRow): MatchAd {
  return {
    adId: row.adId,
    adName: row.adName,
    thumbnailUrl: row.thumbnailUrl ?? "",
    adsManagerUrl: row.adsManagerUrl,
    businessName: row.businessName,
    spend: row.spend,
  };
}

function buildExactGroups(
  rowsByAdId: Map<string, ThumbnailRow>,
  signatures: MetaAdThumbnailSignature[]
): MatchGroup[] {
  const bySha = new Map<string, MetaAdThumbnailSignature[]>();
  for (const signature of signatures) {
    if (!signature.sha256) continue;
    const group = bySha.get(signature.sha256) ?? [];
    group.push(signature);
    bySha.set(signature.sha256, group);
  }
  return Array.from(bySha.entries())
    .filter(([, group]) => group.length > 1)
    .map(([sha, group]) => {
      const ads = group
        .map((signature) => rowsByAdId.get(signature.adId))
        .filter((row): row is ThumbnailRow => Boolean(row))
        .map(toMatchAd);
      return {
        id: `exact:${sha}`,
        matchType: "exact" as const,
        label: "Exact thumbnail match",
        representativeThumbnailUrl: ads[0]?.thumbnailUrl ?? "",
        maxDistance: 0,
        ads,
      };
    });
}

function buildSimilarGroups(
  rowsByAdId: Map<string, ThumbnailRow>,
  signatures: MetaAdThumbnailSignature[],
  threshold: number
): MatchGroup[] {
  const candidates = signatures.filter((signature) => signature.ahash);
  const used = new Set<string>();
  const groups: MatchGroup[] = [];

  for (const signature of candidates) {
    if (used.has(signature.adId) || !signature.ahash) continue;
    const matches: Array<{ signature: MetaAdThumbnailSignature; distance: number }> = [];
    for (const other of candidates) {
      if (!other.ahash) continue;
      const distance = hammingDistanceHex(signature.ahash, other.ahash);
      if (distance <= threshold) matches.push({ signature: other, distance });
    }
    if (matches.length < 2) continue;
    for (const match of matches) used.add(match.signature.adId);
    const ads = matches
      .map((match) => rowsByAdId.get(match.signature.adId))
      .filter((row): row is ThumbnailRow => Boolean(row))
      .map(toMatchAd);
    groups.push({
      id: `similar:${signature.adId}:${threshold}`,
      matchType: "similar",
      label: "Very similar thumbnail match",
      representativeThumbnailUrl: rowsByAdId.get(signature.adId)?.thumbnailUrl ?? "",
      maxDistance: Math.max(...matches.map((match) => match.distance)),
      ads,
    });
  }

  return groups;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      rows?: ThumbnailRow[];
      threshold?: number;
    };
    const threshold = Math.max(0, Math.min(16, Number(body.threshold ?? 8)));
    const rows = Array.isArray(body.rows)
      ? body.rows
          .filter((row) => row.adId && row.adName && row.thumbnailUrl)
          .slice(0, MAX_ROWS)
      : [];
    const rowsByAdId = new Map(rows.map((row) => [row.adId, row]));
    const cached = await listMetaAdThumbnailSignatures(rows.map((row) => row.adId));
    const cachedByAdId = new Map(cached.map((signature) => [signature.adId, signature]));
    const signatures: MetaAdThumbnailSignature[] = [];
    const toCompute: ThumbnailRow[] = [];

    for (const row of rows) {
      const signature = cachedByAdId.get(row.adId);
      if (
        signature &&
        signature.thumbnailUrl === row.thumbnailUrl &&
        (signature.ahash || signature.error)
      ) {
        signatures.push(signature);
      } else {
        toCompute.push(row);
      }
    }

    await runWithConcurrency(toCompute, FETCH_CONCURRENCY, async (row) => {
      const signature = await computeSignature(row);
      signatures.push(signature);
      await upsertMetaAdThumbnailSignature(signature).catch(() => undefined);
    });

    const exactGroups = buildExactGroups(rowsByAdId, signatures);
    const similarGroups = buildSimilarGroups(rowsByAdId, signatures, threshold);
    const groups = [...exactGroups, ...similarGroups]
      .filter((group) => group.ads.length > 1)
      .sort((a, b) => b.ads.length - a.ads.length || a.maxDistance - b.maxDistance);

    return NextResponse.json(
      {
        groups,
        analyzedCount: signatures.filter((signature) => signature.ahash).length,
        failedCount: signatures.filter((signature) => signature.error).length,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to match thumbnails" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
}
