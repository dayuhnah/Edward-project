const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Phase 6 (security checks) and Phase 7 (unit tests).
// Each describe/it name matches an item on the 1b checklist in Notion.

const eth = (n) => ethers.parseEther(String(n));
const WEEK = 7n * 24n * 3600n;

/** Small deterministic random generator so failures can be reproduced. */
function rng(seed) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}

/** Exact (unrounded) constant-product buy, as a fraction: tokens = r_i + v - r_i * prod(r_j / (r_j + v)). */
function exactTokensFloor(reserves, i, v) {
  let num = reserves[i];
  let den = 1n;
  for (let j = 0; j < reserves.length; j++) {
    if (j === i) continue;
    num *= reserves[j];
    den *= reserves[j] + v;
  }
  // tokens = r_i + v - num/den  ->  floor(tokens) = r_i + v - ceil(num/den)
  const ceil = (num + den - 1n) / den;
  return reserves[i] + v - ceil;
}

describe("Phase 6 & 7: security checks and unit tests", function () {
  let factory, market, token, creator, arbitrator, alice, bob, carol, dave, start, end, marketAddr;
  const SEED = eth(10);

  async function deploy(outcomes = ["YES", "NO"], seed = SEED) {
    [creator, arbitrator, alice, bob, carol, dave] = await ethers.getSigners();
    factory = await (await ethers.getContractFactory("MarketFactory")).deploy();
    const now = await time.latest();
    start = now + 100;
    end = now + 100_000;
    await factory.createMarket("Will it happen?", outcomes, start, end, arbitrator.address);
    marketAddr = (await factory.getMarkets())[0];
    market = await ethers.getContractAt("Market", marketAddr);
    token = await ethers.getContractAt("OutcomeToken", await market.outcomeToken());
    if (seed > 0n) await market.connect(creator).seedLiquidity({ value: seed });
    await time.increaseTo(start + 1);
  }

  const buy = (who, outcome, value, minOut = 0) => market.connect(who).buyOutcomeTokens(outcome, minOut, { value });
  const bal = (who, id) => token.balanceOf(who.address ?? who, id);
  const ethBal = (addr) => ethers.provider.getBalance(addr);
  const reserves = async () => (await market.getReserves()).map(BigInt);
  /** YES price as a fraction of 1e18, from the reserves (binary market). */
  const yesPrice = async () => {
    const [ry, rn] = await reserves();
    return (rn * 10n ** 18n) / (ry + rn);
  };
  const resolveAs = async (outcome) => {
    await time.increaseTo(end);
    await market.connect(arbitrator).resolve(outcome);
  };
  const setEth = (addr, wei) => network.provider.send("hardhat_setBalance", [addr, "0x" + wei.toString(16)]);

  beforeEach(async function () {
    await deploy();
  });

  // ═════════════════════════════ PHASE 7 — UNIT TESTS ═════════════════════════════
  describe("Phase 7 — TRADING", function () {
    it("Buy YES: mints YES shares to the buyer and takes their ETH", async function () {
      const quote = await market.calcBuyAmount(eth(1), 0);
      const tx = buy(alice, 0, eth(1));
      await expect(tx).to.emit(market, "OutcomeTokensBought").withArgs(alice.address, 0, eth(1), quote);
      await expect(tx).to.changeEtherBalances([alice, market], [-eth(1), eth(1)]);
      expect(await bal(alice, 0)).to.equal(quote);
      expect(await bal(alice, 1)).to.equal(0);
    });

    it("Buy NO: mints NO shares to the buyer and takes their ETH", async function () {
      const quote = await market.calcBuyAmount(eth(2), 1);
      const tx = buy(bob, 1, eth(2));
      await expect(tx).to.emit(market, "OutcomeTokensBought").withArgs(bob.address, 1, eth(2), quote);
      await expect(tx).to.changeEtherBalances([bob, market], [-eth(2), eth(2)]);
      expect(await bal(bob, 1)).to.equal(quote);
      expect(await bal(bob, 0)).to.equal(0);
    });

    it("Multiple trades: several traders buy both sides and each keeps their own shares", async function () {
      const plan = [[alice, 0, 1], [bob, 1, 2], [carol, 0, 0.5], [alice, 1, 0.25], [dave, 0, 3]];
      const expected = new Map();
      for (const [who, o, v] of plan) {
        const q = await market.calcBuyAmount(eth(v), o);
        await buy(who, o, eth(v));
        const k = who.address + o;
        expected.set(k, (expected.get(k) ?? 0n) + q);
      }
      for (const [who, o] of plan) expect(await bal(who, o)).to.equal(expected.get(who.address + o));
      expect(await ethBal(marketAddr)).to.equal(SEED + eth(1 + 2 + 0.5 + 0.25 + 3));
    });

    it("Price changes after trade: buying YES raises YES and lowers NO; buying NO does the opposite", async function () {
      const p0 = await yesPrice();
      expect(p0).to.equal(eth(0.5));
      await buy(alice, 0, eth(1));
      const p1 = await yesPrice();
      expect(p1).to.be.gt(p0);
      await buy(bob, 1, eth(3));
      const p2 = await yesPrice();
      expect(p2).to.be.lt(p1);
      // the same ETH buys fewer YES shares once YES is more expensive
      const fresh = await market.calcBuyAmount(eth(1), 0);
      await buy(carol, 0, eth(5));
      expect(await market.calcBuyAmount(eth(1), 0)).to.be.lt(fresh);
    });

    it("Zero-value trade rejected", async function () {
      await expect(buy(alice, 0, 0)).to.be.revertedWithCustomError(market, "ZeroAmount");
    });

    it("Invalid outcome rejected", async function () {
      await expect(buy(alice, 2, eth(1))).to.be.revertedWithCustomError(market, "InvalidOutcome").withArgs(2);
      await expect(buy(alice, ethers.MaxUint256, eth(1))).to.be.revertedWithCustomError(market, "InvalidOutcome");
    });
  });

  describe("Phase 7 — PAYOUT", function () {
    let aliceYes, carolYes, bobNo;
    beforeEach(async function () {
      await buy(alice, 0, eth(1));
      await buy(bob, 1, eth(2));
      await buy(carol, 0, eth(0.5));
      [aliceYes, carolYes, bobNo] = [await bal(alice, 0), await bal(carol, 0), await bal(bob, 1)];
      await resolveAs(0); // YES wins
    });

    it("Winning user receives payout: 1 wei per winning share", async function () {
      expect(await market.getPayout(alice.address)).to.equal(aliceYes);
      const tx = market.connect(alice).claimPayout();
      await expect(tx).to.emit(market, "Redeemed").withArgs(alice.address, 0, aliceYes, aliceYes);
      await expect(tx).to.changeEtherBalances([alice, market], [aliceYes, -aliceYes]);
    });

    it("Losing user receives no payout and keeps their (worthless) shares", async function () {
      expect(await market.getPayout(bob.address)).to.equal(0);
      await expect(market.connect(bob).claimPayout()).to.be.revertedWithCustomError(market, "NothingToRedeem");
      await expect(market.connect(bob).redeem(1)).to.be.revertedWithCustomError(market, "InsufficientShares");
      expect(await bal(bob, 1)).to.equal(bobNo);
    });

    it("Tokens are redeemed/burned", async function () {
      await expect(market.connect(alice).claimPayout())
        .to.emit(token, "TransferSingle").withArgs(marketAddr, alice.address, ethers.ZeroAddress, 0, aliceYes);
      expect(await bal(alice, 0)).to.equal(0);
    });

    it("Double claim rejected (claimPayout twice, or redeem after claimPayout)", async function () {
      await market.connect(alice).claimPayout();
      await expect(market.connect(alice).claimPayout()).to.be.revertedWithCustomError(market, "NothingToRedeem");
      await expect(market.connect(alice).redeem(1)).to.be.revertedWithCustomError(market, "InsufficientShares");
    });

    it("Multiple winners can claim, in any order, and each gets exactly their shares", async function () {
      await expect(market.connect(carol).claimPayout()).to.changeEtherBalance(carol, carolYes);
      await expect(market.connect(alice).claimPayout()).to.changeEtherBalance(alice, aliceYes);
    });
  });

  describe("Phase 7 — EDGE CASES", function () {
    it("Very small trade: 1 wei buys at least 1 share and barely moves the price", async function () {
      const before = await yesPrice();
      await buy(alice, 0, 1n);
      expect(await bal(alice, 0)).to.be.gte(1n);
      expect(await yesPrice()).to.be.closeTo(before, 1n);
    });

    it("Very large trade: 1,000,000 ETH on a 10 ETH pool stays below 100% and pays out correctly", async function () {
      await setEth(alice.address, eth(2_000_000));
      await buy(alice, 0, eth(1_000_000));
      const [ry, rn] = await reserves();
      expect(ry).to.be.gt(0n);
      expect(await yesPrice()).to.be.lt(eth(1));
      const shares = await bal(alice, 0);
      expect(await ethBal(marketAddr)).to.be.gte(shares); // can pay her in full
      await resolveAs(0);
      await expect(market.connect(alice).claimPayout()).to.changeEtherBalance(alice, shares);
      expect(await ethBal(marketAddr)).to.equal(ry); // only the pool's YES reserve is left
    });

    it("Rounding: the trader never receives more than the exact maths gives", async function () {
      const r = rng(11);
      for (let k = 0; k < 40; k++) {
        const o = r() < 0.5 ? 0 : 1;
        const v = BigInt(Math.floor(r() * 3e18)) + 1n;
        const exact = exactTokensFloor(await reserves(), o, v);
        const got = await market.calcBuyAmount(v, o);
        expect(got).to.be.lte(exact);
        expect(exact - got).to.be.lte(2n);
        await buy(alice, o, v);
      }
    });

    it("Repeated trades: 150 small buys keep the price moving one way and the pool solvent", async function () {
      let last = await yesPrice();
      for (let k = 0; k < 150; k++) {
        await buy(k % 2 ? alice : bob, 0, eth(0.05));
        const p = await yesPrice();
        expect(p).to.be.gte(last);
        last = p;
      }
      const [ry, rn] = await reserves();
      const total = await ethBal(marketAddr);
      expect(ry + (await bal(alice, 0)) + (await bal(bob, 0))).to.equal(total);
      expect(rn).to.equal(total); // nobody holds NO
    });
  });

  // ═════════════════════════════ PHASE 6 — SECURITY CHECKS ═════════════════════════════
  describe("Phase 6 — Prevent zero-value trades", function () {
    it("zero ETH buy, zero seed and zero-share redeem are all rejected", async function () {
      await expect(buy(alice, 0, 0)).to.be.revertedWithCustomError(market, "ZeroAmount");
      await deploy(["YES", "NO"], 0n);
      await expect(market.connect(creator).seedLiquidity({ value: 0 })).to.be.revertedWithCustomError(market, "ZeroAmount");
      await market.connect(creator).seedLiquidity({ value: SEED });
      await buy(alice, 0, eth(1));
      await resolveAs(0);
      await expect(market.connect(alice).redeem(0)).to.be.revertedWithCustomError(market, "ZeroAmount");
    });

    it("a trade can never mint zero shares for a non-zero payment", async function () {
      for (const v of [1n, 2n, 10n, 1000n]) {
        expect(await market.calcBuyAmount(v, 0)).to.be.gte(1n);
      }
    });
  });

  describe("Phase 6 — Prevent insufficient collateral", function () {
    it("no shares without payment: trading requires seeded liquidity and ETH", async function () {
      await deploy(["YES", "NO"], 0n);
      await expect(buy(alice, 0, eth(1))).to.be.revertedWithCustomError(market, "LiquidityNotSeeded");
    });

    it("users cannot mint shares directly, bypassing the Market", async function () {
      await expect(token.connect(alice).mint(alice.address, 0, eth(100))).to.be.revertedWithCustomError(token, "NotMarket");
    });

    it("slippage guard: a trade that would mint fewer shares than minTokensOut reverts and changes nothing", async function () {
      const quote = await market.calcBuyAmount(eth(1), 0);
      const before = await reserves();
      await expect(buy(alice, 0, eth(1), quote + 1n)).to.be.revertedWithCustomError(market, "SlippageExceeded");
      expect(await reserves()).to.deep.equal(before);
    });

    it("every outcome is fully backed: reserve + all holders' shares == ETH held", async function () {
      const r = rng(3);
      const who = [alice, bob, carol, dave];
      for (let k = 0; k < 30; k++) await buy(who[k % 4], r() < 0.6 ? 0 : 1, BigInt(Math.floor(r() * 2e18)) + 1n);
      const total = await ethBal(marketAddr);
      const res = await reserves();
      for (const o of [0, 1]) {
        let held = 0n;
        for (const w of who) held += await bal(w, o);
        expect(res[o] + held).to.equal(total);
      }
    });
  });

  describe("Phase 6 — Prevent double payouts", function () {
    beforeEach(async function () {
      await buy(alice, 0, eth(1));
      await buy(bob, 1, eth(1));
    });

    it("redeem in parts never pays more than the shares held", async function () {
      await resolveAs(0);
      const shares = await bal(alice, 0);
      await market.connect(alice).redeem(shares / 2n);
      await expect(market.connect(alice).redeem(shares)).to.be.revertedWithCustomError(market, "InsufficientShares");
      await market.connect(alice).redeem(shares - shares / 2n);
      await expect(market.connect(alice).claimPayout()).to.be.revertedWithCustomError(market, "NothingToRedeem");
    });

    it("transferring winning shares moves the claim; the old holder cannot also claim", async function () {
      await resolveAs(0);
      const shares = await bal(alice, 0);
      await token.connect(alice).safeTransferFrom(alice.address, dave.address, 0, shares, "0x");
      await expect(market.connect(alice).claimPayout()).to.be.revertedWithCustomError(market, "NothingToRedeem");
      await expect(market.connect(dave).claimPayout()).to.changeEtherBalance(dave, shares);
    });

    it("payout and refund cannot both happen: a resolved market never refunds", async function () {
      await resolveAs(0);
      await market.connect(alice).claimPayout();
      await time.increase(WEEK * 2n);
      await expect(market.connect(alice).claimRefund()).to.be.revertedWithCustomError(market, "NotExpired");
    });

    it("an expired market never pays out winnings, and refunds only once", async function () {
      await time.increaseTo(await market.resolutionDeadline());
      await expect(market.connect(alice).claimPayout()).to.be.revertedWithCustomError(market, "NotResolved");
      await market.connect(alice).claimRefund();
      await expect(market.connect(alice).claimRefund()).to.be.revertedWithCustomError(market, "NothingToRefund");
    });
  });

  describe("Phase 6 — Check integer/decimal precision", function () {
    it("on-chain quotes match exact fraction maths within 2 wei over 300 random states (2 and 3 outcomes)", async function () {
      for (const outcomes of [["YES", "NO"], ["A", "B", "C"]]) {
        await deploy(outcomes);
        const r = rng(outcomes.length * 17);
        let worst = 0n;
        for (let k = 0; k < 150; k++) {
          const o = Math.floor(r() * outcomes.length);
          const v = BigInt(Math.floor(r() * 4e18)) + 1n;
          const exact = exactTokensFloor(await reserves(), o, v);
          const got = await market.calcBuyAmount(v, o);
          expect(got).to.be.lte(exact);
          if (exact - got > worst) worst = exact - got;
          if (k % 3 === 0) await buy(alice, o, v); // move the state
        }
        expect(worst).to.be.lte(2n);
      }
    });

    it("prices from reserves always add up to 100%", async function () {
      const r = rng(5);
      for (let k = 0; k < 20; k++) {
        await buy(alice, r() < 0.5 ? 0 : 1, BigInt(Math.floor(r() * 5e18)) + 1n);
        const [ry, rn] = await reserves();
        const pYes = (rn * 10n ** 18n) / (ry + rn);
        const pNo = (ry * 10n ** 18n) / (ry + rn);
        expect(pYes + pNo).to.be.closeTo(10n ** 18n, 1n);
      }
    });
  });

  describe("Phase 6 — Check rounding behaviour", function () {
    it("the product of reserves never decreases (rounding always favours the pool)", async function () {
      const r = rng(9);
      let k0 = (await reserves()).reduce((a, b) => a * b, 1n);
      for (let k = 0; k < 60; k++) {
        await buy(k % 2 ? alice : bob, r() < 0.5 ? 0 : 1, BigInt(Math.floor(r() * 1e18)) + 1n);
        const k1 = (await reserves()).reduce((a, b) => a * b, 1n);
        expect(k1).to.be.gte(k0);
        k0 = k1;
      }
    });

    it("splitting a trade into many tiny trades does not earn extra shares", async function () {
      const total = eth(1);
      const single = await market.calcBuyAmount(total, 0);
      for (let k = 0; k < 100; k++) await buy(alice, 0, total / 100n);
      expect(await bal(alice, 0)).to.be.lte(single);
    });

    it("dust trades of 1 wei repeated 50 times cannot drain the pool", async function () {
      const before = await reserves();
      for (let k = 0; k < 50; k++) await buy(alice, 0, 1n);
      const after = await reserves();
      expect(after[1]).to.equal(before[1] + 50n);
      expect(await bal(alice, 0)).to.be.lte(100n); // ~2 shares per wei at 50/50, never more
    });
  });

  describe("Phase 6 — Check reentrancy risks around fund transfers", function () {
    it("buy: re-entering buyOutcomeTokens() from the ERC-1155 hook is blocked", async function () {
      const atk = await (await ethers.getContractFactory("ReentrantBuyer")).deploy();
      await atk.attack(marketAddr, eth(1), { value: eth(2) });
      expect(await atk.attempted()).to.equal(true);
      expect(await atk.reentrancySucceeded()).to.equal(false);
    });

    it("redeem: re-entering redeem() from the ETH payout is blocked", async function () {
      const atk = await (await ethers.getContractFactory("ReentrantRedeemer")).deploy();
      await atk.buy(marketAddr, 0, { value: eth(1) });
      await resolveAs(0);
      await atk.setMode(2); // Reenter
      const shares = await bal(await atk.getAddress(), 0);
      await expect(atk.claim()).to.changeEtherBalance(atk, shares);
      expect(await atk.reentrySucceeded()).to.equal(false);
    });

    it("refund: re-entering claimRefund() from the ETH refund is blocked", async function () {
      const atk = await (await ethers.getContractFactory("ReentrantRefunder")).deploy();
      await atk.buy(marketAddr, 0, { value: eth(1) });
      await time.increaseTo(await market.resolutionDeadline());
      await atk.setMode(2); // Reenter
      await expect(atk.refund()).to.changeEtherBalance(atk, eth(1));
      expect(await atk.reentrySucceeded()).to.equal(false);
    });

    it("forced ETH (selfdestruct) cannot break accounting: refunds stay exact", async function () {
      await buy(alice, 0, eth(1));
      await (await ethers.getContractFactory("ForceSender")).deploy(marketAddr, { value: eth(5) });
      expect(await ethBal(marketAddr)).to.equal(SEED + eth(1) + eth(5));
      await time.increaseTo(await market.resolutionDeadline());
      await expect(market.connect(alice).claimRefund()).to.changeEtherBalance(alice, eth(1));
      await expect(market.connect(creator).claimRefund()).to.changeEtherBalance(creator, SEED);
      expect(await ethBal(marketAddr)).to.equal(eth(5)); // the forced ETH is simply left over
    });
  });

  describe("Phase 6 — Check AMM calculations for extreme values", function () {
    it("tiny pool (1 wei seed) with a large trade: no revert, reserves stay positive", async function () {
      await deploy(["YES", "NO"], 1n);
      await buy(alice, 0, eth(100));
      const [ry, rn] = await reserves();
      expect(ry).to.be.gt(0n);
      expect(rn).to.be.gt(0n);
    });

    it("huge pool (1,000,000 ETH seed) with a 1 wei trade still mints a share", async function () {
      await setEth(creator.address, eth(2_000_000));
      await deploy(["YES", "NO"], eth(1_000_000));
      await buy(alice, 1, 1n);
      expect(await bal(alice, 1)).to.be.gte(1n);
    });

    it("near-certain market: after 10,000 ETH on YES, NO is cheap but its price still rises when bought", async function () {
      await setEth(alice.address, eth(20_000));
      await buy(alice, 0, eth(10_000));
      expect(await yesPrice()).to.be.gt(eth(0.9999));
      const [, rn] = await reserves();
      const q1 = await market.calcBuyAmount(eth(1), 1);
      expect(q1).to.be.gt(eth(1)); // cheap...
      expect(q1).to.be.lt(rn + eth(1)); // ...but can never take more than the pool holds
      await buy(bob, 1, eth(1));
      expect(await market.calcBuyAmount(eth(1), 1)).to.be.lt(q1); // and it gets dearer
    });

    it("10-outcome market: prices, solvency and payout still hold", async function () {
      const labels = Array.from({ length: 10 }, (_, i) => "O" + i);
      await deploy(labels);
      for (let i = 0; i < 10; i++) await buy(i % 2 ? alice : bob, i, eth(0.3 + i / 10));
      const total = await ethBal(marketAddr);
      const res = await reserves();
      for (let i = 0; i < 10; i++) {
        expect(res[i] + (await bal(alice, i)) + (await bal(bob, i))).to.equal(total);
      }
      await resolveAs(7);
      await expect(market.connect(alice).claimPayout()).to.changeEtherBalance(alice, await bal(alice, 7));
    });
  });

  describe("Phase 6 — Check that contract balances cannot become inconsistent", function () {
    /** Random buys + share transfers by 4 traders, checking the backing invariant every step. */
    async function randomTrading(r, n, steps) {
      const who = [alice, bob, carol, dave];
      for (let k = 0; k < steps; k++) {
        const a = who[Math.floor(r() * 4)];
        const o = Math.floor(r() * n);
        if (r() < 0.8) {
          await buy(a, o, BigInt(Math.floor(r() * 2e18)) + 1n);
        } else {
          const b = who[Math.floor(r() * 4)];
          const s = await bal(a, o);
          if (s > 0n && a !== b) await token.connect(a).safeTransferFrom(a.address, b.address, o, s / 2n, "0x");
        }
        const total = await ethBal(marketAddr);
        const res = await reserves();
        for (let i = 0; i < n; i++) {
          let held = 0n;
          for (const w of who) held += await bal(w, i);
          expect(res[i] + held).to.equal(total);
        }
      }
      return who;
    }

    it("resolve path: after random trading and every winner redeeming, exactly the pool's winning reserve is left", async function () {
      await deploy(["A", "B", "C"]);
      const who = await randomTrading(rng(21), 3, 60);
      await resolveAs(1);
      let paid = 0n;
      const before = await ethBal(marketAddr);
      for (const w of who) {
        const s = await bal(w, 1);
        if (s > 0n) { await market.connect(w).claimPayout(); paid += s; }
      }
      const [, rWin] = await reserves();
      expect(await ethBal(marketAddr)).to.equal(before - paid);
      expect(await ethBal(marketAddr)).to.equal(rWin);
    });

    it("expiry path: after random trading, refunds return every wei and the contract ends at 0", async function () {
      await deploy(["YES", "NO"]);
      const who = await randomTrading(rng(33), 2, 60);
      await time.increaseTo(await market.resolutionDeadline());
      let refunded = 0n;
      const start = await ethBal(marketAddr);
      for (const w of [...who, creator]) {
        const owed = await market.collateralPaid(w.address);
        if (owed > 0n) { await market.connect(w).claimRefund(); refunded += owed; }
      }
      expect(refunded).to.equal(start);
      expect(await ethBal(marketAddr)).to.equal(0);
    });
  });

  // ═════════════════════════════ FINDINGS (documented, not fixed here) ═════════════════════════════
  describe("Findings — known limitations", function () {
    it("(finding) after resolution, the pool's leftover collateral has no withdraw function", async function () {
      await buy(alice, 0, eth(1));
      await resolveAs(0);
      await market.connect(alice).claimPayout();
      const left = await ethBal(marketAddr);
      expect(left).to.be.gt(0n); // stays in the contract; the creator cannot take it out
      await expect(market.connect(creator).claimRefund()).to.be.revertedWithCustomError(market, "NotExpired");
    });

    it("(finding) the arbitrator can trade in the market they will resolve", async function () {
      await expect(buy(arbitrator, 0, eth(1))).to.emit(market, "OutcomeTokensBought");
      await resolveAs(0);
      await expect(market.connect(arbitrator).claimPayout()).to.emit(market, "Redeemed");
    });

    it("(finding) gas for buy and refund grows with the number of outcomes", async function () {
      const rows = [];
      for (const n of [2, 10, 30]) {
        await deploy(Array.from({ length: n }, (_, i) => "O" + i));
        const g1 = (await (await buy(alice, 0, eth(1))).wait()).gasUsed;
        await time.increaseTo(await market.resolutionDeadline());
        const g2 = (await (await market.connect(alice).claimRefund()).wait()).gasUsed;
        rows.push({ outcomes: n, buyGas: Number(g1), refundGas: Number(g2) });
      }
      console.table(rows);
      expect(rows[2].buyGas).to.be.gt(rows[0].buyGas);
    });
  });
});
