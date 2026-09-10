/**
 * The three derivations in `src/records.ts` that fail silently.
 *
 * None of these would break a build, throw at runtime, or show up as an error
 * in the indexer's log. Each one produces a perfectly well-formed subgraph
 * that is quietly wrong about something:
 *
 *   textResourceOf   off by one byte and no `EACRolesChanged` ever matches a
 *                    capsule. Every recall silently disappears; the fleet
 *                    renders as if nothing was ever revoked. This is the same
 *                    failure mode `runner/src/records.ts` warns about, one
 *                    layer down — and there it cost an afternoon.
 *   decodeDnsName    off and every capsule is named `analyst.` or
 *                    `analyst.ethcapsulefleet`, which reads as a display bug
 *                    and is actually a parse bug.
 *   parseHeartbeat   off and beat sequences are all zero, which looks like an
 *                    agent that never incremented rather than a parser that
 *                    never parsed.
 *
 * The expected values are not hand-derived. They come from `viem` run against
 * the same inputs — the same library `web/lib/capsule/chain.ts` computes
 * `textResourceOf` with, and therefore the same answer the dashboard, the
 * runner and `CapsuleMinter.textResourceOf` all agree on:
 *
 *   node = namehash("analyst.capsulefleet.eth")
 *   BigInt(keccak256(encodeAbiParameters(
 *     [{type:"bytes32"},{type:"bytes32"}], [node, keccak256(toHex(key))])))
 */
import { assert, describe, test } from "matchstick-as/assembly/index";
import { BigInt, Bytes } from "@graphprotocol/graph-ts";
import {
  KEY_HEARTBEAT,
  decodeDnsName,
  nameResourceOf,
  parseHeartbeatSequence,
  textResourceOf,
} from "../src/records";

const NODE = "0x83bd3b6b2b881dcb8593a9a2fbcc5e4a03f257e5cae4836039ae47f908030501";

describe("EAC resource derivation", () => {
  test("textResourceOf matches CapsuleMinter.textResourceOf", () => {
    assert.stringEquals(
      "112999100897457151865099666008271846934381110111980911947534171495778201403110",
      textResourceOf(Bytes.fromHexString(NODE), KEY_HEARTBEAT),
    );
  });

  test("nameResourceOf matches resource(node, 0)", () => {
    assert.stringEquals(
      "108067390708427363455783106008310885678436020738406991881342057103459082627348",
      nameResourceOf(Bytes.fromHexString(NODE)),
    );
  });

  test("a different key derives a different resource", () => {
    // The whole point of PermissionedResolver: permission is per key, not per
    // name. If these two collided, an agent authorised for its heartbeat would
    // index as authorised for its own prompt.
    const heartbeat = textResourceOf(Bytes.fromHexString(NODE), KEY_HEARTBEAT);
    const prompt = textResourceOf(Bytes.fromHexString(NODE), "agent-prompt");
    assert.assertTrue(heartbeat != prompt);
  });
});

describe("DNS wire names", () => {
  test("decodes the parent the minter stores", () => {
    assert.stringEquals(
      "capsulefleet.eth",
      decodeDnsName(Bytes.fromHexString("0x0c63617073756c65666c6565740365746800")),
    );
  });

  test("an empty name decodes to an empty string, not a dot", () => {
    assert.stringEquals("", decodeDnsName(Bytes.fromHexString("0x00")));
  });

  test("a truncated name returns what it read rather than reading past the end", () => {
    // `0x03657468` with no root byte. Reading `length` past the buffer is how
    // an AssemblyScript mapping panics and takes the whole subgraph down.
    assert.stringEquals("eth", decodeDnsName(Bytes.fromHexString("0x03657468")));
  });
});

describe("heartbeat sequences", () => {
  test("beat-9 is 9", () => {
    assert.bigIntEquals(BigInt.fromI32(9), parseHeartbeatSequence("beat-9"));
  });

  test("a name that has never beaten is 0", () => {
    assert.bigIntEquals(BigInt.zero(), parseHeartbeatSequence(""));
  });

  test("multi-digit sequences survive", () => {
    assert.bigIntEquals(BigInt.fromI32(1024), parseHeartbeatSequence("beat-1024"));
  });

  test("anything unparseable is 0 rather than a panic", () => {
    // Tolerant on purpose, exactly as the runner's copy is: a capsule must not
    // fall out of the index because a curious owner wrote something odd into
    // a record the agent normally owns.
    assert.bigIntEquals(BigInt.zero(), parseHeartbeatSequence("alive"));
  });
});
