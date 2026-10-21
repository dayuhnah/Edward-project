const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const eth = (n) => ethers.parseEther(String(n));

describe("Phase 4: resolution and payout", function () {
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

  /** Seed, let Alice+Carol buy YES(0) and Bob buy NO(1), then move past the end time. */
  async function tradeAndEnd() {
    await market.connect(creator).seedLiquidity({ value: SEED });
    await time.increaseTo(start + 1);
    await market.connect(alice).buyOutcomeTokens(0, 0, { value: eth(1) });
    await market.connect(bob).buyOutcomeTokens(1, 0, { value: eth(2) });
    await market.connect(carol).buyOutcomeTokens(0, 0, { value: eth(0.5) });
    await time.increaseTo(end);
  }

  const bal = (who, id) => token.balanceOf(who.address, id);
  const ethBal = (addr) => ethers.provider.getBalance(addr);

  beforeEach(async function () {
    await deploy();
  });

  // ───────────────────────── resolve() ─────────────────────────
  describe("resolve (identify the winning outcome)", function () {
    beforeEach(tradeAndEnd);

    it("only the arbitrator can resolve", async function () {
      await expect(market.connect(creator).resolve(0)).to.be.revertedWithCustomError(market, "NotArbitrator");
      await expect(market.connect(alice).resolve(0)).to.be.revertedWithCustomError(market, "NotArbitrator");
    });
    it("cannot resolve before the end time", async function () {
      await deploy();
      await market.connect(creator).seedLiquidity({ value: SEED });
      await expect(market.connect(arbitrator).resolve(0)).to.be.revertedWithCustomError(market, "MarketNotEnded");
    });
    it("rejects an invalid winning outcome", async function () {
      await expect(market.connect(arbitrator).resolve(2)).to.be.revertedWithCustomError(market, "InvalidOutcome").withArgs(2);
    });
    it("records the winner and emits MarketResolved", async function () {
      await expect(market.connect(arbitrator).resolve(1))
        .to.emit(market, "MarketResolved").withArgs(1, arbitrator.address);
      expect(await market.resolved()).to.equal(true);
      expect(await market.winningOutcome()).to.equal(1);
    });
    it("cannot be resolved twice, even with a different outcome", async function () {
      await market.connect(arbitrator).resolve(0);
      await expect(market.connect(arbitrator).resolve(0)).to.be.revertedWithCustomError(market, "AlreadyResolved");
      await expect(market.connect(arbitrator).resolve(1)).to.be.revertedWithCustomError(market, "AlreadyResolved");
      expect(await market.winningOutcome()).to.equal(0);
    });
    it("closes trading: buying after resolution reverts with MarketClosed", async function () {
      await market.connect(arbitrator).resolve(0);
      await expect(market.connect(alice).buyOutcomeTokens(0, 0, { value: eth(1) }))
        .to.be.revertedWithCustomError(market, "MarketClosed");
    });
    it("closes seeding: an unseeded market cannot be seeded after resolution", async function () {
      await deploy();
      await time.increaseTo(end);
      await market.connect(arbitrator).resolve(0);
      await expect(market.connect(creator).seedLiquidity({ value: SEED })).to.be.revertedWithCustomError(market, "MarketClosed");
    });
  });

  // ───────────────────────── payout formula ─────────────────────────
  describe("payout formula", function () {
    it("pays exactly 1 wei per winning share", async function () {
      expect(await market.PAYOUT_PER_SHARE()).to.equal(1n);
      for (const n of [0n, 1n, 12345n, eth(1), eth(1000)]) {
        expect(await market.calcPayout(n)).to.equal(n);
      }
    });
    it("getPayout is 0 before resolution", async function () {
      await tradeAndEnd();
      expect(await market.getPayout(alice.address)).to.equal(0);
    });
    it("getPayout equals winning balance after resolution; losers and outsiders get 0", async function () {
      await tradeAndEnd();
      await market.connect(arbitrator).resolve(0);
      expect(await market.getPayout(alice.address)).to.equal(await bal(alice, 0));
      expect(await market.getPayout(carol.address)).to.equal(await bal(carol, 0));
      expect(await market.getPayout(bob.address)).to.equal(0); // holds only losing NO shares
      expect(await market.getPayout(dave.address)).to.equal(0);
    });
  });

  // ───────────────────────── redeem / claimPayout ─────────────────────────
  describe("redeem and claimPayout", function () {
    beforeEach(tradeAndEnd);

    it("reverts before the market is resolved", async function () {
      const s = await bal(alice, 0);
      await expect(market.connect(alice).redeem(s)).to.be.revertedWithCustomError(market, "NotResolved");
      await expect(market.connect(alice).claimPayout()).to.be.revertedWithCustomError(market, "NotResolved");
    });

    describe("after resolution (outcome 0 = YES wins)", function () {
      beforeEach(async function () {
        await market.connect(arbitrator).resolve(0);
      });

      it("claimPayout burns all winning shares, pays 1 wei each, and emits Redeemed", async function () {
        const shares = await bal(alice, 0);
        await expect(market.connect(alice).claimPayout())
          .to.emit(market, "Redeemed").withArgs(alice.address, 0, shares, shares);
        expect(await bal(alice, 0)).to.equal(0);
      });

      it("moves ETH from the Market to the redeemer exactly equal to the shares burned", async function () {
        const shares = await bal(alice, 0);
        await expect(market.connect(alice).claimPayout()).to.changeEtherBalances([market, alice], [-shares, shares]);
      });

      it("redeem pays for a partial amount and leaves the rest claimable", async function () {
        const all = await bal(alice, 0);
        const half = all / 2n;
        await expect(market.connect(alice).redeem(half))
          .to.emit(market, "Redeemed").withArgs(alice.address, 0, half, half);
        expect(await bal(alice, 0)).to.equal(all - half);

        await expect(market.connect(alice).claimPayout())
          .to.emit(market, "Redeemed").withArgs(alice.address, 0, all - half, all - half);
        expect(await bal(alice, 0)).to.equal(0);
      });

      it("also emits the OutcomeToken SharesBurned and ERC-1155 TransferSingle (burn) events", async function () {
        const shares = await bal(alice, 0);
        const tx = market.connect(alice).claimPayout();
        await expect(tx).to.emit(token, "SharesBurned").withArgs(alice.address, 0, shares);
        await expect(tx).to.emit(token, "TransferSingle").withArgs(marketAddr, alice.address, ethers.ZeroAddress, 0, shares);
      });

      it("redeem(0) is rejected", async function () {
        await expect(market.connect(alice).redeem(0)).to.be.revertedWithCustomError(market, "ZeroAmount");
      });

      it("cannot redeem more than the user's winning balance", async function () {
        const b = await bal(alice, 0);
        await expect(market.connect(alice).redeem(b + 1n))
          .to.be.revertedWithCustomError(market, "InsufficientShares").withArgs(b, b + 1n);
      });

      it("prevents double claiming: a second claim finds nothing to redeem", async function () {
        await market.connect(alice).claimPayout();
        await expect(market.connect(alice).claimPayout()).to.be.revertedWithCustomError(market, "NothingToRedeem");
        await expect(market.connect(alice).redeem(1)).to.be.revertedWithCustomError(market, "InsufficientShares").withArgs(0, 1);
      });

      it("a losing holder cannot redeem and keeps their losing shares untouched", async function () {
        const noShares = await bal(bob, 1);
        expect(noShares).to.be.greaterThan(0n);
        await expect(market.connect(bob).claimPayout()).to.be.revertedWithCustomError(market, "NothingToRedeem");
        await expect(market.connect(bob).redeem(noShares)).to.be.revertedWithCustomError(market, "InsufficientShares").withArgs(0, noShares);
        expect(await bal(bob, 1)).to.equal(noShares);
      });

      it("an account with no shares cannot redeem", async function () {
        await expect(market.connect(dave).claimPayout()).to.be.revertedWithCustomError(market, "NothingToRedeem");
      });

      it("transferred shares can be redeemed once, by whoever holds them", async function () {
        const total = await bal(alice, 0);
        const sent = total / 2n;
        await token.connect(alice).safeTransferFrom(alice.address, dave.address, 0, sent, "0x");

        // Alice can only redeem what she still holds, never the transferred half.
        await expect(market.connect(alice).redeem(total))
          .to.be.revertedWithCustomError(market, "InsufficientShares").withArgs(total - sent, total);
        await market.connect(alice).claimPayout();
        await expect(market.connect(dave).claimPayout()).to.changeEtherBalances([dave], [sent]);
        await expect(market.connect(dave).claimPayout()).to.be.revertedWithCustomError(market, "NothingToRedeem");
      });

      it("total paid to all winners equals the winning shares they held, no more", async function () {
        const aliceShares = await bal(alice, 0);
        const carolShares = await bal(carol, 0);
        const before = await ethBal(marketAddr);
        await market.connect(alice).claimPayout();
        await market.connect(carol).claimPayout();
        expect(before - (await ethBal(marketAddr))).to.equal(aliceShares + carolShares);
      });

      it("solvency: after every winner redeems, the Market keeps exactly the pool's winning reserve", async function () {
        const reserveWinner = (await market.getReserves())[0];
        await market.connect(alice).claimPayout();
        await market.connect(carol).claimPayout();
        expect(await ethBal(marketAddr)).to.equal(reserveWinner);
      });

      it("solvency holds before any claim: collateral covers all winning shares plus the pool reserve", async function () {
        const winners = (await bal(alice, 0)) + (await bal(carol, 0));
        const reserveWinner = (await market.getReserves())[0];
        expect(await ethBal(marketAddr)).to.equal(winners + reserveWinner);
      });
    });

    it("the other outcome can win: NO holders are paid and YES holders are not", async function () {
      await market.connect(arbitrator).resolve(1);
      const bobShares = await bal(bob, 1);
      await expect(market.connect(bob).claimPayout()).to.changeEtherBalances([bob], [bobShares]);
      await expect(market.connect(alice).claimPayout()).to.be.revertedWithCustomError(market, "NothingToRedeem");
    });

    it("rejects direct burning: users cannot bypass redeem to burn winning shares", async function () {
      await market.connect(arbitrator).resolve(0);
      await expect(token.connect(alice).burn(alice.address, 0, 1)).to.be.revertedWithCustomError(token, "NotMarket");
    });
  });

  // ───────────────────────── 3 outcomes ─────────────────────────
  describe("3-outcome market", function () {
    it("pays holders of the winning third outcome only", async function () {
      await deploy(["A", "B", "C"]);
      await market.connect(creator).seedLiquidity({ value: SEED });
      await time.increaseTo(start + 1);
      await market.connect(alice).buyOutcomeTokens(2, 0, { value: eth(1) });
      await market.connect(bob).buyOutcomeTokens(0, 0, { value: eth(1) });
      await time.increaseTo(end);
      await market.connect(arbitrator).resolve(2);

      const shares = await bal(alice, 2);
      await expect(market.connect(alice).claimPayout()).to.changeEtherBalances([alice], [shares]);
      await expect(market.connect(bob).claimPayout()).to.be.revertedWithCustomError(market, "NothingToRedeem");
    });
  });

  // ───────────────────────── failure and attack cases ─────────────────────────
  describe("ETH transfer failure and reentrancy", function () {
    let attacker, attackerAddr;
    beforeEach(async function () {
      await market.connect(creator).seedLiquidity({ value: SEED });
      await time.increaseTo(start + 1);
      attacker = await (await ethers.getContractFactory("ReentrantRedeemer")).deploy();
      attackerAddr = await attacker.getAddress();
      await attacker.connect(alice).buy(marketAddr, 0, { value: eth(1) });
      await time.increaseTo(end);
      await market.connect(arbitrator).resolve(0);
    });

    it("a recipient that rejects ETH makes the claim revert and the shares are NOT burned", async function () {
      const shares = await token.balanceOf(attackerAddr, 0);
      await attacker.setMode(1); // RejectEther
      await expect(attacker.claim()).to.be.revertedWithCustomError(market, "TransferFailed");
      expect(await token.balanceOf(attackerAddr, 0)).to.equal(shares); // burn rolled back
    });

    it("the reentrancy guard blocks re-entry even while the attacker still holds winning shares", async function () {
      // A partial redeem leaves shares behind, so burn-before-pay alone would NOT stop a
      // second redeem(1). Only the nonReentrant guard does.
      const shares = await token.balanceOf(attackerAddr, 0);
      const half = shares / 2n;
      await attacker.setMode(2); // Reenter

      await attacker.redeem(half);

      expect(await attacker.reentryAttempted()).to.equal(true);
      expect(await attacker.reentryBlocked()).to.equal(true);
      expect(await attacker.reentrySucceeded()).to.equal(false);
      expect(await token.balanceOf(attackerAddr, 0)).to.equal(shares - half);
      expect(await ethBal(attackerAddr)).to.equal(half);
    });

    it("pays exactly once when re-entering during a full claim (burn-before-pay)", async function () {
      const shares = await token.balanceOf(attackerAddr, 0);
      await attacker.setMode(2); // Reenter
      const marketBefore = await ethBal(marketAddr);

      await attacker.claim();

      expect(await attacker.reentryAttempted()).to.equal(true);
      expect(await attacker.reentryBlocked()).to.equal(true);
      expect(await attacker.reentrySucceeded()).to.equal(false);
      expect(await token.balanceOf(attackerAddr, 0)).to.equal(0);
      expect(await ethBal(attackerAddr)).to.equal(shares); // paid once, 1 wei per share
      expect(marketBefore - (await ethBal(marketAddr))).to.equal(shares);
    });
  });
});