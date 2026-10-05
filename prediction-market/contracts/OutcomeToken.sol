// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";

/**
 * @title OutcomeToken
 * @notice ERC-1155 ledger of outcome shares for ONE Market.
 *         Token ID i == outcome index i of the owning Market
 *         (binary market: 0 = YES, 1 = NO).
 *         Only the owning Market may mint or burn.
 */
contract OutcomeToken is ERC1155 {
    /// @notice The Market contract that controls minting/burning.
    address public immutable market;

    // ───────────── Events ─────────────
    /// @notice Emitted when new outcome shares are minted.
    event SharesMinted(
        address indexed account,
        uint256 indexed outcomeId,
        uint256 amount
    );

    /// @notice Emitted when outcome shares are burned.
    event SharesBurned(
        address indexed account,
        uint256 indexed outcomeId,
        uint256 amount
    );

    error NotMarket();
    error ZeroMarket();

    modifier onlyMarket() {
        if (msg.sender != market) revert NotMarket();
        _;
    }

    constructor(address market_) ERC1155("") {
        if (market_ == address(0)) revert ZeroMarket();
        market = market_;
    }

    function mint(address to, uint256 outcomeId, uint256 amount) external onlyMarket {
        _mint(to, outcomeId, amount, "");
        emit SharesMinted(to, outcomeId, amount);
    }

    function burn(address from, uint256 outcomeId, uint256 amount) external onlyMarket {
        _burn(from, outcomeId, amount);
        emit SharesBurned(from, outcomeId, amount);
    }
}
