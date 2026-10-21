// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./OutcomeToken.sol";

/**
 * @title Market
 * @notice One prediction question and its full lifecycle.
 *         Task 1a: creation data, validation, read interface, OutcomeToken deployment.
 *         Task 1b / Phase 2: ETH-collateralised constant-product AMM and buyOutcomeTokens().
 *         Later phases: selling, arbitrator resolution, redemption, timeouts.
 *
 * AMM model (constant product, "fixed product market maker"):
 *   - The pool keeps one reserve per outcome (virtual accounting, in wei).
 *   - 1 wei of collateral always backs 1 complete set (1 share of EVERY outcome).
 *   - A buy of `x` wei adds `x` to every reserve (a new complete set enters the pool),
 *     then removes `tokensOut` of the chosen outcome so that the product of all reserves
 *     never decreases. Buying an outcome therefore makes it more expensive.
 *   - Invariant: reserves[i] + (shares of i held by traders) == total collateral deposited.
 */
contract Market is ReentrancyGuard {
    // ───────────── State ─────────────
    string public question;
    address public immutable creator;
    address public immutable arbitrator;
    uint256 public immutable startTime;
    uint256 public immutable endTime;

    /// @notice Set by later resolution logic.
    bool public resolved;
    /// @notice Index of winning outcome; only meaningful when `resolved == true`.
    uint256 public winningOutcome;

    /// @notice ERC-1155 contract for this market's shares (token ID == outcome index).
    OutcomeToken public immutable outcomeToken;

    /// @notice True once the creator has funded the pool; trading is impossible before this.
    bool public liquiditySeeded;

    string[] private _outcomes;
    /// @dev Per-outcome AMM reserves, in wei-denominated shares.
    uint256[] private _reserves;

    /// @dev Fixed-point scale used inside the price formula to limit rounding error.
    uint256 private constant ONE = 1e18;

    // ───────────── Events ─────────────
    /// @notice Emitted once when the market has been fully initialised.
    event MarketInitialized(
        address indexed creator,
        address indexed arbitrator,
        address indexed outcomeToken,
        string question,
        uint256 startTime,
        uint256 endTime,
        uint256 outcomeCount
    );

    /// @notice Emitted for each outcome registered during market creation.
    event OutcomeRegistered(uint256 indexed outcomeId, string label);

    /// @notice Emitted when the ERC-1155 outcome token contract is deployed.
    event OutcomeTokenDeployed(address indexed outcomeToken);

    /// @notice Emitted when the creator funds the pool.
    event LiquiditySeeded(address indexed provider, uint256 amountPerOutcome);

    /// @notice Emitted on every successful purchase.
    /// @param trader The buyer (receives the shares).
    /// @param outcomeId Outcome bought.
    /// @param collateralIn ETH paid, in wei.
    /// @param tokensOut Outcome shares minted to the trader.
    event OutcomeTokensBought(
        address indexed trader,
        uint256 indexed outcomeId,
        uint256 collateralIn,
        uint256 tokensOut
    );

    // ───────────── Errors ─────────────
    error EmptyQuestion();
    error TooFewOutcomes();
    error EmptyOutcomeLabel(uint256 index);
    error DuplicateOutcomeLabel(uint256 index);
    error InvalidTimes();
    error EndTimeInPast();
    error ZeroArbitrator();
    error ZeroCreator();

    // Trading errors
    error NotCreator();
    error AlreadySeeded();
    error LiquidityNotSeeded();
    error ZeroAmount();
    error InvalidOutcome(uint256 outcomeId);
    error MarketClosed();
    error MarketNotStarted();
    error MarketExpired();
    error SlippageExceeded(uint256 tokensOut, uint256 minTokensOut);

    constructor(
        address creator_,
        string memory question_,
        string[] memory outcomes_,
        uint256 startTime_,
        uint256 endTime_,
        address arbitrator_
    ) {
        // The Market defends its own invariants regardless of the Factory.
        if (creator_ == address(0)) revert ZeroCreator();
        if (bytes(question_).length == 0) revert EmptyQuestion();
        if (outcomes_.length < 2) revert TooFewOutcomes();
        if (startTime_ >= endTime_) revert InvalidTimes();
        if (endTime_ <= block.timestamp) revert EndTimeInPast();
        if (arbitrator_ == address(0)) revert ZeroArbitrator();

        for (uint256 i = 0; i < outcomes_.length; i++) {
            bytes memory label = bytes(outcomes_[i]);
            if (label.length == 0) revert EmptyOutcomeLabel(i);
            bytes32 h = keccak256(label);
            for (uint256 j = 0; j < i; j++) {
                if (keccak256(bytes(outcomes_[j])) == h) revert DuplicateOutcomeLabel(i);
            }
            _outcomes.push(outcomes_[i]);
            _reserves.push(0);
            emit OutcomeRegistered(i, outcomes_[i]);
        }

        creator = creator_;
        question = question_;
        startTime = startTime_;
        endTime = endTime_;
        arbitrator = arbitrator_;

        // Market is the sole minter/burner of its own outcome shares.
        outcomeToken = new OutcomeToken(address(this));

        emit OutcomeTokenDeployed(address(outcomeToken));
        emit MarketInitialized(
            creator_,
            arbitrator_,
            address(outcomeToken),
            question_,
            startTime_,
            endTime_,
            outcomes_.length
        );
    }

    // ───────────── Liquidity ─────────────
    /**
     * @notice Fund the pool. Callable once, by the creator, before the market ends.
     *         `msg.value` wei becomes the starting reserve of EVERY outcome, so all
     *         outcomes start at equal odds (1 / outcomeCount).
     */
    function seedLiquidity() external payable {
        if (msg.sender != creator) revert NotCreator();
        if (liquiditySeeded) revert AlreadySeeded();
        if (msg.value == 0) revert ZeroAmount();
        if (resolved) revert MarketClosed();
        if (block.timestamp >= endTime) revert MarketExpired();

        liquiditySeeded = true;
        uint256 n = _reserves.length;
        for (uint256 i = 0; i < n; i++) {
            _reserves[i] = msg.value;
        }
        emit LiquiditySeeded(msg.sender, msg.value);
    }

    // ───────────── Trading ─────────────
    /**
     * @notice Buy shares of `outcomeId` with ETH (`msg.value`).
     * @param outcomeId Index of the outcome to buy.
     * @param minTokensOut Slippage guard: revert if fewer shares would be minted.
     * @return tokensOut Shares minted to the caller.
     */
    function buyOutcomeTokens(uint256 outcomeId, uint256 minTokensOut)
        external
        payable
        nonReentrant
        returns (uint256 tokensOut)
    {
        // ── Checks ──
        if (outcomeId >= _outcomes.length) revert InvalidOutcome(outcomeId); // valid outcome
        if (msg.value == 0) revert ZeroAmount();
        if (!liquiditySeeded) revert LiquidityNotSeeded();
        if (resolved) revert MarketClosed(); // market still open
        if (block.timestamp < startTime) revert MarketNotStarted();
        if (block.timestamp >= endTime) revert MarketExpired(); // event not expired

        // Number of outcome tokens to mint, from the AMM.
        tokensOut = calcBuyAmount(msg.value, outcomeId);
        if (tokensOut < minTokensOut) revert SlippageExceeded(tokensOut, minTokensOut);

        // ── Effects: update AMM state BEFORE any external call ──
        // Collateral (msg.value) has already been received by this payable call.
        uint256 n = _reserves.length;
        for (uint256 i = 0; i < n; i++) {
            _reserves[i] += msg.value; // new complete set enters the pool
        }
        _reserves[outcomeId] -= tokensOut; // chosen outcome leaves the pool

        // ── Interactions ──
        // ERC-1155 minting calls onERC1155Received on contract recipients, so this
        // stays last and the function is nonReentrant.
        outcomeToken.mint(msg.sender, outcomeId, tokensOut);

        emit OutcomeTokensBought(msg.sender, outcomeId, msg.value, tokensOut);
    }

    /**
     * @notice Quote: how many shares of `outcomeId` would `investment` wei buy right now.
     * @dev Constant-product rule: product of all reserves must not decrease. Rounding is
     *      always in the pool's favour (reserves rounded up, tokens out rounded down).
     */
    function calcBuyAmount(uint256 investment, uint256 outcomeId) public view returns (uint256) {
        if (outcomeId >= _outcomes.length) revert InvalidOutcome(outcomeId);
        if (!liquiditySeeded) revert LiquidityNotSeeded();

        uint256 buyPool = _reserves[outcomeId];
        uint256 ending = buyPool * ONE;
        uint256 n = _reserves.length;
        for (uint256 i = 0; i < n; i++) {
            if (i == outcomeId) continue;
            uint256 pool = _reserves[i];
            ending = Math.mulDiv(ending, pool, pool + investment, Math.Rounding.Ceil);
        }
        return buyPool + investment - Math.ceilDiv(ending, ONE);
    }

    // ───────────── Views ─────────────
    function getOutcomes() external view returns (string[] memory) {
        return _outcomes;
    }

    function getOutcomeCount() external view returns (uint256) {
        return _outcomes.length;
    }

    /// @notice Current AMM reserve of every outcome (index == outcome id).
    function getReserves() external view returns (uint256[] memory) {
        return _reserves;
    }
}
