import type { Metadata } from "next";
import Nav from "@/components/Nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Capsule — one name, a whole fleet",
  description:
    "Launchpad and fleet dashboard for ENSv2 agents. The name is the agent: settings live in the record, and the right to run is a role you can pull.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;600;700;800&family=Azeret+Mono:wght@400;500;600;700&display=swap"
        />
      </head>
      <body>
        <Nav />
        {children}
        <footer className="b-ink" style={{ padding: "34px 0", borderTop: "3px solid var(--ink)" }}>
          <div className="wrap row wrapflex" style={{ gap: 16 }}>
            <span className="mono" style={{ fontSize: 12, color: "var(--vend-300)" }}>
              Capsule · ETHOnline 2026 · design demo
            </span>
            <span className="push mono" style={{ fontSize: 12, color: "var(--vend-300)" }}>
              Names on ETH Sepolia · money on Base Sepolia · no bridge
            </span>
          </div>
        </footer>
      </body>
    </html>
  );
}
