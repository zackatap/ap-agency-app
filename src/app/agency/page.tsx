import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Agency · Launcher | Automated Practice",
};

const LINKS = [
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
    href: "/agency/presentation",
    title: "Client Roadmap Presentation",
    description: "Zoom-ready onboarding deck",
  },
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
    href: "/agency/discounts",
    title: "Pricing Discounts",
    description: "Promo URLs and discounted pricing",
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
  {
    href: "/",
    title: "Public Pricing Page",
    description: "Offerings + ROI calculator",
  },
];

export default function AgencyIndexPage() {
  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <main className="mx-auto max-w-xl px-6 py-12">
        <header className="mb-8">
          <h1 className="text-xl font-medium text-neutral-100">Launcher</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Agency tools
          </p>
        </header>

        <ul className="divide-y divide-neutral-800 border-y border-neutral-800">
          {LINKS.map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                className="block py-4 transition hover:bg-neutral-900/50"
              >
                <span className="text-[15px] text-neutral-100">
                  {link.title}
                </span>
                <span className="mt-0.5 block text-sm text-neutral-500">
                  {link.description}
                </span>
              </Link>
            </li>
          ))}
        </ul>

        <footer className="mt-8 flex items-center justify-between text-sm text-neutral-600">
          <span>Automated Practice</span>
          <form action="/api/agency/auth/logout" method="POST">
            <button
              type="submit"
              className="text-neutral-500 underline-offset-2 hover:text-neutral-300 hover:underline"
            >
              Log out
            </button>
          </form>
        </footer>
      </main>
    </div>
  );
}
