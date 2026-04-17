import Link from "next/link";
import { buildAgencyRollupView } from "@/lib/agency-rollup-view";
import { ClientBenchmark } from "@/components/agency/client-benchmark";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ locationId: string }>;
  searchParams: Promise<{ campaign?: string | string[] }>;
}

export default async function ClientBenchmarkPage({ params, searchParams }: PageProps) {
  const { locationId } = await params;
  const sp = await searchParams;
  const rawCampaign = sp.campaign;
  const campaignKey = Array.isArray(rawCampaign) ? rawCampaign[0] : rawCampaign;
  const view = await buildAgencyRollupView();

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950">
      <div className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-8">
        <div className="flex items-center justify-between gap-3">
          <Link
            href="/agency/dashboard"
            className="text-xs text-slate-400 transition-colors hover:text-white"
          >
            ← Back to agency dashboard
          </Link>
        </div>
        {view ? (
          <ClientBenchmark
            view={view}
            locationId={locationId}
            campaignKey={campaignKey ?? null}
          />
        ) : (
          <div className="rounded-2xl border border-white/10 bg-slate-900/40 p-8 text-center text-slate-300">
            <p className="text-lg font-medium">No rollup data yet</p>
            <p className="mt-2 text-sm text-slate-400">
              Generate a snapshot from the agency dashboard first.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
