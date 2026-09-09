/**
 * Finding the user's wallet, without picking one for them.
 *
 * `window.ethereum` is a single slot that every injected wallet fights over.
 * With two extensions installed the loser is invisible and the winner is
 * whichever injected last — which is not a thing the user chose, and not a
 * thing we can detect after the fact. A judge with both MetaMask and Rabby
 * installed is the normal case at a hackathon, not the edge one.
 *
 * EIP-6963 fixes this by inverting it: wallets announce themselves on an
 * event, we collect the announcements, and the user picks. Every wallet
 * shipping today supports it.
 *
 * `window.ethereum` remains as a last resort, because a wallet that announces
 * nothing and injects anyway still works — it just cannot be named.
 */

/** The subset of EIP-1193 we actually call. */
export type Eip1193Provider = {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
  on?(event: string, handler: (payload: never) => void): void;
  removeListener?(event: string, handler: (payload: never) => void): void;
};

/** EIP-6963's provider metadata. `rdns` is the stable id; `uuid` changes per page load. */
export type WalletInfo = {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
};

export type DiscoveredWallet = {
  info: WalletInfo;
  provider: Eip1193Provider;
};

/** The rdns we invent for an unannounced `window.ethereum`. */
export const INJECTED_RDNS = "injected.unknown";

type AnnounceEvent = CustomEvent<DiscoveredWallet>;

let wallets: DiscoveredWallet[] = [];
let listeners = new Set<() => void>();
let started = false;

function emit() {
  for (const l of listeners) l();
}

function onAnnounce(event: Event) {
  const detail = (event as AnnounceEvent).detail;
  if (!detail?.info?.rdns || !detail.provider) return;
  // Wallets re-announce on every request broadcast. Key on rdns, not uuid:
  // uuid is per-page-load, so keying on it would grow the list on each poll.
  if (wallets.some((w) => w.info.rdns === detail.info.rdns)) return;
  wallets = [...wallets, detail];
  emit();
}

/**
 * Adds `window.ethereum` only if nothing announced itself.
 *
 * Running this unconditionally would double-list every modern wallet, since
 * they both announce AND inject.
 */
function addInjectedFallback() {
  if (wallets.length > 0) return;
  const injected = (window as { ethereum?: Eip1193Provider }).ethereum;
  if (injected === undefined) return;
  wallets = [
    {
      info: { uuid: INJECTED_RDNS, name: "Browser wallet", icon: "", rdns: INJECTED_RDNS },
      provider: injected,
    },
  ];
  emit();
}

function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  // Extensions that inject late miss the first broadcast. Two cheap re-asks
  // cover the common case without polling forever.
  setTimeout(() => window.dispatchEvent(new Event("eip6963:requestProvider")), 300);
  setTimeout(() => {
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    addInjectedFallback();
  }, 1000);
}

export function subscribeWallets(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Must return a stable reference between changes — React compares snapshots by
 * identity and will loop forever on a fresh array each call.
 */
export function getWallets(): DiscoveredWallet[] {
  return wallets;
}

/** The server renders no wallets; discovery is a browser-only event. */
export function getServerWallets(): DiscoveredWallet[] {
  return EMPTY;
}

const EMPTY: DiscoveredWallet[] = [];

export function findWallet(rdns: string): DiscoveredWallet | undefined {
  return wallets.find((w) => w.info.rdns === rdns);
}
