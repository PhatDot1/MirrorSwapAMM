// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IL1Read} from "./interfaces/IL1Read.sol";
import {WadMath} from "./libs/WadMath.sol";

contract MirrorState is AccessControl {
    using WadMath for int256;

    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    bytes32 public constant STRATEGIST_ROLE = keccak256("STRATEGIST_ROLE");

    struct Theta {
        int256 c;        // ln(pRef) in WAD (keeper-computed)
        int256 lambda;   // WAD
        int256 s;        // WAD (spread)
    }

    struct OracleUpdate {
        int256 pRef;        // WAD
        Theta theta;        // WAD fields
        int256 sigma;       // WAD
        int256 imbalance;   // WAD signed
        uint256 timestamp;  // keeper-reported ts
    }

    Theta public theta;
    int256 public pRef;
    int256 public sigma;
    int256 public imbalance;
    uint256 public lastUpdate;

    // deviation tiers: d ~= |(p_live/p_ref) - 1|   (WAD)
    int256 public tau1 = 0.005e18;
    int256 public tau2 = 0.02e18;
    int256 public tau3 = 0.05e18;

    uint256 public staleSeconds = 60;
    uint256 public emergencyStaleSeconds = 120;

    IL1Read public l1read;
    uint32 public assetIndex;

    event OraclePushed(int256 pRef, int256 c, int256 lambda, int256 s, int256 sigma, int256 imbalance);
    event LiveOracleConfigured(address l1read, uint32 assetIndex);

    constructor(address admin, address _l1read, uint32 _assetIndex) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(KEEPER_ROLE, admin);
        _grantRole(STRATEGIST_ROLE, admin);
        l1read = IL1Read(_l1read);
        assetIndex = _assetIndex;
        emit LiveOracleConfigured(_l1read, _assetIndex);
    }

    function setLiveOracle(address _l1read, uint32 _assetIndex) external onlyRole(STRATEGIST_ROLE) {
        l1read = IL1Read(_l1read);
        assetIndex = _assetIndex;
        emit LiveOracleConfigured(_l1read, _assetIndex);
    }

    function setThresholds(int256 _tau1, int256 _tau2, int256 _tau3) external onlyRole(STRATEGIST_ROLE) {
        require(_tau1 > 0 && _tau1 < _tau2 && _tau2 < _tau3, "bad taus");
        tau1 = _tau1; tau2 = _tau2; tau3 = _tau3;
    }

    function setStaleness(uint256 _stale, uint256 _emergency) external onlyRole(STRATEGIST_ROLE) {
        require(_stale > 0 && _emergency > _stale, "bad staleness");
        staleSeconds = _stale;
        emergencyStaleSeconds = _emergency;
    }

    function pushUpdate(OracleUpdate calldata u) external onlyRole(KEEPER_ROLE) {
        require(u.timestamp + 30 >= block.timestamp, "update too old");
        require(u.pRef > 0, "pRef=0");

        // Bounds consistent with your safety tables
        require(u.theta.lambda >= 0.001e18 && u.theta.lambda <= 0.1e18, "lambda bounds");
        require(u.theta.s >= 0.0005e18 && u.theta.s <= 0.05e18, "spread bounds");

        pRef = u.pRef;
        theta = u.theta;
        sigma = u.sigma;
        imbalance = u.imbalance;
        lastUpdate = block.timestamp;

        emit OraclePushed(pRef, theta.c, theta.lambda, theta.s, sigma, imbalance);
    }

    /// @notice Pull live oracle price (WAD).
    /// @dev For Hardhat mock we assume price is 1e8 and convert to 1e18.
    /// For real HyperEVM deployment, update scaling to match official docs. 
    function livePriceWad() public view returns (int256) {
        (uint64 price,) = l1read.perpOraclePrice(assetIndex);
        return int256(uint256(price)) * 1e10; // 1e8 -> 1e18
    }

    /// @notice d ~= |(p_live/p_ref) - 1| in WAD (cheap approx to |ln(p_live/p_ref)|).
    function deviationApproxWad() public view returns (int256 d) {
        int256 pl = livePriceWad();
        int256 pr = pRef;
        if (pl <= 0 || pr <= 0) return type(int256).max;

        int256 ratio = (pl * 1e18) / pr; // WAD
        return (ratio - 1e18).abs();
    }

    function oracleTier()
        public
        view
        returns (int256 d, uint8 tier, bool isStale, bool emergencyStale)
    {
        uint256 age = block.timestamp - lastUpdate;
        isStale = age > staleSeconds;
        emergencyStale = age > emergencyStaleSeconds;

        d = deviationApproxWad();
        if (d < tau1) tier = 0;
        else if (d < tau2) tier = 1;
        else if (d < tau3) tier = 2;
        else tier = 3;
    }

    // ------------------ NEW: compact market state for allocator ------------------

    struct MarketState {
        int256 pRef;        // WAD
        int256 sigma;       // WAD
        int256 imbalance;   // WAD
        int256 deviation;   // WAD (approx)
        uint8 tier;         // 0..3
        bool stale;
        bool emergencyStale;
        uint256 lastUpdate;
    }

    function getMarketState() external view returns (MarketState memory ms) {
        (int256 d, uint8 t, bool st, bool est) = oracleTier();
        ms = MarketState({
            pRef: pRef,
            sigma: sigma,
            imbalance: imbalance,
            deviation: d,
            tier: t,
            stale: st,
            emergencyStale: est,
            lastUpdate: lastUpdate
        });
    }
}
