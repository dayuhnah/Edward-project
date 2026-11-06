
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Bonus 3: Reputation Weighted Voting", function () {
  let admin, alice, bob, charlie;
  let factory, market, voting;
  let start, end;

  beforeEach(async function () {
    [admin, alice, bob, charlie] = await ethers.getSigners();

    // Deploy voting contract
    const Voting = await ethers.getContractFactory(
      "ReputationWeightedVoting"
    );
    voting = await Voting.deploy();
    await voting.waitForDeployment();

    // Deploy market factory
    const Factory = await ethers.getContractFactory(
      "MarketFactory"
    );
    factory = await Factory.deploy();
    await factory.waitForDeployment();

    const now = await time.latest();
    start = now + 100;
    end = now + 1000;

    // Create market with voting contract as arbitrator
    await factory.createMarket(
      "Will ETH reach $5000?",
      ["YES", "NO"],
      start,
      end,
      await voting.getAddress()
    );

    const addresses = await factory.getMarkets();
    market = await ethers.getContractAt(
      "Market",
      addresses[0]
    );

    // Voting closes 300 seconds after market end
    await voting.initializeMarket(
      addresses[0],
      300
    );

    // Assign reputation
    await voting.setReputation(alice.address, 5);
    await voting.setReputation(bob.address, 2);
    await voting.setReputation(charlie.address, 3);
  });

  it("Assigns reputation correctly", async function () {
    expect(await voting.reputation(alice.address)).to.equal(5n);
    expect(await voting.reputation(bob.address)).to.equal(2n);
    expect(await voting.reputation(charlie.address)).to.equal(3n);
  });

  it("Rejects votes before voting starts", async function () {
    await expect(
      voting.connect(alice).vote(0)
    ).to.be.revertedWithCustomError(
      voting,
      "VotingNotStarted"
    );
  });

  it("Allows reputation-weighted voting", async function () {
    await time.increaseTo(end + 1);

    await voting.connect(alice).vote(0);
    await voting.connect(bob).vote(1);
    await voting.connect(charlie).vote(0);

    const totals = await voting.getVoteTotals();

    expect(totals[0]).to.equal(8n);
    expect(totals[1]).to.equal(2n);
    expect(await voting.totalWeightCast()).to.equal(10n);
  });

  it("Prevents double voting", async function () {
    await time.increaseTo(end + 1);

    await voting.connect(alice).vote(0);

    await expect(
      voting.connect(alice).vote(1)
    ).to.be.revertedWithCustomError(
      voting,
      "AlreadyVoted"
    );
  });

  it("Rejects voters without reputation", async function () {
    const [, , , , outsider] = await ethers.getSigners();

    await time.increaseTo(end + 1);

    await expect(
      voting.connect(outsider).vote(0)
    ).to.be.revertedWithCustomError(
      voting,
      "NotEligible"
    );
  });

  it("Rejects voting after the deadline", async function () {
    await time.increaseTo(end + 300);

    await expect(
      voting.connect(alice).vote(0)
    ).to.be.revertedWithCustomError(
      voting,
      "VotingClosed"
    );
  });

  it("Finalizes the winning outcome", async function () {
    await time.increaseTo(end + 1);

    await voting.connect(alice).vote(0);
    await voting.connect(bob).vote(1);
    await voting.connect(charlie).vote(0);

    await time.increaseTo(end + 300);

    await voting.finalizeVoting();

    expect(await voting.finalized()).to.equal(true);
    expect(await voting.winningOutcome()).to.equal(0n);

    // Existing market should also be resolved
    expect(await market.resolved()).to.equal(true);
    expect(await market.winningOutcome()).to.equal(0n);
  });

  it("Prevents finalizing voting twice", async function () {
    await time.increaseTo(end + 1);

    await voting.connect(alice).vote(0);

    await time.increaseTo(end + 300);

    await voting.finalizeVoting();

    await expect(
      voting.finalizeVoting()
    ).to.be.revertedWithCustomError(
      voting,
      "AlreadyFinalized"
    );
  });

  it("Rejects finalization when votes are tied", async function () {
    // Assign equal voting power before voting starts
    await voting.setReputation(alice.address, 2);

    await time.increaseTo(end + 1);

    await voting.connect(alice).vote(0);
    await voting.connect(bob).vote(1);

    await time.increaseTo(end + 300);

    await expect(
      voting.finalizeVoting()
    ).to.be.revertedWithCustomError(
      voting,
      "VotingTied"
    );

    expect(await market.resolved()).to.equal(false);
  });

  it("Rejects finalization with no votes", async function () {
    await time.increaseTo(end + 300);

    await expect(
      voting.finalizeVoting()
    ).to.be.revertedWithCustomError(
      voting,
      "NoVotes"
    );
  });
});


var deadline = Number(await voting.votingDeadline());
var currentTime = (await ethers.provider.getBlock("latest")).timestamp;

console.log("Deadline:", deadline);
console.log("Current time:", currentTime);

if (currentTime < deadline) {
  await ethers.provider.send(
    "evm_setNextBlockTimestamp",
    [deadline]
  );
  await ethers.provider.send("evm_mine", []);
}

var finalizeTx = await voting.finalizeVoting();

await finalizeTx.wait();

await voting.finalized();

await voting.winningOutcome();

await market.resolved();

await market.status();
