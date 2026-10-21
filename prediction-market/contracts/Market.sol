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
 *         Phase 4: arbitrator resolve(), 1-wei-per-winning-share payout, redeem()/claimPayout().
 *         Phase 5: resolution timeout. If the arbitrator has not resolved by
 *         endTime + RESOLUTION_TIMEOUT, the market is Expired and everyone (traders and the
 *         creator) can claimRefund() the ETH they put in.
 *         Not yet implemented: selling, dispute window, creator withdrawal of the pool's
 *         remaining collateral after a normal resolution.
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

    /// @notice ETH (wei) paid for each share of the winning outcome.
    uint256 public constant PAYOUT_PER_SHARE = 1;

    // ───────────── Phase 5: expiry / timeout state ─────────────
    /// @notice Lifecycle stage, see status().
    enum MarketStatus { Upcoming, Open, Closed, Resolved, Expired }

    /// @notice Time the arbitrator has after endTime to resolve before the market expires.
    uint256 public constant RESOLUTION_TIMEOUT = 7 days;

    /// @notice Set once an unresolved market has been marked expired.
    bool public expired;

    /// @notice ETH each account has put into this market (creator seed + trades), refundable on expiry.
    mapping(address => uint256) public collateralPaid;

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

    /// @notice Emitted once when the arbitrator reports the final result.
    event MarketResolved(uint256 indexed winningOutcome, address indexed arbitrator);

    /// @notice Emitted when winning shares are burned in exchange for ETH.
    /// @param user The redeemer (shares burned from, ETH sent to).
    /// @param outcomeId The winning outcome (always `winningOutcome`).
    /// @param sharesBurned Winning shares burned.
    /// @param payout ETH paid out, in wei.
    event Redeemed(
        address indexed user,
        uint256 indexed outcomeId,
        uint256 sharesBurned,
        uint256 payout
    );

    /// @notice Emitted once when an unresolved market passes its resolution deadline.
    event MarketTimedOut(uint256 timestamp);

    /// @notice Emitted when an account takes back its ETH from an expired market.
    event Refunded(address indexed account, uint256 amount);

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

    // Resolution and payout errors
    error NotArbitrator();
    error AlreadyResolved();
    error MarketNotEnded();
    error NotResolved();
    error NothingToRedeem();
    error InsufficientShares(uint256 balance, uint256 requested);
    error TransferFailed();

    // Expiry / timeout errors
    error ResolutionWindowClosed();
    error AlreadyExpired();
    error NotExpired();
    error NothingToRefund();

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
        collateralPaid[msg.sender] += msg.value; // Phase 5: refundable if the market expires
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
        collateralPaid[msg.sender] += msg.value; // Phase 5: refundable if the market expires

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

    // ───────────── Resolution ─────────────
    /**
     * @notice Report the final result. Only the designated arbitrator, only once, and only
     *         after the market's end time.
     * @dev Minimal resolution rule. Dispute windows, staking and timeouts for an arbitrator
     *      that never resolves are NOT implemented here.
     */
    function resolve(uint256 outcomeId) external {
        if (msg.sender != arbitrator) revert NotArbitrator();
        if (resolved) revert AlreadyResolved();
        if (block.timestamp < endTime) revert MarketNotEnded();
        if (expired || block.timestamp >= resolutionDeadline()) revert ResolutionWindowClosed(); // Phase 5
        if (outcomeId >= _outcomes.length) revert InvalidOutcome(outcomeId);

        resolved = true;
        winningOutcome = outcomeId;
        emit MarketResolved(outcomeId, msg.sender);
    }

    // ───────────── Payout ─────────────
    /**
     * @notice Payout formula: each winning share redeems for exactly 1 wei.
     * @dev Safe because 1 wei of collateral backs 1 complete set (1 share of every outcome),
     *      and exactly one outcome wins, so winning shares are always fully covered:
     *      total winning shares held by traders <= collateral - reserve[winner].
     *      Losing shares are worth 0.
     */
    function calcPayout(uint256 shares) public pure returns (uint256) {
        return shares * PAYOUT_PER_SHARE;
    }

    /// @notice ETH that `user` could claim right now (0 if unresolved or holding no winning shares).
    function getPayout(address user) external view returns (uint256) {
        if (!resolved) return 0;
        return calcPayout(outcomeToken.balanceOf(user, winningOutcome));
    }

    /// @notice Burn `shares` of the winning outcome and receive their payout in ETH.
    function redeem(uint256 shares) external nonReentrant returns (uint256 payout) {
        return _redeem(msg.sender, shares);
    }

    /// @notice Burn ALL of the caller's winning shares and receive the payout in ETH.
    function claimPayout() external nonReentrant returns (uint256 payout) {
        if (!resolved) revert NotResolved();
        uint256 balance = outcomeToken.balanceOf(msg.sender, winningOutcome);
        if (balance == 0) revert NothingToRedeem();
        return _redeem(msg.sender, balance);
    }

    function _redeem(address user, uint256 shares) private returns (uint256 payout) {
        // ── Checks ──
        if (!resolved) revert NotResolved(); // market is resolved
        if (shares == 0) revert ZeroAmount();
        uint256 outcomeId = winningOutcome; // the winning outcome
        uint256 balance = outcomeToken.balanceOf(user, outcomeId);
        if (shares > balance) revert InsufficientShares(balance, shares); // user's entitlement
        payout = calcPayout(shares);

        // ── Effects ──
        // Burning the shares is what prevents a second claim: they no longer exist.
        outcomeToken.burn(user, outcomeId, shares);

        // ── Interactions ──
        (bool ok, ) = payable(user).call{value: payout}("");
        if (!ok) revert TransferFailed(); // reverts the burn too

        emit Redeemed(user, outcomeId, shares, payout);
    }

    // ───────────── Phase 5: expiry / timeout ─────────────
    /// @notice Last moment the arbitrator can resolve; after this an unresolved market is Expired.
    function resolutionDeadline() public view returns (uint256) {
        return endTime + RESOLUTION_TIMEOUT;
    }

    /// @notice Current lifecycle stage (0 Upcoming, 1 Open, 2 Closed, 3 Resolved, 4 Expired).
    function status() public view returns (MarketStatus) {
        if (resolved) return MarketStatus.Resolved;
        if (expired || block.timestamp >= resolutionDeadline()) return MarketStatus.Expired;
        if (block.timestamp < startTime) return MarketStatus.Upcoming;
        if (block.timestamp < endTime) return MarketStatus.Open;
        return MarketStatus.Closed;
    }

    /// @notice Anyone can mark an unresolved market expired once the deadline has passed.
    ///         Optional: the first claimRefund() also does this.
    function markExpired() external {
        if (resolved) revert AlreadyResolved();
        if (expired) revert AlreadyExpired();
        if (block.timestamp < resolutionDeadline()) revert NotExpired();
        _expire();
    }

    /**
     * @notice In an expired market, take back all the ETH you put in (trades, or the seed if
     *         you are the creator). Your outcome shares are burned so they can't be used again.
     * @dev Refunds go to the account that paid. Shares transferred to someone else are burned
     *      from the holder only if the holder also claims; they carry no refund of their own.
     */
    function claimRefund() external nonReentrant returns (uint256 amount) {
        if (status() != MarketStatus.Expired) revert NotExpired();
        if (!expired) _expire();

        amount = collateralPaid[msg.sender];
        if (amount == 0) revert NothingToRefund();

        // ── Effects ──
        collateralPaid[msg.sender] = 0;
        uint256 n = _outcomes.length;
        for (uint256 i = 0; i < n; i++) {
            uint256 held = outcomeToken.balanceOf(msg.sender, i);
            if (held > 0) outcomeToken.burn(msg.sender, i, held);
        }

        // ── Interactions ──
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Refunded(msg.sender, amount);
    }

    function _expire() private {
        expired = true;
        emit MarketTimedOut(block.timestamp);
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
