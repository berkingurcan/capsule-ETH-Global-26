// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.4;

library IPermissionedRegistry {
    type Status is uint8;

    struct State {
        Status status;
        uint64 expiry;
        address latestOwner;
        uint256 tokenId;
        uint256 resource;
    }
}

interface PermissionedRegistry {
    error CannotReduceExpiry(uint64 oldExpiry, uint64 newExpiry);
    error CannotSetPastExpiry(uint64 expiry);
    error EACCannotGrantRoles(uint256 resource, uint256 roleBitmap, address account);
    error EACCannotRevokeRoles(uint256 resource, uint256 roleBitmap, address account);
    error EACInvalidAccount();
    error EACInvalidRoleBitmap(uint256 roleBitmap);
    error EACMaxAssignees(uint256 resource, uint256 role);
    error EACMinAssignees(uint256 resource, uint256 role);
    error EACRootResourceNotAllowed();
    error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account);
    error ERC1155InsufficientBalance(address sender, uint256 balance, uint256 needed, uint256 tokenId);
    error ERC1155InvalidApprover(address approver);
    error ERC1155InvalidArrayLength(uint256 idsLength, uint256 valuesLength);
    error ERC1155InvalidOperator(address operator);
    error ERC1155InvalidReceiver(address receiver);
    error ERC1155InvalidSender(address sender);
    error ERC1155MissingApprovalForAll(address operator, address owner);
    error LabelAlreadyRegistered(string label);
    error LabelAlreadyReserved(string label);
    error LabelExpired(uint256 tokenId);
    error TransferDisallowed(uint256 tokenId, address from);

    event ApprovalForAll(address indexed account, address indexed operator, bool approved);
    event EACRolesChanged(
        uint256 indexed resource, address indexed account, uint256 oldRoleBitmap, uint256 newRoleBitmap
    );
    event ExpiryUpdated(uint256 indexed tokenId, uint64 indexed newExpiry, address indexed sender);
    event LabelRegistered(
        uint256 indexed tokenId,
        bytes32 indexed labelHash,
        string label,
        address owner,
        uint64 expiry,
        address indexed sender
    );
    event LabelReserved(
        uint256 indexed tokenId, bytes32 indexed labelHash, string label, uint64 expiry, address indexed sender
    );
    event LabelUnregistered(uint256 indexed tokenId, address indexed sender);
    event ParentUpdated(address indexed parent, string label, address indexed sender);
    event RegistryCreated();
    event ResolverUpdated(uint256 indexed tokenId, address indexed resolver, address indexed sender);
    event SubregistryUpdated(uint256 indexed tokenId, address indexed subregistry, address indexed sender);
    event TokenRegenerated(uint256 indexed oldTokenId, uint256 indexed newTokenId);
    event TokenResource(uint256 indexed tokenId, uint256 indexed resource);
    event TransferBatch(
        address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values
    );
    event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value);
    event URI(string value, uint256 indexed id);
    event URIUpdated(string uri, address renderer, address indexed sender);

    function LABEL_STORE() external view returns (address);
    function ROOT_RESOURCE() external view returns (uint256);
    function balanceOf(address account, uint256 id) external view returns (uint256);
    function balanceOfBatch(address[] memory accounts, uint256[] memory ids) external view returns (uint256[] memory);
    function findExpiry(string memory label) external view returns (uint64);
    function findOwner(string memory label) external view returns (address);
    function findTokenId(string memory label) external view returns (uint256);
    function getAssigneeCount(uint256 anyId, uint256 roleBitmap) external view returns (uint256 counts, uint256 mask);
    function getExpiry(uint256 anyId) external view returns (uint64);
    function getOwner(uint256 anyId) external view returns (address);
    function getParent() external view returns (address parent, string memory label);
    function getResolver(string memory label) external view returns (address);
    function getResource(uint256 anyId) external view returns (uint256);
    function getState(uint256 anyId) external view returns (IPermissionedRegistry.State memory state);
    function getStatus(uint256 anyId) external view returns (IPermissionedRegistry.Status);
    function getSubregistry(string memory label) external view returns (address);
    function getTokenId(uint256 anyId) external view returns (uint256);
    function grantRoles(uint256 anyId, uint256 roleBitmap, address account) external returns (bool);
    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function hasAssignees(uint256 anyId, uint256 roleBitmap) external view returns (bool);
    function hasRoles(uint256 anyId, uint256 roleBitmap, address account) external view returns (bool);
    function hasRootRoles(uint256 roleBitmap, address account) external view returns (bool);
    function isApprovedForAll(address account, address operator) external view returns (bool);
    function isContractNamer(address namer) external view returns (bool);
    function latestOwnerOf(uint256 tokenId) external view returns (address);
    function ownerOf(uint256 tokenId) external view returns (address);
    function register(
        string memory label,
        address owner,
        address registry,
        address resolver,
        uint256 roleBitmap,
        uint64 expiry
    ) external returns (uint256);
    function renew(uint256 anyId, uint64 newExpiry) external;
    function revokeRoles(uint256 anyId, uint256 roleBitmap, address account) external returns (bool);
    function revokeRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function roleCount(uint256 anyId) external view returns (uint256);
    function roles(uint256 anyId, address account) external view returns (uint256);
    function safeBatchTransferFrom(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values,
        bytes memory data
    ) external;
    function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes memory data) external;
    function setApprovalForAll(address operator, bool approved) external;
    function setParent(address parent, string memory label) external;
    function setResolver(uint256 anyId, address resolver) external;
    function setSubregistry(uint256 anyId, address registry) external;
    function setURI(string memory uri_, address renderer) external;
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
    function unregister(uint256 anyId) external;
    function uri(uint256 tokenId) external view returns (string memory);
}
