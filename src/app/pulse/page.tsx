import type { Metadata } from "next";
import PulseForm from "./PulseForm";

export const metadata: Metadata = {
  title: "Monthly Pulse | Automated Practice",
  description:
    "How are we doing? A quick pulse check from your Automated Practice team.",
};

type SearchParams = Promise<{
  client?: string;
  loc?: string;
  cid?: string;
}>;

export default async function PulsePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  return (
    <PulseForm
      initialClientName={params.client ?? ""}
      locationId={params.loc ?? ""}
      cid={params.cid ?? ""}
    />
  );
}
