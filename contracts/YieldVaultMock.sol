// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "./interfaces/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @notice Minimal "yield module" mock.
/// - Only supports a single underlying asset: QUOTE token
/// - Tracks shares 1:1 for simplicity (plus optional yield factor)
contract YieldVaultMock is ReentrancyGuard, AccessControl {
    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");

    IERC20 public immutable quote;

    // Simple yield multiplier (WAD). 1e18 = no yield.
    int256 public rateWad = 1e18;

    mapping(address => uint256) public shares;

    event Deposit(address indexed user, uint256 amount, uint256 sharesMinted);
    event Withdraw(address indexed user, address indexed to, uint256 amount, uint256 sharesBurned);
    event SetRate(int256 rateWad);

    constructor(address _quote, address admin) {
        quote = IERC20(_quote);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MANAGER_ROLE, admin);
    }

    function setRate(int256 _rateWad) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_rateWad >= 1e18, "rate < 1");
        rateWad = _rateWad;
        emit SetRate(_rateWad);
    }

    function totalUnderlyingFor(address user) public view returns (uint256) {
        // shares * rateWad
        // shares are in underlying units already; multiply by rate
        return uint256((int256(shares[user]) * rateWad) / 1e18);
    }

    function depositFor(address user, uint256 amount) external nonReentrant onlyRole(MANAGER_ROLE) returns (uint256 mintedShares) {
        require(amount > 0, "amount=0");
        // pull quote from caller (allocator)
        require(quote.transferFrom(msg.sender, address(this), amount), "transferFrom fail");

        // 1:1 shares minted (simple)
        mintedShares = amount;
        shares[user] += mintedShares;

        emit Deposit(user, amount, mintedShares);
    }

    function withdrawTo(address user, address to, uint256 amount) external nonReentrant onlyRole(MANAGER_ROLE) returns (uint256 burnedShares) {
        require(amount > 0, "amount=0");
        uint256 underlying = totalUnderlyingFor(user);
        require(amount <= underlying, "insufficient underlying");

        // burn proportional shares (simple approximation)
        // burnedShares = amount / rate
        burnedShares = uint256((int256(amount) * 1e18) / rateWad);
        require(burnedShares <= shares[user], "burn>shares");

        shares[user] -= burnedShares;
        require(quote.transfer(to, amount), "transfer fail");

        emit Withdraw(user, to, amount, burnedShares);
    }
}
