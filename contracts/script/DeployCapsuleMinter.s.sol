// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {CapsuleMinter} from "../src/CapsuleMinter.sol";
import {IPermissionedRegistry, IPermissionedResolver} from "../src/interfaces/IENSv2.sol";

/// @notice Deploys `CapsuleMinter` and grants it the three role sets it cannot mint without.
///
/// Deploying alone is not enough. The minter needs, in one transaction each:
///   * `ROLE_REGISTRAR` on our PermissionedRegistry — to register subnames at all
///   * `ROLE_SET_TEXT | ROLE_SET_ADDR` at root on our resolver — to write config records
///   * `ROLE_SET_TEXT_ADMIN | ROLE_SET_ADDR_ADMIN` at root — to delegate the heartbeat key
///
/// Root-level, because none of the agent names exist yet.
///
/// Run with:
///   forge script script/DeployCapsuleMinter.s.sol --rpc-url sepolia --broadcast
contract DeployCapsuleMinter is Script {
    /// @dev `RegistryRolesLib.ROLE_REGISTRAR`. Note this is the REGISTRY's role table,
    ///      which is a different set of meanings from the resolver's.
    uint256 constant ROLE_REGISTRAR = 1 << 0;

    function run() external {
        address registry = vm.envAddress("SUBREGISTRY");
        address resolver = vm.envAddress("CAPSULE_RESOLVER");
        bytes32 parentNode = vm.envBytes32("PARENT_NODE");
        bytes memory parentDns = vm.envBytes("PARENT_DNS");
        uint64 duration = uint64(vm.envOr("CAPSULE_DURATION", uint256(90 days)));
        // ENSIP-27 `schema`, written on every name. Environment-specific, so it is an
        // argument rather than a constant: preview and production serve it from
        // different hosts, and a name pointing at a schema that 404s is worse than none.
        string memory schemaUri = vm.envString("CAPSULE_SCHEMA_URI");

        vm.startBroadcast();

        CapsuleMinter minter = new CapsuleMinter(
            IPermissionedRegistry(registry),
            IPermissionedResolver(resolver),
            parentNode,
            parentDns,
            duration,
            schemaUri
        );

        IPermissionedRegistry(registry).grantRootRoles(ROLE_REGISTRAR, address(minter));
        IPermissionedResolver(resolver).grantRootRoles(
            minter.REQUIRED_RESOLVER_ROOT_ROLES(), address(minter)
        );

        // Fails loudly here rather than inside a user's first mint.
        minter.checkResolverRoles();

        vm.stopBroadcast();

        console.log("CapsuleMinter:", address(minter));
        // The ENSIP-25 `<registry>` half. Derived from block.chainid and address(this),
        // so it is new with every deployment — RECORDS.md's worked example must be
        // updated to whatever this prints.
        console.log("ERC-7930 registry:", minter.REGISTRY_INTEROP_ADDRESS());
        console.log("registrar role granted:", IPermissionedRegistry(registry).hasRoles(0, ROLE_REGISTRAR, address(minter)));
    }
}
