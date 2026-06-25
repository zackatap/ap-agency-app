import Link from "next/link";
import type { Metadata, Viewport } from "next";
import CarouselGeneratorClient from "@/components/agency/carousel-generator-client";

export const metadata: Metadata = {
  title: "Carousel Generator · Agency",
  description: "Turn a transcript into a clean, on-brand carousel.",
  appleWebApp: {
    capable: true,
    title: "AP Carousel",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#0a0a0a",
};

export default function CarouselPage() {
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
          <h1 className="mt-3 text-xl font-medium">Carousel generator</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Paste a transcript. Break it into slides, edit, then export 4:5 PNGs.
          </p>
        </header>

        <CarouselGeneratorClient />
      </main>
    </div>
  );
}
