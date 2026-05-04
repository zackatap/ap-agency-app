import type { Metadata } from "next";
import { ClientRoadmapPresentation } from "@/components/agency/client-roadmap-presentation";

export const metadata: Metadata = {
  title: "Client Roadmap Presentation | Automated Practice",
  description:
    "A protected agency presentation for walking clients through the Automated Practice onboarding roadmap.",
};

export default function AgencyPresentationPage() {
  return <ClientRoadmapPresentation />;
}
