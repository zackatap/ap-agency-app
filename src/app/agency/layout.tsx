import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Agency · Automated Practice",
  appleWebApp: {
    capable: true,
    title: "AP Agency",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0a0a0a",
};

export default function AgencyLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
