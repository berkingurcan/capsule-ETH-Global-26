// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.4;

library AbstractUniversalResolver {
    struct ResolverInfo {
        bytes name;
        uint256 offset;
        bytes32 node;
        address resolver;
        bool extended;
    }
}

library CCIPBatcher {
    struct Batch {
        Lookup[] lookups;
        string[] gateways;
    }

    struct Lookup {
        address target;
        bytes call;
        bytes data;
        uint256 flags;
    }
}

interface UniversalResolverV2 {
    error DNSDecodingFailed(bytes dns);
    error DNSEncodingFailed(string ens);
    error EmptyAddress();
    error HttpError(uint16 status, string message);
    error InvalidBatchGatewayResponse();
    error LabelIsEmpty();
    error LabelIsTooLong(string label);
    error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData);
    error OffsetOutOfBoundsError(uint256 offset, uint256 length);
    error ResolverError(bytes errorData);
    error ResolverNotContract(bytes name, address resolver);
    error ResolverNotFound(bytes name);
    error ReverseAddressMismatch(string primary, bytes primaryAddress);
    error UnsupportedResolverProfile(bytes4 selector);

    function CONTRACT_NAMER() external view returns (address);
    function ROOT_REGISTRY() external view returns (address);
    function batchGatewayProvider() external view returns (address);
    function ccipBatch(CCIPBatcher.Batch memory batch) external view returns (CCIPBatcher.Batch memory);
    function ccipBatchCallback(bytes memory response, bytes memory extraData)
        external
        view
        returns (CCIPBatcher.Batch memory batch);
    function ccipReadCallback(bytes memory response, bytes memory extraData) external view;
    function findCanonicalName(address registry) external view returns (bytes memory);
    function findCanonicalRegistry(bytes memory name) external view returns (address);
    function findExactRegistry(bytes memory name) external view returns (address);
    function findOwner(bytes memory name) external view returns (address);
    function findParentRegistry(bytes memory name) external view returns (address);
    function findRegistries(bytes memory name) external view returns (address[] memory);
    function findResolver(bytes memory name) external view returns (address resolver, bytes32 node, uint256 offset);
    function isContractNamer(address namer) external view returns (bool);
    function requireResolver(bytes memory name)
        external
        view
        returns (AbstractUniversalResolver.ResolverInfo memory info);
    function resolve(bytes memory name, bytes memory data) external view returns (bytes memory, address);
    function resolveBatchCallback(bytes memory response, bytes memory extraData) external view;
    function resolveCallback(bytes memory response, bytes memory extraData)
        external
        pure
        returns (bytes memory, address);
    function resolveDirectCallback(bytes memory response, bytes memory extraData) external view;
    function resolveDirectCallbackError(bytes memory response, bytes memory) external pure;
    function resolveWithGateways(bytes memory name, bytes memory data, string[] memory gateways)
        external
        view
        returns (bytes memory result, address resolver);
    function resolveWithResolver(address resolver, bytes memory name, bytes memory data, string[] memory gateways)
        external
        view
        returns (bytes memory);
    function reverse(bytes memory lookupAddress, uint256 coinType)
        external
        view
        returns (string memory, address, address);
    function reverseAddressCallback(bytes memory response, bytes memory extraData)
        external
        pure
        returns (string memory primary, address resolver, address reverseResolver);
    function reverseNameCallback(bytes memory response, bytes memory extraData)
        external
        view
        returns (string memory primary, address, address);
    function reverseWithGateways(bytes memory lookupAddress, uint256 coinType, string[] memory gateways)
        external
        view
        returns (string memory primary, address resolver, address reverseResolver);
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}
