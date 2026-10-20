// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../Market.sol";

/**
 * @title MarketHarness (TEST ONLY — never deploy)
 * @notice Stand-in for Phase 2 trading so Phase 3/5 can be tested before
 *         buyOutcomeTokens() exists. It uses the same hooks Phase 2 will use:
 *         _requireTradingOpen() and _recordCollateral().
 *         Price is a flat 0.01 ETH per share here; real pricing is LMSR (Phase 2).
 */
contract MarketHarness is Market {
    uint256 public constant TEST_PRICE = 0.01 ether;

    constructor(
        address creator_,
        string memory question_,
        string[] memory outcomes_,
        uint256 startTime_,
        uint256 endTime_,
        address arbitrator_
    ) Market(creator_, question_, outcomes_, startTime_, endTime_, arbitrator_) {}

    function testBuy(uint256 outcomeId, uint256 shares) external payable {
        _requireTradingOpen();
        if (outcomeId >= this.getOutcomeCount()) revert InvalidOutcome(outcomeId);
        require(msg.value == shares * TEST_PRICE, "wrong ETH amount");
        _recordCollateral(msg.sender, msg.value);
        outcomeToken.mint(msg.sender, outcomeId, shares);
    }
}

/// @notice TEST ONLY: tries to call claimRefund() again from inside its refund.
contract RefundReentrancyAttacker {
    MarketHarness public immutable market;
    uint256 public reentryAttempts;
    bool public reentrySucceeded;

    constructor(MarketHarness market_) { market = market_; }

    function buy(uint256 outcomeId, uint256 shares) external payable {
        market.testBuy{value: msg.value}(outcomeId, shares);
    }

    function attack() external {
        market.claimRefund();
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }

    receive() external payable {
        if (reentryAttempts == 0) {
            reentryAttempts++;
            try market.claimRefund() { reentrySucceeded = true; } catch {}
        }
    }
}
