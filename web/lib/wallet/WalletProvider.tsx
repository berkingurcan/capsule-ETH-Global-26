"use client";

/**
 * The wallet, as one hook.
 *
 * Deliberately not wagmi. The app needs four things — an address, the chain
 * it is on, a way to change that, and a viem WalletClient to sign with — and
 * viem is already a dependency because the server reads chain state with it.
 * A connector framework would add a large tree to do the same four things.
 *
 * Two rules this enforces rather than documents:
 *
 * 1. **The chain is checked, never assumed.** Every write in this app is a
 *    Sepolia write. A wallet sitting on mainnet that we do not notice sends a
 *    real transaction to an address that means nothing there. `chainOk` gates
 *    every button that signs.
 *
 * 2. **Reconnection is silent or it does not happen.** On load we ask
 *    `eth_accounts`, which reports an existing authorisation without
 *    prompting. `eth_requestAccounts` — the one that opens the popup — is
 *    only ever called from a click.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  getAddress,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import { CHAIN } from "@/lib/capsule/chain";
import {
  findWallet,
  getServerWallets,
  getWallets,
  INJECTED_RDNS,
  subscribeWallets,
  type DiscoveredWallet,
  type Eip1193Provider,
} from "./discovery";

/** Remembers which wallet, never whether it is authorised — the wallet owns that. */
const LAST_WALLET_KEY = "capsule.wallet.rdns";

export type WalletStatus = "disconnected" | "connecting" | "connected";

export type WalletState = {
  status: WalletStatus;
  address: Address | null;
  chainId: number | null;
  /** True only when connected AND on the chain every Capsule write targets. */
  chainOk: boolean;
  walletName: string | null;
  error: string | null;
  /** Everything EIP-6963 announced. Empty until the browser has run discovery. */
  wallets: DiscoveredWallet[];
  connect: (rdns?: string) => Promise<void>;
  disconnect: () => void;
  switchChain: () => Promise<void>;
  /** Null unless connected and on the right chain. Signing is not offered otherwise. */
  getWalletClient: () => WalletClient | null;
  /**
   * A read client over the *same* provider the user is signing with.
   *
   * The app needs one in the browser to simulate a mint and to wait for its
   * receipt, and the obvious way to get it — a `NEXT_PUBLIC_` RPC URL — would
   * publish an RPC key to every visitor. The wallet is already talking to this
   * chain on the user's behalf, so it is both the cheapest transport and the
   * honest one: the simulation runs against the node that will accept the
   * transaction, not against a different node that might disagree.
   */
  getPublicClient: () => PublicClient | null;
};

const WalletContext = createContext<WalletState | null>(null);

function readable(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const e = error as { code?: number; shortMessage?: string; message?: string };
    // 4001 is EIP-1193's "user rejected". Not an error worth a red banner.
    if (e.code === 4001) return "Request rejected in the wallet.";
    if (typeof e.shortMessage === "string") return e.shortMessage;
    if (typeof e.message === "string") return e.message.split("\n")[0]!.slice(0, 200);
  }
  return "Something went wrong talking to the wallet.";
}

function toChainId(raw: unknown): number | null {
  if (typeof raw === "string") {
    const n = Number.parseInt(raw, 16);
    return Number.isSafeInteger(n) ? n : null;
  }
  if (typeof raw === "number" && Number.isSafeInteger(raw)) return raw;
  return null;
}

