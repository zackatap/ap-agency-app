import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Agency · Launcher | Automated Practice",
};

type LauncherLink = {
  href: string;
  title: string;
  description: string;
};

type LauncherSection = {
  id: string;
  title: string;
  description: string;
  links: LauncherLink[];
};

const SECTIONS: LauncherSection[] = [
  {
    id: "agency",
    title: "Agency",
    description: "Performance, clients, and ops",
    links: [
      {
        href: "/agency/dashboard",
        title: "Agency Rollup",
        description: "Leaderboard, pipeline metrics, client map",
      },
      {
        href: "/v2/location/Yl8c8Rmoh5TsTfVN5q5F/dashboard",
        title: "Conversions Dashboard (demo)",
        description: "Per-location pipeline view",
      },
      {
        href: "/pulse",
        title: "Monthly Pulse",
        description: "Client feedback survey",
      },
      {
        href: "/customizer",
        title: "Customizer",
        description: "Funnel & workflow customizer",
      },
    ],
  },
  {
    id: "sales",
    title: "Sales",
    description: "Internal pipeline and offers",
    links: [
      {
        href: "/sales",
        title: "Internal Sales",
        description: "Booking, show, and close rates from the lead tracker",
      },
      {
        href: "/agency/presentation",
        title: "Client Roadmap Presentation",
        description: "Zoom-ready onboarding deck",
      },
      {
        href: "/agency/discounts",
        title: "Pricing Discounts",
        description: "Promo URLs and discounted pricing",
      },
      {
        href: "/",
        title: "Public Pricing Page",
        description: "Offerings + ROI calculator",
      },
    ],
  },
  {
    id: "content",
    title: "Content",
    description: "Hooks, ideas, and carousels",
    links: [
      {
        href: "/agency/hooks",
        title: "Hook Generator",
        description: "Topic → hooks from the full library",
      },
      {
        href: "/agency/content-ideas",
        title: "Content Ideas",
        description: "Granola meetings → Google Sheet",
      },
      {
        href: "/agency/carousel",
        title: "Carousel Generator",
        description: "Transcript → editable 4:5 carousel slides",
      },
    ],
  },
];

export default function AgencyIndexPage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 text-white">
      <main className="mx-auto max-w-2xl px-6 py-12">
        <header className="mb-10">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-indigo-300/80">
            Automated Practice
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">
            Launcher
          </h1>
          <p className="mt-2 text-sm text-slate-400">
            Pick a tool. Organized by what you&apos;re doing.
          </p>
        </header>

        <div className="space-y-8">
          {SECTIONS.map((section) => (
            <section key={section.id} aria-labelledby={`section-${section.id}`}>
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <h2
                  id={`section-${section.id}`}
                  className="text-sm font-semibold uppercase tracking-wider text-slate-300"
                >
                  {section.title}
                </h2>
                <p className="text-xs text-slate-500">{section.description}</p>
              </div>

              <ul className="overflow-hidden rounded-2xl border border-white/10 bg-slate-950/50 shadow-xl shadow-slate-950/40 backdrop-blur">
                {section.links.map((link, i) => (
                  <li
                    key={link.href}
                    className={
                      i > 0 ? "border-t border-white/5" : undefined
                    }
                  >
                    <Link
                      href={link.href}
                      className="group flex items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-white/[0.04] focus-visible:bg-white/[0.04] focus-visible:outline-none"
                    >
                      <span className="min-w-0">
                        <span className="block text-[15px] font-medium text-white transition-colors group-hover:text-indigo-200">
                          {link.title}
                        </span>
                        <span className="mt-0.5 block text-sm text-slate-500 group-hover:text-slate-400">
                          {link.description}
                        </span>
                      </span>
                      <span
                        aria-hidden
                        className="shrink-0 text-slate-600 transition-all group-hover:translate-x-0.5 group-hover:text-indigo-300"
                      >
                        →
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <footer className="mt-10 flex items-center justify-between border-t border-white/5 pt-6 text-sm text-slate-500">
          <span>Agency tools</span>
          <form action="/api/agency/auth/logout" method="POST">
            <button
              type="submit"
              className="text-slate-500 underline-offset-2 transition hover:text-slate-300 hover:underline"
            >
              Log out
            </button>
          </form>
        </footer>
      </main>
    </div>
  );
}
