"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

function ErrorContent() {
  const params = useSearchParams();
  const msg = params.get("msg") ?? "An error occurred";

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-950 to-indigo-950">
      <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-8 py-6 text-white">
        <h1 className="text-xl font-semibold text-red-200">Error</h1>
        <p className="mt-2 text-red-200/90">{msg}</p>
        <a
          href="/"
          className="mt-4 inline-block text-indigo-400 underline hover:text-indigo-300"
        >
          ← Back to home
        </a>
      </div>
    </div>
  );
}

export default function ErrorPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-slate-950 text-white">Loading…</div>}>
      <ErrorContent />
    </Suspense>
  );
}