function firstAddress(raw: unknown): Address | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const [first] = raw;
  if (typeof first !== "string") return null;
  try {
    return getAddress(first);
  } catch {
    return null;
  }
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const wallets = useSyncExternalStore(subscribeWallets, getWallets, getServerWallets);

  const [status, setStatus] = useState<WalletStatus>("disconnected");
  const [address, setAddress] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [walletName, setWalletName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** The live provider. A ref, not state: swapping it must not re-render. */
  const providerRef = useRef<Eip1193Provider | null>(null);

  const clear = useCallback(() => {
    providerRef.current = null;
    setStatus("disconnected");
    setAddress(null);
    setChainId(null);
    setWalletName(null);
  }, []);

  /** Binds a provider and reads its current account and chain. */
  const adopt = useCallback(
    async (wallet: DiscoveredWallet, prompt: boolean): Promise<boolean> => {
      const method = prompt ? "eth_requestAccounts" : "eth_accounts";
      const accounts = await wallet.provider.request({ method });
      const next = firstAddress(accounts);
      if (next === null) return false;

      const rawChain = await wallet.provider.request({ method: "eth_chainId" });
      providerRef.current = wallet.provider;
      setAddress(next);
      setChainId(toChainId(rawChain));
      setWalletName(wallet.info.name);
      setStatus("connected");
      try {
        window.localStorage.setItem(LAST_WALLET_KEY, wallet.info.rdns);
      } catch {
        /* private mode, or site data blocked. Reconnect is a convenience. */
      }
      return true;
    },
    [],
  );

  const connect = useCallback(
    async (rdns?: string) => {
      let target = rdns !== undefined ? findWallet(rdns) : undefined;
      if (!target) {
        if (wallets.length === 1) {
          target = wallets[0];
        } else if (wallets.length > 1) {
          // Prefer MetaMask if available, otherwise first wallet
          target =
            wallets.find(
              (w) =>
                w.info.rdns === "io.metamask" ||
                w.info.name.toLowerCase().includes("metamask"),
            ) ?? wallets[0];
        }
      }

      if (!target && typeof window !== "undefined") {
        const injected = (window as { ethereum?: Eip1193Provider & { isMetaMask?: boolean } }).ethereum;
        if (injected) {
          target = {
            info: {
              uuid: INJECTED_RDNS,
              name: injected.isMetaMask ? "MetaMask" : "Browser wallet",
              icon: "",
              rdns: injected.isMetaMask ? "io.metamask" : INJECTED_RDNS,
            },
            provider: injected,
          };
        }
      }

      if (target === undefined) {
        setError(
          wallets.length === 0
            ? "No Ethereum wallet found. Please install or enable MetaMask."
            : "Pick which wallet to connect.",
        );
        return;
      }

      setError(null);
      setStatus("connecting");
      try {
        const ok = await adopt(target, true);
        if (!ok) {
          setStatus("disconnected");
          setError("The wallet returned no accounts.");
        }
      } catch (e) {
        setStatus("disconnected");
        setError(readable(e));
      }
    },
    [wallets, adopt],
  );

  const disconnect = useCallback(() => {
    // EIP-1193 has no disconnect. This drops our handle; the wallet keeps its
    // authorisation, which is why reconnecting does not prompt again.
    try {
      window.localStorage.removeItem(LAST_WALLET_KEY);
    } catch {
      /* see above */
    }
    setError(null);
    clear();
  }, [clear]);

  const switchChain = useCallback(async () => {
    const provider =
      providerRef.current ??
      (typeof window !== "undefined"
        ? (window as { ethereum?: Eip1193Provider }).ethereum
        : null);
    if (provider === null || provider === undefined) return;
    const hexId = `0x${CHAIN.id.toString(16)}`;
    setError(null);
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
    } catch (e) {
      const code = (e as { code?: number }).code;

      // Sepolia (chain 11155111 / 0xaa36a7) is a default testnet in MetaMask.
      // Calling wallet_addEthereumChain for Sepolia causes MetaMask (v13.46+)
      // to crash with: "Cannot read properties of undefined (reading 'origin')"
      // because Sepolia cannot be added as a custom network.
      // Instead, instruct the user to toggle "Show test networks" in MetaMask.
      if (CHAIN.id === 11155111) {
        if (code === 4902) {
          setError(
            "Sepolia is not enabled in MetaMask. Open MetaMask, click the network dropdown (top-left), toggle 'Show test networks' ON, and select Sepolia.",
          );
        } else {
          setError(readable(e));
        }
        return;
      }

      // 4902: the wallet has never heard of this chain. Offer to add it.
      if (code !== 4902) {
        setError(readable(e));
        return;
      }
      try {
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: hexId,
              chainName: CHAIN.name,
              nativeCurrency: CHAIN.nativeCurrency,
              rpcUrls: [CHAIN.rpcUrls.default.http[0]],
              blockExplorerUrls: CHAIN.blockExplorers?.default?.url
                ? [CHAIN.blockExplorers.default.url]
                : [],
            },
          ],
        });
      } catch (addError) {
        setError(readable(addError));
      }
    }
  }, []);

  /* --- silent reconnect, once discovery has produced candidates --- */
  const tried = useRef(false);
  useEffect(() => {
    if (tried.current || wallets.length === 0 || status !== "disconnected") return;
    let remembered: string | null = null;
    try {
      remembered = window.localStorage.getItem(LAST_WALLET_KEY);
    } catch {
      /* see above */
    }
    if (remembered === null) return;
    const wallet = findWallet(remembered);
    if (wallet === undefined) return;
    tried.current = true;
    // eth_accounts, so this never opens a popup on page load.
    void adopt(wallet, false).catch(() => clear());
  }, [wallets, status, adopt, clear]);

  /* --- follow the wallet, do not cache what it tells us --- */
  useEffect(() => {
    const provider = providerRef.current;
    if (provider === null || provider.on === undefined) return;

    const onAccounts = (accounts: never) => {
      const next = firstAddress(accounts);
      // An empty array means the user disconnected the site from inside the
      // wallet. Treat it as a real disconnect rather than a stale address.
      if (next === null) clear();
      else setAddress(next);
    };
    const onChain = (raw: never) => setChainId(toChainId(raw));

    provider.on("accountsChanged", onAccounts);
    provider.on("chainChanged", onChain);
    return () => {
      provider.removeListener?.("accountsChanged", onAccounts);
      provider.removeListener?.("chainChanged", onChain);
    };
  }, [status, clear]);

  const chainOk = status === "connected" && chainId === CHAIN.id;

  const getWalletClient = useCallback((): WalletClient | null => {
    const provider = providerRef.current;
    if (provider === null || address === null || chainId !== CHAIN.id) return null;
    return createWalletClient({ account: address, chain: CHAIN, transport: custom(provider) });
  }, [address, chainId]);

  const getPublicClient = useCallback((): PublicClient | null => {
    const provider = providerRef.current;
    if (provider === null || chainId !== CHAIN.id) return null;
    return createPublicClient({ chain: CHAIN, transport: custom(provider) });
  }, [chainId]);

  const value = useMemo<WalletState>(
    () => ({
      status,
      address,
      chainId,
      chainOk,
      walletName,
      error,
      wallets,
      connect,
      disconnect,
      switchChain,
      getWalletClient,
      getPublicClient,
    }),
    [
      status,
      address,
      chainId,
      chainOk,
      walletName,
      error,
      wallets,
      connect,
      disconnect,
      switchChain,
      getWalletClient,
      getPublicClient,
    ],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (ctx === null) throw new Error("useWallet must be used inside <WalletProvider>");
  return ctx;
}

/** `0x1234…abcd`, the only address format this UI shows. */
export function shortAddress(address: Address | string): string {
  return address.slice(0, 6) + "…" + address.slice(-4);
}
