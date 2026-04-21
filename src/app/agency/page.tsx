import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Agency · Launcher | Automated Practice",
};

type LinkCard = {
  href: string;
  title: string;
  description: string;
  accent: "indigo" | "emerald" | "fuchsia" | "amber";
};

const LINKS: LinkCard[] = [
  {
    href: "/agency/dashboard",
    title: "Agency Rollup",
    description:
      "Cross-client leaderboard, pipeline metrics, and client map.",
    accent: "indigo",
  },
  {
    href: "/v2/location/Yl8c8Rmoh5TsTfVN5q5F/dashboard",
    title: "Conversions Dashboard (demo)",
    description:
      "Per-location pipeline conversion view. Swap the locationId in the URL for any client.",
    accent: "emerald",
  },
  {
    href: "/agency/discounts",
    title: "Pricing Discounts",
    description: "Manage custom promo URLs and discounted pricing.",
    accent: "emerald",
  },
  {
    href: "/pulse",
    title: "Monthly Pulse",
    description: "Client feedback survey — writes responses to Google Sheets.",
    accent: "fuchsia",
  },
  {
    href: "/customizer",
    title: "Customizer",
    description: "Internal funnel & workflow customizer tool.",
    accent: "amber",
  },
  {
    href: "/",
    title: "Public Pricing Page",
    description: "Offerings + ROI calculator shown at the root URL.",
    accent: "indigo",
  },
];

const ACCENT: Record<LinkCard["accent"], string> = {
  indigo:
    "from-indigo-500/15 to-slate-900/40 border-indigo-400/30 hover:border-indigo-300/60",
  emerald:
    "from-emerald-500/15 to-slate-900/40 border-emerald-400/30 hover:border-emerald-300/60",
  fuchsia:
    "from-fuchsia-500/15 to-slate-900/40 border-fuchsia-400/30 hover:border-fuchsia-300/60",
  amber:
    "from-amber-500/15 to-slate-900/40 border-amber-400/30 hover:border-amber-300/60",
};

export default function AgencyIndexPage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 text-white">
      <div className="pointer-events-none absolute inset-x-0 top-0 -z-0 h-[420px] bg-[radial-gradient(60%_60%_at_50%_0%,rgba(99,102,241,0.22),transparent_70%)]" />

      <main className="relative z-10 mx-auto max-w-5xl px-6 py-16">
        <div className="flex flex-col items-start gap-2">
          <span className="inline-flex items-center rounded-full border border-white/15 bg-white/5 px-3 py-1 text-[11px] font-medium uppercase tracking-widest text-indigo-200">
            Internal · Agency
          </span>
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
            Launcher
          </h1>
          <p className="max-w-2xl text-slate-400">
            Quick access to everything behind the agency password.
          </p>
        </div>

        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`group flex flex-col justify-between rounded-2xl border bg-gradient-to-b ${ACCENT[link.accent]} p-6 shadow-lg shadow-slate-950/30 transition hover:-translate-y-0.5`}
            >
              <div>
                <h2 className="text-lg font-semibold tracking-tight">
                  {link.title}
                </h2>
                <p className="mt-1 text-sm text-slate-300">{link.description}</p>
              </div>
              <div className="mt-6 flex items-center justify-between text-xs text-slate-400">
                <code className="rounded bg-white/10 px-2 py-1 font-mono text-slate-300">
                  {link.href}
                </code>
                <span className="text-slate-300 transition group-hover:translate-x-0.5">
                  Open →
                </span>
              </div>
            </Link>
          ))}
        </div>

        <div className="mt-12 flex items-center justify-between border-t border-white/10 pt-6 text-xs text-slate-500">
          <span>Automated Practice · Agency tools</span>
          <form action="/api/agency/auth/logout" method="POST">
            <button
              type="submit"
              className="rounded-full border border-white/15 bg-white/5 px-3 py-1 text-slate-300 hover:bg-white/10"
            >
              Log out
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}
