// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {CapsuleMinter} from "../src/CapsuleMinter.sol";

/// @notice Deploys `CapsuleMinter`. Once, for every name that will ever use it.
///
/// This script no longer grants anything, and no longer knows a parent name. The minter
/// is parent-agnostic: it holds a registry of names that have connected themselves to it,
/// and each name's own admin does the connecting. Wiring the first parent — including
/// `capsulefleet.eth` — is `ConnectParent.s.sol`, and that script is what the roles moved
/// to.
///
/// The split is not cosmetic. Granting from here only ever worked because the deployer
/// happened to be `capsulefleet.eth`'s admin; a second name has a different admin, who
/// cannot be asked to redeploy a contract in order to use it.
///
/// Run with:
///   forge script script/DeployCapsuleMinter.s.sol --rpc-url sepolia --broadcast
contract DeployCapsuleMinter is Script {
    function run() external {
        uint64 duration = uint64(vm.envOr("CAPSULE_DURATION", uint256(90 days)));
        // ENSIP-27 `schema`, written on every name. Environment-specific, so it is an
        // argument rather than a constant: preview and production serve it from
        // different hosts, and a name pointing at a schema that 404s is worse than none.
        string memory schemaUri = vm.envString("CAPSULE_SCHEMA_URI");

        vm.startBroadcast();
        CapsuleMinter minter = new CapsuleMinter(duration, schemaUri);
        vm.stopBroadcast();

        console.log("CapsuleMinter:", address(minter));
        // The ENSIP-25 `<registry>` half. Derived from block.chainid and address(this),
        // so it is new with every deployment — RECORDS.md's worked example must be
        // updated to whatever this prints.
        console.log("ERC-7930 registry:", minter.REGISTRY_INTEROP_ADDRESS());
        console.log("");
        console.log("Next: connect a parent name.");
        console.log("  MINTER=%s forge script script/ConnectParent.s.sol --rpc-url sepolia --broadcast", address(minter));
    }
}
