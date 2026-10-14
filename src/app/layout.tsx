import type { Metadata, Viewport } from "next";
import { DotGothic16 } from "next/font/google";
import { ServiceWorker } from "@/components/ServiceWorker";
import "./globals.css";

const dot = DotGothic16({ weight: "400", subsets: ["latin"], variable: "--font-dot", display: "swap" });

export const metadata: Metadata = {
  title: "Cité de Tirelire",
  description: "節約と貯金で街が育つ、放置型の街づくり貯金ゲーム",
  applicationName: "Cité de Tirelire",
  appleWebApp: { capable: true, title: "Tirelire", statusBarStyle: "default" },
  icons: { icon: "/icons/icon-192.png", apple: "/icons/icon-192.png" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f0e1" },
    { media: "(prefers-color-scheme: dark)", color: "#1b1a17" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" className={dot.variable}>
      <body className="min-h-dvh">
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
