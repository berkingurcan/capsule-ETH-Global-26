// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPermissionedRegistry, IPermissionedResolver} from "./interfaces/IENSv2.sol";
import {AgentRecords} from "./libraries/AgentRecords.sol";

/// @title CapsuleMinter
/// @notice Mints one ENSv2 subname per AI agent and wires its permissions in a single
///         transaction: the name is registered, its records are written to the agent
///         ENSIPs, the owner is given control of the name, and the agent is granted write
///         access to exactly one key — `agent-heartbeat`.
///
/// @dev The records follow three standards rather than a schema of our own:
///
///      ENSIP-27  `class = Agent`, plus `schema` pointing at a JSON Schema that describes
///                every key below that no ENSIP defines. Attribute keys are kebab-case
///                because ENSIP-27 requires it — this is why there are no dots here.
///      ENSIP-26  `agent-context` and the parameterised `agent-endpoint[<protocol>]`.
///      ENSIP-25  `agent-registration[<registry>][<agentId>]`, which lets any client
///                verify that this name really belongs to the agent this contract
///                registered. See `registrationKey`.
///
/// @dev Why the agent gets one key and not a resolver:
///
/// `PermissionedResolver` scopes write permission per name AND per record key. The agent
/// can prove it is alive by writing `agent-heartbeat`, and cannot touch `agent-prompt`,
/// `agent-model` or its endpoints — so a compromised or prompt-injected agent cannot
/// rewrite its own instructions. That boundary is enforced by ENS, not by our backend.
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
contract CapsuleMinter {
    using AgentRecords for string;

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
    //
    // Spelled once, here, and mirrored in runner/src/records.ts and
    // web/lib/capsule/records.ts. Keeping them in step is not cosmetic: authorising one
    // key and writing another does not fail loudly, because `setText` reverts against the
    // NAME-level resource whichever key was denied. A stale key string is therefore
    // indistinguishable from a revoked agent. The TypeScript copies are asserted against
    // these constants in the test suite.

    /// @notice ENSIP-27 node classification. Pascal-case, from the recommended vocabulary.
    string public constant KEY_CLASS = "class";
    string public constant CLASS_AGENT = "Agent";

    /// @notice ENSIP-27 pointer to the JSON Schema describing the Capsule-specific keys.
    string public constant KEY_SCHEMA = "schema";

    /// @notice ENSIP-26. Free-form description of the agent, for any client.
    string public constant KEY_CONTEXT = "agent-context";

    /// @notice ENSIP-26 `agent-endpoint[web]` — the human-facing interface. For a Capsule
    ///         agent that is its Telegram bot; there is no other UI to point at.
    string public constant KEY_ENDPOINT_WEB = "agent-endpoint[web]";

    /// @notice `agent-endpoint[capsule]` — the control plane the runner fetches its prompt
    ///         and its sealed credentials from. Our protocol tag, ENSIP-26's syntax.
    string public constant KEY_ENDPOINT_CAPSULE = "agent-endpoint[capsule]";

    /// @notice The model the agent runs on. Swapping it on chain is one `setText`.
    string public constant KEY_MODEL = "agent-model";

    /// @notice Which runtime the capsule supervises. Always `openclaw` today.
    string public constant KEY_RUNTIME = "agent-runtime";
    string public constant RUNTIME_OPENCLAW = "openclaw";

    /// @dev An opaque pointer such as "cap_8f3d1a", never the prompt itself and never a
    ///      secret. The prompt body and any API keys stay encrypted off-chain.
    string public constant KEY_PROMPT = "agent-prompt";

    /// @notice The only key the agent may write.
    string public constant KEY_HEARTBEAT = "agent-heartbeat";

    /// @dev ENSIP-25 requires a non-empty value; the value itself carries no meaning.
    string internal constant REGISTERED = "1";

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

    /// @notice This contract as an ERC-7930 interoperable address — the `<registry>` half
    ///         of every ENSIP-25 key it writes.
    /// @dev Derived once from `block.chainid` and `address(this)` rather than configured,
    ///      so it cannot drift from the deployment it describes.
    string public REGISTRY_ADDRESS_7930;

    /// @notice The `schema` record every capsule carries, per ENSIP-27.
    string public SCHEMA_URI;

    ////////////////////////////////////////////////////////////////////////
    // Types
    ////////////////////////////////////////////////////////////////////////

    struct CapsuleConfig {
        string model;
        /// @dev Base URL of the control plane → `agent-endpoint[capsule]`.
        string endpoint;
        string promptPointer;
        /// @dev ENSIP-26 `agent-context`. Required: an agent nobody can describe is not
        ///      discoverable, and this is the one record a generic ENS client will show.
        string context;
        /// @dev `https://t.me/<bot>` → `agent-endpoint[web]`. Optional: an owner who has
        ///      not made their bot yet can add it later, and an empty record is worse
        ///      than an absent one.
        string telegramUrl;
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
    error EmptyContext();

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
        REGISTRY_ADDRESS_7930 = AgentRecords.erc7930Address(block.chainid, address(this));
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
        if (bytes(config.context).length == 0) revert EmptyContext();

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

        // Standard first: a client that speaks the ENSIPs and nothing else can read
        // `class`, follow `schema`, and understand every key that follows.
        RESOLVER.setText(node, KEY_CLASS, CLASS_AGENT);
        RESOLVER.setText(node, KEY_SCHEMA, SCHEMA_URI);
        RESOLVER.setText(node, KEY_CONTEXT, config.context);
        RESOLVER.setText(node, KEY_ENDPOINT_CAPSULE, config.endpoint);
        if (bytes(config.telegramUrl).length != 0) {
            RESOLVER.setText(node, KEY_ENDPOINT_WEB, config.telegramUrl);
        }

        // Then ours, as declared by that schema.
        RESOLVER.setText(node, KEY_MODEL, config.model);
        RESOLVER.setText(node, KEY_RUNTIME, RUNTIME_OPENCLAW);
        RESOLVER.setText(node, KEY_PROMPT, config.promptPointer);

        // 4. ENSIP-25: this name is the agent registered here under this token id.
        //    Written last because the key contains the token id, which step 1 produced.
        RESOLVER.setText(node, registrationKey(tokenId), REGISTERED);

        // 5. The agent may write exactly one key.
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
    // ENSIP-25
    ////////////////////////////////////////////////////////////////////////

    /// @notice The ENSIP-25 verification key for the agent registered under `tokenId`.
    ///
    /// @dev ENSIP-25 asks a registry to document how a verifier obtains both halves of the
    ///      key. For Capsule:
    ///
    ///        <agentId>   the `tokenId` returned by `mint()`, also carried by
    ///                    `CapsuleMinted`, in decimal.
    ///        <registry>  this contract, ERC-7930 encoded — `REGISTRY_ADDRESS_7930`.
    ///
    ///      Resolve this key on the claimed name through `UniversalResolverV2`. A
    ///      non-empty value verifies the claim; a missing or empty record fails it. ENS
    ///      ownership can change afterwards, so it is a statement about now.
    function registrationKey(uint256 tokenId) public view returns (string memory) {
        return AgentRecords.registrationKey(REGISTRY_ADDRESS_7930, tokenId);
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
