// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.4;

interface PermissionedResolver {
    error AddressEmptyCode(address target);
    error DNSDecodingFailed(bytes dns);
    error EACCannotGrantRoles(uint256 resource, uint256 roleBitmap, address account);
    error EACCannotRevokeRoles(uint256 resource, uint256 roleBitmap, address account);
    error EACInvalidAccount();
    error EACInvalidRoleBitmap(uint256 roleBitmap);
    error EACMaxAssignees(uint256 resource, uint256 role);
    error EACMinAssignees(uint256 resource, uint256 role);
    error EACRootResourceNotAllowed();
    error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account);
    error ERC1967InvalidImplementation(address implementation);
    error ERC1967NonPayable();
    error FailedCall();
    error InvalidContentType(uint256 contentType);
    error InvalidEVMAddress(bytes addressBytes);
    error InvalidInitialization();
    error NotInitializing();
    error UUPSUnauthorizedCallContext();
    error UUPSUnsupportedProxiableUUID(bytes32 slot);
    error UnsupportedResolverProfile(bytes4 selector);

    event ABIChanged(bytes32 indexed node, uint256 indexed contentType);
    event AddrChanged(bytes32 indexed node, address a);
    event AddressChanged(bytes32 indexed node, uint256 coinType, bytes newAddress);
    event AliasChanged(bytes indexed indexedFromName, bytes indexed indexedToName, bytes fromName, bytes toName);
    event ContenthashChanged(bytes32 indexed node, bytes hash);
    event DataChanged(bytes32 indexed node, string indexed indexedKey, string key, bytes indexed indexedData);
    event EACRolesChanged(
        uint256 indexed resource, address indexed account, uint256 oldRoleBitmap, uint256 newRoleBitmap
    );
    event Initialized(uint64 version);
    event InterfaceChanged(bytes32 indexed node, bytes4 indexed interfaceID, address implementer);
    event NameChanged(bytes32 indexed node, string name);
    event NamedAddrResource(uint256 indexed resource, bytes name, uint256 indexed coinType);
    event NamedDataResource(uint256 indexed resource, bytes name, bytes32 indexed keyHash, string key);
    event NamedResource(uint256 indexed resource, bytes name);
    event NamedTextResource(uint256 indexed resource, bytes name, bytes32 indexed keyHash, string key);
    event PubkeyChanged(bytes32 indexed node, bytes32 x, bytes32 y);
    event TextChanged(bytes32 indexed node, string indexed indexedKey, string key, string value);
    event Upgraded(address indexed implementation);
    event VersionChanged(bytes32 indexed node, uint64 newVersion);

    function ABI(bytes32 node, uint256 contentTypes) external view returns (uint256 contentType, bytes memory value);
    function ROOT_RESOURCE() external view returns (uint256);
    function UPGRADE_INTERFACE_VERSION() external view returns (string memory);
    function addr(bytes32 node) external view returns (address payable);
    function addr(bytes32 node, uint256 coinType) external view returns (bytes memory addressBytes);
    function authorizeAddrRoles(bytes memory toName, uint256 coinType, address account, bool grant)
        external
        returns (bool updated);
    function authorizeDataRoles(bytes memory toName, string memory key, address account, bool grant)
        external
        returns (bool);
    function authorizeNameRoles(bytes memory toName, uint256 roleBitmap, address account, bool grant)
        external
        returns (bool);
    function authorizeTextRoles(bytes memory toName, string memory key, address account, bool grant)
        external
        returns (bool);
    function canUpgradeFrom(address) external pure returns (bool allowed);
    function clearRecords(bytes32 node) external;
    function contenthash(bytes32 node) external view returns (bytes memory);
    function data(bytes32 node, string memory key) external view returns (bytes memory);
    function getAlias(bytes memory fromName) external view returns (bytes memory toName);
    function getAssigneeCount(uint256 resource, uint256 roleBitmap) external view returns (uint256 counts, uint256 mask);
    function grantRoles(uint256 resource, uint256 roleBitmap, address account) external pure returns (bool);
    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function hasAddr(bytes32 node, uint256 coinType) external view returns (bool);
    function hasAssignees(uint256 resource, uint256 roleBitmap) external view returns (bool);
    function hasRoles(uint256 resource, uint256 roleBitmap, address account) external view returns (bool);
    function hasRootRoles(uint256 roleBitmap, address account) external view returns (bool);
    function initialize(address admin, uint256 roleBitmap, bytes[] memory setters) external;
    function interfaceImplementer(bytes32 node, bytes4 interfaceId) external view returns (address implementer);
    function isContractNamer(address namer) external view returns (bool);
    function multicall(bytes[] memory calls) external returns (bytes[] memory results);
    function multicallWithNodeCheck(bytes32, bytes[] memory calls) external returns (bytes[] memory);
    function name(bytes32 node) external view returns (string memory);
    function proxiableUUID() external view returns (bytes32);
    function pubkey(bytes32 node) external view returns (bytes32 x, bytes32 y);
    function recordVersions(bytes32 node) external view returns (uint64);
    function resolve(bytes memory fromName, bytes memory fromData) external view returns (bytes memory);
    function revokeRoles(uint256 resource, uint256 roleBitmap, address account) external pure returns (bool);
    function revokeRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function roleCount(uint256 resource) external view returns (uint256);
    function roles(uint256 resource, address account) external view returns (uint256);
    function setABI(bytes32 node, uint256 contentType, bytes memory value) external;
    function setAddr(bytes32 node, uint256 coinType, bytes memory addressBytes) external;
    function setAddr(bytes32 node, address addr_) external;
    function setAlias(bytes memory fromName, bytes memory toName) external;
    function setContenthash(bytes32 node, bytes memory hash) external;
    function setData(bytes32 node, string memory key, bytes memory value) external;
    function setInterface(bytes32 node, bytes4 interfaceId, address implementer) external;
    function setName(bytes32 node, string memory primary) external;
    function setPubkey(bytes32 node, bytes32 x, bytes32 y) external;
    function setText(bytes32 node, string memory key, string memory value) external;
    function supportsFeature(bytes4 feature) external pure returns (bool);
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
    function text(bytes32 node, string memory key) external view returns (string memory);
    function upgradeToAndCall(address newImplementation, bytes memory data) external payable;
}
