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

    function revokeRootRoles(uint256 roleBitmap, address account) external returns (bool) {
        roles[0][account] &= ~roleBitmap;
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

    /// @dev A real namehash over the DNS wire name, not a fixture. The minter now serves
    ///      several parents from one deployment, so a mock that answered with a constant
    ///      node would let a cross-parent bug — the exact class of bug this refactor is
    ///      about — pass every assertion in this file.
    function _nodeOf(bytes memory dns) internal pure returns (bytes32) {
        return _namehash(dns, 0);
    }

    function _namehash(bytes memory dns, uint256 offset) internal pure returns (bytes32) {
        uint256 length = uint8(dns[offset]);
        if (length == 0) return bytes32(0);
        bytes memory label = new bytes(length);
        for (uint256 i = 0; i < length; i++) label[i] = dns[offset + 1 + i];
        return keccak256(abi.encodePacked(_namehash(dns, offset + 1 + length), keccak256(label)));
    }
}

/// @dev The registry one level up — `ETHRegistry` on the live deployment. It exists so
///      `connectParent`'s two-way link check has a real downward answer to compare
///      against, rather than one the registry under test could fabricate.
contract MockRootRegistry {
    mapping(string => address) public subregistries;

    function setSubregistry(string calldata label, address registry) external {
        subregistries[label] = registry;
    }

    function getSubregistry(string calldata label) external view returns (address) {
        return subregistries[label];
    }
}

