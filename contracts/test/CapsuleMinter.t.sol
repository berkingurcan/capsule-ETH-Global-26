// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {CapsuleMinter} from "../src/CapsuleMinter.sol";
import {IPermissionedRegistry, IPermissionedResolver} from "../src/interfaces/IENSv2.sol";

/// @dev Records every call so tests can assert on the exact sequence `mint()` performs.
contract MockResolver {
    mapping(bytes32 => mapping(string => string)) public texts;
    mapping(bytes32 => address) public addrs;
    mapping(uint256 => mapping(address => uint256)) public roles;

    bytes public lastTextAuthName;
    string public lastTextAuthKey;
    address public lastTextAuthAccount;
    bool public lastTextAuthGrant;

    bytes public lastNameAuthName;
    uint256 public lastNameAuthRoles;
    address public lastNameAuthAccount;

    string[] public writtenKeys;

    function setText(bytes32 node, string calldata key, string calldata value) external {
        texts[node][key] = value;
        writtenKeys.push(key);
    }

    function setAddr(bytes32 node, address a) external {
        addrs[node] = a;
    }

    function authorizeTextRoles(bytes calldata toName, string calldata key, address account, bool grant)
        external
        returns (bool)
    {
        lastTextAuthName = toName;
        lastTextAuthKey = key;
        lastTextAuthAccount = account;
        lastTextAuthGrant = grant;
        uint256 resource = uint256(keccak256(abi.encode(_nodeOf(toName), keccak256(bytes(key)))));
        if (grant) roles[resource][account] |= (1 << 4);
        else roles[resource][account] &= ~uint256(1 << 4);
        return true;
    }

    function authorizeNameRoles(bytes calldata toName, uint256 roleBitmap, address account, bool)
        external
        returns (bool)
    {
        lastNameAuthName = toName;
        lastNameAuthRoles = roleBitmap;
        lastNameAuthAccount = account;
        return true;
    }

    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool) {
        roles[0][account] |= roleBitmap;
        return true;
    }

    function text(bytes32 node, string calldata key) external view returns (string memory) {
        return texts[node][key];
    }

    /// @dev Mirrors the real contract: root roles apply to every resource.
    function hasRoles(uint256 resource, uint256 roleBitmap, address account) external view returns (bool) {
        return (roles[0][account] | roles[resource][account]) & roleBitmap == roleBitmap;
    }

    function writtenKeyCount() external view returns (uint256) {
        return writtenKeys.length;
    }

    /// @dev The mock is only ever handed names the minter built, so a fixed-shape decode is enough.
    function _nodeOf(bytes memory) internal pure returns (bytes32) {
        return NODE_UNDER_TEST;
    }

    bytes32 internal constant NODE_UNDER_TEST =
        0x66a9d2f8c0624c05f62f7b4767380c0ed5de24b18e2ac582cb30b03fc9483648;
}

contract MockRegistry {
    string public lastLabel;
    address public lastOwner;
    address public lastSubregistry;
    address public lastResolver;
    uint256 public lastRoleBitmap;
    uint64 public lastExpiry;

    function register(
        string calldata label,
        address owner,
        address subregistry,
        address resolver,
        uint256 roleBitmap,
        uint64 expiry
    ) external returns (uint256) {
        lastLabel = label;
        lastOwner = owner;
        lastSubregistry = subregistry;
        lastResolver = resolver;
        lastRoleBitmap = roleBitmap;
        lastExpiry = expiry;
        return 42;
    }

    function latestOwnerOf(uint256) external view returns (address) {
        return lastOwner;
    }
}

