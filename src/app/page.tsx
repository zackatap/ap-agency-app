import Link from "next/link";

export default function Home() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950">
      <main className="mx-auto max-w-2xl px-6 py-24 text-center text-white">
        <h1 className="text-4xl font-bold tracking-tight">
          Automated Practice
        </h1>
        <p className="mt-4 text-lg text-slate-400">
          Embed this app in GoHighLevel via a custom menu link at the location
          level. The Conversions Dashboard will show metrics for each pipeline.
        </p>
        <p className="mt-6 text-sm text-slate-500">
          Open the dashboard at{" "}
          <code className="rounded bg-white/10 px-2 py-1 font-mono">
            /v2/location/[locationId]/dashboard
          </code>
        </p>
        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/v2/location/Yl8c8Rmoh5TsTfVN5q5F/dashboard"
            className="inline-block rounded-xl bg-indigo-600 px-6 py-3 font-medium text-white transition-colors hover:bg-indigo-500"
          >
            Try Demo Dashboard →
          </Link>
          <Link
            href="/agency/dashboard"
            className="inline-block rounded-xl border border-white/20 bg-white/5 px-6 py-3 font-medium text-white transition-colors hover:bg-white/10"
          >
            Agency Rollup →
          </Link>
        </div>
      </main>
    </div>
  );
}
