// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgentRecords} from "../src/libraries/AgentRecords.sol";

/// @dev The ENSIP-25 key is a string built from a chain id and an address, and a string
///      that is off by one character resolves to nothing at all — with no error, because
///      an unset text record is the empty string rather than a revert. So the encoder is
///      tested against the vector printed in ENSIP-25 itself, not only against itself.
contract AgentRecordsTest is Test {
    /// @dev Wrapper: internal library functions are not callable from `expectRevert` etc.
    function erc7930(uint256 chainId, address account) external pure returns (string memory) {
        return AgentRecords.erc7930Address(chainId, account);
    }

    function key(string memory prefix, uint256 agentId) external pure returns (string memory) {
        return AgentRecords.registrationKey(prefix, agentId);
    }

    function endpoint(string memory protocol) external pure returns (string memory) {
        return AgentRecords.endpointKey(protocol);
    }

    /// @notice The worked example from ENSIP-25: an ERC-8004 registry on Ethereum mainnet.
    function test_erc7930_matchesEnsip25Example() public view {
        assertEq(
            this.erc7930(1, 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432),
            "0x000100000101148004a169fb4a3325136eb29fa0ceb6d2e539a432"
        );
    }

    /// @notice The same address on Sepolia. 11155111 needs three bytes, not one, and the
    ///         length byte in front of it has to change with it.
    function test_erc7930_sepoliaUsesThreeByteReference() public view {
        assertEq(
            this.erc7930(11155111, 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432),
            "0x0001000003aa36a7148004a169fb4a3325136eb29fa0ceb6d2e539a432"
        );
    }

    /// @dev Leading zeros must be stripped: a zero-padded chain reference is a different
    ///      string, and therefore a different record key.
    function test_erc7930_referenceIsMinimal() public view {
        assertEq(
            this.erc7930(255, address(0)),
            "0x0001000001ff140000000000000000000000000000000000000000"
        );
        assertEq(
            this.erc7930(256, address(0)),
            "0x00010000020100140000000000000000000000000000000000000000"
        );
    }

    function test_registrationKey_shape() public view {
        assertEq(
            this.key("0x000100000101148004a169fb4a3325136eb29fa0ceb6d2e539a432", 167),
            "agent-registration[0x000100000101148004a169fb4a3325136eb29fa0ceb6d2e539a432][167]"
        );
    }

    function test_registrationKey_zeroAndLargeIds() public view {
        assertEq(this.key("0xaa", 0), "agent-registration[0xaa][0]");
        assertEq(
            this.key("0xaa", type(uint256).max),
            "agent-registration[0xaa][115792089237316195423570985008687907853269984665640564039457584007913129639935]"
        );
    }

    function test_endpointKey_usesBracketNotation() public view {
        assertEq(this.endpoint("web"), "agent-endpoint[web]");
        assertEq(this.endpoint("capsule"), "agent-endpoint[capsule]");
        assertEq(this.endpoint("mcp"), "agent-endpoint[mcp]");
    }

    /// @dev ENSIP-25 forbids `[` and `]` inside either parameter. Neither a hex string nor
    ///      a decimal integer can produce one, so this asserts the property rather than a
    ///      validation branch that would be dead code.
    function testFuzz_registrationKey_bracketsOnlyDelimit(uint256 agentId) public view {
        bytes memory k = bytes(this.key("0xdeadbeef", agentId));
        uint256 open;
        uint256 close;
        for (uint256 i = 0; i < k.length; i += 1) {
            if (k[i] == "[") open += 1;
            if (k[i] == "]") close += 1;
        }
        assertEq(open, 2);
        assertEq(close, 2);
    }
}
