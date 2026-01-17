// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import {IERC20} from "./interfaces/IERC20.sol";
import {MirrorState} from "./MirrorState.sol";
import {YieldVaultMock} from "./YieldVaultMock.sol";

contract InstantonAllocator is AccessControl, ReentrancyGuard {
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    enum Venue {
        AMM,
        ORDERBOOK,
        YIELD_RECALL
    }

    IERC20 public immutable base;
    IERC20 public immutable quote;
    MirrorState public immutable mirror;
    address public immutable amm;
    YieldVaultMock public immutable yieldVault;

    // Weights (WAD)
    int256 public alphaWad = 2e18;
    int256 public betaWad  = 2e18;
    int256 public gammaWad = 10e18;
    int256 public zetaWad  = 2e18;

    // Thresholds (WAD)
    int256 public SOrderbookWad = 5e18;
    int256 public SYieldRecallWad = 3e18;

    uint256 public recallQuoteWad = 2000e18;
    int256 public maxTierPenaltyWad = 3e18;

    event InstantonDecision(
        Venue venue,
        int256 SWad,
        int256 qWad,
        uint8 tier,
        bool emergencyStale,
        int256 pRefWad,
        int256 sEffWad
    );

    event RebalanceIntent(Venue venue, uint256 quoteAmountWad);
    event QuoteIntent(bool isBuyBase, uint256 baseAmountWad, uint256 limitPriceWad);

    constructor(
        address _amm,
        address _mirror,
        address _base,
        address _quote,
        address _yieldVault,
        address admin
    ) {
        amm = _amm;
        mirror = MirrorState(_mirror);
        base = IERC20(_base);
        quote = IERC20(_quote);
        yieldVault = YieldVaultMock(_yieldVault);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(KEEPER_ROLE, admin);
    }

    function setWeights(int256 _alphaWad, int256 _betaWad, int256 _gammaWad, int256 _zetaWad)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        alphaWad = _alphaWad;
        betaWad  = _betaWad;
        gammaWad = _gammaWad;
        zetaWad  = _zetaWad;
    }

    function setThresholds(int256 _SOrderbookWad, int256 _SYieldRecallWad) external onlyRole(DEFAULT_ADMIN_ROLE) {
        SOrderbookWad = _SOrderbookWad;
        SYieldRecallWad = _SYieldRecallWad;
    }

    function setRecallAmount(uint256 _recallQuoteWad) external onlyRole(DEFAULT_ADMIN_ROLE) {
        recallQuoteWad = _recallQuoteWad;
    }

    function _abs(int256 x) internal pure returns (int256) {
        return x >= 0 ? x : -x;
    }

    function _spreadWadFromTier(int256 sBaseWad, uint8 tier) internal pure returns (int256) {
        if (tier == 0) return sBaseWad;
        if (tier == 1) return sBaseWad + sBaseWad / 2;
        if (tier == 2) return sBaseWad * 2;
        return sBaseWad * 5;
    }

    function computeActionWad(
        int256 qWad,
        int256 qMaxWad,
        uint8 tier,
        bool emergencyStale,
        int256 sEffWad
    ) public view returns (int256 SWad) {
        // qFrac = |q|/qMax in WAD
        int256 qFrac = int256(0);
        if (qMaxWad > 0) {
            qFrac = (_abs(qWad) * int256(1e18)) / qMaxWad;
        }

        // tierPenalty in WAD: tier 0..2 -> [0, maxTierPenalty]
        int256 tierPenalty = int256(0);
        if (tier >= 2) {
            tierPenalty = maxTierPenaltyWad;
        } else {
            tierPenalty = (int256(uint256(tier)) * maxTierPenaltyWad) / int256(2);
        }

        int256 stalePenalty = emergencyStale ? int256(1e18) : int256(0);

        SWad =
            (alphaWad * qFrac) / int256(1e18) +
            (betaWad  * tierPenalty) / int256(1e18) +
            (gammaWad * stalePenalty) / int256(1e18) +
            (zetaWad  * sEffWad) / int256(1e18);
    }

    function trigger() external nonReentrant onlyRole(KEEPER_ROLE) {
        (, uint8 tier,, bool emergencyStale) = mirror.oracleTier();
        (, , int256 sBaseWad) = mirror.theta();
        int256 sEffWad = _spreadWadFromTier(sBaseWad, tier);

        int256 qWad = _readInt256(amm, "qWad()");
        int256 qMaxWad = _readInt256(amm, "qMaxWad()");
        int256 pRefWad = mirror.pRef();

        int256 SWad = computeActionWad(qWad, qMaxWad, tier, emergencyStale, sEffWad);

        Venue venue = Venue.AMM;
        if (emergencyStale || tier >= 2 || SWad >= SOrderbookWad) {
            venue = Venue.ORDERBOOK;
        } else if (SWad >= SYieldRecallWad) {
            venue = Venue.YIELD_RECALL;
        }

        emit InstantonDecision(venue, SWad, qWad, tier, emergencyStale, pRefWad, sEffWad);

        if (venue == Venue.ORDERBOOK) {
            bool isBuyBase = qWad < 0;

            int256 absQ = _abs(qWad);
            int256 cap = int256(5e18); // 5 base
            int256 amtI = absQ > cap ? cap : absQ;

            uint256 baseAmountWad = uint256(amtI);
            uint256 limitPriceWad = uint256(pRefWad);

            emit QuoteIntent(isBuyBase, baseAmountWad, limitPriceWad);
            emit RebalanceIntent(venue, 0);
            return;
        }

        if (venue == Venue.YIELD_RECALL) {
            uint256 amount = recallQuoteWad;
            uint256 available = yieldVault.totalUnderlyingFor(address(this));
            if (amount > available) amount = available;

            if (amount > 0) {
                yieldVault.withdrawTo(address(this), address(this), amount);
                emit RebalanceIntent(venue, amount);
            } else {
                emit RebalanceIntent(venue, 0);
            }
            return;
        }

        // AMM regime: deposit half allocator quote into yield
        uint256 idle = quote.balanceOf(address(this));
        if (idle > 0) {
            uint256 amt = idle / 2;
            quote.approve(address(yieldVault), amt);
            yieldVault.depositFor(address(this), amt);
            emit RebalanceIntent(venue, amt);
        } else {
            emit RebalanceIntent(venue, 0);
        }
    }

    function seedQuote(uint256 amountWad) external nonReentrant {
        require(amountWad > 0, "amount=0");
        require(quote.transferFrom(msg.sender, address(this), amountWad), "transferFrom fail");
    }

    function _readInt256(address target, string memory sig) internal view returns (int256 out) {
        (bool ok, bytes memory data) = target.staticcall(abi.encodeWithSignature(sig));
        require(ok && data.length >= 32, "read fail");
        out = abi.decode(data, (int256));
    }
}
