// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {CapsuleMinter} from "../src/CapsuleMinter.sol";
import {IPermissionedRegistry, IPermissionedResolver} from "../src/interfaces/IENSv2.sol";

/// @notice The whole connect-and-mint flow, against the live ENSv2 Sepolia beta.
///
/// `CapsuleMinter.t.sol` proves the contract's logic against mocks it also defines, which
/// is the right place for the record keys and the role arithmetic and useless for the one
/// question this refactor turns on: does `connectParent`'s two-way link check pass against
/// a registry ENS actually deployed? A mock that returns what the check wants proves
/// nothing about that, and getting it wrong means the contract is unusable on the chain it
/// was written for.
///
/// So this forks Sepolia, impersonates `capsulefleet.eth`'s owner, and runs the real
/// sequence: grant, grant, connect, mint. Everything it touches is a live address.
///
/// Run with:
///   forge test --match-path test/CapsuleMinterFork.t.sol --fork-url sepolia -vv
///
/// Skipped automatically when no fork is configured, so `forge test` stays offline.
contract CapsuleMinterForkTest is Test {
    // Live ENSv2 Sepolia beta — contracts/NOTES.md.
    address constant ETH_REGISTRY = 0xBDC85dD5b15D7ecb354cd7cb6f2c50b4f2c4F0E2;
    address constant SUBREGISTRY = 0x4d2b9DB6b011425F12F271Fa680b0ec8c2f0cd0e;
    address constant RESOLVER = 0x7C66eE081c5326478dCA44760f5Ab97cab8DE8C3;
    address constant OWNER = 0x9e0283E37bd2f2c6bEFC29b89CF2d86fe5b5fB71;

    bytes constant PARENT_DNS = hex"0c63617073756c65666c6565740365746800";
    bytes32 constant PARENT_NODE =
        0x036a91f25e11db713abf00b569adb0a03c248d7b9f291430dac6807860d4a6b3;

    uint256 constant ROLE_REGISTRAR = 1 << 0;

    address constant CAPSULE_OWNER = address(0xB0B);
    address constant AGENT = address(0xA6E7);
    address constant STRANGER = address(0xBEEF);

    string constant SCHEMA_URI = "https://capsule.example/schema/capsule-agent-v1.json";

    CapsuleMinter minter;

    /// @dev True only when `--fork-url` was given. Every test returns early otherwise, so
    ///      the offline suite is unaffected and CI without an RPC still passes.
    bool forked;

    function setUp() public {
        // `chainid` is 31337 on a bare anvil and 11155111 on a Sepolia fork.
        forked = block.chainid == 11155111;
        if (!forked) return;
        minter = new CapsuleMinter(90 days, SCHEMA_URI);
    }

    /// @dev The check that could not be written against a mock: ENS's own registries have
    ///      to agree, in both directions, that this registry is capsulefleet.eth's.
    function test_fork_connectParent_acceptsTheLiveCapsulefleetRegistry() public {
        if (!forked) return;
        _connect(true);

        (bool connected, bool open, IPermissionedResolver resolver, bytes32 node,,) =
            minter.parentOf(IPermissionedRegistry(SUBREGISTRY));

        assertTrue(connected);
        assertTrue(open);
        assertEq(address(resolver), RESOLVER);
        assertEq(node, PARENT_NODE, "namehash of the live DNS name must match cast namehash");
    }

    function test_fork_readiness_isGreenAfterConnecting() public {
        if (!forked) return;
        _connect(true);

        (bool connected, bool registrar, bool resolverRoles, bool open, bool mayMint) =
            minter.readiness(IPermissionedRegistry(SUBREGISTRY), STRANGER);

        assertTrue(connected, "connected");
        assertTrue(registrar, "ROLE_REGISTRAR on the live registry");
        assertTrue(resolverRoles, "root roles on the live resolver");
        assertTrue(open, "open");
        assertTrue(mayMint, "a stranger may mint under an open parent");
    }

    /// @dev The end of the line: a real subname, registered in ENS's registry, with records
    ///      read back out of ENS's resolver. If this passes on a fork it passes on chain.
    function test_fork_mint_writesRecordsReadableFromTheLiveResolver() public {
        if (!forked) return;
        _connect(true);

        string memory label = "forkcheck";
        _unregisterIfPresent(label);

        (uint256 tokenId, bytes32 node) = minter.mint(
            IPermissionedRegistry(SUBREGISTRY),
            label,
            CAPSULE_OWNER,
            AGENT,
            CapsuleMinter.CapsuleConfig({
                context: "A fork-test capsule.",
                telegramUrl: "https://t.me/forkcheckbot",
                capsuleEndpoint: "https://capsule.invalid",
                model: "anthropic/claude-opus-5",
                runtime: "openclaw",
                promptPointer: "cap_fork01"
            })
        );

        // The node the contract derived must be the node the live resolver stored under.
        assertEq(node, keccak256(abi.encodePacked(PARENT_NODE, keccak256(bytes(label)))));

        IPermissionedResolver resolver = IPermissionedResolver(RESOLVER);
        assertEq(resolver.text(node, "agent-model"), "anthropic/claude-opus-5");
        assertEq(resolver.text(node, "agent-runtime"), "openclaw");
        assertEq(resolver.text(node, "class"), "Agent");
        assertEq(resolver.text(node, minter.registrationKey(tokenId)), "1");

        // The name really is registered, to the owner we named.
        assertEq(IPermissionedRegistry(SUBREGISTRY).findOwner(label), CAPSULE_OWNER);

        // And the one claim the whole project rests on: the agent may write exactly one key.
        assertTrue(minter.isAgentAuthorized(IPermissionedRegistry(SUBREGISTRY), label, AGENT));
        assertFalse(
            resolver.hasRoles(
                minter.textResourceOf(node, "agent-prompt"), 1 << 4, AGENT
            ),
            "the agent must not be able to rewrite its own instructions"
        );
    }

    function test_fork_closedParent_refusesAStranger() public {
        if (!forked) return;
        _connect(false);

        vm.prank(STRANGER);
        vm.expectRevert(
            abi.encodeWithSelector(CapsuleMinter.ParentNotOpen.selector, SUBREGISTRY, STRANGER)
        );
        minter.mint(
            IPermissionedRegistry(SUBREGISTRY), "nope", CAPSULE_OWNER, AGENT, _emptyConfig()
        );
    }

    /// @dev A stranger cannot connect somebody else's name, however well-formed their
    ///      arguments are. This is the check that makes "one minter, many parents" safe.
    function test_fork_connectParent_refusesAStranger() public {
        if (!forked) return;
        vm.prank(STRANGER);
        vm.expectRevert(
            abi.encodeWithSelector(CapsuleMinter.NotParentAdmin.selector, SUBREGISTRY, STRANGER)
        );
        minter.connectParent(
            IPermissionedRegistry(SUBREGISTRY),
            IPermissionedResolver(RESOLVER),
            PARENT_DNS,
            true
        );
    }

    /// @dev A name with no subregistry cannot be connected by anyone, which is why the
    ///      /connect page reports that state separately: it is the one step Capsule cannot
    ///      perform on a user's behalf.
    function test_fork_aNameWithNoSubregistryHasNothingToConnect() public view {
        if (!forked) return;
        (bool ok, bytes memory data) = ETH_REGISTRY.staticcall(
            abi.encodeWithSignature("getSubregistry(string)", "berkin")
        );
        assertTrue(ok);
        assertEq(abi.decode(data, (address)), address(0), "berkin.eth has no subregistry yet");
    }

    ////////////////////////////////////////////////////////////////////////
    // helpers
    ////////////////////////////////////////////////////////////////////////

    /// @dev Exactly what `ConnectParent.s.sol` broadcasts, and what /connect sends.
    function _connect(bool open) internal {
        vm.startPrank(OWNER);
        IPermissionedRegistry(SUBREGISTRY).grantRootRoles(ROLE_REGISTRAR, address(minter));
        IPermissionedResolver(RESOLVER).grantRootRoles(
            minter.REQUIRED_RESOLVER_ROOT_ROLES(), address(minter)
        );
        minter.connectParent(
            IPermissionedRegistry(SUBREGISTRY),
            IPermissionedResolver(RESOLVER),
            PARENT_DNS,
            open
        );
        vm.stopPrank();
    }

    /// @dev `register` reverts while a live registration stands, and this label may survive
    ///      from an earlier fork run against a cached block.
    function _unregisterIfPresent(string memory label) internal {
        if (IPermissionedRegistry(SUBREGISTRY).findOwner(label) != address(0)) {
            uint256 existing = IPermissionedRegistry(SUBREGISTRY).findTokenId(label);
            vm.prank(OWNER);
            IPermissionedRegistry(SUBREGISTRY).unregister(existing);
        }
    }

    function _emptyConfig() internal pure returns (CapsuleMinter.CapsuleConfig memory) {
        return CapsuleMinter.CapsuleConfig("", "", "", "", "", "");
    }
}
