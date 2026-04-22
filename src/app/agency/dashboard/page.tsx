import { buildAgencyRollupView } from "@/lib/agency-rollup-view";
import { getLatestSnapshot } from "@/lib/agency-rollup-store";
import { AgencyDashboard } from "@/components/agency/agency-dashboard";
import {
  DATE_RANGE_LABELS,
  getDateRangeForPreset,
} from "@/lib/date-ranges";

export const dynamic = "force-dynamic";

export default async function AgencyDashboardPage() {
  // Keep the SSR default in sync with the client dashboard (Last 30 days).
  // The client can switch via the <select>; SSR just needs a sensible seed.
  const { startDate, endDate } = getDateRangeForPreset("last_30");
  const [view, latest] = await Promise.all([
    buildAgencyRollupView({
      range: {
        preset: "last_30",
        startDate,
        endDate,
        label: DATE_RANGE_LABELS.last_30,
      },
    }),
    getLatestSnapshot(),
  ]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950">
      <AgencyDashboard initial={view} initialLatest={latest} />
    </div>
  );
}
