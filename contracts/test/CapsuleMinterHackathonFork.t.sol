// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {CapsuleMinter} from "../src/CapsuleMinter.sol";
import {IPermissionedRegistry, IPermissionedResolver} from "../src/interfaces/IENSv2.sol";

/// @dev `EnhancedAccessControl`'s initializer grant. Declared here rather than imported
///      because nothing else in this repo needs it.
struct Grant {
    address account;
    uint256 roleBitmap;
}

/// @notice The connect-and-mint flow against the ENS **hackathon** deployment.
///
/// `CapsuleMinterFork.t.sol` is the same flow against the ENSv2 beta. Both are needed and
/// neither substitutes for the other: the two deployments share a chain and a registry ABI
/// but not a resolver ABI, and the whole point of `Parent.inode` is to pick the right one
/// without being told. A mock cannot test that — it would be a mock of the very thing in
/// question.
///
/// Run with:
///   forge test --match-path test/CapsuleMinterHackathonFork.t.sol --fork-url sepolia -vv
///
/// Skipped automatically when no fork is configured, so `forge test` stays offline.
contract CapsuleMinterHackathonForkTest is Test {
    // The ENS hackathon deployment. Read off the portal's own bundle and verified on
    // chain; contracts/NOTES.md carries the full table.
    address constant ETH_REGISTRY = 0x1D78834d97c1D7b1A38c1deDBD1a287cFEd3971e;
    address constant VERIFIABLE_FACTORY = 0x894bc9cC8ff1ad96B8a288C86A8C71D662C07780;
    address constant USER_REGISTRY_IMPL = 0x47B442d0CF617c41CAbAFf5f02f44DD1e5f72546;
    address constant RESOLVER_IMPL = 0xa9d3814AB151BF6E37A427432795371a8361614e;

    // A second-level name that already exists on the hackathon deployment, and its owner.
    // Impersonated rather than registered, because registering one costs a commit, a
    // 60-second wait and a USDC balance to prove a point this test is not about.
    string constant PARENT_LABEL = "leash";
    address constant PARENT_OWNER = 0xf450d687863E9a86d440acD6dbf6D9973682962B;

    uint256 constant ALL_ROLES =
        0x1111111111111111111111111111111111111111111111111111111111111111;
    uint256 constant ROLE_REGISTRAR = 1 << 0;

    address constant CAPSULE_OWNER = address(0xB0B);
    address constant AGENT = address(0xA6E7);

    CapsuleMinter minter;
    IPermissionedRegistry registry;
    IPermissionedResolver resolver;
    bytes parentDns;

    function setUp() public {
        // `forge test` with no --fork-url leaves chainid 31337; skip rather than fail.
        if (block.chainid != 11155111) return;

        parentDns = _dnsEncodeEth(PARENT_LABEL);

        minter = new CapsuleMinter(90 days, "https://example.invalid/schema.json");

        vm.startPrank(PARENT_OWNER);

        // 1. The parent needs a subregistry. On this deployment that is a UserRegistry
        //    proxy, not a whole PermissionedRegistry — which is why the vendored bytecode
        //    in web/ has no job here.
        registry = IPermissionedRegistry(
            _deployProxy(USER_REGISTRY_IMPL, 1, abi.encodeWithSignature(
                "initialize((address,uint256)[])", _grants(PARENT_OWNER, ALL_ROLES)
            ))
        );

        // 2. Link it both ways, which is what `connectParent` insists on.
        uint256 parentTokenId = _findTokenId(PARENT_LABEL);
        (bool ok,) = ETH_REGISTRY.call(
            abi.encodeWithSignature("setSubregistry(uint256,address)", parentTokenId, address(registry))
        );
        require(ok, "setSubregistry failed");
        (ok,) = address(registry).call(
            abi.encodeWithSignature("setParent(address,string)", ETH_REGISTRY, PARENT_LABEL)
        );
        require(ok, "setParent failed");

        // 3. The parent's own resolver, and the minter's roles on it, in one deploy.
        resolver = IPermissionedResolver(
            // Salt 2, not 1: `VerifiableFactory` derives the proxy address from
            // (factory, deployer, salt) and ignores the implementation, so reusing a salt
            // across two different implementations is a CREATE2 collision, not a second
            // contract.
            _deployProxy(RESOLVER_IMPL, 2, abi.encodeWithSignature(
                "initialize((address,uint256)[],bytes[])",
                _grants2(PARENT_OWNER, ALL_ROLES, address(minter), minter.REQUIRED_RESOLVER_ROOT_ROLES()),
                new bytes[](0)
            ))
        );

        registry.grantRootRoles(ROLE_REGISTRAR, address(minter));
        minter.connectParent(registry, resolver, parentDns, true);

        vm.stopPrank();
    }

    function test_detectsTheHackathonResolver() public view {
        if (block.chainid != 11155111) return;
        (,,,,, bool inode) = minter.parentOf(registry);
        assertTrue(inode, "should have detected the inode resolver");
    }

    function test_readinessIsGreen() public view {
        if (block.chainid != 11155111) return;
        (bool connected, bool registrarGranted, bool resolverRolesGranted,,) =
            minter.readiness(registry, PARENT_OWNER);
        assertTrue(connected, "not connected");
        assertTrue(registrarGranted, "registrar not granted");
        assertTrue(resolverRolesGranted, "resolver roles not granted");
    }

    function test_mintWritesRecordsReadableByEnsip10() public {
        if (block.chainid != 11155111) return;

        vm.prank(PARENT_OWNER);
        (uint256 tokenId, bytes32 node) = minter.mint(
            registry,
            "trader",
            CAPSULE_OWNER,
            AGENT,
            CapsuleMinter.CapsuleConfig({
                context: "a trading agent",
                telegramUrl: "https://t.me/example",
                capsuleEndpoint: "https://example.invalid",
                model: "claude-opus-5",
                runtime: "openclaw",
                promptPointer: "cap_000001"
            })
        );

        assertGt(tokenId, 0, "no token minted");
        assertEq(registry.findOwner("trader"), CAPSULE_OWNER, "wrong capsule owner");

        // Records on this resolver are written by DNS name and read back through ENSIP-10
        // only: there is no `text(bytes32,string)` to call directly.
        bytes memory childDns = abi.encodePacked(uint8(6), "trader", parentDns);
        assertEq(_readText(childDns, node, "agent-model"), "claude-opus-5", "agent-model");
        assertEq(_readText(childDns, node, "class"), "Agent", "class");
        assertEq(
            _readText(childDns, node, minter.registrationKey(tokenId)), "1", "registration key"
        );
    }

    function test_agentMayWriteItsHeartbeat() public {
        if (block.chainid != 11155111) return;

        vm.prank(PARENT_OWNER);
        (, bytes32 node) = minter.mint(
            registry,
            "beater",
            CAPSULE_OWNER,
            AGENT,
            CapsuleMinter.CapsuleConfig("c", "w", "e", "m", "r", "p")
        );

        bytes memory childDns = abi.encodePacked(uint8(6), "beater", parentDns);

        vm.prank(AGENT);
        (bool ok,) = address(resolver).call(
            abi.encodeWithSignature(
                "setText(bytes,string,string)", childDns, "agent-heartbeat", "1700000000"
            )
        );
        assertTrue(ok, "agent could not write its heartbeat");
        assertEq(_readText(childDns, node, "agent-heartbeat"), "1700000000", "heartbeat");

        assertTrue(minter.isAgentAuthorized(registry, "beater", AGENT), "not reported authorized");
    }

    ////////////////////////////////////////////////////////////////////////
    // Helpers
    ////////////////////////////////////////////////////////////////////////

    function _deployProxy(address impl, uint256 salt, bytes memory data)
        internal
        returns (address)
    {
        (bool ok, bytes memory ret) = VERIFIABLE_FACTORY.call(
            abi.encodeWithSignature("deployProxy(address,uint256,bytes)", impl, salt, data)
        );
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return abi.decode(ret, (address));
    }

    function _findTokenId(string memory label) internal view returns (uint256) {
        (bool ok, bytes memory ret) =
            ETH_REGISTRY.staticcall(abi.encodeWithSignature("findTokenId(string)", label));
        require(ok, "findTokenId failed");
        return abi.decode(ret, (uint256));
    }

    /// @dev ENSIP-10. `resolve(name, abi.encodeCall(text, (node, key)))`, then unwrap the
    ///      inner ABI-encoded string.
    function _readText(bytes memory dnsName, bytes32 node, string memory key)
        internal
        view
        returns (string memory)
    {
        (bool ok, bytes memory ret) = address(resolver).staticcall(
            abi.encodeWithSignature(
                "resolve(bytes,bytes)",
                dnsName,
                abi.encodeWithSelector(bytes4(0x59d1d43c), node, key)
            )
        );
        require(ok, "resolve failed");
        return abi.decode(abi.decode(ret, (bytes)), (string));
    }

    function _grants(address a, uint256 roles) internal pure returns (Grant[] memory g) {
        g = new Grant[](1);
        g[0] = Grant(a, roles);
    }

    function _grants2(address a, uint256 ar, address b, uint256 br)
        internal
        pure
        returns (Grant[] memory g)
    {
        g = new Grant[](2);
        g[0] = Grant(a, ar);
        g[1] = Grant(b, br);
    }

    function _dnsEncodeEth(string memory label) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(bytes(label).length), label, uint8(3), "eth", uint8(0));
    }
}
