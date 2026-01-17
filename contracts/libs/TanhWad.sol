// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {WadMath} from "./WadMath.sol";

library TanhWad {
    using WadMath for int256;

    int256 internal constant WAD = 1e18;

    /// @notice tanh(x) where x is WAD-scaled; returns WAD-scaled.
    function tanhWad(int256 x) internal pure returns (int256) {
        // clamp beyond ~3 to +/-1
        int256 three = 3e18;
        if (x >= three) return WAD;
        if (x <= -three) return -WAD;

        // tanh(x) ~ x*(27 + x^2) / (27 + 9x^2)
        int256 x2 = WadMath.mulWad(x, x);
        int256 num = WadMath.mulWad(x, (27e18 + x2));
        int256 den = (27e18 + 9 * x2);
        return WadMath.divWad(num, den);
    }
}
