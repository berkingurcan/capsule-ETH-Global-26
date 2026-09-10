/**
 * Proves the /register page's assumptions against the live chain.
 *
 * Almost everything on that page is a claim about contracts nobody in this repo
 * wrote, and three of the claims are the kind that look right until a user is
 * standing in front of a wallet:
 *
 *   1. **The payment tokens are accepted.** The registrar prices through a
 *      `RentPriceOracle` holding a whitelist; a token that is not on it reverts
 *      `PaymentTokenNotSupported`. Our list was read off that oracle's logs, and
 *      the oracle's owner can change it at any time.
 *   2. **`mintable` is true where we say it is.** The page offers a "mint some"
 *      button on the strength of that flag. It is a claim about access control
 *      on somebody else's token — the mocks let anyone call `mint`, Circle's
 *      USDC does not — and getting it backwards means either a dead button or a
 *      missing one.
 *   3. **The waiting period is what the countdown counts.** `MIN_COMMITMENT_AGE`
 *      is read live by the page, but a value far from 60s would mean the UI copy
 *      ("sixty seconds apart") is lying, so it is asserted here rather than only
 *      rendered.
 *
 * Run with:  npm run check:register
 */
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { ETH_REGISTRAR, PAYMENT_TOKENS, erc20Abi, ethRegistrarAbi } from "../lib/capsule/chain";
import { labelProblems } from "../lib/capsule/register";
import { encodeParent, parentBlocker, readParentStatus } from "../lib/capsule/parent";
import { loadServerEnv } from "../lib/capsule/env";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

/* Nobody in particular. Used to simulate `mint` from an address that has been
   granted nothing, which is the whole question: an open mint succeeds for a
   stranger, a gated one does not. */
const STRANGER = "0x000000000000000000000000000000000000bEEF" as const;

const YEAR = 31_536_000n;

async function main() {
  const env = loadServerEnv();
  const client = createPublicClient({ chain: sepolia, transport: http(env.rpcUrl) });
  const registrar = { address: ETH_REGISTRAR, abi: ethRegistrarAbi } as const;

  // 1. The commit/reveal window the page's countdown is built around.
  const [minAge, maxAge, minDuration] = await Promise.all([
    client.readContract({ ...registrar, functionName: "MIN_COMMITMENT_AGE" }),
    client.readContract({ ...registrar, functionName: "MAX_COMMITMENT_AGE" }),
    client.readContract({ ...registrar, functionName: "MIN_REGISTER_DURATION" }),
  ]);
  check("MIN_COMMITMENT_AGE is the 60s the page tells the user to wait", minAge === 60n, `${minAge}s`);
  check("MAX_COMMITMENT_AGE leaves room to be interrupted", maxAge >= 3600n, `${maxAge}s`);
  check(
    "the shortest duration offered clears MIN_REGISTER_DURATION",
    2_419_200n >= minDuration,
    `min ${minDuration}s`,
  );

  // 2. Availability, in both directions. A registrar that answered `true` for
  //    everything would let the page march someone all the way to a revert.
  const taken = await client.readContract({
    ...registrar,
    functionName: "isAvailable",
    args: ["capsulefleet"],
  });
  check("a registered name reads as unavailable", taken === false, "capsulefleet.eth");

  const probe = `capsule-probe-${Date.now().toString(36)}`;
  const free = await client.readContract({ ...registrar, functionName: "isAvailable", args: [probe] });
  check("an unregistered name reads as available", free === true, `${probe}.eth`);

  // 3. Every token we offer is one the oracle will actually price, and the
  //    decimals we format amounts with are the token's own.
  console.log("");
  for (const token of PAYMENT_TOKENS) {
    let price: readonly [bigint, bigint] | null = null;
    try {
      price = await client.readContract({
        ...registrar,
        functionName: "getRegisterPrice",
        args: [probe, YEAR, token.address],
      });
    } catch {
      price = null;
    }
    check(`${token.label} is accepted for payment`, price !== null, price === null ? "" : `${price[0]} base`);

    const decimals = await client
      .readContract({ address: token.address, abi: erc20Abi, functionName: "decimals" })
      .catch(() => null);
    check(
      `  its decimals match what we format with (${token.decimals})`,
      decimals !== null && Number(decimals) === token.decimals,
      decimals === null ? "the token has no decimals()" : `chain says ${decimals}`,
    );

    // The `mintable` claim, tested the only way that means anything: simulate the
    // call from an account holding no roles and see whether the token lets it.
    let openMint = false;
    try {
      await client.simulateContract({
        address: token.address,
        abi: erc20Abi,
        functionName: "mint",
        args: [STRANGER, 10n ** BigInt(token.decimals)],
        account: STRANGER,
      });
      openMint = true;
    } catch {
      openMint = false;
    }
    check(
      `  mintable=${token.mintable} matches the token's own access control`,
      openMint === token.mintable,
      openMint ? "anyone may mint" : "mint is gated",
    );
  }

  // 4. The label guard is a pure function, so it is asserted here rather than
  //    trusted: it is the only thing standing between a user and typing a full
  //    name into a field that wants a label.
  console.log("");
  check("a bare label passes the guard", labelProblems("berkin").length === 0);
  check("a full name is rejected", labelProblems("berkin.eth").length > 0);
  check("uppercase is rejected", labelProblems("Berkin").length > 0);
  check("two characters are rejected", labelProblems("ab").length > 0);

  /* The handoff /connect makes to this page turns on one bit: whether the name
     exists. It is the difference between telling somebody to buy a name and
     telling them their name has a permissions problem, so both answers are
     asserted against the chain rather than trusted. */
  console.log("");
  const minter = env.minterAddress as `0x${string}`;
  const anyone = "0x000000000000000000000000000000000000bEEF" as const;

  const live = await readParentStatus(client, minter, encodeParent("capsulefleet.eth"), anyone);
  check("a registered parent reads as registered", live.registered === true, "capsulefleet.eth");
  check("  and it has a subregistry, so /connect shows the checklist", live.registry !== null);

  const ghost = await readParentStatus(client, minter, encodeParent(`${probe}.eth`), anyone);
  check("an unregistered parent reads as unregistered", ghost.registered === false, `${probe}.eth`);
  check("  and it has no subregistry", ghost.registry === null);
  check(
    "  its blocker sends the user to buy it, not to fix permissions",
    (parentBlocker(ghost) ?? "").includes("registered"),
    parentBlocker(ghost) ?? "",
  );

  console.log(`\n${failures === 0 ? "register path OK" : `${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
