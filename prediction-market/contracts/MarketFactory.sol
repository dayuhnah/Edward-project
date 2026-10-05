// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Market.sol";

/**
 * @title MarketFactory
 * @notice Creation entry point and registry for Market contracts.
 *         Holds no pricing, balances, resolution or payout logic.
 */
contract MarketFactory {
    address[] private markets;

    event MarketCreated(
        address indexed market,
        address indexed creator,
        address indexed arbitrator,
        string question,
        uint256 startTime,
        uint256 endTime
    );

    /// @dev Basic validation is done by the Market constructor (single source of truth);
    ///      any invalid input reverts the whole creation transaction.
    function createMarket(
        string calldata question,
        string[] calldata outcomes,
        uint256 startTime,
        uint256 endTime,
        address arbitrator
    ) external returns (address market) {
        Market m = new Market(msg.sender, question, outcomes, startTime, endTime, arbitrator);
        market = address(m);
        markets.push(market);

        emit MarketCreated(market, msg.sender, arbitrator, question, startTime, endTime);
    }

    function getMarkets() external view returns (address[] memory) {
        return markets;
    }

    function getMarketCount() external view returns (uint256) {
        return markets.length;
    }
}
