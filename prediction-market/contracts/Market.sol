// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./OutcomeToken.sol";

/**
 * @title Market
 * @notice One prediction question and its full lifecycle.
 *         Task 1a: creation data, validation, read interface, OutcomeToken deployment.
 *         Task 1b (later): AMM trading, arbitrator resolution, redemption, timeouts.
 */
contract Market {
    // ───────────── State ─────────────
    string public question;
    address public immutable creator;
    address public immutable arbitrator;
    uint256 public immutable startTime;
    uint256 public immutable endTime;

    /// @notice Set by Task 1b resolution logic.
    bool public resolved;
    /// @notice Index of winning outcome; only meaningful when `resolved == true`.
    uint256 public winningOutcome;

    /// @notice ERC-1155 contract for this market's shares (token ID == outcome index).
    OutcomeToken public immutable outcomeToken;

    string[] private _outcomes;

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

    // ───────────── Errors ─────────────
    error EmptyQuestion();
    error TooFewOutcomes();
    error EmptyOutcomeLabel(uint256 index);
    error DuplicateOutcomeLabel(uint256 index);
    error InvalidTimes();
    error EndTimeInPast();
    error ZeroArbitrator();
    error ZeroCreator();

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

    // ───────────── Views ─────────────
    function getOutcomes() external view returns (string[] memory) {
        return _outcomes;
    }

    function getOutcomeCount() external view returns (uint256) {
        return _outcomes.length;
    }
}
