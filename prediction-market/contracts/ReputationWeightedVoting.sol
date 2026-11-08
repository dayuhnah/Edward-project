
 // SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IVotingMarket {
    function arbitrator() external view returns (address);
    function endTime() external view returns (uint256);
    function resolutionDeadline() external view returns (uint256);
    function getOutcomeCount() external view returns (uint256);
    function resolve(uint256 outcomeId) external;
}

/**
 * Bonus 3: reputation-weighted voting decides a market's outcome.
 * The voting contract is the market's arbitrator, so finalizeVoting() resolves the market.
 *
 * Reputation updates: after a round is finalized, every voter's reputation changes
 * according to whether they voted for the winning outcome:
 *   voted with the result   -> reputation + REPUTATION_REWARD
 *   voted against it        -> reputation - REPUTATION_PENALTY (never below MIN_REPUTATION)
 * Anyone can apply a voter's update with updateReputation(voter); it is also applied
 * automatically the next time that voter votes. Once a round is finalized (or its market
 * has expired) the admin can start a new round on another market, and the updated
 * reputation carries over, so voters who keep getting it right gain more weight.
 */
contract ReputationWeightedVoting {

    uint256 public constant REPUTATION_REWARD = 1;
    uint256 public constant REPUTATION_PENALTY = 1;
    uint256 public constant MIN_REPUTATION = 1;

    address public immutable admin;
    IVotingMarket public market;

    uint256 public votingDeadline;
    bool public initialized;
    bool public finalized;
    uint256 public winningOutcome;
    uint256 public totalWeightCast;

    mapping(address => uint256) public reputation;

    uint256[] private voteTotals;

    // Rounds: one round per market. Round numbers start at 1.
    uint256 public round;
    mapping(uint256 => address) public roundMarket;
    // winning outcome + 1 for each finalized round (0 = not finalized)
    mapping(uint256 => uint256) private roundWinnerPlusOne;

    // Each voter's latest vote: the round, and the outcome + 1
    mapping(address => uint256) public lastVotedRound;
    mapping(address => uint256) private lastChoicePlusOne;
    // Last round whose result has been applied to the voter's reputation
    mapping(address => uint256) public settledRound;

    event ReputationAssigned(
        address indexed voter,
        uint256 weight
    );

    event VoteCast(
        address indexed voter,
        uint256 indexed outcomeId,
        uint256 weight
    );

    event VotingFinalized(
        uint256 indexed outcomeId,
        uint256 totalWeight
    );

    event RoundStarted(
        uint256 indexed round,
        address indexed market,
        uint256 votingDeadline
    );

    event ReputationUpdated(
        address indexed voter,
        uint256 indexed round,
        bool votedWithResult,
        uint256 oldWeight,
        uint256 newWeight
    );

    error NotAdmin();
    error AlreadyInitialized();
    error NotInitialized();
    error InvalidMarket();
    error InvalidVotingWindow();
    error InvalidReputation();
    error ReputationLocked();
    error VotingNotStarted();
    error VotingClosed();
    error NotEligible();
    error AlreadyVoted();
    error InvalidOutcome();
    error VotingStillOpen();
    error AlreadyFinalized();
    error NoVotes();
    error VotingTied();
    error ResolutionWindowClosed();
    error NothingToUpdate();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor() {
        admin = msg.sender;
    }

    // Link this voting contract to a new market
    function initializeMarket(
        address marketAddress,
        uint256 votingDuration
    ) external onlyAdmin {

        // A new round can start once the previous one is finalized, or once its market
        // can no longer be resolved (tie / no votes until the market expired).
        if (
            initialized &&
            !finalized &&
            block.timestamp < market.resolutionDeadline()
        ) revert AlreadyInitialized();

        if (
            marketAddress == address(0) ||
            marketAddress.code.length == 0
        ) revert InvalidMarket();

        IVotingMarket target = IVotingMarket(marketAddress);

        if (target.arbitrator() != address(this)) {
            revert InvalidMarket();
        }

        uint256 end = target.endTime();

        if (block.timestamp >= end) {
            revert InvalidVotingWindow();
        }

        uint256 deadline = end + votingDuration;

        if (
            votingDuration == 0 ||
            deadline >= target.resolutionDeadline()
        ) revert InvalidVotingWindow();

        uint256 count = target.getOutcomeCount();

        if (count < 2) revert InvalidMarket();

        market = target;
        votingDeadline = deadline;
        voteTotals = new uint256[](count);
        totalWeightCast = 0;
        finalized = false;
        winningOutcome = 0;
        initialized = true;

        round += 1;
        roundMarket[round] = marketAddress;

        emit RoundStarted(round, marketAddress, deadline);
    }

    // True if the voter has voted in the current round
    function hasVoted(address voter) public view returns (bool) {
        return round != 0 && lastVotedRound[voter] == round;
    }

    // The voter's choice in their latest round, if any
    function lastChoice(address voter) external view returns (bool voted, uint256 outcomeId) {
        uint256 c = lastChoicePlusOne[voter];
        if (c == 0) return (false, 0);
        return (true, c - 1);
    }

    // Reputation with any pending update included (what the voter's weight will be)
    function currentReputation(address voter) public view returns (uint256) {
        (bool pending, , uint256 newWeight) = _pendingUpdate(voter);
        return pending ? newWeight : reputation[voter];
    }

    // Whether updateReputation(voter) would change anything right now
    function hasPendingUpdate(address voter) external view returns (bool) {
        (bool pending, , ) = _pendingUpdate(voter);
        return pending;
    }

    // Apply the voter's reputation change from their last finalized round. Anyone can call.
    function updateReputation(address voter) external {
        if (!_settle(voter)) revert NothingToUpdate();
    }

    function _pendingUpdate(address voter)
        private
        view
        returns (bool pending, bool correct, uint256 newWeight)
    {
        uint256 r = lastVotedRound[voter];
        if (r == 0 || settledRound[voter] >= r) return (false, false, 0);

        uint256 winnerPlusOne = roundWinnerPlusOne[r];
        if (winnerPlusOne == 0) return (false, false, 0); // round not finalized

        uint256 old = reputation[voter];
        correct = lastChoicePlusOne[voter] == winnerPlusOne;

        if (correct) {
            newWeight = old + REPUTATION_REWARD;
        } else if (old > MIN_REPUTATION + REPUTATION_PENALTY) {
            newWeight = old - REPUTATION_PENALTY;
        } else {
            newWeight = MIN_REPUTATION;
        }
        return (true, correct, newWeight);
    }

    function _settle(address voter) private returns (bool) {
        (bool pending, bool correct, uint256 newWeight) = _pendingUpdate(voter);
        if (!pending) return false;

        uint256 r = lastVotedRound[voter];
        uint256 old = reputation[voter];

        settledRound[voter] = r;
        reputation[voter] = newWeight;

        emit ReputationUpdated(voter, r, correct, old, newWeight);
        return true;
    }

    // Admin assigns reputation before voting starts
    function setReputation(
        address voter,
        uint256 weight
    ) external onlyAdmin {

        if (!initialized) revert NotInitialized();

        if (block.timestamp >= market.endTime()) {
            revert ReputationLocked();
        }

        if (voter == address(0) || weight == 0) {
            revert InvalidReputation();
        }

        // An admin-set value replaces any pending update from an earlier round
        settledRound[voter] = lastVotedRound[voter];
        reputation[voter] = weight;

        emit ReputationAssigned(voter, weight);
    }

    // Each eligible address can vote once
    function vote(uint256 outcomeId) external {

        if (!initialized) revert NotInitialized();

        if (block.timestamp < market.endTime()) {
            revert VotingNotStarted();
        }

        if (block.timestamp >= votingDeadline) {
            revert VotingClosed();
        }

        if (hasVoted(msg.sender)) {
            revert AlreadyVoted();
        }

        // Apply the result of the voter's previous round first
        _settle(msg.sender);

        uint256 weight = reputation[msg.sender];

        if (weight == 0) revert NotEligible();

        if (outcomeId >= voteTotals.length) {
            revert InvalidOutcome();
        }

        lastVotedRound[msg.sender] = round;
        lastChoicePlusOne[msg.sender] = outcomeId + 1;

        voteTotals[outcomeId] += weight;
        totalWeightCast += weight;

        emit VoteCast(msg.sender, outcomeId, weight);
    }

    // Read weighted vote totals for each outcome
    function getVoteTotals()
        external
        view
        returns (uint256[] memory)
    {
        return voteTotals;
    }

    // Finalise after the deadline
    function finalizeVoting() external {

        if (!initialized) revert NotInitialized();
        if (finalized) revert AlreadyFinalized();

        if (block.timestamp < votingDeadline) {
            revert VotingStillOpen();
        }

        if (
            block.timestamp >= market.resolutionDeadline()
        ) revert ResolutionWindowClosed();

        if (totalWeightCast == 0) revert NoVotes();

        uint256 highest = 0;
        uint256 winner = 0;
        bool tied = false;

        for (uint256 i = 0; i < voteTotals.length; i++) {

            if (voteTotals[i] > highest) {
                highest = voteTotals[i];
                winner = i;
                tied = false;
            } else if (voteTotals[i] == highest) {
                tied = true;
            }
        }

        if (tied) revert VotingTied();

        finalized = true;
        winningOutcome = winner;
        roundWinnerPlusOne[round] = winner + 1;

        // The voting contract is the market arbitrator
        market.resolve(winner);

        emit VotingFinalized(winner, highest);
    }
}
