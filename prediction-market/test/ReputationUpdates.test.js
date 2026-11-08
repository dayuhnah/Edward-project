const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Task 2b: reputation updates and the reputation voting system as a whole.
// Voters who back the final result gain reputation, the others lose some, and the
// new weights carry into the next market.

const eth = (n) => ethers.parseEther(String(n));
const WEEK = 7 * 24 * 3600;
const VOTE_WINDOW = 300;

describe("Task 2b: reputation updates and voting system", function () {
  let admin, alice, bob, charlie, dave, trader1, trader2, outsider;
  let factory, voting;

  // Creates a market with the voting contract as arbitrator and starts a voting round on it.
  async function newRound(question = "Will it happen?", outcomes = ["YES", "NO"], seed = 0) {
    const now = await time.latest();
    const start = now + 10;
    const end = now + 1000;
    await factory.createMarket(question, outcomes, start, end, await voting.getAddress());
    const market = await ethers.getContractAt("Market", (await factory.getMarkets()).at(-1));
    if (seed) await market.seedLiquidity({ value: eth(seed) });
    await voting.initializeMarket(await market.getAddress(), VOTE_WINDOW);
    return { market, start, end };
  }

  async function voteAndFinalize(end, votes) {
    await time.increaseTo(end);
    for (const [who, outcome] of votes) await voting.connect(who).vote(outcome);
    await time.increaseTo(end + VOTE_WINDOW);
    await voting.finalizeVoting();
  }

  beforeEach(async function () {
    [admin, alice, bob, charlie, dave, trader1, trader2, outsider] = await ethers.getSigners();
    voting = await (await ethers.getContractFactory("ReputationWeightedVoting")).deploy();
    factory = await (await ethers.getContractFactory("MarketFactory")).deploy();
  });

  describe("reputation updates after a round", function () {
    let market, end;

    beforeEach(async function () {
      ({ market, end } = await newRound());
      await voting.setReputation(alice.address, 5);
      await voting.setReputation(bob.address, 2);
      await voting.setReputation(charlie.address, 3);
      await voting.setReputation(dave.address, 1);
    });

    it("voters with the result gain REPUTATION_REWARD, the others lose REPUTATION_PENALTY", async function () {
      // YES: alice 5 + charlie 3 = 8, NO: bob 2 + dave 1 = 3
      await voteAndFinalize(end, [[alice, 0], [bob, 1], [charlie, 0], [dave, 1]]);
      expect(await market.winningOutcome()).to.equal(0n);

      for (const v of [alice, bob, charlie, dave]) await voting.updateReputation(v.address);

      expect(await voting.reputation(alice.address)).to.equal(6n);
      expect(await voting.reputation(charlie.address)).to.equal(4n);
      expect(await voting.reputation(bob.address)).to.equal(1n);
      expect(await voting.reputation(dave.address)).to.equal(1n); // already at the minimum
    });

    it("emits ReputationUpdated with the round, direction and old/new weight", async function () {
      await voteAndFinalize(end, [[alice, 0], [bob, 1]]);
      await expect(voting.updateReputation(alice.address))
        .to.emit(voting, "ReputationUpdated").withArgs(alice.address, 1n, true, 5n, 6n);
      await expect(voting.updateReputation(bob.address))
        .to.emit(voting, "ReputationUpdated").withArgs(bob.address, 1n, false, 2n, 1n);
    });

    it("reputation never drops below MIN_REPUTATION, so a voter keeps the right to vote", async function () {
      await voteAndFinalize(end, [[alice, 0], [dave, 1]]);
      await voting.updateReputation(dave.address);
      expect(await voting.reputation(dave.address)).to.equal(await voting.MIN_REPUTATION());
    });

    it("anyone can apply a voter's update, but only once", async function () {
      await voteAndFinalize(end, [[alice, 0], [bob, 1]]);
      await voting.connect(outsider).updateReputation(alice.address);
      expect(await voting.reputation(alice.address)).to.equal(6n);
      await expect(voting.updateReputation(alice.address))
        .to.be.revertedWithCustomError(voting, "NothingToUpdate");
    });

    it("nothing to update before finalization, or for someone who did not vote", async function () {
      await time.increaseTo(end);
      await voting.connect(alice).vote(0);
      await expect(voting.updateReputation(alice.address))
        .to.be.revertedWithCustomError(voting, "NothingToUpdate");
      await time.increaseTo(end + VOTE_WINDOW);
      await voting.finalizeVoting();
      await expect(voting.updateReputation(charlie.address))
        .to.be.revertedWithCustomError(voting, "NothingToUpdate");
      await expect(voting.updateReputation(outsider.address))
        .to.be.revertedWithCustomError(voting, "NothingToUpdate");
    });

    it("currentReputation and hasPendingUpdate show the change before it is applied", async function () {
      await voteAndFinalize(end, [[alice, 0], [bob, 1]]);
      expect(await voting.hasPendingUpdate(alice.address)).to.equal(true);
      expect(await voting.currentReputation(alice.address)).to.equal(6n);
      expect(await voting.reputation(alice.address)).to.equal(5n);
      await voting.updateReputation(alice.address);
      expect(await voting.hasPendingUpdate(alice.address)).to.equal(false);
      expect(await voting.currentReputation(alice.address)).to.equal(6n);
    });

    it("lastChoice records what each voter picked", async function () {
      await voteAndFinalize(end, [[alice, 0], [bob, 1]]);
      expect(await voting.lastChoice(alice.address)).to.deep.equal([true, 0n]);
      expect(await voting.lastChoice(bob.address)).to.deep.equal([true, 1n]);
      expect(await voting.lastChoice(charlie.address)).to.deep.equal([false, 0n]);
    });

    it("a tied round changes nobody's reputation", async function () {
      await voting.setReputation(bob.address, 5);
      await time.increaseTo(end);
      await voting.connect(alice).vote(0);
      await voting.connect(bob).vote(1);
      await time.increaseTo(end + VOTE_WINDOW);
      await expect(voting.finalizeVoting()).to.be.revertedWithCustomError(voting, "VotingTied");
      expect(await voting.hasPendingUpdate(alice.address)).to.equal(false);
      expect(await voting.currentReputation(alice.address)).to.equal(5n);
    });
  });

  describe("several markets in a row", function () {
    it("a new round can only start once the current one is finalized", async function () {
      const { end } = await newRound("Round 1");
      await voting.setReputation(alice.address, 3);
      const now = await time.latest();
      await factory.createMarket("Round 2", ["YES", "NO"], now + 10, now + 5000, await voting.getAddress());
      const second = (await factory.getMarkets()).at(-1);

      await expect(voting.initializeMarket(second, VOTE_WINDOW))
        .to.be.revertedWithCustomError(voting, "AlreadyInitialized");

      await voteAndFinalize(end, [[alice, 0]]);
      await expect(voting.initializeMarket(second, VOTE_WINDOW))
        .to.emit(voting, "RoundStarted").withArgs(2n, second, anyUint());
      expect(await voting.round()).to.equal(2n);
      expect(await voting.roundMarket(2)).to.equal(second);
      expect(await voting.finalized()).to.equal(false);
      expect(await voting.totalWeightCast()).to.equal(0n);
      expect(await voting.getVoteTotals()).to.deep.equal([0n, 0n]);
    });

    it("if a round can never finish (tie), a new one can start after that market expires", async function () {
      const { market, end } = await newRound("Tied");
      await voting.setReputation(alice.address, 2);
      await voting.setReputation(bob.address, 2);
      await time.increaseTo(end);
      await voting.connect(alice).vote(0);
      await voting.connect(bob).vote(1);

      const now = await time.latest();
      await factory.createMarket("Next", ["YES", "NO"], now + 10, now + 2 * WEEK, await voting.getAddress());
      const next = (await factory.getMarkets()).at(-1);
      await expect(voting.initializeMarket(next, VOTE_WINDOW))
        .to.be.revertedWithCustomError(voting, "AlreadyInitialized");

      await time.increaseTo(await market.resolutionDeadline());
      expect(await market.status()).to.equal(4n); // Expired: traders get refunds
      await voting.initializeMarket(next, VOTE_WINDOW);
      expect(await voting.round()).to.equal(2n);
    });

    it("updated reputation carries into the next round and changes the voting weight", async function () {
      // Round 1: alice and charlie are right, bob is wrong.
      let r = await newRound("Round 1");
      await voting.setReputation(alice.address, 2);
      await voting.setReputation(bob.address, 4);
      await voting.setReputation(charlie.address, 3);
      await voteAndFinalize(r.end, [[alice, 0], [bob, 1], [charlie, 0]]); // 5 vs 4: YES

      // Round 2: nobody calls updateReputation; voting applies it automatically.
      r = await newRound("Round 2");
      await time.increaseTo(r.end);
      await expect(voting.connect(alice).vote(1))
        .to.emit(voting, "ReputationUpdated").withArgs(alice.address, 1n, true, 2n, 3n);
      await voting.connect(bob).vote(0); // bob's weight is now 3, not 4
      expect(await voting.getVoteTotals()).to.deep.equal([3n, 3n]);
      await voting.connect(charlie).vote(1); // charlie now 4
      expect(await voting.getVoteTotals()).to.deep.equal([3n, 7n]);
      await time.increaseTo(r.end + VOTE_WINDOW);
      await voting.finalizeVoting();
      expect(await r.market.winningOutcome()).to.equal(1n);

      // After round 2: alice and charlie were right again, bob was wrong again.
      await voting.updateReputation(alice.address);
      await voting.updateReputation(bob.address);
      await voting.updateReputation(charlie.address);
      expect(await voting.reputation(alice.address)).to.equal(4n);
      expect(await voting.reputation(bob.address)).to.equal(2n);
      expect(await voting.reputation(charlie.address)).to.equal(5n);
    });

    it("hasVoted resets for each round, so the same voter can vote on every market", async function () {
      let r = await newRound("Round 1");
      await voting.setReputation(alice.address, 1);
      await voteAndFinalize(r.end, [[alice, 0]]);
      expect(await voting.hasVoted(alice.address)).to.equal(true);

      r = await newRound("Round 2");
      expect(await voting.hasVoted(alice.address)).to.equal(false);
      await time.increaseTo(r.end);
      await voting.connect(alice).vote(1);
      await expect(voting.connect(alice).vote(1)).to.be.revertedWithCustomError(voting, "AlreadyVoted");
    });

    it("an admin setReputation replaces a pending update instead of stacking with it", async function () {
      let r = await newRound("Round 1");
      await voting.setReputation(alice.address, 5);
      await voteAndFinalize(r.end, [[alice, 0]]);
      r = await newRound("Round 2");
      await voting.setReputation(alice.address, 10);
      expect(await voting.hasPendingUpdate(alice.address)).to.equal(false);
      await time.increaseTo(r.end);
      await voting.connect(alice).vote(0);
      expect(await voting.getVoteTotals()).to.deep.equal([10n, 0n]);
    });

    it("works for a market with three outcomes", async function () {
      const r = await newRound("Which?", ["A", "B", "C"]);
      await voting.setReputation(alice.address, 2);
      await voting.setReputation(bob.address, 2);
      await voting.setReputation(charlie.address, 3);
      await voteAndFinalize(r.end, [[alice, 0], [bob, 1], [charlie, 2]]);
      expect(await r.market.winningOutcome()).to.equal(2n);
      await expect(voting.connect(dave).vote(0)).to.be.reverted; // closed anyway
      await voting.updateReputation(charlie.address);
      await voting.updateReputation(alice.address);
      expect(await voting.reputation(charlie.address)).to.equal(4n);
      expect(await voting.reputation(alice.address)).to.equal(1n);
    });
  });

  describe("voting together with trading and payouts", function () {
    it("traders buy, voters decide, and the voted winners are paid in full", async function () {
      const { market, start, end } = await newRound("Will the demo work?", ["YES", "NO"], 2);
      await voting.setReputation(alice.address, 5);
      await voting.setReputation(bob.address, 2);

      await time.increaseTo(start);
      await market.connect(trader1).buyOutcomeTokens(0, 0, { value: eth(1) }); // YES
      await market.connect(trader2).buyOutcomeTokens(1, 0, { value: eth(1) }); // NO
      const token = await ethers.getContractAt("OutcomeToken", await market.outcomeToken());
      const yesShares = await token.balanceOf(trader1.address, 0);

      await voteAndFinalize(end, [[alice, 0], [bob, 1]]);
      expect(await market.status()).to.equal(3n); // Resolved
      expect(await market.winningOutcome()).to.equal(0n);

      const before = await ethers.provider.getBalance(trader1.address);
      const rc = await (await market.connect(trader1).claimPayout()).wait();
      expect((await ethers.provider.getBalance(trader1.address)) - before + rc.gasUsed * rc.gasPrice)
        .to.equal(yesShares);
      await expect(market.connect(trader2).claimPayout())
        .to.be.revertedWithCustomError(market, "NothingToRedeem");
      await expect(market.connect(trader1).claimRefund())
        .to.be.revertedWithCustomError(market, "NotExpired");
    });

    it("if voting never finishes, the market expires and traders are refunded", async function () {
      const { market, start, end } = await newRound("No votes", ["YES", "NO"], 2);
      await time.increaseTo(start);
      await market.connect(trader1).buyOutcomeTokens(0, 0, { value: eth(1) });
      await time.increaseTo(end + VOTE_WINDOW);
      await expect(voting.finalizeVoting()).to.be.revertedWithCustomError(voting, "NoVotes");
      await time.increaseTo(await market.resolutionDeadline());
      expect(await market.status()).to.equal(4n);
      const owed = await market.collateralPaid(trader1.address);
      await expect(market.connect(trader1).claimRefund()).to.changeEtherBalance(trader1, owed);
    });
  });

  describe("security", function () {
    let market, end;
    beforeEach(async function () {
      ({ market, end } = await newRound());
      await voting.setReputation(alice.address, 5);
    });

    it("only the admin can start rounds or set reputation", async function () {
      await expect(voting.connect(outsider).setReputation(outsider.address, 100))
        .to.be.revertedWithCustomError(voting, "NotAdmin");
      await expect(voting.connect(outsider).initializeMarket(await market.getAddress(), VOTE_WINDOW))
        .to.be.revertedWithCustomError(voting, "NotAdmin");
    });

    it("reputation cannot be changed by the admin once voting has started", async function () {
      await time.increaseTo(end);
      await expect(voting.setReputation(alice.address, 50))
        .to.be.revertedWithCustomError(voting, "ReputationLocked");
    });

    it("only the voting contract can resolve its market; voters cannot go around it", async function () {
      await time.increaseTo(end);
      for (const who of [admin, alice, outsider]) {
        await expect(market.connect(who).resolve(1)).to.be.revertedWithCustomError(market, "NotArbitrator");
      }
    });

    it("a market whose arbitrator is someone else cannot be attached", async function () {
      const now = await time.latest();
      const v2 = await (await ethers.getContractFactory("ReputationWeightedVoting")).deploy();
      await factory.createMarket("Other", ["YES", "NO"], now + 10, now + 1000, admin.address);
      const other = (await factory.getMarkets()).at(-1);
      await expect(v2.initializeMarket(other, VOTE_WINDOW)).to.be.revertedWithCustomError(v2, "InvalidMarket");
    });

    it("the voting deadline must end before the market's resolution deadline", async function () {
      const now = await time.latest();
      const v2 = await (await ethers.getContractFactory("ReputationWeightedVoting")).deploy();
      await factory.createMarket("Long", ["YES", "NO"], now + 10, now + 1000, await v2.getAddress());
      const m = (await factory.getMarkets()).at(-1);
      await expect(v2.initializeMarket(m, WEEK)).to.be.revertedWithCustomError(v2, "InvalidVotingWindow");
    });

    it("finalizing is not allowed after the market's resolution window has closed", async function () {
      await time.increaseTo(end);
      await voting.connect(alice).vote(0);
      await time.increaseTo(await market.resolutionDeadline());
      await expect(voting.finalizeVoting()).to.be.revertedWithCustomError(voting, "ResolutionWindowClosed");
    });
  });
});

function anyUint() {
  return (v) => typeof v === "bigint";
}
