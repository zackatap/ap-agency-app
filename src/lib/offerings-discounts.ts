import { neon } from "@neondatabase/serverless";

export type AcceleratorDiscount = {
  slug: string;
  /** Discounted monthly price for the Accelerator package. */
  acceleratorPrice: number;
  /** Short badge/label shown on the page (e.g., "Liz Exclusive"). */
  badge: string;
  createdAt?: string;
};

// Fallback static discounts if DB is unreachable or during build
export const FALLBACK_DISCOUNTS: Record<string, AcceleratorDiscount> = {
  liz: {
    slug: "liz",
    acceleratorPrice: 1000,
    badge: "Liz Exclusive",
  },
  vip: {
    slug: "vip",
    acceleratorPrice: 1495,
    badge: "VIP Exclusive",
  },
};

function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  return neon(url);
}

export async function getAcceleratorDiscounts(): Promise<
  AcceleratorDiscount[]
> {
  const sql = getDb();
  if (!sql) return Object.values(FALLBACK_DISCOUNTS);

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS accelerator_discounts (
        slug TEXT PRIMARY KEY,
        accelerator_price INT NOT NULL,
        badge TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    const rows = await sql`
      SELECT slug, accelerator_price, badge, created_at 
      FROM accelerator_discounts 
      ORDER BY created_at DESC
    `;

    return rows.map((r) => ({
      slug: r.slug as string,
      acceleratorPrice: r.accelerator_price as number,
      badge: r.badge as string,
      createdAt: r.created_at as string,
    }));
  } catch (err) {
    console.error("[offerings-discounts] getAcceleratorDiscounts error:", err);
    return Object.values(FALLBACK_DISCOUNTS);
  }
}

export async function getAcceleratorDiscount(
  slug: string
): Promise<AcceleratorDiscount | null> {
  const sql = getDb();
  if (!sql) return FALLBACK_DISCOUNTS[slug.toLowerCase()] ?? null;

  try {
    const rows = await sql`
      SELECT slug, accelerator_price, badge, created_at 
      FROM accelerator_discounts 
      WHERE slug = ${slug.toLowerCase()}
    `;

    if (!rows[0]) return null;

    const r = rows[0];
    return {
      slug: r.slug as string,
      acceleratorPrice: r.accelerator_price as number,
      badge: r.badge as string,
      createdAt: r.created_at as string,
    };
  } catch (err) {
    // Note: Table might not exist yet if this is the very first hit, 
    // but the fallback handles that gracefully.
    return FALLBACK_DISCOUNTS[slug.toLowerCase()] ?? null;
  }
}

export async function upsertAcceleratorDiscount(
  discount: Omit<AcceleratorDiscount, "createdAt">
): Promise<void> {
  const sql = getDb();
  if (!sql) throw new Error("DATABASE_URL not configured");

  await sql`
    CREATE TABLE IF NOT EXISTS accelerator_discounts (
      slug TEXT PRIMARY KEY,
      accelerator_price INT NOT NULL,
      badge TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    INSERT INTO accelerator_discounts (slug, accelerator_price, badge)
    VALUES (${discount.slug.toLowerCase()}, ${discount.acceleratorPrice}, ${discount.badge})
    ON CONFLICT (slug) DO UPDATE SET
      accelerator_price = EXCLUDED.accelerator_price,
      badge = EXCLUDED.badge
  `;
}

export async function deleteAcceleratorDiscount(slug: string): Promise<void> {
  const sql = getDb();
  if (!sql) throw new Error("DATABASE_URL not configured");

  await sql`
    DELETE FROM accelerator_discounts WHERE slug = ${slug.toLowerCase()}
  `;
}
