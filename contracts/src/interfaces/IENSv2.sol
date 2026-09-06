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

    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);

    function hasRoles(uint256 resource, uint256 roleBitmap, address account)
        external
        view
        returns (bool);
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
