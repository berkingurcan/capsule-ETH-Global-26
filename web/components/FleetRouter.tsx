"use client";

/**
 * Sends a bare /fleet to the fleet the visitor actually has.
 *
 * `/fleet` with no `?parent=` means "the deployment's default", which is right
 * for a stranger and wrong for everyone who has used the app: they mint under
 * their own name, click Fleet, and land on a dashboard of somebody else's agents
 * — or, worse, on an empty one, which reads as "the mint failed".
 *
 * Doing it here rather than on each link is deliberate. The Fleet button lives in
 * the nav on every page, and there are four other routes into /fleet plus
 * bookmarks and typed URLs; fixing the destination once covers all of them, and
 * a link that is only correct when someone remembered to qualify it will
 * eventually be added unqualified again.
 *
 * It has to be a client component because the parent is derived from the
 * connected wallet, and the wallet exists only in the browser — the server
 * rendering /fleet has no idea who is looking at it.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useWallet } from "@/lib/wallet/WalletProvider";

type Parent = { name: string; open: boolean; minted: number; connectedByOwner: boolean };

export default function FleetRouter({ showing }: { showing: string }) {
  const { address } = useWallet();
  const router = useRouter();
  const [parents, setParents] = useState<Parent[] | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (address === null) {
      setParents(null);
      return;
    }

    // `cancelled` rather than an AbortController on the fetch: the request is
    // cheap and idempotent, and what actually matters is not writing state for a
    // wallet the user has already switched away from.
    let cancelled = false;
    setChecking(true);
    fetch(`/api/capsule/parents?owner=${address}`)
      .then((response) => (response.ok ? response.json() : { parents: [] }))
      .then((body: { parents?: Parent[] }) => {
        if (cancelled) return;
        const found = body.parents ?? [];
        setParents(found);
        // One name is not a choice, so do not make the user click it. `replace`
        // rather than `push` so Back leaves /fleet instead of bouncing between
        // the default and the real one.
        if (found.length === 1 && found[0].name !== showing) {
          router.replace(`/fleet?parent=${encodeURIComponent(found[0].name)}`);
        }
      })
      .catch(() => {
        // The default fleet is already rendered underneath. A failed lookup costs
        // the redirect, not the page.
        if (!cancelled) setParents([]);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });

    return () => {
      cancelled = true;
    };
  }, [address, showing, router]);

  if (address === null) return null;
  if (checking) {
    return (
      <p className="hint" style={{ marginBottom: 18 }}>
        Checking which names this wallet has…
      </p>
    );
  }

  const others = (parents ?? []).filter((parent) => parent.name !== showing);
  if (others.length === 0) return null;

  // Two or more names is a genuine choice and the app must not guess. This is the
  // case a remembered "last parent" could not represent at all: a wallet that has
  // agents under several names has several fleets, and only its owner knows which
  // one they meant.
  return (
    <div className="panel pad" style={{ marginBottom: 22 }}>
      <div className="label">Your other names</div>
      <p className="hint" style={{ margin: "6px 0 12px" }}>
        This wallet has minted or connected {others.length === 1 ? "another name" : `${others.length} other names`}.
        Each one has its own fleet.
      </p>
      <div className="row wrapflex" style={{ gap: 10 }}>
        {others.map((parent) => (
          <Link
            key={parent.name}
            href={`/fleet?parent=${encodeURIComponent(parent.name)}`}
            className="btn btn-sm"
          >
            {parent.name}
            <span className="hint" style={{ marginLeft: 8 }}>
              {parent.minted > 0
                ? `${parent.minted} agent${parent.minted === 1 ? "" : "s"}`
                : "connected, no agents yet"}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
