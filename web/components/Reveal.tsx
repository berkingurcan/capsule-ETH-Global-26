"use client";

import { useEffect, useRef } from "react";

/* Raises its children into place the first time they scroll into view.

   The hidden state is armed from JS rather than written into the stylesheet, so
   the markup ships visible: if this component never runs — no JS, a hydration
   error, prefers-reduced-motion — the content is simply there, which is the one
   failure mode a reveal effect must not get wrong. Anything already on screen
   when it arms is left alone rather than flickering out and back in. */

export default function Reveal({
  className,
  style,
  children,
}: {
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    /* already in view on load — nothing to reveal, and hiding it now would read
       as a flicker rather than an entrance */
    if (el.getBoundingClientRect().top < window.innerHeight * 0.85) return;

    el.classList.add("reveal");
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            el.classList.add("in");
            io.disconnect();
            return;
          }
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -6% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} className={className} style={style}>
      {children}
    </div>
  );
}
