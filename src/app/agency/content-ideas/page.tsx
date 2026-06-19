import Link from "next/link";
import { Suspense } from "react";
import ContentIdeasClient from "@/components/agency/content-ideas-client";
import { isGranolaConnected } from "@/lib/granola-service";
import { getContentIdeasSheetUrl } from "@/lib/content-ideas-sheet";

export const dynamic = "force-dynamic";

export default async function ContentIdeasPage() {
  const connected = await isGranolaConnected();
  const sheetUrl = getContentIdeasSheetUrl();

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
            Content Ideas
          </span>
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-4xl px-6 py-12">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            Content ideas from Granola
          </h1>
          <p className="mt-2 max-w-2xl text-slate-400">
            Pull marketing angles from your recorded meetings and append 5
            ideas to the content sheet. Hooks use your swipe file templates,
            tuned for health practice owners and chiros.
          </p>
        </div>

        <div className="mt-8 rounded-2xl border border-white/10 bg-slate-950/60 p-6 shadow-2xl shadow-slate-950/40 backdrop-blur">
          <Suspense fallback={<p className="text-sm text-slate-400">Loading…</p>}>
            <ContentIdeasClient
              initialConnected={connected}
              sheetUrl={sheetUrl}
            />
          </Suspense>
        </div>
      </main>
    </div>
  );
}
