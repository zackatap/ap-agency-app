import type { Metadata } from "next";
import { InternalSalesDashboard } from "@/components/agency/internal-sales-dashboard";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Internal Sales | Automated Practice",
};

export default function SalesPage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950">
      <InternalSalesDashboard />
    </div>
  );
}
