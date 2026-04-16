import { buildAgencyRollupView } from "@/lib/agency-rollup-view";
import { getLatestSnapshot } from "@/lib/agency-rollup-store";
import { AgencyDashboard } from "@/components/agency/agency-dashboard";

export const dynamic = "force-dynamic";

export default async function AgencyDashboardPage() {
  const [view, latest] = await Promise.all([
    buildAgencyRollupView(),
    getLatestSnapshot(),
  ]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950">
      <AgencyDashboard initial={view} initialLatest={latest} />
    </div>
  );
}
