import ConnectName from "@/components/ConnectName";
import { loadServerEnv } from "@/lib/capsule/env";

/* A thin server shell around the client checklist, for one reason: the minter
   address.

   The browser genuinely needs it — every read and every transaction on this page
   is against that contract — but publishing it as a `NEXT_PUBLIC_` variable
   would add a second copy of a value the server already holds, and each copy is
   a place for the deployment to disagree with itself. A prop comes from the same
   `loadServerEnv()` every other server path uses, so it cannot drift. When it is
   missing the page still renders and says so, rather than checking names against
   `undefined`. */
export const dynamic = "force-dynamic";

export default async function ConnectPage() {
  let minter: string | null = null;
  try {
    minter = loadServerEnv().minterAddress;
  } catch {
    /* Reported on the page. */
  }

  return (
    <div className="page wrap">
      <ConnectName minter={minter} />
    </div>
  );
}
