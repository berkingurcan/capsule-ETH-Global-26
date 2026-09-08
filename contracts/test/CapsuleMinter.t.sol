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

    // `uint256(keccak256(abi.encode(TRADER_NODE, keccak256(key))))`, computed with `cast`
    // rather than by this contract, so a bug in `textResourceOf` cannot hide behind it.
    uint256 constant RES_HEARTBEAT =
        0x7ea53a4c6e08c773bbfa64f135d93bb711df30cd4885b70f46d11004fd42549c;
    uint256 constant RES_PROMPT =
        0xa434a4601e0c2b85537793493e7b0f41e7f2ef74b17bd68336470478dfdd4d86;

    string constant SCHEMA_URI = "https://capsule.example/schema/capsule-agent-v1.json";

    address constant OWNER = address(0xB0B);
    address constant AGENT = 0xca266f69EE3EFed7eC71CE5062f5A07c18908905;

    CapsuleMinter minter;
    MockRegistry registry;
    MockResolver resolver;

    function setUp() public {
        registry = new MockRegistry();
        resolver = new MockResolver();
        minter = _deploy();
        resolver.grantRootRoles(minter.REQUIRED_RESOLVER_ROOT_ROLES(), address(minter));
    }

    function _deploy() internal returns (CapsuleMinter) {
        return new CapsuleMinter(
            IPermissionedRegistry(address(registry)),
            IPermissionedResolver(address(resolver)),
            PARENT_NODE,
            PARENT_DNS,
            90 days,
            SCHEMA_URI
        );
    }

    // --- record keys: asserted against literals, because a typo cannot be seen ---
    //
    // The mirror of these values lives in runner/src/records.ts and
    // web/lib/capsule/records.ts; `npm run check:records` in web/ compares all three.
    // Asserted here too so a Solidity-side edit fails in `forge test` rather than on
    // chain, where a mismatched key is byte-identical to a revocation.

    function test_recordKeys_matchTheSpec() public view {
        // ENSIP-27
        assertEq(minter.KEY_CLASS(), "class");
        assertEq(minter.KEY_SCHEMA(), "schema");
        assertEq(minter.CLASS_VALUE(), "Agent");
        // ENSIP-26
        assertEq(minter.KEY_CONTEXT(), "agent-context");
        assertEq(minter.KEY_ENDPOINT_WEB(), "agent-endpoint[web]");
        assertEq(minter.KEY_ENDPOINT_CAPSULE(), "agent-endpoint[capsule]");
        // ours
        assertEq(minter.KEY_MODEL(), "agent-model");
        assertEq(minter.KEY_RUNTIME(), "agent-runtime");
        assertEq(minter.KEY_PROMPT(), "agent-prompt");
        assertEq(minter.KEY_HEARTBEAT(), "agent-heartbeat");
    }

    /// @dev Every attribute is kebab-case with at most one bracket group — ENSIP-27's
    ///      grammar. A dotted key would resolve fine and quietly fail conformance.
    function test_recordKeys_containNoDot() public view {
        string[9] memory keys = [
            minter.KEY_CLASS(),
            minter.KEY_SCHEMA(),
            minter.KEY_CONTEXT(),
            minter.KEY_ENDPOINT_WEB(),
            minter.KEY_ENDPOINT_CAPSULE(),
            minter.KEY_MODEL(),
            minter.KEY_RUNTIME(),
            minter.KEY_PROMPT(),
            minter.KEY_HEARTBEAT()
        ];
        for (uint256 i = 0; i < keys.length; i++) {
            bytes memory k = bytes(keys[i]);
            for (uint256 j = 0; j < k.length; j++) {
                assertTrue(k[j] != ".", "ENSIP-27 reserves dot notation for ENSIP-5 namespacing");
            }
        }
    }

    // --- ENSIP-25: the registration key ---

    /// @dev The fixture in ../../Branding-ENSClaw/RECORDS.md, computed by hand from the
    ///      ERC-7930 layout. Sepolia's chain id is 0xaa36a7, three bytes.
    function test_interopAddress_matchesTheErc7930Fixture() public view {
        assertEq(
            minter.interopAddressOf(11155111, 0x193Bb7dB059a6f93e796d97da278465d20224819),
            "0x0001000003aa36a714193bb7db059a6f93e796d97da278465d20224819"
        );
    }

    /// @dev The chain reference is length-prefixed, so it must carry no leading zero
    ///      byte — a padded reference is a different encoding and therefore a different
    ///      key. Mainnet is the one-byte case, and 0x0100 the two-byte one.
    function test_interopAddress_chainReferenceIsMinimal() public view {
        assertEq(
            minter.interopAddressOf(1, 0x193Bb7dB059a6f93e796d97da278465d20224819),
            "0x00010000010114193bb7db059a6f93e796d97da278465d20224819"
        );
        assertEq(
            minter.interopAddressOf(256, 0x193Bb7dB059a6f93e796d97da278465d20224819),
            "0x0001000002010014193bb7db059a6f93e796d97da278465d20224819"
        );
    }

    /// @dev Derived from `block.chainid` at construction, never a constructor argument —
    ///      so it cannot be deployed wrong.
    function test_interopAddress_isStoredForThisDeployment() public {
        vm.chainId(11155111);
        CapsuleMinter fresh = _deploy();
        assertEq(
            fresh.REGISTRY_INTEROP_ADDRESS(),
            fresh.interopAddressOf(11155111, address(fresh))
        );
    }

    function test_registrationKey_isTheEnsip25Shape() public view {
        assertEq(
            minter.registrationKey(7),
            string.concat("agent-registration[", minter.REGISTRY_INTEROP_ADDRESS(), "][7]")
        );
        // Decimal, not hex, and no leading zero.
        assertEq(_agentIdOf(minter.registrationKey(0)), "0");
        assertEq(_agentIdOf(minter.registrationKey(1234567890)), "1234567890");
        assertEq(_agentIdOf(minter.registrationKey(type(uint256).max)), _maxUint256Decimal());
    }

    // --- encoding: the values below came off-chain, so a mismatch is a real bug ---

    function test_nodeOf_matchesLiveChain() public view {
        assertEq(minter.nodeOf("trader"), TRADER_NODE);
    }

    function test_dnsNameOf_matchesLiveChain() public view {
        assertEq(minter.dnsNameOf("trader"), TRADER_DNS);
    }

    function test_textResourceOf_matchesLiveChain() public view {
        assertEq(minter.textResourceOf(TRADER_NODE, "agent-heartbeat"), RES_HEARTBEAT);
        assertEq(minter.textResourceOf(TRADER_NODE, "agent-prompt"), RES_PROMPT);
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

    function _config() internal pure returns (CapsuleMinter.CapsuleConfig memory) {
        return CapsuleMinter.CapsuleConfig({
            context: "A trading agent for the capsulefleet demo.",
            telegramUrl: "https://t.me/capsule_trader_bot",
            capsuleEndpoint: "https://api.capsule.dev/trader",
            model: "claude-opus-5",
            runtime: "openclaw",
            promptPointer: "cap_8f3d1a"
        });
    }

    function _mint() internal returns (uint256 tokenId, bytes32 node) {
        return minter.mint("trader", OWNER, AGENT, _config());
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

    function test_mint_writesEveryEnsipRecord() public {
        _mint();

        // ENSIP-27. `class` must equal the served schema's `title`; the schema URI is a
        // constructor argument because preview and production serve it from different hosts.
        assertEq(resolver.text(TRADER_NODE, "class"), "Agent");
        assertEq(resolver.text(TRADER_NODE, "schema"), SCHEMA_URI);

        // ENSIP-26.
        assertEq(resolver.text(TRADER_NODE, "agent-context"), "A trading agent for the capsulefleet demo.");
        assertEq(resolver.text(TRADER_NODE, "agent-endpoint[web]"), "https://t.me/capsule_trader_bot");
        assertEq(resolver.text(TRADER_NODE, "agent-endpoint[capsule]"), "https://api.capsule.dev/trader");

        // Ours.
        assertEq(resolver.text(TRADER_NODE, "agent-model"), "claude-opus-5");
        assertEq(resolver.text(TRADER_NODE, "agent-runtime"), "openclaw");
        assertEq(resolver.text(TRADER_NODE, "agent-prompt"), "cap_8f3d1a");

        // ENSIP-1/9.
        assertEq(resolver.addrs(TRADER_NODE), AGENT);
    }

    /// @dev ENSIP-25 asks only for a non-empty value, and the registry must document how
    ///      to build the key. Ours writes it, so a verifier never has to guess.
    function test_mint_writesTheRegistrationRecord() public {
        (uint256 tokenId,) = _mint();
        assertEq(resolver.text(TRADER_NODE, minter.registrationKey(tokenId)), "1");
    }

    function test_mint_writesNoHeartbeat() public {
        _mint();
        assertEq(bytes(resolver.text(TRADER_NODE, "agent-heartbeat")).length, 0);
        // 9 keys: class, schema, agent-context, two endpoints, model, runtime, prompt,
        // agent-registration. An unwritten heartbeat is what "never ran" looks like.
        assertEq(resolver.writtenKeyCount(), 9, "mint must not write agent-heartbeat itself");
    }

    function test_mint_grantsOwnerNameControl() public {
        _mint();
        assertEq(resolver.lastNameAuthAccount(), OWNER);
        assertEq(resolver.lastNameAuthRoles(), minter.OWNER_NAME_ROLES());
        assertEq(resolver.lastNameAuthName(), TRADER_DNS);
    }

    /// @dev The core claim of the project.
    function test_mint_grantsAgentHeartbeatOnly() public {
        (uint256 tokenId,) = _mint();
        assertEq(resolver.lastTextAuthKey(), "agent-heartbeat");
        assertEq(resolver.lastTextAuthAccount(), AGENT);
        assertTrue(resolver.lastTextAuthGrant());
        assertEq(resolver.lastTextAuthName(), TRADER_DNS, "authorize takes DNS wire format, not a namehash");

        assertTrue(minter.isAgentAuthorized("trader", AGENT));

        // Every other key individually, not just the prompt: the grant is per-key, so a
        // per-key test is the only one that proves it.
        string[9] memory denied = [
            minter.KEY_CLASS(),
            minter.KEY_SCHEMA(),
            minter.KEY_CONTEXT(),
            minter.KEY_ENDPOINT_WEB(),
            minter.KEY_ENDPOINT_CAPSULE(),
            minter.KEY_MODEL(),
            minter.KEY_RUNTIME(),
            minter.KEY_PROMPT(),
            minter.registrationKey(tokenId)
        ];
        for (uint256 i = 0; i < denied.length; i++) {
            assertFalse(
                resolver.hasRoles(minter.textResourceOf(TRADER_NODE, denied[i]), 1 << 4, AGENT),
                denied[i]
            );
        }
    }

    function test_mint_rejectsZeroAgent() public {
        vm.expectRevert(CapsuleMinter.ZeroAddress.selector);
        minter.mint("trader", OWNER, address(0), _config());
    }

    function test_checkResolverRoles() public view {
        minter.checkResolverRoles();
    }

    function test_checkResolverRoles_revertsWithoutGrant() public {
        CapsuleMinter fresh = _deploy();
        vm.expectRevert(CapsuleMinter.MissingResolverRoles.selector);
        fresh.checkResolverRoles();
    }

    // --- helpers ---

    /// @dev The `<agentId>` half of `agent-registration[<registry>][<agentId>]`.
    function _agentIdOf(string memory key) internal pure returns (string memory) {
        bytes memory k = bytes(key);
        uint256 open = k.length;
        // The last '[' opens the agent id; the registry's own brackets come earlier.
        for (uint256 i = k.length; i > 0; i--) {
            if (k[i - 1] == "[") {
                open = i;
                break;
            }
        }
        bytes memory out = new bytes(k.length - open - 1);
        for (uint256 i = 0; i < out.length; i++) out[i] = k[open + i];
        return string(out);
    }

    function _maxUint256Decimal() internal pure returns (string memory) {
        return "115792089237316195423570985008687907853269984665640564039457584007913129639935";
    }
}
