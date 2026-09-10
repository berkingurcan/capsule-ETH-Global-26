/**
 * Display helpers shared by the fleet views.
 *
 * `ago` takes a unix timestamp because that is what a block carries. It
 * deliberately renders `null` as "never" rather than "just now" or an empty
 * string: on this dashboard a missing timestamp means the write never happened,
 * and that is a fact worth stating rather than hiding.
 *
 * It also takes `now` explicitly, and callers in client components MUST pass
 * the server's read time rather than letting it default. Every one of these
 * components is server-rendered and then hydrated, so a default of
 * `Date.now()` is evaluated twice against two different clocks — "12h 41m ago"
 * on the server, "12h 42m ago" in the browser a moment later — and React
 * reports that as a hydration mismatch. Passing the block-read timestamp makes
 * both passes agree by construction, and has the side benefit of being the
 * honest number: these values are as of the block they were read at, not as of
 * whenever the viewer's tab happens to be open.
 */

export function ago(timestamp: number | null, now = Math.floor(Date.now() / 1000)): string {
  if (timestamp === null) return "never";
  return duration(Math.max(0, now - timestamp)) + " ago";
}

export function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

/** `0x8be32a8d…4f19` — enough to recognise, short enough for a table cell. */
export function shortHex(value: string, lead = 6, tail = 4): string {
  if (value.length <= lead + tail + 3) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

export const EXPLORER = "https://sepolia.etherscan.io";

export function txUrl(hash: string): string {
  return `${EXPLORER}/tx/${hash}`;
}

export function addressUrl(address: string): string {
  return `${EXPLORER}/address/${address}`;
}
