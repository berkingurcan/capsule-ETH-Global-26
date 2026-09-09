// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {CapsuleMinter} from "../src/CapsuleMinter.sol";
import {IPermissionedRegistry, IPermissionedResolver} from "../src/interfaces/IENSv2.sol";

/// @notice Connects ONE ENS name to an already-deployed `CapsuleMinter`, so capsules can
///         be minted under it. Run once per name, by that name's own admin.
///
/// Three things have to be true before `mint()` works for a name, and this script does all
/// three in one broadcast:
///
///   1. `ROLE_REGISTRAR` on the name's `PermissionedRegistry` — so the minter can register
///      subnames there at all.
///   2. `ROLE_SET_TEXT | ROLE_SET_ADDR` and both admin halves at ROOT on the name's
///      `PermissionedResolver` — so it can write the records and delegate the heartbeat
///      key. Root-level, because the capsule names do not exist yet.
///   3. `connectParent` — which stores the resolver and the DNS name against the registry,
///      so `mint()` takes only a registry and cannot be pointed at a mismatched triple.
///
/// The minter cannot do any of steps 1 and 2 for itself, which is the point: connecting is
/// something a name's owner does TO the minter, and revoking either role at any time takes
/// the capability back without this contract's cooperation.
///
/// @dev This is the browser flow in `web/app/connect` spelled as a script. Prefer the page
///      — it checks `readiness()` between steps and tells you which one is missing. This
///      exists for the demo parent, for CI, and for anyone who would rather not click.
///
/// The web app never needs the resolver address configured, because the minter stores it
/// here. Read it back with `minter.parentOf(registry)`.
///
/// Run with (capsulefleet.eth, the demo parent):
///   MINTER=0x… \
///   SUBREGISTRY=0x4d2b9DB6b011425F12F271Fa680b0ec8c2f0cd0e \
///   CAPSULE_RESOLVER=0x7C66eE081c5326478dCA44760f5Ab97cab8DE8C3 \
///   PARENT_DNS=0x0c63617073756c65666c6565740365746800 \
///   PARENT_OPEN=true \
///   forge script script/ConnectParent.s.sol --rpc-url sepolia --broadcast
contract ConnectParent is Script {
    /// @dev `RegistryRolesLib.ROLE_REGISTRAR`. Note this is the REGISTRY's role table,
    ///      which is a different set of meanings from the resolver's.
    uint256 constant ROLE_REGISTRAR = 1 << 0;

    function run() external {
        CapsuleMinter minter = CapsuleMinter(vm.envAddress("MINTER"));
        IPermissionedRegistry registry = IPermissionedRegistry(vm.envAddress("SUBREGISTRY"));
        IPermissionedResolver resolver = IPermissionedResolver(vm.envAddress("CAPSULE_RESOLVER"));
        bytes memory parentDns = vm.envBytes("PARENT_DNS");

        // Whether strangers may mint under this name, or only its own admins. `true` is
        // right for a demo parent people are invited to try; `false` is right for a name
        // somebody actually owns, and is the default here for that reason — an accidental
        // `true` hands out subnames of your name, and an accidental `false` costs one
        // `setParentOpen` call.
        bool open = vm.envOr("PARENT_OPEN", false);

        // Derived by the minter from the DNS name, never passed alongside it, so the two
        // cannot disagree. Printed here so the operator can eyeball it against `cast
        // namehash` before spending gas on the grants.
        bytes32 parentNode = minter.namehash(parentDns);
        console.log("parent node:", vm.toString(parentNode));

        vm.startBroadcast();

        registry.grantRootRoles(ROLE_REGISTRAR, address(minter));
        resolver.grantRootRoles(minter.REQUIRED_RESOLVER_ROOT_ROLES(), address(minter));
        minter.connectParent(registry, resolver, parentDns, open);

        vm.stopBroadcast();

        // Fails loudly here rather than inside a user's first mint. `readiness` is the
        // same view the launch form gates its buttons on, so a green line here and a
        // usable form are the same fact.
        (
            bool connected,
            bool registrarGranted,
            bool resolverRolesGranted,
            bool isOpen,
            bool deployerMayMint
        ) = minter.readiness(registry, msg.sender);

        console.log("connected:            ", connected);
        console.log("registrar granted:    ", registrarGranted);
        console.log("resolver roles granted:", resolverRolesGranted);
        console.log("open to anyone:       ", isOpen);
        console.log("this account may mint:", deployerMayMint);

        require(connected, "connectParent did not take");
        require(registrarGranted, "the minter cannot register subnames here");
        require(resolverRolesGranted, "the minter cannot write records here");
    }
}
