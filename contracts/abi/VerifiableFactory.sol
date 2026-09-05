// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.4;

interface VerifiableFactory {
    error VerificationFailed(address proxy);

    event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation);

    function deployProxy(address implementation, uint256 salt, bytes memory data) external returns (address proxy);
    function proxyLogic() external view returns (address);
    function verifyContract(address proxy) external view returns (address implementation);
}
