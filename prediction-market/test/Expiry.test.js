const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const eth = (n) => ethers.parseEther(String(n));
const Status = { Upcoming: 0n, Open: 1n, Closed: 2n, Resolved: 3n, Expired: 4n };
const WEEK = 7n * 24n * 3600n;

describe("Phase 5: expiry and timeout", function () {
  let factory, market, token, creator, arbitrator, alice, bob, carol, dave, start, end, marketAddr;
  const SEED = eth(10);

  async function deploy(outcomes = ["YES", "NO"]) {
    [creator, arbitrator, alice, bob, carol, dave] = await ethers.getSigners();
    factory = await (await ethers.getContractFactory("MarketFactory")).deploy();
    const now = await time.latest();
    start = now + 100;
    end = now + 100_000;
    await factory.createMarket("Will it happen?", outcomes, start, end, arbitrator.address);
    marketAddr = (await factory.getMarkets())[0];
    market = await ethers.getContractAt("Market", marketAddr);
    token = await ethers.getContractAt("OutcomeToken", await market.outcomeToken());
  }

  /** Seed 10 ETH; Alice buys YES twice (1 + 0.5), Bob buys NO (2), Carol buys YES (0.5). */
  async function seedAndTrade() {
    await market.connect(creator).seedLiquidity({ value: SEED });
    await time.increaseTo(start + 1);
    await market.connect(alice).buyOutcomeTokens(0, 0, { value: eth(1) });
    await market.connect(bob).buyOutcomeTokens(1, 0, { value: eth(2) });
    await market.connect(carol).buyOutcomeTokens(0, 0, { value: eth(0.5) });
    await market.connect(alice).buyOutcomeTokens(0, 0, { value: eth(0.5) });
  }

  const toDeadline = async () => time.increaseTo(await market.resolutionDeadline());
  const bal = (who, id) => token.balanceOf(who.address, id);
  const ethBal = (addr) => ethers.provider.getBalance(addr);

  beforeEach(async function () {
    await deploy();
  });

  // ───────────────────────── lifecycle ─────────────────────────
  describe("status() lifecycle", function () {
    it("resolution deadline is endTime + 7 days", async function () {
      expect(await market.resolutionDeadline()).to.equal(BigInt(end) + WEEK);
    });

    it("Upcoming → Open → Closed → Resolved", async function () {
      expect(await market.status()).to.equal(Status.Upcoming);
      await time.increaseTo(start);
      expect(await market.status()).to.equal(Status.Open);
      await time.increaseTo(end);
      expect(await market.status()).to.equal(Status.Closed);
      await market.connect(arbitrator).resolve(0);
      expect(await market.status()).to.equal(Status.Resolved);
    });

    it("Closed → Expired exactly at the deadline when nobody resolves", async function () {
      await time.increaseTo((await market.resolutionDeadline()) - 1n);
      expect(await market.status()).to.equal(Status.Closed);
      await time.increase(1);
      expect(await market.status()).to.equal(Status.Expired);
    });

    it("a resolved market never becomes Expired", async function () {
      await time.increaseTo(end);
      await market.connect(arbitrator).resolve(1);
      await time.increase(30n * 24n * 3600n);
      expect(await market.status()).to.equal(Status.Resolved);
    });
  });

  // ───────────────────────── resolution window ─────────────────────────
  describe("resolution deadline", function () {
    it("arbitrator can still resolve one second before the deadline", async function () {
      await time.setNextBlockTimestamp((await market.resolutionDeadline()) - 1n);
      await expect(market.connect(arbitrator).resolve(0)).to.emit(market, "MarketResolved");
    });

    it("arbitrator cannot resolve at or after the deadline", async function () {
      await toDeadline();
      await expect(market.connect(arbitrator).resolve(0)).to.be.revertedWithCustomError(market, "ResolutionWindowClosed");
      expect(await market.resolved()).to.equal(false);
    });

    it("the arbitrator check still comes first after expiry", async function () {
      await toDeadline();
      await expect(market.connect(alice).resolve(0)).to.be.revertedWithCustomError(market, "NotArbitrator");
    });
  });

  // ───────────────────────── trading after expiry ─────────────────────────
  describe("no trading after endTime or expiry", function () {
    beforeEach(seedAndTrade);

    it("buying after endTime is rejected", async function () {
      await time.increaseTo(end);
      await expect(market.connect(dave).buyOutcomeTokens(0, 0, { value: eth(1) }))
        .to.be.revertedWithCustomError(market, "MarketExpired");
    });

    it("buying in an expired market is rejected", async function () {
      await toDeadline();
      await market.markExpired();
      await expect(market.connect(dave).buyOutcomeTokens(1, 0, { value: eth(1) }))
        .to.be.revertedWithCustomError(market, "MarketExpired");
    });

    it("an expired market cannot be redeemed as if resolved", async function () {
      await toDeadline();
      await expect(market.connect(alice).claimPayout()).to.be.revertedWithCustomError(market, "NotResolved");
      await expect(market.connect(alice).redeem(1)).to.be.revertedWithCustomError(market, "NotResolved");
    });
  });

  // ───────────────────────── collateral tracking ─────────────────────────
  describe("collateral tracking", function () {
    beforeEach(seedAndTrade);

    it("records the creator's seed and every trader's ETH", async function () {
      expect(await market.collateralPaid(creator.address)).to.equal(SEED);
      expect(await market.collateralPaid(alice.address)).to.equal(eth(1.5));
      expect(await market.collateralPaid(bob.address)).to.equal(eth(2));
      expect(await market.collateralPaid(carol.address)).to.equal(eth(0.5));
      expect(await market.collateralPaid(dave.address)).to.equal(0);
    });

    it("contract balance equals the total recorded collateral", async function () {
      expect(await ethBal(marketAddr)).to.equal(SEED + eth(4));
    });
  });

  // ───────────────────────── markExpired ─────────────────────────
  describe("markExpired()", function () {
    beforeEach(seedAndTrade);

    it("cannot be called before the deadline", async function () {
      await time.increaseTo(end);
      await expect(market.markExpired()).to.be.revertedWithCustomError(market, "NotExpired");
    });

    it("anyone can call it after the deadline; emits MarketTimedOut", async function () {
      await toDeadline();
      await expect(market.connect(dave).markExpired()).to.emit(market, "MarketTimedOut");
      expect(await market.expired()).to.equal(true);
      expect(await market.status()).to.equal(Status.Expired);
    });

    it("cannot be called twice", async function () {
      await toDeadline();
      await market.markExpired();
      await expect(market.markExpired()).to.be.revertedWithCustomError(market, "AlreadyExpired");
    });

    it("cannot expire a resolved market", async function () {
      await time.increaseTo(end);
      await market.connect(arbitrator).resolve(0);
      await time.increase(WEEK);
      await expect(market.markExpired()).to.be.revertedWithCustomError(market, "AlreadyResolved");
    });
  });

  // ───────────────────────── refunds ─────────────────────────
  describe("claimRefund()", function () {
    beforeEach(seedAndTrade);

    it("is not allowed before expiry", async function () {
      await time.increaseTo(end);
      await expect(market.connect(alice).claimRefund()).to.be.revertedWithCustomError(market, "NotExpired");
    });

    it("is not allowed in a resolved market, even much later", async function () {
      await time.increaseTo(end);
      await market.connect(arbitrator).resolve(0);
      await time.increase(30n * 24n * 3600n);
      await expect(market.connect(alice).claimRefund()).to.be.revertedWithCustomError(market, "NotExpired");
    });

    it("first refund marks the market expired and emits MarketTimedOut + Refunded", async function () {
      await toDeadline();
      await expect(market.connect(bob).claimRefund())
        .to.emit(market, "MarketTimedOut")
        .and.to.emit(market, "Refunded").withArgs(bob.address, eth(2));
      expect(await market.expired()).to.equal(true);
    });

    it("every trader gets back exactly what they paid", async function () {
      await toDeadline();
      await expect(market.connect(alice).claimRefund()).to.changeEtherBalances([alice, market], [eth(1.5), -eth(1.5)]);
      await expect(market.connect(bob).claimRefund()).to.changeEtherBalances([bob, market], [eth(2), -eth(2)]);
      await expect(market.connect(carol).claimRefund()).to.changeEtherBalances([carol, market], [eth(0.5), -eth(0.5)]);
    });

    it("the creator gets the seed back", async function () {
      await toDeadline();
      await expect(market.connect(creator).claimRefund()).to.changeEtherBalances([creator, market], [SEED, -SEED]);
    });

    it("after everyone is refunded the contract is empty", async function () {
      await toDeadline();
      for (const who of [alice, bob, carol, creator]) await market.connect(who).claimRefund();
      expect(await ethBal(marketAddr)).to.equal(0);
    });

    it("burns the refunded trader's shares of every outcome", async function () {
      await toDeadline();
      expect(await bal(alice, 0)).to.be.gt(0);
      await market.connect(alice).claimRefund();
      expect(await bal(alice, 0)).to.equal(0);
      expect(await bal(alice, 1)).to.equal(0);
      expect(await market.collateralPaid(alice.address)).to.equal(0);
    });

    it("double refund is rejected", async function () {
      await toDeadline();
      await market.connect(bob).claimRefund();
      await expect(market.connect(bob).claimRefund()).to.be.revertedWithCustomError(market, "NothingToRefund");
    });

    it("an account that never paid has nothing to refund", async function () {
      await toDeadline();
      await expect(market.connect(dave).claimRefund()).to.be.revertedWithCustomError(market, "NothingToRefund");
    });

    it("refunds go to the payer, not to whoever holds transferred shares (known limitation)", async function () {
      const shares = await bal(alice, 0);
      await token.connect(alice).safeTransferFrom(alice.address, dave.address, 0, shares, "0x");
      await toDeadline();
      await expect(market.connect(dave).claimRefund()).to.be.revertedWithCustomError(market, "NothingToRefund");
      await expect(market.connect(alice).claimRefund()).to.changeEtherBalance(alice, eth(1.5));
    });
  });

  // ───────────────────────── 3-outcome market ─────────────────────────
  describe("3-outcome market", function () {
    it("refunds and burns across all three outcomes", async function () {
      await deploy(["A", "B", "C"]);
      await market.connect(creator).seedLiquidity({ value: SEED });
      await time.increaseTo(start + 1);
      await market.connect(alice).buyOutcomeTokens(0, 0, { value: eth(1) });
      await market.connect(alice).buyOutcomeTokens(2, 0, { value: eth(1) });
      await toDeadline();
      await expect(market.connect(alice).claimRefund()).to.changeEtherBalance(alice, eth(2));
      for (const id of [0, 1, 2]) expect(await bal(alice, id)).to.equal(0);
    });
  });

  // ───────────────────────── attacks on the refund path ─────────────────────────
  describe("ETH transfer failure and reentrancy", function () {
    let attacker, attackerAddr;
    beforeEach(async function () {
      await market.connect(creator).seedLiquidity({ value: SEED });
      await time.increaseTo(start + 1);
      await market.connect(alice).buyOutcomeTokens(1, 0, { value: eth(1) });
      attacker = await (await ethers.getContractFactory("ReentrantRefunder")).deploy();
      attackerAddr = await attacker.getAddress();
      await attacker.buy(marketAddr, 0, { value: eth(3) });
      await toDeadline();
    });

    it("re-entering claimRefund() from inside the refund is blocked; it is paid exactly once", async function () {
      await attacker.setMode(2); // Reenter
      await expect(attacker.refund()).to.changeEtherBalance(attacker, eth(3));
      expect(await attacker.reentryAttempted()).to.equal(true);
      expect(await attacker.reentrySucceeded()).to.equal(false);
      expect(await ethBal(marketAddr)).to.equal(SEED + eth(1)); // others untouched
    });

    it("a recipient that rejects ETH makes the refund revert; nothing is burned or cleared", async function () {
      await attacker.setMode(1); // RejectEther
      const before = await token.balanceOf(attackerAddr, 0);
      await expect(attacker.refund()).to.be.revertedWithCustomError(market, "TransferFailed");
      expect(await token.balanceOf(attackerAddr, 0)).to.equal(before);
      expect(await market.collateralPaid(attackerAddr)).to.equal(eth(3));
    });
  });
});
