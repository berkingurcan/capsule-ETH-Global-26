// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {CapsuleMinter} from "../src/CapsuleMinter.sol";
import {IPermissionedRegistry} from "../src/interfaces/IENSv2.sol";

/// @notice Mints the demo fleet onto a freshly deployed `CapsuleMinter`.
///
/// The fleet is a literal table below rather than an argument, because it *is* a
/// fixture: four named capsules under `capsulefleet.eth` that the dashboard and the
/// demo script both assume. Real minting goes through the web provisioner, which
/// builds the same struct from a user's order.
///
/// @dev Re-minting a label that already exists needs `unregister` first — `register`
///      reverts while a live registration stands. Re-registering issues a NEW tokenId
///      (the low bits carry a version) but the **namehash does not change**, so the old
///      resolver records and EAC grants on that node survive the burn. This script does
///      not clean them; see the cast recipes in NOTES.md, because deciding what to wipe
///      is a judgement call and doing it inside a broadcast makes it invisible.
///
/// Run with:
///   forge script script/MintCapsules.s.sol --rpc-url sepolia --broadcast
contract MintCapsules is Script {
    struct Capsule {
        string label;
        string context;
        string telegramUrl;
        string promptRef;
    }

    function run() external {
        address registry = vm.envAddress("SUBREGISTRY");
        address minterAddress = vm.envAddress("MINTER");
        address owner = vm.envAddress("ADDRESS");
        address agent = vm.envAddress("AGENT_ADDRESS");
        string memory endpoint = vm.envString("CAPSULE_ENDPOINT");
        string memory model = vm.envOr("CAPSULE_MODEL", string("claude-opus-5"));
        string memory runtime = vm.envOr("CAPSULE_RUNTIME", string("openclaw"));

        CapsuleMinter minter = CapsuleMinter(minterAddress);
        Capsule[4] memory fleet = _fleet();

        // Fails here rather than inside the first mint, after gas has been spent.
        minter.checkResolverRoles();

        vm.startBroadcast();

        for (uint256 i = 0; i < fleet.length; i++) {
            Capsule memory c = fleet[i];

            uint256 existing = IPermissionedRegistry(registry).findTokenId(c.label);
            if (IPermissionedRegistry(registry).findOwner(c.label) != address(0)) {
                console.log("unregister:", c.label, existing);
                IPermissionedRegistry(registry).unregister(existing);
            }

            (uint256 tokenId,) = minter.mint(
                c.label,
                owner,
                agent,
                CapsuleMinter.CapsuleConfig({
                    context: c.context,
                    telegramUrl: c.telegramUrl,
                    capsuleEndpoint: endpoint,
                    model: model,
                    runtime: runtime,
                    promptPointer: c.promptRef
                })
            );

            console.log("minted:", c.label, tokenId);
            console.log("  ensip-25 key:", minter.registrationKey(tokenId));
        }

        vm.stopBroadcast();
    }

    /// @dev `agent-context` is what a generic ENS client shows a human who resolves the
    ///      name, so it is written for that reader and not for us.
    ///
    ///      The Telegram handles are the ones Phase 5 must register. They are the one
    ///      field here that is a promise rather than a fact — if a handle turns out to
    ///      be taken, the owner rewrites the record with one `setText`.
    function _fleet() internal view returns (Capsule[4] memory) {
        return [
            Capsule({
                label: "trader",
                context: "Trading desk for the Capsule demo fleet. Watches ETH/USDC on Sepolia and answers questions about price and size. Holds no funds and no keys beyond its own identity.",
                telegramUrl: "https://t.me/capsulefleet_trader_bot",
                promptRef: vm.envString("REF_TRADER")
            }),
            Capsule({
                label: "dev",
                context: "Build assistant for the Capsule demo fleet. Answers questions about the contracts, the runner and the ENS records that configure them.",
                telegramUrl: "https://t.me/capsulefleet_dev_bot",
                promptRef: vm.envString("REF_DEV")
            }),
            Capsule({
                label: "marketing",
                context: "Writer for the Capsule demo fleet. Explains what Capsule is to people who have never used ENS.",
                telegramUrl: "https://t.me/capsulefleet_marketing_bot",
                promptRef: vm.envString("REF_MARKETING")
            }),
            Capsule({
                label: "analyst",
                context: "Analyst for the Capsule demo fleet. Watches ETH/USDC on Sepolia and reports what changed and why it might matter. This is the capsule the live runner drives.",
                telegramUrl: "https://t.me/capsulefleet_analyst_bot",
                promptRef: vm.envString("REF_ANALYST")
            })
        ];
    }
}
