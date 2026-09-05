// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.4;

interface PublicResolverV2 {
    error DNSDecodingFailed(bytes dns);
    error InvalidEVMAddress(bytes addressBytes);
    error OffsetOutOfBoundsError(uint256 offset, uint256 length);

    event ABIChanged(bytes32 indexed node, uint256 indexed contentType);
    event AddrChanged(bytes32 indexed node, address a);
    event AddressChanged(bytes32 indexed node, uint256 coinType, bytes newAddress);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event Approved(address owner, bytes32 indexed node, address indexed delegate, bool indexed approved);
    event ContenthashChanged(bytes32 indexed node, bytes hash);
    event DNSRecordChanged(bytes32 indexed node, bytes name, uint16 resource, bytes record);
    event DNSRecordDeleted(bytes32 indexed node, bytes name, uint16 resource);
    event DNSZonehashChanged(bytes32 indexed node, bytes lastzonehash, bytes zonehash);
    event DataChanged(bytes32 indexed node, string indexed indexedKey, string key, bytes indexed indexedData);
    event InterfaceChanged(bytes32 indexed node, bytes4 indexed interfaceID, address implementer);
    event NameChanged(bytes32 indexed node, string name);
    event PubkeyChanged(bytes32 indexed node, bytes32 x, bytes32 y);
    event TextChanged(bytes32 indexed node, string indexed indexedKey, string key, string value);
    event VersionChanged(bytes32 indexed node, uint64 newVersion);

    function ABI(bytes32 node, uint256 contentTypes) external view returns (uint256, bytes memory);
    function CONTRACT_NAMER() external view returns (address);
    function NAME_WRAPPER() external view returns (address);
    function ROOT_REGISTRY() external view returns (address);
    function addr(bytes32 node) external view returns (address payable);
    function addr(bytes32 node, uint256 coinType) external view returns (bytes memory addressBytes);
    function approve(bytes32 node, address delegate, bool approved) external;
    function canModifyName(bytes32 node, address operator) external view returns (bool);
    function clearRecords(bytes32 node) external;
    function contenthash(bytes32 node) external view returns (bytes memory);
    function data(bytes32 node, string memory key) external view returns (bytes memory);
    function dnsRecord(bytes32 node, bytes32 name, uint16 resource) external view returns (bytes memory);
    function hasAddr(bytes32 node, uint256 coinType) external view returns (bool);
    function hasDNSRecords(bytes32 node, bytes32 name) external view returns (bool);
    function interfaceImplementer(bytes32 node, bytes4 interfaceID) external view returns (address);
    function isApprovedFor(address owner, bytes32 node, address delegate) external view returns (bool);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
    function isContractNamer(address namer) external view returns (bool);
    function multicall(bytes[] memory data) external returns (bytes[] memory results);
    function multicallWithNodeCheck(bytes32 nodehash, bytes[] memory data) external returns (bytes[] memory results);
    function name(bytes32 node) external view returns (string memory);
    function pubkey(bytes32 node) external view returns (bytes32 x, bytes32 y);
    function recordVersions(bytes32) external view returns (uint64);
    function setABI(bytes32 node, uint256 contentType, bytes memory data) external;
    function setAddr(bytes32 node, uint256 coinType, bytes memory addressBytes) external;
    function setAddr(bytes32 node, address _addr) external;
    function setApprovalForAll(address operator, bool approved) external;
    function setContenthash(bytes32 node, bytes memory hash) external;
    function setDNSRecords(bytes32 node, bytes memory data) external;
    function setData(bytes32 node, string memory key, bytes memory value) external;
    function setInterface(bytes32 node, bytes4 interfaceID, address implementer) external;
    function setName(bytes32 node, string memory newName) external;
    function setPubkey(bytes32 node, bytes32 x, bytes32 y) external;
    function setText(bytes32 node, string memory key, string memory value) external;
    function setZonehash(bytes32 node, bytes memory hash) external;
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
    function text(bytes32 node, string memory key) external view returns (string memory);
    function zonehash(bytes32 node) external view returns (bytes memory);
}
