// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Replace with Hyperliquid's official L1Read.sol interface for real deployment.
/// Docs show read-precompile style usage and provide an L1Read.sol helper. 
interface IL1Read {
    /// @dev Placeholder signature for local testing.
    /// On HyperEVM, match the official signature + scaling.
    function perpOraclePrice(uint32 assetIndex) external view returns (uint64 price, uint64 conf);
}
