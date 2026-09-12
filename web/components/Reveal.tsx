"use client";

import { useEffect, useRef } from "react";

/* Raises its children into place the first time they scroll into view.

   The hidden state is armed from JS rather than written into the stylesheet, so
   the markup ships visible: if this component never runs — no JS, a hydration
   error, prefers-reduced-motion — the content is simply there, which is the one
   failure mode a reveal effect must not get wrong. Anything already on screen
   when it arms is left alone rather than flickering out and back in.

   This watches the scroll position rather than using an IntersectionObserver,
   which sounds like the wrong way round. An observer only reports threshold
   *crossings*, and a jump straight down the page — an anchor link, a restored
   scroll position on reload, Cmd+Down, a hard flick on a trackpad — can take a
   block from below the fold to above it inside one frame, crossing nothing the
   observer ever sees. The content then stays at opacity 0 for good. Comparing
   positions instead answers "is it past yet", which cannot be skipped. */

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

    /* "far enough up the screen to be worth revealing". The trigger line has to
       scale with the block, because a flat fraction of the viewport is a line
       that short content at the very end of the document can never cross: the
       footer comes to rest a little above the bottom edge and simply stays
       hidden. Asking instead for a slice of the element itself to be showing —
       capped so tall sections do not wait too long — is a question anything can
       eventually answer. */
    const arrived = () => {
      const r = el.getBoundingClientRect();
      return r.top < window.innerHeight - Math.min(80, r.height * 0.3);
    };

    /* already in view on load — nothing to reveal, and hiding it now would read
       as a flicker rather than an entrance */
    if (arrived()) return;

    el.classList.add("reveal");

    let frame = 0;
    let done = false;

    const finish = () => {
      done = true;
      el.classList.add("in");
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame !== 0) cancelAnimationFrame(frame);
    };

    const check = () => {
      frame = 0;
      if (!done && arrived()) finish();
    };

    function schedule() {
      if (frame === 0 && !done) frame = requestAnimationFrame(check);
    }

    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    schedule();

    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div ref={ref} className={className} style={style}>
      {children}
    </div>
  );
}
