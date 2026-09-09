// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPermissionedRegistry, IPermissionedResolver} from "./interfaces/IENSv2.sol";

/// @title CapsuleMinter
/// @notice Mints one ENSv2 subname per AI agent and wires its permissions in a single
///         transaction: the name is registered, its ENSIP-25/26/27 records are written,
///         the owner is given control of the name's records, and the agent is granted
///         write access to exactly one key — `agent-heartbeat`.
///
/// @dev Why the agent gets one key and not a resolver:
///
/// `PermissionedResolver` scopes write permission per name AND per record key. The agent
/// can prove it is alive by writing `agent-heartbeat`, and cannot touch `agent-prompt`,
/// `agent-model` or `agent-endpoint[capsule]` — so a compromised or prompt-injected agent
/// cannot rewrite its own instructions. That boundary is enforced by ENS, not by our
/// backend.
///
/// @dev Why there is no `halt()` function here:
///
/// `mint()` grants the owner `ROLE_SET_TEXT_ADMIN` on their own name, so the owner revokes
/// the agent by calling the resolver directly:
///
///     resolver.authorizeTextRoles(dnsName, "agent-heartbeat", agent, false)
///
/// The kill switch therefore does not depend on this contract existing. If Capsule
/// disappears tomorrow, every owner keeps control of their agent through ENS alone.
///
/// @dev This contract is also the ENSIP-25 *registry*: it issues the `tokenId` that
///      `agent-registration[<registry>][<agentId>]` names, and it writes that record
///      itself at mint. See `registrationKey`.
///
/// ## One minter, many parents
///
/// This contract holds no parent name of its own. Any ENS name whose owner connects it
/// can issue capsules: `dev.berkin.eth` and `trader.pumpagent.eth` are minted by this
/// same deployment, under registries it has never been redeployed for.
///
/// The parent name is NOT an argument to `mint()`. It is *registered once* by the parent's
/// own admin, through `connectParent`, and `mint()` then names only the registry. That
/// ordering is the whole security model, and the reason for it is worth stating plainly:
///
/// A `mint(registry, resolver, parentDns, ...)` that took all three per call looks
/// equivalent and is not. Nothing on chain ties a registry to a resolver, so a caller
/// could pass a real parent's registry alongside a resolver they control, satisfy every
/// permission check against their own resolver, and register a label in somebody else's
/// name. Storing the triple once, keyed by registry, behind an admin check makes that
/// combination unrepresentable rather than merely discouraged.
contract CapsuleMinter {
    ////////////////////////////////////////////////////////////////////////
    // Roles
    ////////////////////////////////////////////////////////////////////////

    /// @dev From `PermissionedResolverLib`. Roles are nybble-packed: each occupies 4 bits,
    ///      and the admin counterpart sits 128 bits higher.
    uint256 internal constant ROLE_SET_ADDR = 1 << 0;
    uint256 internal constant ROLE_SET_ADDR_ADMIN = ROLE_SET_ADDR << 128;
    uint256 internal constant ROLE_SET_TEXT = 1 << 4;
    uint256 internal constant ROLE_SET_TEXT_ADMIN = ROLE_SET_TEXT << 128;

    /// @dev From `RegistryRolesLib` — the REGISTRY's role table, a different set of
    ///      meanings from the resolver's. `ROLE_REGISTRAR` is what this contract needs in
    ///      order to `register`; `ROLE_REGISTRAR_ADMIN` is what lets an account *grant*
    ///      it, and is therefore held by exactly the accounts that could have connected
    ///      this minter in the first place. That makes it the right proof of control over
    ///      a parent: no separate owner table, no signature scheme, no allowlist.
    uint256 internal constant ROLE_REGISTRAR = 1 << 0;
    uint256 internal constant ROLE_REGISTRAR_ADMIN = ROLE_REGISTRAR << 128;

    /// @notice Root roles this contract must hold on a parent's resolver before `mint()`
    ///         works for that parent.
    /// @dev The non-admin halves let it write records; the admin halves let it delegate.
    ///      Root roles apply to every name, which is required because the names do not
    ///      exist yet at connect time.
    uint256 public constant REQUIRED_RESOLVER_ROOT_ROLES =
        ROLE_SET_ADDR | ROLE_SET_ADDR_ADMIN | ROLE_SET_TEXT | ROLE_SET_TEXT_ADMIN;

    /// @notice Resolver roles granted to the capsule owner, scoped to their own name.
    uint256 public constant OWNER_NAME_ROLES = REQUIRED_RESOLVER_ROOT_ROLES;

    /// @dev From `EACBaseRolesLib` — bit 0 of every nybble.
    uint256 internal constant ALL_ROLES =
        0x1111111111111111111111111111111111111111111111111111111111111111;

    ////////////////////////////////////////////////////////////////////////
    // Record keys
    ////////////////////////////////////////////////////////////////////////

    // Spelled once per codebase and cross-checked, because a mismatch between the key
    // that was authorized and the key that gets written does NOT fail loudly: the
    // resolver reverts against the name-level resource whichever key was denied, so a
    // stale string is byte-identical to a revocation. The other two copies are
    // `runner/src/records.ts` and `web/lib/capsule/records.ts`; `npm run check:records`
    // in web/ asserts all three agree.
    //
    // Spec: ../../Branding-ENSClaw/RECORDS.md
    //
    // Every attribute is kebab-case, because ENSIP-27 requires it of schema attributes,
    // and parameters go in square brackets because ENSIP-26 and ENSIP-27 both define
    // that notation. Names minted by the PREVIOUS deployment carry the dotted spellings
    // (`agent.model` and friends); they are not migrated, they are testnet names.

    /// @notice ENSIP-27 node classification.
    string public constant KEY_CLASS = "class";

    /// @notice ENSIP-27 pointer to the JSON Schema covering our own keys.
    string public constant KEY_SCHEMA = "schema";

    /// @notice ENSIP-26 free-form description of the agent.
    string public constant KEY_CONTEXT = "agent-context";

    /// @notice ENSIP-26. The human-facing interface — for a capsule, the Telegram bot.
    string public constant KEY_ENDPOINT_WEB = "agent-endpoint[web]";

    /// @notice ENSIP-26 syntax, our own protocol tag: the control plane the runner
    ///         fetches its prompt and credentials from. ENSIP-26 names `mcp`, `a2a` and
    ///         `web` but leaves the protocol set open, so this conforms.
    string public constant KEY_ENDPOINT_CAPSULE = "agent-endpoint[capsule]";

    /// @notice Our schema. e.g. "claude-opus-5".
    string public constant KEY_MODEL = "agent-model";

    /// @notice Our schema. The agent runtime, e.g. "openclaw".
    string public constant KEY_RUNTIME = "agent-runtime";

    /// @dev Our schema. An opaque pointer such as "cap_8f3d1a", never the prompt itself
    ///      and never a secret. The prompt body and any API keys stay encrypted off-chain.
    string public constant KEY_PROMPT = "agent-prompt";

    /// @notice Our schema. The only key the agent may write.
    string public constant KEY_HEARTBEAT = "agent-heartbeat";

    /// @notice ENSIP-27 `class` value, pascal-case. Must equal the served schema's `title`.
    string public constant CLASS_VALUE = "Agent";

    /// @dev ENSIP-25 requires a non-empty string; only its presence carries meaning.
    string internal constant REGISTRATION_VALUE = "1";

    ////////////////////////////////////////////////////////////////////////
    // Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @dev Registration length. Must not outlive the parent name — which this contract
    ///      cannot check, because a parent's own expiry lives in a registry one level up
    ///      that it has no handle on. A parent connecting a name with less than this left
    ///      on it issues capsules that outlive their parent on paper and resolve to
    ///      nothing in practice; that is the parent's call to make, and `connectParent`
    ///      does not second-guess it.
    uint64 public immutable DURATION;

    /// @notice The ENSIP-27 `schema` value written on every name — the URI of the JSON
    ///         Schema describing the four keys no ENSIP defines.
    /// @dev A constructor argument because it is environment-specific: preview
    ///      deployments and production serve it from different hosts.
    string public SCHEMA_URI;

    /// @notice This contract as an ERC-7930 interoperable address — the `<registry>` half
    ///         of the ENSIP-25 key.
    /// @dev Derived once at construction from `block.chainid` and `address(this)`, so it
    ///      is correct on every chain and after every redeploy, and never hardcoded
    ///      anywhere. Building it per mint would be pure waste: it cannot change.
    ///
    ///      Note this is the *minter*, not the parent. Every capsule this deployment
    ///      issues carries the same ENSIP-25 registry id whatever name it sits under,
    ///      which is the correct reading of ENSIP-25: the registry is whoever issued the
    ///      agent id, and that is this contract for all of them.
    string public REGISTRY_INTEROP_ADDRESS;

    ////////////////////////////////////////////////////////////////////////
    // Parents
    ////////////////////////////////////////////////////////////////////////

    /// @notice A name that has connected itself to this minter.
    /// @dev Keyed by the parent's own subregistry, which is a stable one-to-one handle on
    ///      the name: `PermissionedRegistry.getParent()` binds a registry to exactly one
    ///      label, and `connectParent` verifies the link runs both ways before storing
    ///      anything.
    struct Parent {
        /// @dev The `PermissionedResolver` capsules under this name are registered with.
        ///      Supplied by the parent's admin rather than read from the registry — see
        ///      the note on `IPermissionedRegistry.getResolver`.
        IPermissionedResolver resolver;
        /// @dev Namehash of the parent name, derived from `dnsName` at connect time.
        bytes32 node;
        /// @dev When true, anybody may mint a capsule here. When false, only accounts
        ///      holding `ROLE_REGISTRAR_ADMIN` on the registry may.
        bool open;
        /// @dev Distinguishes "connected, closed" from "never connected". Both refuse a
        ///      stranger's mint; only the first refuses the parent's own.
        bool connected;
        /// @dev The parent in DNS wire format including the root byte, e.g.
        ///      `0x0c63617073756c65666c6565740365746800` for `capsulefleet.eth`.
        bytes dnsName;
    }

    /// @dev registry => its configuration. Read through `parentOf`, which is the ABI the
    ///      frontend uses; the public getter on a struct holding `bytes` is awkward.
    mapping(address => Parent) internal _parents;

    ////////////////////////////////////////////////////////////////////////
    // Types
    ////////////////////////////////////////////////////////////////////////

    /// @dev One field per record `mint()` writes from caller input. `class`, `schema` and
    ///      `agent-registration[…][…]` are absent because the contract derives all three.
    struct CapsuleConfig {
        /// @dev `agent-context` — what this agent is, in plain language.
        string context;
        /// @dev `agent-endpoint[web]` — `https://t.me/<bot>`.
        string telegramUrl;
        /// @dev `agent-endpoint[capsule]` — base URL of the Capsule control plane.
        string capsuleEndpoint;
        /// @dev `agent-model`.
        string model;
        /// @dev `agent-runtime`, e.g. "openclaw".
        string runtime;
        /// @dev `agent-prompt` — a pointer, never the body.
        string promptPointer;
    }

    /// @notice Emitted once per capsule. Deliberately carries no record *values*.
    /// @dev The resolver emits its own event per `setText`, so repeating nine strings
    ///      here would pay for the same data twice — and `mint()` already writes nine
    ///      records, which is where this phase's gas goes. An indexer wanting the config
    ///      reads the resolver's log or the records themselves.
    ///
    ///      `parentNode` is indexed and `agent` is not, which is a deliberate swap from
    ///      the single-parent version: three topics is the ABI limit, and a dashboard
    ///      showing one name's fleet filters on the parent every time it loads, whereas
    ///      nothing has ever looked a capsule up by its agent address.
    ///
    ///      The parent's registry and resolver are deliberately NOT here, though a
    ///      multi-parent indexer plainly needs both. Neither is new information: the
    ///      registry is `getSubregistry(<parent label>)` one level up, and the resolver is
    ///      whatever `UniversalResolver` walks to — which is how the runner and the
    ///      dashboard already read every record they read. Putting a second copy in the
    ///      log would add two words of gas per mint to publish a value that can go stale
    ///      against the chain it was copied from.
    event CapsuleMinted(
        bytes32 indexed parentNode,
        bytes32 indexed node,
        address indexed owner,
        address agent,
        uint256 tokenId,
        string label,
        uint64 expiry
    );

    /// @notice Emitted when a name connects to this minter, and on every reconfiguration.
    event ParentConnected(
        bytes32 indexed parentNode,
        address indexed registry,
        address indexed resolver,
        address by,
        bool open
    );

    /// @notice Emitted when a parent withdraws. Capsules already minted are untouched.
    event ParentDisconnected(bytes32 indexed parentNode, address indexed registry, address by);

    error ZeroAddress();
    error InvalidLabel(string label);
    error InvalidName(bytes dnsName);
    error MissingResolverRoles();
    /// @dev The caller does not hold `ROLE_REGISTRAR_ADMIN` on the registry.
    error NotParentAdmin(address registry, address account);
    /// @dev No `connectParent` has ever succeeded for this registry.
    error ParentNotConnected(address registry);
    /// @dev The parent is connected but closed, and the caller is not its admin.
    error ParentNotOpen(address registry, address account);
    /// @dev The registry is not wired as the subregistry of the name it claims, or the
    ///      name supplied does not carry the label the registry says it is.
    error ParentLinkBroken(address registry);

    ////////////////////////////////////////////////////////////////////////
    // Construction
    ////////////////////////////////////////////////////////////////////////

    constructor(uint64 duration, string memory schemaUri) {
        DURATION = duration;
        SCHEMA_URI = schemaUri;
        REGISTRY_INTEROP_ADDRESS = interopAddressOf(block.chainid, address(this));
    }

    ////////////////////////////////////////////////////////////////////////
    // Connecting a parent
    ////////////////////////////////////////////////////////////////////////

    /// @notice Register a name with this minter so capsules can be issued under it.
    /// @param registry The name's own `PermissionedRegistry` — the subregistry that will
    ///        hold the capsule labels.
    /// @param resolver The `PermissionedResolver` capsule records are written to. This is
    ///        supplied rather than read off the registry on purpose; see
    ///        `IPermissionedRegistry.getResolver`.
    /// @param parentDns The parent name in DNS wire format, including the trailing root
    ///        byte. The namehash is derived from it rather than accepted alongside it, so
    ///        the two can never disagree — a mismatch would write records to one node and
    ///        grant permissions on another, and neither call would revert.
    /// @param open Whether anybody may mint here, or only this registry's admins.
    ///
    /// @dev Call this *after* granting the minter its roles, and check `readiness` to see
    ///      what is still missing. Connecting does not grant anything: this contract
    ///      cannot give itself `ROLE_REGISTRAR` on your registry, which is the point.
    ///
    ///      Re-calling it is how a parent changes its resolver or flips `open`.
    function connectParent(
        IPermissionedRegistry registry,
        IPermissionedResolver resolver,
        bytes calldata parentDns,
        bool open
    ) external {
        if (address(registry) == address(0) || address(resolver) == address(0)) revert ZeroAddress();
        _requireParentAdmin(registry);

        bytes32 node = _verifyParentLink(registry, parentDns);

        Parent storage parent = _parents[address(registry)];
        parent.resolver = resolver;
        parent.node = node;
        parent.open = open;
        parent.connected = true;
        parent.dnsName = parentDns;

        emit ParentConnected(node, address(registry), address(resolver), msg.sender, open);
    }

    /// @notice Flip whether strangers may mint under an already-connected name.
    /// @dev Separate from `connectParent` because it is the one setting an owner is
    ///      likely to change twice in a demo, and re-sending the DNS name to change a
    ///      boolean invites sending a different one by accident.
    function setParentOpen(IPermissionedRegistry registry, bool open) external {
        Parent storage parent = _requireConnected(registry);
        _requireParentAdmin(registry);
        parent.open = open;
        emit ParentConnected(parent.node, address(registry), address(parent.resolver), msg.sender, open);
    }

    /// @notice Withdraw a name from this minter.
    /// @dev Cosmetic on its own — the roles are what actually authorise minting, and
    ///      revoking `ROLE_REGISTRAR` on your registry is the real disconnection. This
    ///      exists so the intent is on chain and the frontend stops offering the name.
    ///      Capsules already minted keep working: their records, their owner's roles and
    ///      their agent's one key all live in the resolver, not here.
    function disconnectParent(IPermissionedRegistry registry) external {
        Parent storage parent = _requireConnected(registry);
        _requireParentAdmin(registry);
        bytes32 node = parent.node;
        delete _parents[address(registry)];
        emit ParentDisconnected(node, address(registry), msg.sender);
    }

    /// @dev `ROLE_REGISTRAR_ADMIN` at the registry's root resource. Root roles are OR-ed
    ///      into every resource by `EnhancedAccessControl`, so a registry's deployer —
    ///      who necessarily holds this, or they could not have granted the minter
    ///      `ROLE_REGISTRAR` — passes, and nobody else does.
    function _requireParentAdmin(IPermissionedRegistry registry) internal view {
        if (!registry.hasRoles(0, ROLE_REGISTRAR_ADMIN, msg.sender)) {
            revert NotParentAdmin(address(registry), msg.sender);
        }
    }

    function _requireConnected(IPermissionedRegistry registry) internal view returns (Parent storage) {
        Parent storage parent = _parents[address(registry)];
        if (!parent.connected) revert ParentNotConnected(address(registry));
        return parent;
    }

    /// @dev Proves `registry` really is the subregistry of the name `parentDns` spells,
    ///      and returns that name's namehash.
    ///
    ///      Both directions are checked, because either alone is forgeable. A contract can
    ///      return anything at all from `getParent()`, so the upward claim proves nothing
    ///      by itself; the downward `getSubregistry` answer comes from the registry one
    ///      level up, which the caller does not control. Requiring them to agree means the
    ///      only way to pass is to actually be wired in — the same two-way link NOTES.md
    ///      records as gotcha 1, checked here instead of discovered later.
    function _verifyParentLink(IPermissionedRegistry registry, bytes calldata parentDns)
        internal
        view
        returns (bytes32 node)
    {
        (address grandparent, string memory childLabel) = registry.getParent();
        if (grandparent == address(0)) revert ParentLinkBroken(address(registry));
        if (IPermissionedRegistry(grandparent).getSubregistry(childLabel) != address(registry)) {
            revert ParentLinkBroken(address(registry));
        }

        // The name must lead with the label the registry answers to, or the records would
        // land on a node that has nothing to do with the registry the labels are minted in.
        bytes memory dns = parentDns;
        if (dns.length == 0) revert InvalidName(parentDns);
        uint256 firstLength = uint8(dns[0]);
        if (firstLength == 0 || 1 + firstLength > dns.length) revert InvalidName(parentDns);
        if (_labelHashAt(dns, 1, firstLength) != keccak256(bytes(childLabel))) {
            revert ParentLinkBroken(address(registry));
        }

        node = _namehash(dns, 0);
    }

    ////////////////////////////////////////////////////////////////////////
    // Minting
    ////////////////////////////////////////////////////////////////////////

    /// @notice Mint `label.<parent>` as an agent capsule.
    /// @param registry The connected parent's subregistry — the handle on which name this
    ///        capsule goes under. Everything else about the parent is stored, not passed.
    /// @param label The label only, e.g. "trader".
    /// @param owner Receives the name and full control of its resolver records.
    /// @param agent The agent's own EOA. Gets `agent-heartbeat` write access and nothing else.
    function mint(
        IPermissionedRegistry registry,
        string calldata label,
        address owner,
        address agent,
        CapsuleConfig calldata config
    ) external returns (uint256 tokenId, bytes32 node) {
        if (owner == address(0) || agent == address(0)) revert ZeroAddress();

        Parent storage parent = _requireConnected(registry);
        if (!parent.open && !registry.hasRoles(0, ROLE_REGISTRAR_ADMIN, msg.sender)) {
            revert ParentNotOpen(address(registry), msg.sender);
        }

        node = keccak256(abi.encodePacked(parent.node, keccak256(bytes(label))));

        // Split across two internal calls, and it has to be. Registering, granting and
        // writing nine records in one frame needs more than the sixteen reachable stack
        // slots the EVM gives a function, and `solc` refuses the whole contract rather
        // than spilling — so the split is a compiler constraint, not a style choice, and
        // collapsing it back into one body will not build.
        tokenId = _registerAndDelegate(parent, registry, label, owner, agent, node);
        _writeRecords(parent.resolver, node, tokenId, config);
    }

    /// @dev Steps 1, 2 and 4: the name exists, the owner controls it, the agent may write
    ///      exactly one key. Ordered so a failure cannot leave a name nobody controls.
    function _registerAndDelegate(
        Parent storage parent,
        IPermissionedRegistry registry,
        string calldata label,
        address owner,
        address agent,
        bytes32 node
    ) internal returns (uint256 tokenId) {
        IPermissionedResolver resolver = parent.resolver;
        bytes memory dnsName = _childDnsName(parent.dnsName, label);
        uint64 expiry = uint64(block.timestamp) + DURATION;

        // `address(0)` subregistry: agents do not issue child names.
        tokenId = registry.register(label, owner, address(0), address(resolver), ALL_ROLES, expiry);

        // Hand the owner control of this name's records, including the kill switch. Done
        // before the record writes so a failure there cannot leave a half-owned name.
        resolver.authorizeNameRoles(dnsName, OWNER_NAME_ROLES, owner, true);

        // The agent may write exactly one key.
        resolver.authorizeTextRoles(dnsName, KEY_HEARTBEAT, agent, true);

        resolver.setAddr(node, agent);

        emit CapsuleMinted(parent.node, node, owner, agent, tokenId, label, expiry);
    }

    /// @dev Step 3. Uses this contract's own root `ROLE_SET_TEXT` on the parent's resolver.
    function _writeRecords(
        IPermissionedResolver resolver,
        bytes32 node,
        uint256 tokenId,
        CapsuleConfig calldata config
    ) internal {
        // ENSIP-27: what kind of node this is, and where to find the schema for the keys
        // no ENSIP defines. `class` must equal the schema's `title`.
        resolver.setText(node, KEY_CLASS, CLASS_VALUE);
        resolver.setText(node, KEY_SCHEMA, SCHEMA_URI);

        // ENSIP-26: what a generic ENS client shows a human, and where to reach the agent.
        resolver.setText(node, KEY_CONTEXT, config.context);
        resolver.setText(node, KEY_ENDPOINT_WEB, config.telegramUrl);
        resolver.setText(node, KEY_ENDPOINT_CAPSULE, config.capsuleEndpoint);

        // Ours. `agent-heartbeat` is NOT written here — an unwritten heartbeat is what
        // "this agent has never run" looks like, and the agent writes the first one.
        resolver.setText(node, KEY_MODEL, config.model);
        resolver.setText(node, KEY_RUNTIME, config.runtime);
        resolver.setText(node, KEY_PROMPT, config.promptPointer);

        // ENSIP-25: this name really is the agent holding `tokenId` in this registry.
        resolver.setText(node, registrationKey(tokenId), REGISTRATION_VALUE);
    }

    ////////////////////////////////////////////////////////////////////////
    // ENSIP-25 — the registration key
    ////////////////////////////////////////////////////////////////////////

    /// @notice `agent-registration[<registry>][<agentId>]` for a capsule minted here.
    /// @param tokenId The value `mint()` returned, and the `tokenId` in `CapsuleMinted`.
    /// @dev Two bracket groups, which is ENSIP-25's own grammar. ENSIP-27's attribute
    ///      grammar allows only one, which is exactly why this key must never appear in
    ///      the schema at `SCHEMA_URI` — ENSIP-25 defines it, we do not.
    function registrationKey(uint256 tokenId) public view returns (string memory) {
        return string.concat(
            "agent-registration[", REGISTRY_INTEROP_ADDRESS, "][", _toDecimal(tokenId), "]"
        );
    }

    /// @notice An ERC-7930 interoperable address for an EVM account, as a hex string.
    /// @dev Layout, all big-endian:
    ///
    ///        0001            version 1
    ///        0000            chain type — eip155
    ///        <n>             chain reference length
    ///        <chainId>       chain reference, minimal bytes (Sepolia: aa36a7)
    ///        14              address length — 20
    ///        <account>       lowercase, unprefixed
    ///
    ///      Exposed publicly so the fixture in RECORDS.md can be checked against it
    ///      directly, rather than only through a live deployment's stored copy.
    function interopAddressOf(uint256 chainId, address account) public pure returns (string memory) {
        bytes memory ref = _chainReference(chainId);
        return _toHexString(
            abi.encodePacked(
                bytes2(0x0001), bytes2(0x0000), uint8(ref.length), ref, uint8(20), account
            )
        );
    }

    /// @dev The chain id in the fewest bytes that hold it. ERC-7930 length-prefixes the
    ///      reference, so leading zero bytes would be a different encoding of the same
    ///      chain — and therefore a different key.
    function _chainReference(uint256 chainId) internal pure returns (bytes memory ref) {
        if (chainId == 0) return hex"00";
        uint256 length;
        for (uint256 v = chainId; v != 0; v >>= 8) length++;
        ref = new bytes(length);
        for (uint256 i = length; i > 0; i--) {
            ref[i - 1] = bytes1(uint8(chainId));
            chainId >>= 8;
        }
    }

    bytes16 private constant HEX_DIGITS = "0123456789abcdef";

    function _toHexString(bytes memory data) internal pure returns (string memory) {
        bytes memory out = new bytes(2 + data.length * 2);
        out[0] = "0";
        out[1] = "x";
        for (uint256 i = 0; i < data.length; i++) {
            uint8 b = uint8(data[i]);
            out[2 + i * 2] = HEX_DIGITS[b >> 4];
            out[3 + i * 2] = HEX_DIGITS[b & 0x0f];
        }
        return string(out);
    }

    /// @dev ENSIP-25 specifies the agent id in decimal, not hex.
    function _toDecimal(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 length;
        for (uint256 v = value; v != 0; v /= 10) length++;
        bytes memory out = new bytes(length);
        while (value != 0) {
            out[--length] = bytes1(uint8(48 + (value % 10)));
            value /= 10;
        }
        return string(out);
    }

    ////////////////////////////////////////////////////////////////////////
    // Name encoding
    ////////////////////////////////////////////////////////////////////////
    //
    // ENSv2 uses two encodings and mixing them up is the most common integration bug:
    //   * namehash (bytes32)  — for setText / setAddr / text
    //   * DNS wire format     — for authorizeTextRoles / authorizeNameRoles
    // Both are exposed so the frontend can derive them without a second RPC round trip.

    /// @notice The namehash of `label.<parent>`.
    function nodeOf(IPermissionedRegistry registry, string memory label) public view returns (bytes32) {
        return keccak256(abi.encodePacked(_requireConnected(registry).node, keccak256(bytes(label))));
    }

    /// @notice `label.<parent>` in DNS wire format, including the trailing root byte.
    function dnsNameOf(IPermissionedRegistry registry, string memory label)
        public
        view
        returns (bytes memory)
    {
        return _childDnsName(_requireConnected(registry).dnsName, label);
    }

    function _childDnsName(bytes memory parentDns, string memory label)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory l = bytes(label);
        // DNS labels carry a single length byte, so 63 characters is a hard protocol limit.
        if (l.length == 0 || l.length > 63) revert InvalidLabel(label);
        return abi.encodePacked(uint8(l.length), l, parentDns);
    }

    /// @notice The namehash of a DNS wire-format name.
    /// @dev Mirrors `NameCoder.namehash`, which is what `PermissionedResolver` runs on
    ///      every `authorizeTextRoles` / `authorizeNameRoles` call. Deriving the node here
    ///      instead of accepting it as an argument is what makes it impossible for the
    ///      node we write records to and the name we grant permissions on to be different
    ///      names — a divergence that reverts nowhere and shows up as an agent whose
    ///      heartbeat is silently unauthorized.
    ///
    ///      Recursive, with depth bounded by the label count of a name someone chose to
    ///      type. The terminal check requires the root byte to be the *last* byte, so
    ///      trailing junk is rejected rather than ignored.
    function namehash(bytes memory dnsName) public pure returns (bytes32) {
        return _namehash(dnsName, 0);
    }

    function _namehash(bytes memory dns, uint256 offset) internal pure returns (bytes32) {
        if (offset >= dns.length) revert InvalidName(dns);
        uint256 length = uint8(dns[offset]);
        if (length == 0) {
            if (offset + 1 != dns.length) revert InvalidName(dns);
            return bytes32(0);
        }
        if (offset + 1 + length > dns.length) revert InvalidName(dns);
        return keccak256(
            abi.encodePacked(
                _namehash(dns, offset + 1 + length), _labelHashAt(dns, offset + 1, length)
            )
        );
    }

    /// @dev `keccak256(dns[start:start+length])` without copying the slice into a new
    ///      `bytes`. Bounds are checked by every caller before it gets here.
    function _labelHashAt(bytes memory dns, uint256 start, uint256 length)
        internal
        pure
        returns (bytes32 hash)
    {
        assembly {
            hash := keccak256(add(add(dns, 0x20), start), length)
        }
    }

    /// @notice The EAC resource id guarding one text key on one name.
    /// @dev `uint256(keccak256(abi.encode(node, keccak256(key))))`. Use this with
    ///      `resolver.hasRoles(...)` to check permissions. Never read a permission from a
    ///      revert: `setText` reverts against the name-level resource `resource(node, 0)`
    ///      regardless of which key was denied.
    function textResourceOf(bytes32 node, string memory key) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(node, keccak256(bytes(key)))));
    }

    ////////////////////////////////////////////////////////////////////////
    // Views the frontend runs before it lets anyone sign anything
    ////////////////////////////////////////////////////////////////////////

    /// @notice A parent's stored configuration. `connected` is false for a name that has
    ///         never called `connectParent`, and every other field is then meaningless.
    function parentOf(IPermissionedRegistry registry)
        external
        view
        returns (
            bool connected,
            bool open,
            IPermissionedResolver resolver,
            bytes32 node,
            bytes memory dnsName
        )
    {
        Parent storage parent = _parents[address(registry)];
        return (parent.connected, parent.open, parent.resolver, parent.node, parent.dnsName);
    }

    /// @notice Everything that has to be true before `mint()` will work for `account`.
    ///
    /// @dev One call, five booleans, because the alternative is a launch form that finds
    ///      out which step was skipped from a revert selector after the user has signed.
    ///      `connectParent` deliberately does not require the roles to be in place, so
    ///      "connected but not yet granted" is a real and expected state, and this is what
    ///      tells the two apart.
    ///
    /// @return connected `connectParent` has been called for this registry.
    /// @return registrarGranted The minter holds `ROLE_REGISTRAR` on the registry.
    /// @return resolverRolesGranted The minter holds all four root roles on the resolver.
    /// @return open Anybody may mint here.
    /// @return callerMayMint `account` would get past the authorization check today.
    function readiness(IPermissionedRegistry registry, address account)
        external
        view
        returns (
            bool connected,
            bool registrarGranted,
            bool resolverRolesGranted,
            bool open,
            bool callerMayMint
        )
    {
        Parent storage parent = _parents[address(registry)];
        connected = parent.connected;
        open = parent.open;

        registrarGranted = registry.hasRoles(0, ROLE_REGISTRAR, address(this));
        resolverRolesGranted = connected
            && parent.resolver.hasRoles(0, REQUIRED_RESOLVER_ROOT_ROLES, address(this));

        bool isAdmin = registry.hasRoles(0, ROLE_REGISTRAR_ADMIN, account);
        callerMayMint = connected && registrarGranted && resolverRolesGranted && (open || isAdmin);
    }

    /// @notice Whether `agent` can currently write `agent-heartbeat` on `label`.
    /// @dev The frontend's live "is this capsule running?" check.
    function isAgentAuthorized(IPermissionedRegistry registry, string calldata label, address agent)
        external
        view
        returns (bool)
    {
        Parent storage parent = _requireConnected(registry);
        bytes32 node = keccak256(abi.encodePacked(parent.node, keccak256(bytes(label))));
        return parent.resolver.hasRoles(textResourceOf(node, KEY_HEARTBEAT), ROLE_SET_TEXT, agent);
    }

    /// @notice Reverts unless this contract holds the resolver roles `mint()` needs.
    /// @dev Call once after connecting a parent. Cheaper to find out here than inside a
    ///      user's mint. Takes the resolver rather than the registry so a deploy script
    ///      can check a resolver before any parent references it.
    function checkResolverRoles(IPermissionedResolver resolver) external view {
        if (!resolver.hasRoles(0, REQUIRED_RESOLVER_ROOT_ROLES, address(this))) {
            revert MissingResolverRoles();
        }
    }
}
