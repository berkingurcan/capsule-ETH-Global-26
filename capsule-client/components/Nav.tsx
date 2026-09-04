"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import Capsule from "./Capsule";
import { PARENT } from "@/lib/mock";

const LINKS = [
  { href: "/launch", label: "Launch" },
  { href: "/fleet", label: "Fleet" },
  { href: "/analyst", label: "Analyst" },
];

export default function Nav() {
  const path = usePathname();
  const on = (href: string) => path === href || path.startsWith(href + "/");

  return (
    <>
      <nav className="nav">
        <div className="wrap nav-inner">
          <Link href="/" className="brand" aria-label="Capsule, home">
            <Capsule size={30} />
            <span className="wm">
              Capsule<span style={{ color: "var(--bubble)" }}>.</span>
            </span>
          </Link>

          <div className="nav-links">
            {LINKS.map((l) => (
              <Link key={l.href} href={l.href} className={"nav-link" + (on(l.href) ? " on" : "")}>
                {l.label}
              </Link>
            ))}
          </div>

          <span className="tag sun" style={{ marginLeft: "auto" }} title="Nothing here touches a chain or a wallet">
            Demo · mock data
          </span>

          <div className="wallet" title="Connected parent name">
            <span className="dot" />
            <span>{PARENT.name}</span>
            <span style={{ opacity: 0.6 }}>0x7a1c…9e40</span>
          </div>
        </div>
      </nav>

      <div className="nav-mobile">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} className={"nav-link" + (on(l.href) ? " on" : "")}>
            {l.label}
          </Link>
        ))}
      </div>
    </>
  );
}
