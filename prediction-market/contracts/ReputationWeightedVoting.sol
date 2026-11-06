
 // SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IVotingMarket {
    function arbitrator() external view returns (address);
    function endTime() external view returns (uint256);
    function resolutionDeadline() external view returns (uint256);
    function getOutcomeCount() external view returns (uint256);
    function resolve(uint256 outcomeId) external;
}

contract ReputationWeightedVoting {

    address public immutable admin;
    IVotingMarket public market;

    uint256 public votingDeadline;
    bool public initialized;
    bool public finalized;
    uint256 public winningOutcome;
    uint256 public totalWeightCast;

    mapping(address => uint256) public reputation;
    mapping(address => bool) public hasVoted;

    uint256[] private voteTotals;

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

        if (initialized) revert AlreadyInitialized();

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
        initialized = true;
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

        if (hasVoted[msg.sender]) {
            revert AlreadyVoted();
        }

        uint256 weight = reputation[msg.sender];

        if (weight == 0) revert NotEligible();

        if (outcomeId >= voteTotals.length) {
            revert InvalidOutcome();
        }

        hasVoted[msg.sender] = true;

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

        // The voting contract is the market arbitrator
        market.resolve(winner);

        emit VotingFinalized(winner, highest);
    }
}