contract CapsuleMinterTest is Test {
    // Golden values read off the live ENSv2 Sepolia beta for trader.capsulefleet.eth.
    bytes32 constant PARENT_NODE = 0x036a91f25e11db713abf00b569adb0a03c248d7b9f291430dac6807860d4a6b3;
    bytes constant PARENT_DNS = hex"0c63617073756c65666c6565740365746800";
    bytes32 constant TRADER_NODE = 0x66a9d2f8c0624c05f62f7b4767380c0ed5de24b18e2ac582cb30b03fc9483648;
    bytes constant TRADER_DNS = hex"067472616465720c63617073756c65666c6565740365746800";
    uint256 constant RES_HEARTBEAT =
        0xcdd52bc15022b496e667b6080c8dabdc31b08834f7ee1578a06d0f6ea10a12b3;
    uint256 constant RES_PROMPT =
        0xd8a52b4557d07167799f053cf68321bfe369ee7a8a957f50404c60e716abfbba;

    address constant OWNER = address(0xB0B);
    address constant AGENT = 0xca266f69EE3EFed7eC71CE5062f5A07c18908905;

    CapsuleMinter minter;
    MockRegistry registry;
    MockResolver resolver;

    function setUp() public {
        registry = new MockRegistry();
        resolver = new MockResolver();
        minter = new CapsuleMinter(
            IPermissionedRegistry(address(registry)),
            IPermissionedResolver(address(resolver)),
            PARENT_NODE,
            PARENT_DNS,
            90 days
        );
        resolver.grantRootRoles(minter.REQUIRED_RESOLVER_ROOT_ROLES(), address(minter));
    }

    // --- encoding: the values below came off-chain, so a mismatch is a real bug ---

    function test_nodeOf_matchesLiveChain() public view {
        assertEq(minter.nodeOf("trader"), TRADER_NODE);
    }

    function test_dnsNameOf_matchesLiveChain() public view {
        assertEq(minter.dnsNameOf("trader"), TRADER_DNS);
    }

    function test_textResourceOf_matchesLiveChain() public view {
        assertEq(minter.textResourceOf(TRADER_NODE, "agent.heartbeat"), RES_HEARTBEAT);
        assertEq(minter.textResourceOf(TRADER_NODE, "agent.prompt"), RES_PROMPT);
    }

    function test_dnsNameOf_rejectsEmptyLabel() public {
        vm.expectRevert(abi.encodeWithSelector(CapsuleMinter.InvalidLabel.selector, ""));
        minter.dnsNameOf("");
    }

    function test_dnsNameOf_rejectsOverlongLabel() public {
        string memory long = new string(64);
        vm.expectRevert(abi.encodeWithSelector(CapsuleMinter.InvalidLabel.selector, long));
        minter.dnsNameOf(long);
    }

    // --- mint ---

    function _mint() internal returns (uint256 tokenId, bytes32 node) {
        return minter.mint(
            "trader",
            OWNER,
            AGENT,
            CapsuleMinter.CapsuleConfig("claude-opus-5", "https://api.capsule.dev/trader", "cap_8f3d1a")
        );
    }

    function test_mint_registersWithResolverAndNoSubregistry() public {
        (uint256 tokenId, bytes32 node) = _mint();
        assertEq(tokenId, 42);
        assertEq(node, TRADER_NODE);
        assertEq(registry.lastLabel(), "trader");
        assertEq(registry.lastOwner(), OWNER);
        assertEq(registry.lastResolver(), address(resolver));
        assertEq(registry.lastSubregistry(), address(0), "agents must not issue child names");
        assertEq(registry.lastExpiry(), uint64(block.timestamp) + 90 days);
    }

    function test_mint_writesConfigRecords() public {
        _mint();
        assertEq(resolver.text(TRADER_NODE, "agent.model"), "claude-opus-5");
        assertEq(resolver.text(TRADER_NODE, "agent.endpoint"), "https://api.capsule.dev/trader");
        assertEq(resolver.text(TRADER_NODE, "agent.prompt"), "cap_8f3d1a");
        assertEq(resolver.addrs(TRADER_NODE), AGENT);
        assertEq(resolver.writtenKeyCount(), 3, "mint must not write agent.heartbeat itself");
    }

    function test_mint_grantsOwnerNameControl() public {
        _mint();
        assertEq(resolver.lastNameAuthAccount(), OWNER);
        assertEq(resolver.lastNameAuthRoles(), minter.OWNER_NAME_ROLES());
        assertEq(resolver.lastNameAuthName(), TRADER_DNS);
    }

    /// @dev The core claim of the project.
    function test_mint_grantsAgentHeartbeatOnly() public {
        _mint();
        assertEq(resolver.lastTextAuthKey(), "agent.heartbeat");
        assertEq(resolver.lastTextAuthAccount(), AGENT);
        assertTrue(resolver.lastTextAuthGrant());
        assertEq(resolver.lastTextAuthName(), TRADER_DNS, "authorize takes DNS wire format, not a namehash");

        assertTrue(minter.isAgentAuthorized("trader", AGENT));
        assertFalse(resolver.hasRoles(RES_PROMPT, 1 << 4, AGENT), "agent must not be able to rewrite its prompt");
    }

    function test_mint_rejectsZeroAgent() public {
        vm.expectRevert(CapsuleMinter.ZeroAddress.selector);
        minter.mint("trader", OWNER, address(0), CapsuleMinter.CapsuleConfig("m", "e", "p"));
    }

    function test_checkResolverRoles() public view {
        minter.checkResolverRoles();
    }

    function test_checkResolverRoles_revertsWithoutGrant() public {
        CapsuleMinter fresh = new CapsuleMinter(
            IPermissionedRegistry(address(registry)),
            IPermissionedResolver(address(resolver)),
            PARENT_NODE,
            PARENT_DNS,
            90 days
        );
        vm.expectRevert(CapsuleMinter.MissingResolverRoles.selector);
        fresh.checkResolverRoles();
    }
}
