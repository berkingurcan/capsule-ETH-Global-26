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

    /// @notice Root roles this contract must hold on the resolver before `mint()` works.
    /// @dev The non-admin halves let it write records; the admin halves let it delegate.
    ///      Root roles apply to every name, which is required because the names do not
    ///      exist yet at deploy time.
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

    IPermissionedRegistry public immutable REGISTRY;
    IPermissionedResolver public immutable RESOLVER;

    /// @dev Namehash of the parent, e.g. `capsulefleet.eth`.
    bytes32 public immutable PARENT_NODE;

    /// @dev Registration length. Must not outlive the parent name.
    uint64 public immutable DURATION;

    /// @dev Parent in DNS wire format including the root byte, e.g.
    ///      `0x0c63617073756c65666c6565740365746800` for `capsulefleet.eth`.
    ///      Dynamic, so it cannot be `immutable`.
    bytes public PARENT_DNS;

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
    string public REGISTRY_INTEROP_ADDRESS;

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
    event CapsuleMinted(
        bytes32 indexed node,
        address indexed owner,
        address indexed agent,
        uint256 tokenId,
        string label,
        uint64 expiry
    );

    error ZeroAddress();
    error InvalidLabel(string label);
    error MissingResolverRoles();

    ////////////////////////////////////////////////////////////////////////
    // Construction
    ////////////////////////////////////////////////////////////////////////

    constructor(
        IPermissionedRegistry registry,
        IPermissionedResolver resolver,
        bytes32 parentNode,
        bytes memory parentDns,
        uint64 duration,
        string memory schemaUri
    ) {
        REGISTRY = registry;
        RESOLVER = resolver;
        PARENT_NODE = parentNode;
        PARENT_DNS = parentDns;
        DURATION = duration;
        SCHEMA_URI = schemaUri;
        REGISTRY_INTEROP_ADDRESS = interopAddressOf(block.chainid, address(this));
    }

    ////////////////////////////////////////////////////////////////////////
    // Minting
    ////////////////////////////////////////////////////////////////////////

    /// @notice Mint `label.<parent>` as an agent capsule.
    /// @param label The label only, e.g. "trader".
    /// @param owner Receives the name and full control of its resolver records.
    /// @param agent The agent's own EOA. Gets `agent-heartbeat` write access and nothing else.
    function mint(string calldata label, address owner, address agent, CapsuleConfig calldata config)
        external
        returns (uint256 tokenId, bytes32 node)
    {
        if (owner == address(0) || agent == address(0)) revert ZeroAddress();

        bytes memory dnsName = dnsNameOf(label);
        node = nodeOf(label);
        uint64 expiry = uint64(block.timestamp) + DURATION;

        // 1. Register the name. `address(0)` subregistry: agents do not issue child names.
        tokenId = REGISTRY.register(label, owner, address(0), address(RESOLVER), ALL_ROLES, expiry);

        // 2. Hand the owner control of this name's records, including the kill switch.
        //    Done before the writes below so a failure here cannot leave a half-owned name.
        RESOLVER.authorizeNameRoles(dnsName, OWNER_NAME_ROLES, owner, true);

        // 3. Write the records. Uses this contract's own root ROLE_SET_TEXT / ROLE_SET_ADDR.
        RESOLVER.setAddr(node, agent);

        // ENSIP-27: what kind of node this is, and where to find the schema for the keys
        // no ENSIP defines. `class` must equal the schema's `title`.
        RESOLVER.setText(node, KEY_CLASS, CLASS_VALUE);
        RESOLVER.setText(node, KEY_SCHEMA, SCHEMA_URI);

        // ENSIP-26: what a generic ENS client shows a human, and where to reach the agent.
        RESOLVER.setText(node, KEY_CONTEXT, config.context);
        RESOLVER.setText(node, KEY_ENDPOINT_WEB, config.telegramUrl);
        RESOLVER.setText(node, KEY_ENDPOINT_CAPSULE, config.capsuleEndpoint);

        // Ours. `agent-heartbeat` is NOT written here — an unwritten heartbeat is what
        // "this agent has never run" looks like, and the agent writes the first one.
        RESOLVER.setText(node, KEY_MODEL, config.model);
        RESOLVER.setText(node, KEY_RUNTIME, config.runtime);
        RESOLVER.setText(node, KEY_PROMPT, config.promptPointer);

        // ENSIP-25: this name really is the agent holding `tokenId` in this registry.
        RESOLVER.setText(node, registrationKey(tokenId), REGISTRATION_VALUE);

        // 4. The agent may write exactly one key.
        RESOLVER.authorizeTextRoles(dnsName, KEY_HEARTBEAT, agent, true);

        emit CapsuleMinted(node, owner, agent, tokenId, label, expiry);
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
    function nodeOf(string memory label) public view returns (bytes32) {
        return keccak256(abi.encodePacked(PARENT_NODE, keccak256(bytes(label))));
    }

    /// @notice `label.<parent>` in DNS wire format, including the trailing root byte.
    function dnsNameOf(string memory label) public view returns (bytes memory) {
        bytes memory l = bytes(label);
        // DNS labels carry a single length byte, so 63 characters is a hard protocol limit.
        if (l.length == 0 || l.length > 63) revert InvalidLabel(label);
        return abi.encodePacked(uint8(l.length), l, PARENT_DNS);
    }

    /// @notice The EAC resource id guarding one text key on one name.
    /// @dev `uint256(keccak256(abi.encode(node, keccak256(key))))`. Use this with
    ///      `resolver.hasRoles(...)` to check permissions. Never read a permission from a
    ///      revert: `setText` reverts against the name-level resource `resource(node, 0)`
    ///      regardless of which key was denied.
    function textResourceOf(bytes32 node, string memory key) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(node, keccak256(bytes(key)))));
    }

    /// @notice Whether `agent` can currently write `agent-heartbeat` on `label`.
    /// @dev The frontend's live "is this capsule running?" check.
    function isAgentAuthorized(string calldata label, address agent) external view returns (bool) {
        return RESOLVER.hasRoles(textResourceOf(nodeOf(label), KEY_HEARTBEAT), ROLE_SET_TEXT, agent);
    }

    /// @notice Reverts unless this contract holds the resolver roles `mint()` needs.
    /// @dev Call once after deployment. Cheaper to find out here than inside a user's mint.
    function checkResolverRoles() external view {
        if (!RESOLVER.hasRoles(0, REQUIRED_RESOLVER_ROOT_ROLES, address(this))) {
            revert MissingResolverRoles();
        }
    }
}
