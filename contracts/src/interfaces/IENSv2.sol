// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev Minimal local interfaces for the ENSv2 Sepolia beta.
///
/// We deliberately do NOT vendor the ENS contracts. Only the handful of functions Capsule
/// calls are declared here, transcribed from the Etherscan-verified sources in `ens-src*/`.
/// `IRegistry` parameters are declared as `address` — the canonical ABI type for a contract
/// reference — so every selector below matches the deployed contracts exactly.

interface IPermissionedRegistry {
    /// @notice Mint a subname. Caller needs `ROLE_REGISTRAR` on the registry's root resource.
    /// @param label The label only, e.g. "trader" — not the full name.
    /// @param subregistry Registry for the subname's own children, or `address(0)` for none.
    /// @param roleBitmap Registry roles granted to `owner` on this token's resource.
    function register(
        string calldata label,
        address owner,
        address subregistry,
        address resolver,
        uint256 roleBitmap,
        uint64 expiry
    ) external returns (uint256 tokenId);

    function latestOwnerOf(uint256 tokenId) external view returns (address owner);

    /// @notice Burn a registration so the label can be registered again.
    /// @dev Needed to re-mint a label onto a new minter: `register` reverts while a
    ///      live registration exists. Re-registering yields a NEW tokenId — the low
    ///      bits carry a version — but the namehash is unchanged, so resolver records
    ///      and EAC grants on the node SURVIVE. Clean them up explicitly.
    function unregister(uint256 tokenId) external;

    /// @notice Current tokenId for a label, or 0 if it has never been registered.
    function findTokenId(string calldata label) external view returns (uint256 tokenId);

    /// @notice Current owner of a label, or `address(0)` if unregistered or expired.
    function findOwner(string calldata label) external view returns (address owner);

    /// @notice The registry holding this registry's own name, and that name's label.
    /// @dev `(address(0), "")` until someone calls `setParent`. This is the upward half
    ///      of the two-way link an ENSv2 subregistry needs; `getSubregistry` on the
    ///      returned registry is the downward half, and `CapsuleMinter.connectParent`
    ///      checks both, because either one alone can be asserted by a contract that is
    ///      not actually anybody's subregistry.
    function getParent() external view returns (address parent, string memory label);

    /// @notice The subregistry issuing `label`'s children, or `address(0)` for none.
    function getSubregistry(string calldata label) external view returns (address);

    /// @notice The resolver recorded for `label`.
    /// @dev NOT used to discover a parent's resolver. On the hackathon deployment
    ///      `ETHRegistry.getResolver("capsulefleet")` answers `PublicResolverV2`, which
    ///      cannot authorize ENSv2-native names at all (NOTES.md, gotcha 2) — the
    ///      resolver capsules actually use is the `PermissionedResolver` proxy passed to
    ///      `register()` per subname. So the parent's resolver is supplied to
    ///      `connectParent` by the parent's own admin and stored, never inferred.
    function getResolver(string calldata label) external view returns (address);

    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);

    function hasRoles(uint256 resource, uint256 roleBitmap, address account)
        external
        view
        returns (bool);
}

/// @dev The ENS hackathon deployment's `PermissionedResolver`, which is a later revision
///      than the beta's and not call-compatible with it. Records there are addressed by
///      DNS wire name rather than namehash, and permissions hang off the *argument*
///      alone: `setText` checks `keccak256(key)`, with the name playing no part. See
///      NOTES.md gotcha 16 for what that costs us.
interface IInodeResolver {
    function setText(bytes calldata name, string calldata key, string calldata value) external;

    /// @param coinType ENSIP-9. 60 is Ethereum, and `addressBytes` is then the 20 raw bytes.
    function setAddress(bytes calldata name, uint256 coinType, bytes calldata addressBytes)
        external;

    /// @notice Grant one setter's argument-scoped role to `account`.
    /// @param setter An abi-encoded call to the setter being authorized. Only the selector
    ///        and the argument are read; the name and value are ignored, which is exactly
    ///        the problem — the grant is not scoped to the name passed here.
    function grantSetterRoles(bytes calldata setter, address account) external returns (bool);

    /// @notice Number of records created. Used only as a liveness probe: the beta resolver
    ///         has no such function, so a successful call identifies the deployment.
    function getRecordCount() external view returns (uint256);
}

interface IPermissionedResolver {
    /// @param node The ENS namehash.
    function setText(bytes32 node, string calldata key, string calldata value) external;

    function setAddr(bytes32 node, address addr_) external;

    /// @notice Grant or revoke write access to ONE text key on ONE name.
    /// @dev This is the kill switch. Caller needs `ROLE_SET_TEXT_ADMIN`.
    /// @param toName DNS wire format, NOT a namehash.
    function authorizeTextRoles(
        bytes calldata toName,
        string calldata key,
        address account,
        bool grant
    ) external returns (bool);

    /// @notice Grant or revoke name-wide resolver roles.
    /// @param toName DNS wire format, NOT a namehash.
    function authorizeNameRoles(
        bytes calldata toName,
        uint256 roleBitmap,
        address account,
        bool grant
    ) external returns (bool);

    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);

    function text(bytes32 node, string calldata key) external view returns (string memory);

    function hasRoles(uint256 resource, uint256 roleBitmap, address account)
        external
        view
        returns (bool);
}
