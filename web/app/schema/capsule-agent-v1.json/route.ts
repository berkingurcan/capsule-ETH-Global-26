/**
 * GET /schema/capsule-agent-v1.json — the ENSIP-27 schema for our own keys.
 *
 * The directory is named `capsule-agent-v1.json` on purpose: App Router turns
 * the path into the URL, so a segment ending in `.json` is how a route handler
 * serves a URL that looks like a file. It is a file to everyone who fetches it
 * and a handler to us, which is what lets `$id` reflect the host it was served
 * from.
 *
 * This URL is load-bearing in a way the rest of the app is not. Every name
 * `CapsuleMinter` has minted carries it in its `schema` record, permanently —
 * the URI is a constructor argument, so it cannot be corrected after the fact
 * for names that already exist. **It must not move, and it must not 404.**
 *
 * Deliberately unauthenticated, env-free and dependency-free. It reads no
 * database, no chain and no environment: the one thing this route must never do
 * is fail for a reason unrelated to itself. `/api/health` can 503; this cannot.
 */
import { capsuleAgentSchema } from "@/lib/capsule/schema";

export const runtime = "nodejs";

export function GET(request: Request): Response {
  // The URI it was actually fetched from, minus query and fragment. Preview and
  // production serve the same document from different hosts and a `$id` that
  // disagrees with the fetch URL will not resolve against itself.
  const url = new URL(request.url);
  const id = `${url.origin}${url.pathname}`;

  // Indented, because the audience is half validators and half people reading
  // it in a browser tab to check a claim.
  const body = JSON.stringify(capsuleAgentSchema(id), null, 2);

  return new Response(`${body}\n`, {
    status: 200,
    headers: {
      // The registered media type for JSON Schema. A validator expects it; a
      // browser will offer to save the file rather than pretty-print it, which
      // is the correct trade in that order.
      "content-type": "application/schema+json; charset=utf-8",
      // An ENS client resolving a name in a browser fetches this cross-origin.
      // Without this header "legible to any client" is only true server-side.
      "access-control-allow-origin": "*",
      // Versioned in its filename and permanent by construction, so it is safe
      // to cache hard. A v2 is a different URL and a different minter.
      "cache-control": "public, max-age=3600, s-maxage=86400, immutable",
    },
  });
}
