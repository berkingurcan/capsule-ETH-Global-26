// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.4;

interface ETHRegistrar {
    error CommitmentTooNew(bytes32 commitment, uint64 validFrom, uint64 blockTimestamp);
    error CommitmentTooOld(bytes32 commitment, uint64 validTo, uint64 blockTimestamp);
    error DurationTooShort(uint64 duration, uint64 minDuration);
    error InvalidOwner();
    error MaxCommitmentAgeTooLow();
    error NameNotAvailable(string label);
    error NameNotRenewable(string label);
    error OwnableInvalidOwner(address owner);
    error OwnableUnauthorizedAccount(address account);
    error SafeERC20FailedOperation(address token);
    error UnexpiredCommitmentExists(bytes32 commitment);

    event CommitmentMade(bytes32 commitment);
    event NameRegistered(
        uint256 indexed tokenId,
        string label,
        address owner,
        address subregistry,
        address resolver,
        uint64 duration,
        address paymentToken,
        bytes32 indexed referrer,
        uint256 base,
        uint256 premium
    );
    event NameRenewed(
        uint256 indexed tokenId,
        string label,
        uint64 duration,
        uint64 newExpiry,
        address paymentToken,
        bytes32 indexed referrer,
        uint256 amount
    );
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event RentPriceOracleUpdated(address oracle);

    function BENEFICIARY() external view returns (address);
    function ETH_REGISTRY() external view returns (address);
    function GRACE_PERIOD() external view returns (uint64);
    function MAX_COMMITMENT_AGE() external view returns (uint64);
    function MIN_COMMITMENT_AGE() external view returns (uint64);
    function MIN_REGISTER_DURATION() external view returns (uint64);
    function MIN_RENEW_DURATION() external view returns (uint64);
    function commit(bytes32 commitment) external;
    function commitmentAt(bytes32 commitment) external view returns (uint64 commitTime);
    function getRegisterPrice(string memory label, uint64 duration, address paymentToken)
        external
        view
        returns (uint256 base, uint256 premium);
    function getRemainingGracePeriod(string memory label) external view returns (uint64);
    function getRenewPrice(string memory label, uint64 duration, address paymentToken) external view returns (uint256);
    function isAvailable(string memory label) external view returns (bool);
    function isRenewable(string memory label) external view returns (bool);
    function makeCommitment(
        string memory label,
        address owner,
        bytes32 secret,
        address subregistry,
        address resolver,
        uint64 duration,
        bytes32 referrer
    ) external pure returns (bytes32);
    function owner() external view returns (address);
    function register(
        string memory label,
        address owner,
        bytes32 secret,
        address subregistry,
        address resolver,
        uint64 duration,
        address paymentToken,
        bytes32 referrer
    ) external returns (uint256 tokenId);
    function renew(string memory label, uint64 duration, address paymentToken, bytes32 referrer) external;
    function renounceOwnership() external;
    function rentPriceOracle() external view returns (address);
    function setRentPriceOracle(address oracle) external;
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
    function transferOwnership(address newOwner) external;
}
