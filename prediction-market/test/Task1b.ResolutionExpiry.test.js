const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Task 1b — Phase 3 (oracle resolution) & Phase 5 (expiry / timeout).
// Covers the ORACLE group of Phase 7 plus the expiry-related trading and edge-case tests.

const Status = { Upcoming: 0n, Open: 1n, Closed: 2n, Resolved: 3n, Expired: 4n };
const Q = "Will ETH exceed $5,000 by 31 Dec 2026?";
const OUTCOMES = ["YES", "NO"];
const PRICE = ethers.parseEther("0.01"); // MarketHarness flat test price per share

describe("Task 1b: resolution (Phase 3) and expiry (Phase 5)", function () {
  let creator, arbitrator, alice, bob, carol, start, end;

  beforeEach(async function () {
    [creator, arbitrator, alice, bob, carol] = await ethers.getSigners();
    const now = await time.latest();
    start = now + 100;
    end = now + 10_000;
  });

  /** Market created through the real Factory (as in production). */
  async function factoryMarket(outcomes = OUTCOMES) {
    const factory = await (await ethers.getContractFactory("MarketFactory")).deploy();
    await factory.connect(creator).createMarket(Q, outcomes, start, end, arbitrator.address);
    return ethers.getContractAt("Market", (await factory.getMarkets())[0]);
  }

  /** Market with a stand-in buy() that uses the Phase 2 hooks, for refund tests. */
  async function harnessMarket() {
    return (await ethers.getContractFactory("MarketHarness")).deploy(
      creator.address, Q, OUTCOMES, start, end, arbitrator.address
    );
  }

  const buy = (m, who, outcome, shares) => m.connect(who).testBuy(outcome, shares, { value: PRICE * BigInt(shares) });

  // ───────────────────────────────────────────── Phase 3
  describe("resolveMarket() — Phase 3", function () {
    let market;
    beforeEach(async function () { market = await factoryMarket(); });

    it("stores the arbitrator assigned at creation (Task 1a)", async function () {
      expect(await market.arbitrator()).to.equal(arbitrator.address);
    });

    it("correct arbitrator can resolve after endTime: stores outcome, sets RESOLVED, emits MarketResolved", async function () {
      await time.increaseTo(end);
      await expect(market.connect(arbitrator).resolveMarket(1))
        .to.emit(market, "MarketResolved").withArgs(arbitrator.address, 1, "NO");
      expect(await market.resolved()).to.equal(true);
      expect(await market.winningOutcome()).to.equal(1);
      expect(await market.status()).to.equal(Status.Resolved);
    });

    it("can resolve exactly at endTime", async function () {
      await time.setNextBlockTimestamp(end);
      await expect(market.connect(arbitrator).resolveMarket(0)).to.emit(market, "MarketResolved");
    });

    it("wrong users cannot resolve (creator, trader)", async function () {
      await time.increaseTo(end);
      await expect(market.connect(creator).resolveMarket(0)).to.be.revertedWithCustomError(market, "NotArbitrator");
      await expect(market.connect(alice).resolveMarket(0)).to.be.revertedWithCustomError(market, "NotArbitrator");
      expect(await market.resolved()).to.equal(false);
    });

    it("cannot resolve before endTime (before start or while trading is open)", async function () {
      await expect(market.connect(arbitrator).resolveMarket(0)).to.be.revertedWithCustomError(market, "MarketNotEnded");
      await time.increaseTo(start);
      await expect(market.connect(arbitrator).resolveMarket(0)).to.be.revertedWithCustomError(market, "MarketNotEnded");
    });

    it("rejects an outcome index that does not exist", async function () {
      await time.increaseTo(end);
      await expect(market.connect(arbitrator).resolveMarket(2))
        .to.be.revertedWithCustomError(market, "InvalidOutcome").withArgs(2);
    });

    it("cannot resolve twice; the first outcome stands", async function () {
      await time.increaseTo(end);
      await market.connect(arbitrator).resolveMarket(0);
      await expect(market.connect(arbitrator).resolveMarket(1)).to.be.revertedWithCustomError(market, "AlreadyResolved");
      expect(await market.winningOutcome()).to.equal(0);
    });

    it("works for markets with more than two outcomes", async function () {
      const m3 = await factoryMarket(["A", "B", "C"]);
      await time.increaseTo(end);
      await expect(m3.connect(arbitrator).resolveMarket(2)).to.emit(m3, "MarketResolved").withArgs(arbitrator.address, 2, "C");
      await expect(m3.connect(arbitrator).resolveMarket(3)).to.be.revertedWithCustomError(m3, "AlreadyResolved");
    });

    it("cannot resolve once the resolution deadline has passed", async function () {
      await time.increaseTo(await market.resolutionDeadline());
      await expect(market.connect(arbitrator).resolveMarket(0)).to.be.revertedWithCustomError(market, "ResolutionWindowClosed");
    });

    it("market existence must be checked via the Factory registry, not by a revert", async function () {
      const factory = await (await ethers.getContractFactory("MarketFactory")).deploy();
      await factory.createMarket(Q, OUTCOMES, start, end, arbitrator.address);
      const registered = await factory.getMarkets();
      expect(registered).to.have.length(1);
      expect(await ethers.provider.getCode(registered[0])).to.not.equal("0x");

      // Finding: calling resolveMarket() on an address with no code (not a market)
      // does NOT revert — the EVM treats it as a successful no-op. So a frontend or
      // script must confirm the address is in factory.getMarkets() before using it.
      expect(registered).to.not.include(alice.address);
      expect(await ethers.provider.getCode(alice.address)).to.equal("0x");
      const fake = await ethers.getContractAt("Market", alice.address);
      await expect(fake.connect(arbitrator).resolveMarket(0)).to.not.be.reverted;
    });
  });

  // ───────────────────────────────────────────── lifecycle
  describe("status() lifecycle", function () {
    it("Upcoming → Open → Closed → Resolved", async function () {
      const m = await factoryMarket();
      expect(await m.status()).to.equal(Status.Upcoming);
      await time.increaseTo(start);
      expect(await m.status()).to.equal(Status.Open);
      await time.increaseTo(end);
      expect(await m.status()).to.equal(Status.Closed);
      await m.connect(arbitrator).resolveMarket(0);
      expect(await m.status()).to.equal(Status.Resolved);
    });

    it("Closed → Expired when nobody resolves by endTime + 7 days", async function () {
      const m = await factoryMarket();
      expect(await m.resolutionDeadline()).to.equal(BigInt(end) + 7n * 24n * 3600n);
      await time.increaseTo((await m.resolutionDeadline()) - 1n);
      expect(await m.status()).to.equal(Status.Closed);
      await time.increase(1);
      expect(await m.status()).to.equal(Status.Expired);
    });

    it("a resolved market never becomes Expired", async function () {
      const m = await factoryMarket();
      await time.increaseTo(end);
      await m.connect(arbitrator).resolveMarket(1);
      await time.increase(30 * 24 * 3600);
      expect(await m.status()).to.equal(Status.Resolved);
    });
  });

  // ───────────────────────────────────────────── Phase 5: trading window
  describe("trading window (hooks used by Phase 2)", function () {
    let m;
    beforeEach(async function () { m = await harnessMarket(); });

    it("rejects trades before startTime", async function () {
      await expect(buy(m, alice, 0, 1)).to.be.revertedWithCustomError(m, "TradingNotOpen").withArgs(Status.Upcoming);
    });

    it("accepts trades while open and records the collateral paid", async function () {
      await time.increaseTo(start);
      await buy(m, alice, 0, 3);
      expect(await m.collateralPaid(alice.address)).to.equal(PRICE * 3n);
      const token = await ethers.getContractAt("OutcomeToken", await m.outcomeToken());
      expect(await token.balanceOf(alice.address, 0)).to.equal(3);
    });

    it("rejects trades after expiry of the trading window (endTime)", async function () {
      await time.increaseTo(end);
      await expect(buy(m, alice, 0, 1)).to.be.revertedWithCustomError(m, "TradingNotOpen").withArgs(Status.Closed);
    });

    it("rejects trades after resolution", async function () {
      await time.increaseTo(end);
      await m.connect(arbitrator).resolveMarket(0);
      await expect(buy(m, alice, 0, 1)).to.be.revertedWithCustomError(m, "TradingNotOpen").withArgs(Status.Resolved);
    });

    it("rejects trades in an expired market", async function () {
      await time.increaseTo(await m.resolutionDeadline());
      await expect(buy(m, alice, 0, 1)).to.be.revertedWithCustomError(m, "TradingNotOpen").withArgs(Status.Expired);
    });
  });

  // ───────────────────────────────────────────── Phase 5: expiry & refunds
  describe("expired unresolved market — refunds", function () {
    let m, token;
    beforeEach(async function () {
      m = await harnessMarket();
      token = await ethers.getContractAt("OutcomeToken", await m.outcomeToken());
      await time.increaseTo(start);
      await buy(m, alice, 0, 5);  // 0.05 ETH on YES
      await buy(m, bob, 1, 2);    // 0.02 ETH on NO
      await buy(m, alice, 1, 1);  // 0.01 ETH on NO
    });

    it("markExpired() only after the deadline, only once, and not on resolved markets", async function () {
      await time.increaseTo(end);
      await expect(m.markExpired()).to.be.revertedWithCustomError(m, "NotExpired");
      await time.increaseTo(await m.resolutionDeadline());
      await expect(m.connect(carol).markExpired()).to.emit(m, "MarketExpired");
      expect(await m.expired()).to.equal(true);
      await expect(m.markExpired()).to.be.revertedWithCustomError(m, "AlreadyExpired");

      const now = await time.latest();
      const r = await (await ethers.getContractFactory("MarketHarness")).deploy(
        creator.address, Q, OUTCOMES, now + 10, now + 100, arbitrator.address
      );
      await time.increaseTo(now + 100);
      await r.connect(arbitrator).resolveMarket(0);
      await expect(r.markExpired()).to.be.revertedWithCustomError(r, "AlreadyResolved");
    });

    it("no refunds before expiry or after a normal resolution", async function () {
      await expect(m.connect(alice).claimRefund()).to.be.revertedWithCustomError(m, "NotExpired");
      await time.increaseTo(end);
      await m.connect(arbitrator).resolveMarket(0);
      await time.increase(30 * 24 * 3600);
      await expect(m.connect(alice).claimRefund()).to.be.revertedWithCustomError(m, "NotExpired");
    });

    it("arbitrator can no longer resolve after expiry", async function () {
      await time.increaseTo(await m.resolutionDeadline());
      await expect(m.connect(arbitrator).resolveMarket(0)).to.be.revertedWithCustomError(m, "ResolutionWindowClosed");
    });

    it("every trader gets back exactly what they paid; shares are burned; contract ends empty", async function () {
      await time.increaseTo(await m.resolutionDeadline());
      const addr = await m.getAddress();
      expect(await ethers.provider.getBalance(addr)).to.equal(PRICE * 8n);

      await expect(m.connect(alice).claimRefund()).to.changeEtherBalances([alice, m], [PRICE * 6n, -PRICE * 6n]);
      await expect(m.connect(bob).claimRefund()).to.changeEtherBalances([bob, m], [PRICE * 2n, -PRICE * 2n]);

      for (const who of [alice, bob]) {
        expect(await m.collateralPaid(who.address)).to.equal(0);
        expect(await token.balanceOf(who.address, 0)).to.equal(0);
        expect(await token.balanceOf(who.address, 1)).to.equal(0);
      }
      expect(await ethers.provider.getBalance(addr)).to.equal(0);
    });

    it("first refund marks the market expired automatically and emits Refunded", async function () {
      await time.increaseTo(await m.resolutionDeadline());
      await expect(m.connect(bob).claimRefund())
        .to.emit(m, "MarketExpired")
        .and.to.emit(m, "Refunded").withArgs(bob.address, PRICE * 2n);
      expect(await m.expired()).to.equal(true);
    });

    it("double refund is rejected; non-traders have nothing to refund", async function () {
      await time.increaseTo(await m.resolutionDeadline());
      await m.connect(bob).claimRefund();
      await expect(m.connect(bob).claimRefund()).to.be.revertedWithCustomError(m, "NothingToRefund");
      await expect(m.connect(carol).claimRefund()).to.be.revertedWithCustomError(m, "NothingToRefund");
    });

    it("contract balance always equals total unrefunded collateral", async function () {
      const addr = await m.getAddress();
      const total = async () => (await m.collateralPaid(alice.address)) + (await m.collateralPaid(bob.address));
      expect(await ethers.provider.getBalance(addr)).to.equal(await total());
      await time.increaseTo(await m.resolutionDeadline());
      await m.connect(alice).claimRefund();
      expect(await ethers.provider.getBalance(addr)).to.equal(await total());
    });

    it("re-entering claimRefund() from inside the refund is blocked", async function () {
      const Attacker = await ethers.getContractFactory("RefundReentrancyAttacker");
      const atk = await Attacker.deploy(await m.getAddress());
      await atk.buy(0, 4, { value: PRICE * 4n });
      await time.increaseTo(await m.resolutionDeadline());

      await expect(atk.attack()).to.changeEtherBalance(atk, PRICE * 4n);
      expect(await atk.reentryAttempts()).to.equal(1);
      expect(await atk.reentrySucceeded()).to.equal(false);
      // Other traders' money is untouched
      expect(await ethers.provider.getBalance(await m.getAddress())).to.equal(PRICE * 8n);
    });
  });
});
