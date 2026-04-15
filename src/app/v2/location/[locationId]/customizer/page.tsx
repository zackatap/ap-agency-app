import { CustomizerApp } from "@/components/customizer/customizer-app";

export default async function LocationCustomizerPage({
  params,
}: {
  params: Promise<{ locationId: string }>;
}) {
  const { locationId } = await params;
  return <CustomizerApp locationId={locationId} />;
}
