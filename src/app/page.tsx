import type { Metadata } from "next";
import OfferingsClient from "@/components/offerings/OfferingsClient";

export const metadata: Metadata = {
  title: "Automated Practice | Pricing & ROI Calculator",
  description:
    "Compare our two Automated Practice offerings and dial in the patients-per-month needed for a 2× or 5× return on your investment.",
};

export default function Page() {
  return <OfferingsClient />;
}
