import Link from "next/link";
import type { Metadata, Viewport } from "next";
import HooksGeneratorClient from "@/components/agency/hooks-generator-client";

export const metadata: Metadata = {
  title: "Hook Generator · Agency",
  description: "Generate social hooks from a topic using the AP hook library.",
  appleWebApp: {
    capable: true,
    title: "AP Hooks",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#0a0a0a",
};

export default function HooksPage() {
  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <main className="mx-auto max-w-xl px-5 py-8 pb-16">
        <header className="mb-6">
          <Link
            href="/agency"
            className="text-sm text-neutral-500 hover:text-neutral-300"
          >
            ← Launcher
          </Link>
          <h1 className="mt-3 text-xl font-medium">Hook generator</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Enter a topic. Get hooks from the full library.
          </p>
        </header>

        <HooksGeneratorClient />
      </main>
    </div>
  );
}
