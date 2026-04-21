import { notFound } from "next/navigation";
import type { Metadata } from "next";
import OfferingsClient from "@/components/offerings/OfferingsClient";
import {
  ACCELERATOR_DISCOUNTS,
  getAcceleratorDiscount,
} from "@/lib/offerings-discounts";

type PageProps = {
  params: Promise<{ slug: string }>;
};

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const discount = getAcceleratorDiscount(slug);
  if (!discount) return {};
  return {
    title: `Automated Practice | ${discount.badge}`,
    description: "Exclusive Accelerator pricing for your practice.",
  };
}

export function generateStaticParams() {
  return Object.keys(ACCELERATOR_DISCOUNTS).map((slug) => ({ slug }));
}

export const dynamicParams = false;

export default async function DiscountPage({ params }: PageProps) {
  const { slug } = await params;
  const discount = getAcceleratorDiscount(slug);
  if (!discount) notFound();

  return (
    <OfferingsClient
      acceleratorPrice={discount.acceleratorPrice}
      discountBadge={discount.badge}
    />
  );
}
