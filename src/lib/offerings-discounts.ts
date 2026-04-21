export type AcceleratorDiscount = {
  slug: string;
  /** Discounted monthly price for the Accelerator package. */
  acceleratorPrice: number;
  /** Short badge/label shown on the page (e.g., "Liz Exclusive"). */
  badge: string;
};

/**
 * Add a new entry here to expose a new discount URL.
 * e.g. { foo: { slug: "foo", acceleratorPrice: 999, badge: "Foo VIP" } }
 * will make /foo a live discount page.
 */
export const ACCELERATOR_DISCOUNTS: Record<string, AcceleratorDiscount> = {
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

export function getAcceleratorDiscount(
  slug: string,
): AcceleratorDiscount | null {
  return ACCELERATOR_DISCOUNTS[slug.toLowerCase()] ?? null;
}
