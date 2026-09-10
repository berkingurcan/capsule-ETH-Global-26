#!/usr/bin/env node
/**
 * `capsule-wallet` — what the model actually runs.
 *
 * This is the agent's side of the teller window. It holds no key, signs nothing
 * and decides nothing: it turns a command line into an HTTP request to the
 * supervisor, which owns all three. A refusal printed by this script was decided
 * by `checkSpend` in the supervisor against records on the ENS name, and no
 * argument to this script can change that answer.
 *
 * ## Why this file is plain .mjs with no imports
 *
 * The rest of the runner is TypeScript run through `tsx`, which lives in
 * `/capsule/node_modules`. This script is executed by the *gateway's* child
 * process, from the gateway's working directory, through a shell the model
 * chose. `node --import tsx` resolves `tsx` relative to the current directory,
 * so the same command that works from `/capsule` fails from the workspace — and
 * it fails at the moment an agent is trying to move money, which is the worst
 * time to discover a module resolution problem.
 *
 * Node builtins and `fetch` only. There is nothing here to resolve.
 */

const URL_ = process.env.CAPSULE_WALLET_URL;
const TOKEN = process.env.CAPSULE_WALLET_TOKEN;

const USAGE = `capsule-wallet — spend from this capsule's own wallet

  capsule-wallet status
      Balance, spendable amount, per-transaction cap, and where you may send.
      Always run this first: the cap is set on chain by your owner and can
      change between one message and the next.

  capsule-wallet send <to> <eth> [note]
      Send ETH. <eth> is a decimal amount, e.g. 0.01
      Refused if it is over the cap, outside the allowlist, or would eat the
      gas held back for your heartbeat.

  capsule-wallet call <to> <0xcalldata> [eth]
      Call a contract. The target must be named in agent-spend-allow on your
      name — "any" does not cover calldata.

Every refusal is a decision your owner made in a text record on your ENS name.
Report it and stop; there is no flag, phrasing or retry that changes it.`;

function die(message, code = 1) {
  console.error(message);
  process.exit(code);
}

async function request(path, method, body) {
  // Checked here rather than at the top of the file, so `--help` still answers
  // in a capsule that has no broker. An agent that cannot spend should still be
  // able to find out what it would be able to do, and discovering the tool by
  // running it with no arguments is the first thing a model tries.
  if (URL_ === undefined || TOKEN === undefined) {
    die(
      "capsule-wallet is not available in this capsule — CAPSULE_WALLET_URL or CAPSULE_WALLET_TOKEN is unset.\n" +
        "The supervisor did not start a wallet broker, so there is no route by which you can spend.\n" +
        "This is an operator setting, not a permission your owner withheld. Report it as such.",
    );
  }

  let response;
  try {
    response = await fetch(`${URL_}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    die(`could not reach the supervisor's wallet broker — ${error.message}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    die(`the wallet broker answered ${response.status} with something that was not JSON`);
  }

  return { status: response.status, payload };
}

const [command, ...args] = process.argv.slice(2);

if (command === undefined || command === "help" || command === "--help" || command === "-h") {
  console.log(USAGE);
  process.exit(0);
}

if (command === "status") {
  const { status, payload } = await request("/status", "GET");
  if (status !== 200) die(`status failed — ${payload.error ?? status}`);

  const sent = payload.transactionsThisRun;
  const lines = [`spending    ${payload.enabled ? "ENABLED" : "OFF"} — ${payload.policy}`, `wallet      ${payload.address}`];

  if (payload.enabled) {
    lines.push(
      `spendable   ${payload.spendableEth} ETH  (this transaction, after the heartbeat reserve)`,
      `cap         ${payload.capEth} ETH        (agent-spend-cap, set by your owner)`,
      `send to     ${payload.allow === "any" ? "any address" : payload.allow.join(", ")}`,
      // Only meaningful while there is a cap: the ceiling is derived from it, so
      // with spending off this reads "0.005 ETH of 0 ETH" and looks like a bug.
      `this run    ${payload.spentThisRunEth} ETH of ${payload.runCeilingEth} ETH, ${sent} transaction${sent === 1 ? "" : "s"}`,
    );
  } else {
    lines.push(
      `balance     ${payload.balanceEth} ETH  (yours, but you cannot move it right now)`,
      `this run    ${sent} transaction${sent === 1 ? "" : "s"}`,
      "",
      "Only your owner can turn this on, by writing agent-spend-cap on your name.",
      "Report that and stop — there is nothing for you to retry.",
    );
  }

  console.log(lines.join("\n"));
  process.exit(0);
}

if (command === "send") {
  const [to, eth, ...note] = args;
  if (to === undefined || eth === undefined) die(`usage: capsule-wallet send <to> <eth> [note]\n\n${USAGE}`);

  const { status, payload } = await request("/send", "POST", {
    to,
    value: eth,
    note: note.join(" "),
  });

  if (status !== 200) die(`REFUSED — ${payload.error}`);
  if (payload.ok === false) die(`REVERTED — ${payload.error}\n  tx ${payload.hash}`);

  console.log(
    [
      `sent        ${payload.valueEth} ETH`,
      `to          ${payload.to}`,
      `tx          ${payload.hash}`,
      `block       ${payload.blockNumber}  ·  ${payload.gasUsed} gas`,
      `this run    ${payload.spentThisRunEth} ETH total`,
    ].join("\n"),
  );
  process.exit(0);
}

if (command === "call") {
  const [to, data, eth] = args;
  if (to === undefined || data === undefined) {
    die(`usage: capsule-wallet call <to> <0xcalldata> [eth]\n\n${USAGE}`);
  }

  const { status, payload } = await request("/call", "POST", { to, data, value: eth ?? "0" });

  if (status !== 200) die(`REFUSED — ${payload.error}`);
  if (payload.ok === false) die(`REVERTED — ${payload.error}\n  tx ${payload.hash}`);

  console.log(
    [`called      ${payload.to}`, `tx          ${payload.hash}`, `block       ${payload.blockNumber}  ·  ${payload.gasUsed} gas`].join(
      "\n",
    ),
  );
  process.exit(0);
}

die(`unknown command "${command}"\n\n${USAGE}`);
