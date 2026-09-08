// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title AgentRecords
/// @notice String machinery for the parameterised ENS record keys Capsule writes.
///
/// @dev Two ENSIPs put parameters inside square brackets in the key itself
///      (`agent-endpoint[web]`, `agent-registration[<registry>][<agentId>]`), which means
///      a key is not always a constant — ENSIP-25's registry key contains a chain id, a
///      contract address and a token id. Building it on chain is the only way it stays
///      correct across redeploys and chains, so the pieces live here.
///
///      Nothing in this library is hot: `registrationKey` runs once per mint, and the
///      ERC-7930 prefix is built once in the minter's constructor and stored.
library AgentRecords {
    bytes16 private constant HEX = "0123456789abcdef";

    /// @notice `account` on `chainId`, as an ERC-7930 interoperable address, hex-encoded.
    ///
    /// @dev The binary layout, which ENSIP-25 hex-encodes with an `0x` prefix:
    ///
    ///        0001      version 1                       2 bytes
    ///        0000      chain type — eip155             2 bytes
    ///        NN        chain reference length          1 byte
    ///        ...       chain id, big-endian, minimal   NN bytes
    ///        14        address length — 20             1 byte
    ///        ...       the address                     20 bytes
    ///
    ///      "Minimal" matters: chain 1 encodes as `01`, not as 32 zero-padded bytes, and a
    ///      padded encoding is a different string, which is a different record key, which
    ///      resolves to nothing. Sepolia (11155111) is `03aa36a7`.
    function erc7930Address(uint256 chainId, address account) internal pure returns (string memory) {
        bytes memory chainRef = _minimalBigEndian(chainId);

        bytes memory packed = abi.encodePacked(
            bytes2(0x0001), // version
            bytes2(0x0000), // chain type: eip155
            uint8(chainRef.length),
            chainRef,
            uint8(20),
            account
        );

        return _toHexString(packed);
    }

    /// @notice The ENSIP-25 key for one agent in one registry.
    /// @param registryPrefix The registry as an ERC-7930 address, from `erc7930Address`.
    /// @param agentId The registry's own identifier for the agent — for Capsule, the ENS
    ///        token id, in decimal.
    /// @dev ENSIP-25 forbids `[` and `]` inside either parameter. Neither a hex string nor
    ///      a decimal number can contain one, so the shape is safe by construction rather
    ///      than by validation.
    function registrationKey(string memory registryPrefix, uint256 agentId)
        internal
        pure
        returns (string memory)
    {
        return string.concat(
            "agent-registration[", registryPrefix, "][", _toDecimalString(agentId), "]"
        );
    }

    /// @notice `agent-endpoint[<protocol>]` — ENSIP-26.
    function endpointKey(string memory protocol) internal pure returns (string memory) {
        return string.concat("agent-endpoint[", protocol, "]");
    }

    ////////////////////////////////////////////////////////////////////////
    // Internals
    ////////////////////////////////////////////////////////////////////////

    /// @dev Big-endian bytes with leading zeros stripped. Zero encodes as one `0x00` byte
    ///      rather than as nothing, because a zero-length chain reference is not valid.
    function _minimalBigEndian(uint256 value) private pure returns (bytes memory out) {
        if (value == 0) return hex"00";

        uint256 length = 0;
        for (uint256 v = value; v != 0; v >>= 8) length += 1;

        out = new bytes(length);
        for (uint256 i = length; i > 0; i -= 1) {
            out[i - 1] = bytes1(uint8(value));
            value >>= 8;
        }
    }

    /// @dev Lowercase, `0x`-prefixed. ENSIP-25's example is lowercase, and a key differing
    ///      only in case is a different key — there is no checksum or normalisation step
    ///      between here and the resolver.
    function _toHexString(bytes memory data) private pure returns (string memory) {
        bytes memory out = new bytes(2 + data.length * 2);
        out[0] = "0";
        out[1] = "x";
        for (uint256 i = 0; i < data.length; i += 1) {
            out[2 + i * 2] = HEX[uint8(data[i]) >> 4];
            out[3 + i * 2] = HEX[uint8(data[i]) & 0x0f];
        }
        return string(out);
    }

    function _toDecimalString(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";

        uint256 digits = 0;
        for (uint256 v = value; v != 0; v /= 10) digits += 1;

        bytes memory out = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            out[digits] = bytes1(uint8(48 + (value % 10)));
            value /= 10;
        }
        return string(out);
    }
}
