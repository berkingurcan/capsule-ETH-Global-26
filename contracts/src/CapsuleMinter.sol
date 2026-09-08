// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPermissionedRegistry, IPermissionedResolver} from "./interfaces/IENSv2.sol";

/// @title CapsuleMinter
/// @notice Mints one ENSv2 subname per AI agent and wires its permissions in a single
///         transaction: the name is registered, its config records are written, the owner
///         is given control of the name's records, and the agent is granted write access
///         to exactly one key — `agent.heartbeat`.
///
/// @dev Why the agent gets one key and not a resolver:
///
/// `PermissionedResolver` scopes write permission per name AND per record key. The agent
/// can prove it is alive by writing `agent.heartbeat`, and cannot touch `agent.prompt`,
/// `agent.model` or `agent.endpoint` — so a compromised or prompt-injected agent cannot
/// rewrite its own instructions. That boundary is enforced by ENS, not by our backend.
///
/// @dev Why there is no `halt()` function here:
///
/// `mint()` grants the owner `ROLE_SET_TEXT_ADMIN` on their own name, so the owner revokes
/// the agent by calling the resolver directly:
///
///     resolver.authorizeTextRoles(dnsName, "agent.heartbeat", agent, false)
///
/// The kill switch therefore does not depend on this contract existing. If Capsule
/// disappears tomorrow, every owner keeps control of their agent through ENS alone.
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
    // The four keys already written on chain still hold their DOTTED values — live
    // names carry `agent.model`, and renaming here without a redeploy would lock every
    // running agent out of its own heartbeat. The kebab-case rename is Phase 2 and
    // lands in all three files at once. Keys marked NEW have never been written, so
    // they carry their final ENSIP values already.

    /// @notice ENSIP-27 node classification. NEW.
    string public constant KEY_CLASS = "class";

    /// @notice ENSIP-27 pointer to the JSON Schema covering our own keys. NEW.
    string public constant KEY_SCHEMA = "schema";

    /// @notice ENSIP-26 free-form description of the agent. NEW.
    string public constant KEY_CONTEXT = "agent-context";

    /// @notice ENSIP-26. The human-facing interface — for a capsule, the Telegram bot. NEW.
    string public constant KEY_ENDPOINT_WEB = "agent-endpoint[web]";

    /// @notice ENSIP-26 syntax, our own protocol tag: the control plane the runner
    ///         fetches its prompt and credentials from. Phase 2 -> "agent-endpoint[capsule]".
    string public constant KEY_ENDPOINT_CAPSULE = "agent.endpoint";

    /// @notice Phase 2 -> "agent-model".
    string public constant KEY_MODEL = "agent.model";

    /// @notice The agent runtime, e.g. "openclaw". NEW.
    string public constant KEY_RUNTIME = "agent-runtime";

    /// @dev An opaque pointer such as "cap_8f3d1a", never the prompt itself and never a
    ///      secret. The prompt body and any API keys stay encrypted off-chain.
    ///      Phase 2 -> "agent-prompt".
    string public constant KEY_PROMPT = "agent.prompt";

    /// @notice The only key the agent may write. Phase 2 -> "agent-heartbeat".
    string public constant KEY_HEARTBEAT = "agent.heartbeat";

    /// @notice ENSIP-27 `class` value, pascal-case. Must equal the served schema's `title`.
    string public constant CLASS_VALUE = "Agent";

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

    ////////////////////////////////////////////////////////////////////////
    // Types
    ////////////////////////////////////////////////////////////////////////

    struct CapsuleConfig {
        string model;
        string endpoint;
        string promptPointer;
    }

    event CapsuleMinted(
        bytes32 indexed node,
        address indexed owner,
        address indexed agent,
        uint256 tokenId,
        string label,
        string model,
        string endpoint,
        string promptPointer,
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
        uint64 duration
    ) {
        REGISTRY = registry;
        RESOLVER = resolver;
        PARENT_NODE = parentNode;
        PARENT_DNS = parentDns;
        DURATION = duration;
    }

    ////////////////////////////////////////////////////////////////////////
    // Minting
    ////////////////////////////////////////////////////////////////////////

    /// @notice Mint `label.<parent>` as an agent capsule.
    /// @param label The label only, e.g. "trader".
    /// @param owner Receives the name and full control of its resolver records.
    /// @param agent The agent's own EOA. Gets `agent.heartbeat` write access and nothing else.
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

        // 3. Write the config. Uses this contract's own root ROLE_SET_TEXT / ROLE_SET_ADDR.
        RESOLVER.setAddr(node, agent);
        RESOLVER.setText(node, KEY_MODEL, config.model);
        RESOLVER.setText(node, KEY_ENDPOINT_CAPSULE, config.endpoint);
        RESOLVER.setText(node, KEY_PROMPT, config.promptPointer);

        // 4. The agent may write exactly one key.
        RESOLVER.authorizeTextRoles(dnsName, KEY_HEARTBEAT, agent, true);

        emit CapsuleMinted(
            node,
            owner,
            agent,
            tokenId,
            label,
            config.model,
            config.endpoint,
            config.promptPointer,
            expiry
        );
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

    /// @notice Whether `agent` can currently write `agent.heartbeat` on `label`.
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
