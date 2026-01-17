// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {MirrorState} from "./MirrorState.sol";
import {MirrorAMM} from "./MirrorAMM.sol";
import {WadMath} from "./libs/WadMath.sol";

contract InstantonAllocator is AccessControl {
    using WadMath for int256;

    bytes32 public constant STRATEGIST_ROLE = keccak256("STRATEGIST_ROLE");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    MirrorState public mirror;
    MirrorAMM public amm;

    struct Weights {
        uint256 wAMM;   // 1e18
        uint256 wOB;    // 1e18
        uint256 wYield; // 1e18
    }

    // Current "accounted" weights (MVP: updated by keeper after off-chain execution)
    Weights public current;

    // Policy knobs
    uint256 public rebalanceCooldown = 30; // seconds
    uint256 public lastRebalance;

    uint256 public epsW = 0.05e18;  // 5% drift threshold
    int256 public S_thresh = 0.15e18;

    // Action weights (alpha)
    int256 public aOB = 0.6e18;
    int256 public aY  = 0.4e18;
    int256 public aTier = 0.4e18;
    int256 public aInv  = 0.3e18;

    // Sigma thresholds
    int256 public sigmaHigh = 0.05e18;
    int256 public sigmaLow  = 0.015e18;

    event RebalanceIntent(
        uint256 wAMM,
        uint256 wOB,
        uint256 wYield,
        int256 actionScore,
        uint8 oracleTier,
        bool stale,
        bool emergencyStale,
        int256 sigma,
        int256 imbalance,
        int256 qWad
    );

    event QuoteIntent(
        int256 pRef,
        int256 bidBpsWad,   // WAD (0.001e18 = 10 bps)
        int256 askBpsWad,
        uint256 sizeBaseHint,
        bool skewToReduceInventory
    );

    constructor(address admin, address _mirror, address _amm) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(STRATEGIST_ROLE, admin);
        _grantRole(KEEPER_ROLE, admin);
        mirror = MirrorState(_mirror);
        amm = MirrorAMM(_amm);

        current = Weights({wAMM: 0.55e18, wOB: 0.25e18, wYield: 0.20e18});
        lastRebalance = block.timestamp;
    }

    // -------- strategist setters --------

    function setCooldown(uint256 cd) external onlyRole(STRATEGIST_ROLE) {
        rebalanceCooldown = cd;
    }

    function setThresholds(uint256 _epsW, int256 _S) external onlyRole(STRATEGIST_ROLE) {
        epsW = _epsW;
        S_thresh = _S;
    }

    function setSigmas(int256 low, int256 high) external onlyRole(STRATEGIST_ROLE) {
        require(low > 0 && high > low, "bad sigma");
        sigmaLow = low; sigmaHigh = high;
    }

    function setActionWeights(int256 _aOB, int256 _aY, int256 _aTier, int256 _aInv) external onlyRole(STRATEGIST_ROLE) {
        aOB = _aOB; aY = _aY; aTier = _aTier; aInv = _aInv;
    }

    // Keeper updates current weights after executing off-chain moves (MVP accounting)
    function setCurrentWeights(Weights calldata w) external onlyRole(KEEPER_ROLE) {
        require(w.wAMM + w.wOB + w.wYield == 1e18, "sum != 1");
        current = w;
    }

    // -------- core logic --------

    function computeTarget() public view returns (Weights memory target, bool skewToReduceInventory) {
        MirrorState.MarketState memory ms = mirror.getMarketState();
        int256 q = amm.qWad();

        // baseline
        uint256 wOB = 0.25e18;
        uint256 wAMM = 0.55e18;

        // stressed regime => less OB, more AMM
        if (ms.sigma > sigmaHigh || ms.tier >= 2 || ms.stale) {
            wOB = 0.08e18;
            wAMM = 0.70e18;
        }
        // calm regime => more OB
        else if (ms.sigma < sigmaLow) {
            wOB = 0.35e18;
            wAMM = 0.45e18;
        }

        // strong imbalance => reduce OB
        if (ms.imbalance.abs() > 0.5e18) {
            if (wOB > 0.10e18) wOB = 0.10e18;
            if (wAMM < 0.60e18) wAMM = 0.60e18;
        }

        uint256 wYield = 1e18 - wOB - wAMM;

        // inventory skew preference
        int256 qAbs = q.abs();
        int256 qMax = amm.qMaxWad();
        skewToReduceInventory = (qMax > 0) && ((qAbs * 1e18) / qMax > 0.4e18);

        target = Weights({wAMM: wAMM, wOB: wOB, wYield: wYield});
    }

    function actionScore(Weights memory target)
        public
        view
        returns (int256 S, MirrorState.MarketState memory ms, int256 q)
    {
        ms = mirror.getMarketState();
        q = amm.qWad();

        int256 dOB = int256(target.wOB) - int256(current.wOB);
        int256 dY  = int256(target.wYield) - int256(current.wYield);

        int256 termOB = aOB.mulWad(dOB.abs());
        int256 termY  = aY.mulWad(dY.abs());

        int256 tierTerm = 0;
        if (ms.tier >= 2) tierTerm = aTier;

        int256 invTerm = 0;
        int256 qMax = amm.qMaxWad();
        if (qMax > 0) {
            invTerm = aInv.mulWad(q.abs().divWad(qMax));
        }

        S = termOB + termY + tierTerm + invTerm;
    }

    function shouldInstanton(Weights memory target) public view returns (bool ok, int256 S) {
        (S,,) = actionScore(target);

        int256 driftOB = (int256(target.wOB) - int256(current.wOB)).abs();
        int256 driftY  = (int256(target.wYield) - int256(current.wYield)).abs();

        bool drift = (driftOB > int256(epsW)) || (driftY > int256(epsW));
        bool cooldownOk = (block.timestamp - lastRebalance) >= rebalanceCooldown;

        ok = cooldownOk && (S > S_thresh || drift);
    }

    /// @notice Emits intents if instanton triggers. Keeper runs this in a loop.
    function trigger() external onlyRole(KEEPER_ROLE) {
        (Weights memory target, bool skew) = computeTarget();
        (bool ok, int256 S) = shouldInstanton(target);
        if (!ok) return;

        ( , MirrorState.MarketState memory ms, int256 q) = actionScore(target);
        lastRebalance = block.timestamp;

        emit RebalanceIntent(
            target.wAMM, target.wOB, target.wYield,
            S,
            ms.tier,
            ms.stale,
            ms.emergencyStale,
            ms.sigma,
            ms.imbalance,
            q
        );

        // Quote intent for OB keeper (bps heuristic)
        int256 baseBps = 0.002e18; // 20 bps
        if (ms.sigma > sigmaHigh) baseBps = 0.006e18; // 60 bps
        if (ms.tier == 2) baseBps = baseBps + 0.004e18;

        uint256 sizeBaseHint = (target.wOB * 1e3) / 1e18; // simple hint

        emit QuoteIntent(ms.pRef, baseBps, baseBps, sizeBaseHint, skew);
    }
}
