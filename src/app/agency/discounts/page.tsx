import { getAcceleratorDiscounts } from "@/lib/offerings-discounts";
import DiscountsClient from "@/components/agency/discounts-client";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function AgencyDiscountsPage() {
  const discounts = await getAcceleratorDiscounts();

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 text-white">
      <header className="relative z-10 mx-auto flex max-w-4xl items-center justify-between px-6 pt-8">
        <div className="flex items-center gap-4">
          <Link
            href="/agency"
            className="text-sm font-semibold tracking-tight text-white/80 hover:text-white"
          >
            ← Back to Launcher
          </Link>
          <span className="text-slate-600">/</span>
          <span className="text-sm font-semibold tracking-tight text-indigo-300">
            Discount URLs
          </span>
        </div>
      </header>
      <main className="relative z-10 mx-auto max-w-4xl px-6 py-12">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">
              Pricing Discounts
            </h1>
            <p className="mt-2 text-slate-400">
              Create and manage promo URLs (e.g. /liz) that discount the
              Accelerator package on the public pricing page.
            </p>
          </div>
        </div>

        <div className="mt-8 rounded-2xl border border-white/10 bg-slate-950/60 p-6 shadow-2xl shadow-slate-950/40 backdrop-blur">
          <DiscountsClient initialDiscounts={discounts} />
        </div>
      </main>
    </div>
  );
}
