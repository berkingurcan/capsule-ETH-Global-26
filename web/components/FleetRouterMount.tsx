"use client";

/**
 * Loads `FleetRouter` out of the critical path.
 *
 * `FleetRouter` calls `useWallet`, and importing that from a route chunk drags
 * the wallet module graph in with it — measured at +96 kB of First Load JS on
 * /fleet, which is the one page in this app that a visitor is most likely to
 * open cold and read without ever connecting anything. The redirect it performs
 * cannot happen before hydration anyway, so nothing is lost by fetching it after
 * paint.
 *
 * `ssr: false` needs a client component to live in, which is the only reason
 * this wrapper exists rather than a `dynamic()` call in the page itself.
 */

import dynamic from "next/dynamic";

const FleetRouter = dynamic(() => import("./FleetRouter"), { ssr: false });

export default function FleetRouterMount({ showing }: { showing: string }) {
  return <FleetRouter showing={showing} />;
}
