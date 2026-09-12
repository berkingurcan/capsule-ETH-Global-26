"use client";

import { useEffect, useRef } from "react";
import Capsule from "./Capsule";

/* The landing hero's capsules, which follow the pointer and the scroll.

   Two nested transforms carry all of it: the outer span takes the parallax,
   driven by CSS variables this file writes, and the inner one keeps the idle
   float keyframe. They have to be separate elements — one element cannot hold a
   CSS animation and a JS-written transform on the same property without one of
   them simply winning.

   The pointer is lerped towards rather than followed, so the capsules trail the
   cursor and settle instead of snapping; the loop parks itself once everything
   has caught up, so an idle hero costs nothing. Under prefers-reduced-motion the
   effect never starts, the variables stay unset, and every `var(--mx, 0)` in the
   stylesheet falls back to a still frame. */

const FLOATS = [
  { cls: "lp-f1", cap: "#FFC42E", size: 58 },
  { cls: "lp-f2", cap: "#8CF0B4", size: 50 },
  { cls: "lp-f3", cap: "#F2F6FF", size: 42 },
  { cls: "lp-f4", cap: "#FFC42E", size: 46 },
];

const SPARKS = ["lp-s1", "lp-s2", "lp-s3"];

const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n);

export default function HeroArt() {
  const art = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = art.current;
    if (el === null) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    /* The pointer is tracked across the whole hero, not just the artwork, so the
       capsules lean towards the cursor while it is still over the headline. */
    const host: Element = el.closest("section") ?? el;

    let tx = 0;
    let ty = 0;
    let ts = 0;
    let cx = 0;
    let cy = 0;
    let cs = 0;
    let frame = 0;

    const write = () => {
      el.style.setProperty("--mx", cx.toFixed(4));
      el.style.setProperty("--my", cy.toFixed(4));
      el.style.setProperty("--sy", cs.toFixed(4));
    };

    const settled = () =>
      Math.abs(tx - cx) < 0.0008 && Math.abs(ty - cy) < 0.0008 && Math.abs(ts - cs) < 0.0008;

    const tick = () => {
      cx += (tx - cx) * 0.085;
      cy += (ty - cy) * 0.085;
      cs += (ts - cs) * 0.12;
      if (settled()) {
        cx = tx;
        cy = ty;
        cs = ts;
        write();
        frame = 0;
        return;
      }
      write();
      frame = requestAnimationFrame(tick);
    };

    const run = () => {
      if (frame === 0) frame = requestAnimationFrame(tick);
    };

    const onMove = (e: Event) => {
      const p = e as PointerEvent;
      const r = host.getBoundingClientRect();
      tx = clamp((p.clientX - (r.left + r.width / 2)) / (r.width / 2), -1, 1);
      ty = clamp((p.clientY - (r.top + r.height / 2)) / (r.height / 2), -1, 1);
      run();
    };

    const onLeave = () => {
      tx = 0;
      ty = 0;
      run();
    };

    const onScroll = () => {
      const r = el.getBoundingClientRect();
      ts = clamp(-r.top / Math.max(window.innerHeight, 1), -0.5, 1.5);
      run();
    };

    host.addEventListener("pointermove", onMove, { passive: true });
    host.addEventListener("pointerleave", onLeave);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    return () => {
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("scroll", onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div className="lp-stage">
      <div className="lp-art" ref={art} aria-hidden="true">
        <span className="lp-chip">agent.yourname.eth</span>

        {SPARKS.map((c) => (
          <svg key={c} className={"lp-spark " + c} viewBox="0 0 24 24" width="24" height="24">
            <path
              d="M12 0 L14.6 9.4 L24 12 L14.6 14.6 L12 24 L9.4 14.6 L0 12 L9.4 9.4 Z"
              fill="#FFC42E"
              stroke="#12203F"
              strokeWidth="1.7"
              strokeLinejoin="round"
            />
          </svg>
        ))}

        {FLOATS.map((f) => (
          <span key={f.cls} className={"lp-float " + f.cls}>
            <span className="lp-bob">
              <Capsule size={f.size} cap={f.cap} />
            </span>
          </span>
        ))}

        <span className="lp-mark">
          <span className="lp-mark-in">
            <Capsule size={182} cap="#FF4D8D" />
          </span>
        </span>

        <span className="lp-note">Your name. Your authority.</span>
      </div>
    </div>
  );
}