contract MockRegistry {
    string public lastLabel;
    address public lastOwner;
    address public lastSubregistry;
    address public lastResolver;
    uint256 public lastRoleBitmap;
    uint64 public lastExpiry;

    address internal _parent;
    string internal _label;
    mapping(uint256 => mapping(address => uint256)) public roles;

    function setParent(address parent, string calldata label) external {
        _parent = parent;
        _label = label;
    }

    function getParent() external view returns (address, string memory) {
        return (_parent, _label);
    }

    function getSubregistry(string calldata) external pure returns (address) {
        return address(0);
    }

    function getResolver(string calldata) external pure returns (address) {
        return address(0);
    }

    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool) {
        roles[0][account] |= roleBitmap;
        return true;
    }

    function revokeRootRoles(uint256 roleBitmap, address account) external returns (bool) {
        roles[0][account] &= ~roleBitmap;
        return true;
    }

    function hasRoles(uint256 resource, uint256 roleBitmap, address account) external view returns (bool) {
        return (roles[0][account] | roles[resource][account]) & roleBitmap == roleBitmap;
    }

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

    // A second, unrelated parent — the whole point of the contract. Namehashes computed
    // with `cast namehash`, DNS encodings by hand, both independent of this contract.
    bytes32 constant BERKIN_NODE = 0x040c30b53d36763820f4222dc2165ae761b015f2486a657f331e57bc407eb90c;
    bytes constant BERKIN_DNS = hex"066265726b696e0365746800";
    bytes32 constant DEV_BERKIN_NODE = 0x0c2fba3b199a1fc834f6178c7d5e3d4c526c7cec2f2f1590c35b8d4f5c6c83c6;
    bytes constant DEV_BERKIN_DNS = hex"03646576066265726b696e0365746800";

    // `uint256(keccak256(abi.encode(TRADER_NODE, keccak256(key))))`, computed with `cast`
    // rather than by this contract, so a bug in `textResourceOf` cannot hide behind it.
    uint256 constant RES_HEARTBEAT =
        0x7ea53a4c6e08c773bbfa64f135d93bb711df30cd4885b70f46d11004fd42549c;
    uint256 constant RES_PROMPT =
        0xa434a4601e0c2b85537793493e7b0f41e7f2ef74b17bd68336470478dfdd4d86;

    /// @dev `RegistryRolesLib.ROLE_REGISTRAR` and the role that may grant it. Spelled here
    ///      rather than read off the minter because they are the ENS side of the contract.
    uint256 constant ROLE_REGISTRAR = 1 << 0;
    uint256 constant ROLE_REGISTRAR_ADMIN = ROLE_REGISTRAR << 128;

    string constant SCHEMA_URI = "https://capsule.example/schema/capsule-agent-v1.json";

    address constant OWNER = address(0xB0B);
    address constant AGENT = 0xca266f69EE3EFed7eC71CE5062f5A07c18908905;
    /// @dev Holds `ROLE_REGISTRAR_ADMIN` on the capsulefleet registry: the name's owner.
    address constant PARENT_ADMIN = address(0xA11CE);
    /// @dev Holds nothing anywhere. Every authorization test is written from here.
    address constant STRANGER = address(0xBEEF);

    CapsuleMinter minter;
    MockRootRegistry root;
    MockRegistry registry;
    MockResolver resolver;

    function setUp() public {
        root = new MockRootRegistry();
        registry = new MockRegistry();
        resolver = new MockResolver();

        // The two-way link NOTES.md records as gotcha 1, which `connectParent` checks.
        registry.setParent(address(root), "capsulefleet");
        root.setSubregistry("capsulefleet", address(registry));

        registry.grantRootRoles(ROLE_REGISTRAR_ADMIN, PARENT_ADMIN);

        minter = _deploy();
        _grantMinterRoles(registry, resolver);
        _connect(registry, resolver, PARENT_DNS, true);
    }

    function _deploy() internal returns (CapsuleMinter) {
        return new CapsuleMinter(90 days, SCHEMA_URI);
    }

    function _grantMinterRoles(MockRegistry r, MockResolver res) internal {
        r.grantRootRoles(ROLE_REGISTRAR, address(minter));
        res.grantRootRoles(minter.REQUIRED_RESOLVER_ROOT_ROLES(), address(minter));
    }

    function _connect(MockRegistry r, MockResolver res, bytes memory dns, bool open) internal {
        vm.prank(PARENT_ADMIN);
        minter.connectParent(
            IPermissionedRegistry(address(r)), IPermissionedResolver(address(res)), dns, open
        );
    }

    function _reg() internal view returns (IPermissionedRegistry) {
        return IPermissionedRegistry(address(registry));
    }

    ////////////////////////////////////////////////////////////////////////
    // Record keys: asserted against literals, because a typo cannot be seen
    ////////////////////////////////////////////////////////////////////////
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

    ////////////////////////////////////////////////////////////////////////
    // ENSIP-25: the registration key
    ////////////////////////////////////////////////////////////////////////

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
        assertEq(fresh.REGISTRY_INTEROP_ADDRESS(), fresh.interopAddressOf(11155111, address(fresh)));
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

    /// @dev The ENSIP-25 registry is the MINTER, not the parent, so two capsules under
    ///      different names carry the same `<registry>` half. That is the correct reading
    ///      — the registry is whoever issued the agent id — and it is worth pinning,
    ///      because "make the key per-parent" is a plausible-looking wrong turn.
    function test_registrationKey_isTheSameAcrossParents() public {
        (MockRegistry berkinRegistry,) = _connectBerkin(true);
        (uint256 a,) = _mint();
        vm.prank(PARENT_ADMIN);
        (uint256 b,) = minter.mint(
            IPermissionedRegistry(address(berkinRegistry)), "dev", OWNER, AGENT, _config()
        );
        assertEq(minter.registrationKey(a), minter.registrationKey(b));
    }

    ////////////////////////////////////////////////////////////////////////
    // Encoding: the values below came off-chain, so a mismatch is a real bug
    ////////////////////////////////////////////////////////////////////////

    function test_nodeOf_matchesLiveChain() public view {
        assertEq(minter.nodeOf(_reg(), "trader"), TRADER_NODE);
    }

    function test_dnsNameOf_matchesLiveChain() public view {
        assertEq(minter.dnsNameOf(_reg(), "trader"), TRADER_DNS);
    }

    function test_textResourceOf_matchesLiveChain() public view {
        assertEq(minter.textResourceOf(TRADER_NODE, "agent-heartbeat"), RES_HEARTBEAT);
        assertEq(minter.textResourceOf(TRADER_NODE, "agent-prompt"), RES_PROMPT);
    }

    /// @dev The derivation that replaced the `PARENT_NODE` constructor argument. It has to
    ///      agree with `NameCoder.namehash`, which is what the resolver runs on the DNS
    ///      name every `authorizeTextRoles` call — a disagreement writes records to one
    ///      node and grants permissions on another, and reverts nowhere.
    function test_namehash_matchesLiveChain() public view {
        assertEq(minter.namehash(PARENT_DNS), PARENT_NODE);
        assertEq(minter.namehash(TRADER_DNS), TRADER_NODE);
        assertEq(minter.namehash(BERKIN_DNS), BERKIN_NODE);
        assertEq(minter.namehash(DEV_BERKIN_DNS), DEV_BERKIN_NODE);
        assertEq(minter.namehash(hex"00"), bytes32(0), "the root is the zero node");
    }

    /// @dev A root byte in the middle would namehash the prefix and silently ignore the
    ///      rest, so `x.eth` plus trailing junk would hash as `x.eth`.
    function test_namehash_rejectsTrailingBytes() public {
        bytes memory junk = hex"066265726b696e036574680000";
        vm.expectRevert(abi.encodeWithSelector(CapsuleMinter.InvalidName.selector, junk));
        minter.namehash(junk);
    }

    function test_namehash_rejectsUnterminatedName() public {
        bytes memory truncated = hex"066265726b696e";
        vm.expectRevert(abi.encodeWithSelector(CapsuleMinter.InvalidName.selector, truncated));
        minter.namehash(truncated);
    }

    function test_namehash_rejectsOverrunningLabel() public {
        bytes memory overrun = hex"4062";
        vm.expectRevert(abi.encodeWithSelector(CapsuleMinter.InvalidName.selector, overrun));
        minter.namehash(overrun);
    }

    function test_dnsNameOf_rejectsEmptyLabel() public {
        vm.expectRevert(abi.encodeWithSelector(CapsuleMinter.InvalidLabel.selector, ""));
        minter.dnsNameOf(_reg(), "");
    }

    function test_dnsNameOf_rejectsOverlongLabel() public {
        string memory long = new string(64);
        vm.expectRevert(abi.encodeWithSelector(CapsuleMinter.InvalidLabel.selector, long));
        minter.dnsNameOf(_reg(), long);
    }

    ////////////////////////////////////////////////////////////////////////
    // Connecting a parent
    ////////////////////////////////////////////////////////////////////////

    /// @dev Builds a second, independent parent: `berkin.eth`, its own registry and its
    ///      own resolver, connected by its own admin.
    function _connectBerkin(bool open) internal returns (MockRegistry, MockResolver) {
        MockRegistry berkinRegistry = new MockRegistry();
        MockResolver berkinResolver = new MockResolver();
        berkinRegistry.setParent(address(root), "berkin");
        root.setSubregistry("berkin", address(berkinRegistry));
        berkinRegistry.grantRootRoles(ROLE_REGISTRAR_ADMIN, PARENT_ADMIN);
        _grantMinterRoles(berkinRegistry, berkinResolver);
        _connect(berkinRegistry, berkinResolver, BERKIN_DNS, open);
        return (berkinRegistry, berkinResolver);
    }

    function test_connectParent_storesTheDerivedNode() public view {
        (bool connected, bool open, IPermissionedResolver res, bytes32 node, bytes memory dns,) =
            minter.parentOf(_reg());
        assertTrue(connected);
        assertTrue(open);
        assertEq(address(res), address(resolver));
        assertEq(node, PARENT_NODE, "the node is derived from the DNS name, never passed in");
        assertEq(dns, PARENT_DNS);
    }

    function test_connectParent_rejectsANonAdmin() public {
        MockRegistry fresh = new MockRegistry();
        fresh.setParent(address(root), "berkin");
        root.setSubregistry("berkin", address(fresh));
        vm.prank(STRANGER);
        vm.expectRevert(
            abi.encodeWithSelector(CapsuleMinter.NotParentAdmin.selector, address(fresh), STRANGER)
        );
        minter.connectParent(
            IPermissionedRegistry(address(fresh)),
            IPermissionedResolver(address(resolver)),
            BERKIN_DNS,
            true
        );
    }

    /// @dev A registry can claim any parent it likes. The claim only counts if the
    ///      registry one level up agrees, and that one the caller does not control.
    function test_connectParent_rejectsAnUnreciprocatedLink() public {
        MockRegistry liar = new MockRegistry();
        liar.setParent(address(root), "capsulefleet"); // claims a name it does not hold
        liar.grantRootRoles(ROLE_REGISTRAR_ADMIN, PARENT_ADMIN);
        vm.prank(PARENT_ADMIN);
        vm.expectRevert(
            abi.encodeWithSelector(CapsuleMinter.ParentLinkBroken.selector, address(liar))
        );
        minter.connectParent(
            IPermissionedRegistry(address(liar)),
            IPermissionedResolver(address(resolver)),
            PARENT_DNS,
            true
        );
    }

    function test_connectParent_rejectsARegistryWithNoParent() public {
        MockRegistry orphan = new MockRegistry();
        orphan.grantRootRoles(ROLE_REGISTRAR_ADMIN, PARENT_ADMIN);
        vm.prank(PARENT_ADMIN);
        vm.expectRevert(
            abi.encodeWithSelector(CapsuleMinter.ParentLinkBroken.selector, address(orphan))
        );
        minter.connectParent(
            IPermissionedRegistry(address(orphan)),
            IPermissionedResolver(address(resolver)),
            PARENT_DNS,
            true
        );
    }

    /// @dev The one that matters most. `berkin.eth`'s admin connecting their own registry
    ///      but naming `capsulefleet.eth` would mint labels into their registry while
    ///      writing records onto — and granting permissions over — nodes under somebody
    ///      else's name. Nothing downstream reverts; the label check here is the only
    ///      thing between that and a live misconfiguration.
    function test_connectParent_rejectsANameThatIsNotTheRegistrysOwn() public {
        MockRegistry berkinRegistry = new MockRegistry();
        berkinRegistry.setParent(address(root), "berkin");
        root.setSubregistry("berkin", address(berkinRegistry));
        berkinRegistry.grantRootRoles(ROLE_REGISTRAR_ADMIN, PARENT_ADMIN);
        vm.prank(PARENT_ADMIN);
        vm.expectRevert(
            abi.encodeWithSelector(
                CapsuleMinter.ParentLinkBroken.selector, address(berkinRegistry)
            )
        );
        minter.connectParent(
            IPermissionedRegistry(address(berkinRegistry)),
            IPermissionedResolver(address(resolver)),
            PARENT_DNS, // capsulefleet.eth, on berkin.eth's registry
            true
        );
    }

    function test_connectParent_rejectsZeroResolver() public {
        vm.prank(PARENT_ADMIN);
        vm.expectRevert(CapsuleMinter.ZeroAddress.selector);
        minter.connectParent(_reg(), IPermissionedResolver(address(0)), PARENT_DNS, true);
    }

    function test_setParentOpen_flipsAccess() public {
        vm.prank(PARENT_ADMIN);
        minter.setParentOpen(_reg(), false);
        (, bool open,,,,) = minter.parentOf(_reg());
        assertFalse(open);
    }

    function test_setParentOpen_rejectsANonAdmin() public {
        vm.prank(STRANGER);
        vm.expectRevert(
            abi.encodeWithSelector(
                CapsuleMinter.NotParentAdmin.selector, address(registry), STRANGER
            )
        );
        minter.setParentOpen(_reg(), false);
    }

    function test_disconnectParent_stopsFurtherMints() public {
        vm.prank(PARENT_ADMIN);
        minter.disconnectParent(_reg());
        (bool connected,,,,,) = minter.parentOf(_reg());
        assertFalse(connected);
        vm.expectRevert(
            abi.encodeWithSelector(CapsuleMinter.ParentNotConnected.selector, address(registry))
        );
        _mint();
    }

    /// @dev Disconnecting is a statement of intent, not a revocation: the records and the
    ///      owner's roles live in the resolver, and this contract could not take them back
    ///      if it wanted to. Pinned because "disconnect kills my agents" is the natural
    ///      wrong assumption, and it would be a bad one to discover during a demo.
    function test_disconnectParent_leavesMintedCapsulesAlone() public {
        _mint();
        vm.prank(PARENT_ADMIN);
        minter.disconnectParent(_reg());
        assertEq(resolver.text(TRADER_NODE, "agent-model"), "claude-opus-5");
        assertTrue(resolver.hasRoles(RES_HEARTBEAT, 1 << 4, AGENT));
    }

    ////////////////////////////////////////////////////////////////////////
    // Who may mint
    ////////////////////////////////////////////////////////////////////////

    function test_mint_underAnOpenParent_isPermissionless() public {
        vm.prank(STRANGER);
        (, bytes32 node) = minter.mint(_reg(), "trader", OWNER, AGENT, _config());
        assertEq(node, TRADER_NODE);
    }

    function test_mint_underAClosedParent_refusesAStranger() public {
        vm.prank(PARENT_ADMIN);
        minter.setParentOpen(_reg(), false);
        vm.prank(STRANGER);
        vm.expectRevert(
            abi.encodeWithSelector(
                CapsuleMinter.ParentNotOpen.selector, address(registry), STRANGER
            )
        );
        minter.mint(_reg(), "trader", OWNER, AGENT, _config());
    }

    function test_mint_underAClosedParent_admitsTheParentAdmin() public {
        vm.prank(PARENT_ADMIN);
        minter.setParentOpen(_reg(), false);
        vm.prank(PARENT_ADMIN);
        (, bytes32 node) = minter.mint(_reg(), "trader", OWNER, AGENT, _config());
        assertEq(node, TRADER_NODE);
    }

    function test_mint_refusesAnUnconnectedRegistry() public {
        MockRegistry fresh = new MockRegistry();
        vm.expectRevert(
            abi.encodeWithSelector(CapsuleMinter.ParentNotConnected.selector, address(fresh))
        );
        minter.mint(
            IPermissionedRegistry(address(fresh)), "trader", OWNER, AGENT, _config()
        );
    }

    ////////////////////////////////////////////////////////////////////////
    // Two parents, one minter
    ////////////////////////////////////////////////////////////////////////

    /// @dev The feature, stated as one assertion: the same label under two names produces
    ///      two different nodes, in two different registries, in two different resolvers.
    function test_mint_underTwoParents_staysSeparate() public {
        (MockRegistry berkinRegistry, MockResolver berkinResolver) = _connectBerkin(true);

        _mint();
        vm.prank(PARENT_ADMIN);
        (, bytes32 devNode) = minter.mint(
            IPermissionedRegistry(address(berkinRegistry)), "dev", OWNER, AGENT, _config()
        );

        assertEq(devNode, DEV_BERKIN_NODE);
        assertEq(berkinRegistry.lastLabel(), "dev");
        assertEq(registry.lastLabel(), "trader");
        assertEq(berkinRegistry.lastResolver(), address(berkinResolver));

        // Each name's records live in its own parent's resolver, and nowhere else.
        assertEq(berkinResolver.text(DEV_BERKIN_NODE, "agent-model"), "claude-opus-5");
        assertEq(bytes(resolver.text(DEV_BERKIN_NODE, "agent-model")).length, 0);
        assertEq(bytes(berkinResolver.text(TRADER_NODE, "agent-model")).length, 0);
    }

    function test_mint_underASecondParent_usesThatParentsDnsName() public {
        (MockRegistry berkinRegistry, MockResolver berkinResolver) = _connectBerkin(true);
        vm.prank(PARENT_ADMIN);
        minter.mint(IPermissionedRegistry(address(berkinRegistry)), "dev", OWNER, AGENT, _config());
        assertEq(berkinResolver.lastTextAuthName(), DEV_BERKIN_DNS);
        assertEq(berkinResolver.lastNameAuthName(), DEV_BERKIN_DNS);
    }

    ////////////////////////////////////////////////////////////////////////
    // readiness — what the launch form asks before it lets anyone sign
    ////////////////////////////////////////////////////////////////////////

    function test_readiness_whenEverythingIsWired() public view {
        (bool connected, bool registrar, bool resolverRoles, bool open, bool mayMint) =
            minter.readiness(_reg(), STRANGER);
        assertTrue(connected);
        assertTrue(registrar);
        assertTrue(resolverRoles);
        assertTrue(open);
        assertTrue(mayMint);
    }

    function test_readiness_reportsAnUnconnectedRegistry() public {
        MockRegistry fresh = new MockRegistry();
        (bool connected,,,, bool mayMint) =
            minter.readiness(IPermissionedRegistry(address(fresh)), PARENT_ADMIN);
        assertFalse(connected);
        assertFalse(mayMint);
    }

    /// @dev `connectParent` deliberately does not require the grants, so this pair —
    ///      connected, not yet granted — is a real state a user passes through, and the
    ///      form has to be able to name which half is missing.
    function test_readiness_separatesConnectionFromGrants() public {
        registry.revokeRootRoles(ROLE_REGISTRAR, address(minter));
        (bool connected, bool registrar, bool resolverRoles,, bool mayMint) =
            minter.readiness(_reg(), PARENT_ADMIN);
        assertTrue(connected);
        assertFalse(registrar);
        assertTrue(resolverRoles);
        assertFalse(mayMint);

        registry.grantRootRoles(ROLE_REGISTRAR, address(minter));
        resolver.revokeRootRoles(minter.REQUIRED_RESOLVER_ROOT_ROLES(), address(minter));
        (, bool registrar2, bool resolverRoles2,, bool mayMint2) =
            minter.readiness(_reg(), PARENT_ADMIN);
        assertTrue(registrar2);
        assertFalse(resolverRoles2);
        assertFalse(mayMint2);
    }

    function test_readiness_reportsAClosedParentPerCaller() public {
        vm.prank(PARENT_ADMIN);
        minter.setParentOpen(_reg(), false);
        (,,,, bool strangerMayMint) = minter.readiness(_reg(), STRANGER);
        (,,,, bool adminMayMint) = minter.readiness(_reg(), PARENT_ADMIN);
        assertFalse(strangerMayMint);
        assertTrue(adminMayMint);
    }

    ////////////////////////////////////////////////////////////////////////
    // mint — the records and the grants
    ////////////////////////////////////////////////////////////////////////

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
        return minter.mint(_reg(), "trader", OWNER, AGENT, _config());
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

        assertTrue(minter.isAgentAuthorized(_reg(), "trader", AGENT));

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
        minter.mint(_reg(), "trader", OWNER, address(0), _config());
    }

    function test_mint_emitsTheParentNode() public {
        vm.expectEmit(true, true, true, true, address(minter));
        emit CapsuleMinter.CapsuleMinted(
            PARENT_NODE, TRADER_NODE, OWNER, AGENT, 42, "trader", uint64(block.timestamp) + 90 days
        );
        _mint();
    }

    function test_checkResolverRoles() public view {
        minter.checkResolverRoles(IPermissionedResolver(address(resolver)));
    }

    function test_checkResolverRoles_revertsWithoutGrant() public {
        MockResolver bare = new MockResolver();
        vm.expectRevert(CapsuleMinter.MissingResolverRoles.selector);
        minter.checkResolverRoles(IPermissionedResolver(address(bare)));
    }

    ////////////////////////////////////////////////////////////////////////
    // helpers
    ////////////////////////////////////////////////////////////////////////

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
