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

    // ═════════════════════════════════════════════════════════════════════
    //  Task 1b — Phase 3 (oracle resolution) & Phase 5 (expiry / timeout)
    //  Owner: Dayana. Trading (Phase 2) and payouts (Phase 4) plug into the
    //  hooks at the bottom of this section.
    //
    //  Lifecycle:
    //    Upcoming ─(startTime)─▶ Open ─(endTime)─▶ Closed ─┬─(arbitrator resolves)─▶ Resolved
    //                                                       └─(no resolution by endTime + RESOLUTION_TIMEOUT)─▶ Expired
    //  Expired markets refund each trader the ETH collateral they paid.
    // ═════════════════════════════════════════════════════════════════════

    enum MarketStatus { Upcoming, Open, Closed, Resolved, Expired }

    /// @notice How long the arbitrator has after endTime to resolve before the market expires.
    uint256 public constant RESOLUTION_TIMEOUT = 7 days;

    /// @notice Set once the market has been marked expired (by markExpired() or the first refund).
    bool public expired;

    /// @notice ETH collateral each trader has paid in (recorded by Phase 2 via _recordCollateral()).
    mapping(address => uint256) public collateralPaid;

    bool private _locked;

    event MarketResolved(address indexed arbitrator, uint256 indexed winningOutcome, string winningLabel);
    event MarketExpired(uint256 expiredAt);
    event Refunded(address indexed account, uint256 amount);

    error NotArbitrator();
    error MarketNotEnded();
    error AlreadyResolved();
    error AlreadyExpired();
    error InvalidOutcome(uint256 outcomeId);
    error ResolutionWindowClosed();
    error NotExpired();
    error NothingToRefund();
    error TradingNotOpen(MarketStatus status);
    error RefundFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    // ───────────── Views ─────────────

    /// @notice Last moment the arbitrator can resolve; after this the market is Expired.
    function resolutionDeadline() public view returns (uint256) {
        return endTime + RESOLUTION_TIMEOUT;
    }

    /// @notice Current lifecycle stage, derived from stored flags and the block time.
    function status() public view returns (MarketStatus) {
        if (resolved) return MarketStatus.Resolved;
        if (expired || block.timestamp >= resolutionDeadline()) return MarketStatus.Expired;
        if (block.timestamp < startTime) return MarketStatus.Upcoming;
        if (block.timestamp < endTime) return MarketStatus.Open;
        return MarketStatus.Closed;
    }

    // ───────────── Phase 3: resolution ─────────────

    /// @notice Arbitrator declares the winning outcome. Allowed once, only after
    ///         endTime and before the resolution deadline.
    /// @param outcomeId index into getOutcomes() (binary market: 0 = YES, 1 = NO)
    function resolveMarket(uint256 outcomeId) external {
        if (msg.sender != arbitrator) revert NotArbitrator();
        if (resolved) revert AlreadyResolved();
        if (expired || block.timestamp >= resolutionDeadline()) revert ResolutionWindowClosed();
        if (block.timestamp < endTime) revert MarketNotEnded();
        if (outcomeId >= _outcomes.length) revert InvalidOutcome(outcomeId);

        resolved = true;
        winningOutcome = outcomeId;

        emit MarketResolved(msg.sender, outcomeId, _outcomes[outcomeId]);
    }

    // ───────────── Phase 5: expiry & refunds ─────────────

    /// @notice Anyone can mark an unresolved market as expired once the deadline has passed.
    ///         Optional: claimRefund() does this automatically on first use.
    function markExpired() external {
        if (resolved) revert AlreadyResolved();
        if (expired) revert AlreadyExpired();
        if (block.timestamp < resolutionDeadline()) revert NotExpired();
        _expire();
    }

    /// @notice In an expired market, return the caller's paid-in ETH and burn
    ///         their outcome shares so they cannot be used again.
    function claimRefund() external nonReentrant {
        if (status() != MarketStatus.Expired) revert NotExpired();
        if (!expired) _expire();

        uint256 amount = collateralPaid[msg.sender];
        if (amount == 0) revert NothingToRefund();
        collateralPaid[msg.sender] = 0; // effects before the transfer

        uint256 n = _outcomes.length;
        for (uint256 i = 0; i < n; i++) {
            uint256 bal = outcomeToken.balanceOf(msg.sender, i);
            if (bal > 0) outcomeToken.burn(msg.sender, i, bal);
        }

        emit Refunded(msg.sender, amount);
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert RefundFailed();
    }

    function _expire() private {
        expired = true;
        emit MarketExpired(block.timestamp);
    }

    // ───────────── Hooks for Phase 2 (trading) / Phase 4 (payout) ─────────────

    /// @dev Phase 2: call at the start of buyOutcomeTokens(). Rejects trades before
    ///      startTime, after endTime, after resolution and after expiry.
    function _requireTradingOpen() internal view {
        MarketStatus s = status();
        if (s != MarketStatus.Open) revert TradingNotOpen(s);
    }

    /// @dev Phase 2: call after taking `amount` wei from `trader`, so the trade can be
    ///      refunded if the market expires. (A creator subsidy can be recorded the same way.)
    function _recordCollateral(address trader, uint256 amount) internal {
        collateralPaid[trader] += amount;
    }
}
