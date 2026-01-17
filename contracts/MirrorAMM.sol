// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "./interfaces/IERC20.sol";
import {MirrorState} from "./MirrorState.sol";
import {WadMath} from "./libs/WadMath.sol";
import {TanhWad} from "./libs/TanhWad.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

contract MirrorAMM is ReentrancyGuard {
    using WadMath for int256;

    IERC20 public immutable base;
    IERC20 public immutable quote;
    MirrorState public immutable mirror;

    // inventory coordinate q in base units, WAD-scaled
    int256 public qWad;

    int256 public etaWad = 50e18;
    int256 public qMaxWad = 1000e18;
    int256 public maxTradeBaseWad = 50e18;

    event Swap(address indexed user, bool isBuyBase, uint256 baseAmount, uint256 quoteAmount);

    constructor(address _base, address _quote, address _mirror) {
        base = IERC20(_base);
        quote = IERC20(_quote);
        mirror = MirrorState(_mirror);
    }

    function setRiskCaps(int256 _qMaxWad, int256 _maxTradeBaseWad) external {
        qMaxWad = _qMaxWad;
        maxTradeBaseWad = _maxTradeBaseWad;
    }

    function setEta(int256 _etaWad) external {
        require(_etaWad > 0, "eta=0");
        etaWad = _etaWad;
    }

    /// @notice delta(q) = lambda*q + tanh(q/eta)  in WAD
    function deltaWad(int256 _qWad) public view returns (int256) {
        // mirror.theta() getter returns (c, lambda, s) as a tuple, not a struct
        (, int256 lambdaWad, ) = mirror.theta();

        int256 termLin = WadMath.mulWad(lambdaWad, _qWad);
        int256 x = WadMath.divWad(_qWad, etaWad);
        int256 tanhTerm = TanhWad.tanhWad(x);
        return termLin + tanhTerm;
    }

    /// @notice Mid price approximation: p(q) ≈ pRef * (1 + delta(q))
    /// @dev Assumes delta small; enforced via caps.
    function midPriceWad(int256 _qWad) public view returns (int256) {
        int256 pr = mirror.pRef();
        int256 d = deltaWad(_qWad);
        d = WadMath.clamp(d, -0.5e18, 0.5e18); // safety clamp
        return WadMath.mulWad(pr, (1e18 + d));
    }

    function _spreadWadFromTier(int256 sBase, uint8 tier) internal pure returns (int256) {
        if (tier == 0) return sBase;
        if (tier == 1) return sBase + sBase / 2; // +50%
        if (tier == 2) return sBase * 2;         // 2x
        return sBase * 5;
    }

    function quoteForBaseDelta(bool isBuyBase, int256 baseDeltaWad) public view returns (int256 quoteDeltaWad) {
        require(baseDeltaWad > 0, "baseDelta=0");
        require(baseDeltaWad <= maxTradeBaseWad, "trade too big");

        (, uint8 tier,, bool emergencyStale) = mirror.oracleTier();
        require(!emergencyStale, "oracle emergency stale");
        require(tier < 3, "oracle deviation critical");

        // mirror.theta() getter returns (c, lambda, s)
        (, , int256 sBaseWad) = mirror.theta();
        int256 sEff = _spreadWadFromTier(sBaseWad, tier);

        int256 q0 = qWad;
        int256 q1 = isBuyBase ? (q0 - baseDeltaWad) : (q0 + baseDeltaWad);
        require(q1 <= qMaxWad && q1 >= -qMaxWad, "inventory cap");

        // midpoint price approximation across q0->q1
        int256 qMid = (q0 + q1) / 2;
        int256 pMid = midPriceWad(qMid);

        if (isBuyBase) {
            int256 ask = WadMath.mulWad(pMid, (1e18 + sEff));
            quoteDeltaWad = WadMath.mulWad(ask, baseDeltaWad);
        } else {
            int256 bid = WadMath.mulWad(pMid, (1e18 - sEff));
            quoteDeltaWad = WadMath.mulWad(bid, baseDeltaWad);
        }
    }

    function swapBuyBaseExactOut(uint256 baseOut) external nonReentrant returns (uint256 quoteIn) {
        int256 baseDeltaWad = int256(baseOut) * 1e18;
        int256 qd = quoteForBaseDelta(true, baseDeltaWad);

        quoteIn = uint256(qd / 1e18);
        require(quote.transferFrom(msg.sender, address(this), quoteIn), "quote in fail");
        require(base.transfer(msg.sender, baseOut), "base out fail");

        qWad = qWad - baseDeltaWad;
        emit Swap(msg.sender, true, baseOut, quoteIn);
    }

    function swapSellBaseExactIn(uint256 baseIn) external nonReentrant returns (uint256 quoteOut) {
        int256 baseDeltaWad = int256(baseIn) * 1e18;
        int256 qd = quoteForBaseDelta(false, baseDeltaWad);

        quoteOut = uint256(qd / 1e18);
        require(base.transferFrom(msg.sender, address(this), baseIn), "base in fail");
        require(quote.transfer(msg.sender, quoteOut), "quote out fail");

        qWad = qWad + baseDeltaWad;
        emit Swap(msg.sender, false, baseIn, quoteOut);
    }
}
