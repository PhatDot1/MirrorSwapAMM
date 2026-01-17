// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library WadMath {
    int256 internal constant WAD = 1e18;

    function mulWad(int256 x, int256 y) internal pure returns (int256) {
        return (x * y) / WAD;
    }

    function divWad(int256 x, int256 y) internal pure returns (int256) {
        return (x * WAD) / y;
    }

    function abs(int256 x) internal pure returns (int256) {
        return x >= 0 ? x : -x;
    }

    function clamp(int256 x, int256 lo, int256 hi) internal pure returns (int256) {
        if (x < lo) return lo;
        if (x > hi) return hi;
        return x;
    }
}
