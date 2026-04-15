import { CustomizerApp } from "@/components/customizer/customizer-app";

export default function CustomizerPage() {
  const fallbackLocationId =
    process.env.NEXT_PUBLIC_CUSTOMIZER_LOCATION_ID?.trim() ?? "";
  return <CustomizerApp locationId={fallbackLocationId} />;
}
