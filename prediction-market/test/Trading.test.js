const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const ONE = 10n ** 18n;
const eth = (n) => ethers.parseEther(String(n));
const ceilDiv = (a, b) => (a + b - 1n) / b;

/** Independent JS reference of the constant-product buy formula (BigInt). */
function refCalcBuy(reserves, x, o) {
  let ending = reserves[o] * ONE;
  for (let i = 0; i < reserves.length; i++) {
    if (i === o) continue;
    ending = ceilDiv(ending * reserves[i], reserves[i] + x);
  }
  return reserves[o] + x - ceilDiv(ending, ONE);
}

describe("Phase 2: trading (buyOutcomeTokens)", function () {
  let factory, market, token, creator, arbitrator, alice, bob, start, end;
  const SEED = eth(10);

  async function deploy(outcomes = ["YES", "NO"]) {
    [creator, arbitrator, alice, bob] = await ethers.getSigners();
    factory = await (await ethers.getContractFactory("MarketFactory")).deploy();
    const now = await time.latest();
    start = now + 100;
    end = now + 100_000;
    await factory.createMarket("Will it happen?", outcomes, start, end, arbitrator.address);
    const addr = (await factory.getMarkets())[0];
    market = await ethers.getContractAt("Market", addr);
    token = await ethers.getContractAt("OutcomeToken", await market.outcomeToken());
  }

  /** Seed liquidity and move time into the trading window. */
  async function openForTrading() {
    await market.connect(creator).seedLiquidity({ value: SEED });
    await time.increaseTo(start + 1);
  }

  beforeEach(async function () {
    await deploy();
  });

  // ───────────────────────── marketId validation ─────────────────────────
  describe("marketId validation (factory registry)", function () {
    it("isMarket is true for factory-created markets", async function () {
      expect(await factory.isMarket(await market.getAddress())).to.equal(true);
    });
    it("isMarket is false for unknown addresses", async function () {
      expect(await factory.isMarket(alice.address)).to.equal(false);
      expect(await factory.isMarket(ethers.ZeroAddress)).to.equal(false);
    });
    it("every registered market is flagged", async function () {
      await factory.createMarket("Second?", ["A", "B"], start, end, arbitrator.address);
      for (const m of await factory.getMarkets()) expect(await factory.isMarket(m)).to.equal(true);
    });
  });

  // ───────────────────────── liquidity seeding ─────────────────────────
  describe("seedLiquidity", function () {
    it("starts unseeded with zero reserves", async function () {
      expect(await market.liquiditySeeded()).to.equal(false);
      expect(await market.getReserves()).to.deep.equal([0n, 0n]);
    });
    it("creator seeds equal reserves for every outcome and emits LiquiditySeeded", async function () {
      await expect(market.connect(creator).seedLiquidity({ value: SEED }))
        .to.emit(market, "LiquiditySeeded").withArgs(creator.address, SEED);
      expect(await market.liquiditySeeded()).to.equal(true);
      expect(await market.getReserves()).to.deep.equal([SEED, SEED]);
      expect(await ethers.provider.getBalance(await market.getAddress())).to.equal(SEED);
    });
    it("only the creator can seed", async function () {
      await expect(market.connect(alice).seedLiquidity({ value: SEED })).to.be.revertedWithCustomError(market, "NotCreator");
      await expect(market.connect(arbitrator).seedLiquidity({ value: SEED })).to.be.revertedWithCustomError(market, "NotCreator");
    });
    it("can only be seeded once", async function () {
      await market.connect(creator).seedLiquidity({ value: SEED });
      await expect(market.connect(creator).seedLiquidity({ value: SEED })).to.be.revertedWithCustomError(market, "AlreadySeeded");
    });
    it("rejects zero value", async function () {
      await expect(market.connect(creator).seedLiquidity({ value: 0 })).to.be.revertedWithCustomError(market, "ZeroAmount");
    });
    it("rejects seeding after the market has ended", async function () {
      await time.increaseTo(end + 1);
      await expect(market.connect(creator).seedLiquidity({ value: SEED })).to.be.revertedWithCustomError(market, "MarketExpired");
    });
    it("seeds every reserve for a 3-outcome market", async function () {
      await deploy(["A", "B", "C"]);
      await market.connect(creator).seedLiquidity({ value: SEED });
      expect(await market.getReserves()).to.deep.equal([SEED, SEED, SEED]);
    });
  });

  // ───────────────────────── validation ─────────────────────────
  describe("buy validation", function () {
    it("reverts when liquidity has not been seeded", async function () {
      await time.increaseTo(start + 1);
      await expect(market.connect(alice).buyOutcomeTokens(0, 0, { value: eth(1) }))
        .to.be.revertedWithCustomError(market, "LiquidityNotSeeded");
    });
    it("reverts for an invalid outcome id", async function () {
      await openForTrading();
      await expect(market.connect(alice).buyOutcomeTokens(2, 0, { value: eth(1) }))
        .to.be.revertedWithCustomError(market, "InvalidOutcome").withArgs(2);
      await expect(market.connect(alice).buyOutcomeTokens(999, 0, { value: eth(1) }))
        .to.be.revertedWithCustomError(market, "InvalidOutcome").withArgs(999);
    });
    it("reverts when no collateral is sent", async function () {
      await openForTrading();
      await expect(market.connect(alice).buyOutcomeTokens(0, 0, { value: 0 }))
        .to.be.revertedWithCustomError(market, "ZeroAmount");
    });
    it("reverts before the market has started", async function () {
      await market.connect(creator).seedLiquidity({ value: SEED });
      await expect(market.connect(alice).buyOutcomeTokens(0, 0, { value: eth(1) }))
        .to.be.revertedWithCustomError(market, "MarketNotStarted");
    });
    it("reverts after the event has expired", async function () {
      await openForTrading();
      await time.increaseTo(end);
      await expect(market.connect(alice).buyOutcomeTokens(0, 0, { value: eth(1) }))
        .to.be.revertedWithCustomError(market, "MarketExpired");
    });
    it("still works just before expiry", async function () {
      await openForTrading();
      await time.setNextBlockTimestamp(end - 1);
      await expect(market.connect(alice).buyOutcomeTokens(0, 0, { value: eth(1) })).to.emit(market, "OutcomeTokensBought");
    });
    it("reverts when slippage limit is not met and changes no state", async function () {
      await openForTrading();
      const quote = await market.calcBuyAmount(eth(1), 0);
      await expect(market.connect(alice).buyOutcomeTokens(0, quote + 1n, { value: eth(1) }))
        .to.be.revertedWithCustomError(market, "SlippageExceeded").withArgs(quote, quote + 1n);
      expect(await market.getReserves()).to.deep.equal([SEED, SEED]);
      expect(await token.balanceOf(alice.address, 0)).to.equal(0);
    });
    it("succeeds when minTokensOut equals the quote exactly", async function () {
      await openForTrading();
      const quote = await market.calcBuyAmount(eth(1), 0);
      await market.connect(alice).buyOutcomeTokens(0, quote, { value: eth(1) });
      expect(await token.balanceOf(alice.address, 0)).to.equal(quote);
    });
    it("calcBuyAmount reverts for bad outcome and when unseeded", async function () {
      await expect(market.calcBuyAmount(eth(1), 0)).to.be.revertedWithCustomError(market, "LiquidityNotSeeded");
      await openForTrading();
      await expect(market.calcBuyAmount(eth(1), 5)).to.be.revertedWithCustomError(market, "InvalidOutcome");
    });
    it("rejects plain ETH transfers (no receive/fallback)", async function () {
      await expect(alice.sendTransaction({ to: await market.getAddress(), value: 1 })).to.be.reverted;
    });
  });

  // ───────────────────────── successful buys ─────────────────────────
  describe("successful buy", function () {
    beforeEach(async function () {
      await openForTrading();
    });

    it("mints shares, emits the trade event and updates reserves", async function () {
      const x = eth(1);
      const expected = refCalcBuy([SEED, SEED], x, 0);
      await expect(market.connect(alice).buyOutcomeTokens(0, 0, { value: x }))
        .to.emit(market, "OutcomeTokensBought").withArgs(alice.address, 0, x, expected);

      expect(await token.balanceOf(alice.address, 0)).to.equal(expected);
      expect(await token.balanceOf(alice.address, 1)).to.equal(0);
      expect(await market.getReserves()).to.deep.equal([SEED + x - expected, SEED + x]);
    });

    it("also emits the OutcomeToken SharesMinted event", async function () {
      const x = eth(1);
      const expected = refCalcBuy([SEED, SEED], x, 1);
      await expect(market.connect(alice).buyOutcomeTokens(1, 0, { value: x }))
        .to.emit(token, "SharesMinted").withArgs(alice.address, 1, expected);
    });

    it("on-chain quote equals an independent reference implementation", async function () {
      for (const x of [1n, 1000n, eth(0.001), eth(1), eth(5), eth(100)]) {
        const reserves = await market.getReserves();
        expect(await market.calcBuyAmount(x, 0)).to.equal(refCalcBuy(reserves, x, 0));
        expect(await market.calcBuyAmount(x, 1)).to.equal(refCalcBuy(reserves, x, 1));
      }
    });

    it("quote returned by the call equals the minted amount", async function () {
      const x = eth(2);
      const quote = await market.calcBuyAmount(x, 0);
      const out = await market.connect(alice).buyOutcomeTokens.staticCall(0, 0, { value: x });
      expect(out).to.equal(quote);
    });

    it("gives more than 1 share per wei at the start (price below 1 ETH per share)", async function () {
      const x = eth(1);
      expect(await market.calcBuyAmount(x, 0)).to.be.greaterThan(x);
    });

    it("starting odds are equal: same ETH buys the same shares of either outcome", async function () {
      expect(await market.calcBuyAmount(eth(1), 0)).to.equal(await market.calcBuyAmount(eth(1), 1));
    });

    it("price rises with demand: a second identical buy returns fewer shares", async function () {
      const x = eth(1);
      const first = await market.calcBuyAmount(x, 0);
      await market.connect(alice).buyOutcomeTokens(0, 0, { value: x });
      const second = await market.calcBuyAmount(x, 0);
      expect(second).to.be.lessThan(first);
    });

    it("buying one outcome makes the other cheaper", async function () {
      const x = eth(1);
      const noBefore = await market.calcBuyAmount(x, 1);
      await market.connect(alice).buyOutcomeTokens(0, 0, { value: x });
      const noAfter = await market.calcBuyAmount(x, 1);
      expect(noAfter).to.be.greaterThan(noBefore);
    });

    it("larger trades move the price more (slippage grows with size)", async function () {
      const small = await market.calcBuyAmount(eth(0.1), 0);
      const large = await market.calcBuyAmount(eth(10), 0);
      // shares per ETH is lower for the large trade
      expect(small * 100n).to.be.greaterThan(large);
    });

    it("never lets the product of reserves decrease (rounding favours the pool)", async function () {
      const prod = (r) => r.reduce((a, b) => a * b, 1n);
      let before = prod(await market.getReserves());
      for (const [who, o, x] of [[alice, 0, eth(1)], [bob, 1, eth(3)], [alice, 0, 7n], [bob, 0, eth(0.5)], [alice, 1, 12345n]]) {
        await market.connect(who).buyOutcomeTokens(o, 0, { value: x });
        const after = prod(await market.getReserves());
        expect(after >= before).to.equal(true);
        before = after;
      }
    });

    it("solvency invariant: reserves[i] + traders' shares[i] == total collateral for every outcome", async function () {
      await market.connect(alice).buyOutcomeTokens(0, 0, { value: eth(1) });
      await market.connect(bob).buyOutcomeTokens(1, 0, { value: eth(2.5) });
      await market.connect(alice).buyOutcomeTokens(1, 0, { value: 999n });
      await market.connect(bob).buyOutcomeTokens(0, 0, { value: eth(4) });

      const collateral = await ethers.provider.getBalance(await market.getAddress());
      const reserves = await market.getReserves();
      for (let i = 0; i < 2; i++) {
        const held = (await token.balanceOf(alice.address, i)) + (await token.balanceOf(bob.address, i));
        expect(reserves[i] + held).to.equal(collateral);
      }
    });

    it("the market holds exactly the seed plus all purchases as collateral", async function () {
      await market.connect(alice).buyOutcomeTokens(0, 0, { value: eth(1) });
      await market.connect(bob).buyOutcomeTokens(1, 0, { value: eth(2) });
      expect(await ethers.provider.getBalance(await market.getAddress())).to.equal(SEED + eth(3));
    });

    it("moves the trader's ETH into the market", async function () {
      const x = eth(1);
      await expect(market.connect(alice).buyOutcomeTokens(0, 0, { value: x }))
        .to.changeEtherBalances([alice, market], [-x, x]);
    });

    it("handles a dust purchase (1 wei) and returns at least 1 share", async function () {
      await market.connect(alice).buyOutcomeTokens(0, 0, { value: 1n });
      expect(await token.balanceOf(alice.address, 0)).to.be.greaterThanOrEqual(1n);
    });

    it("pool can never be drained: a huge buy leaves every reserve positive", async function () {
      await market.connect(alice).buyOutcomeTokens(0, 0, { value: eth(1000) });
      for (const r of await market.getReserves()) expect(r).to.be.greaterThan(0n);
    });

    it("the Market is the only minter: direct mint by the trader still fails", async function () {
      await market.connect(alice).buyOutcomeTokens(0, 0, { value: eth(1) });
      await expect(token.connect(alice).mint(alice.address, 0, 1)).to.be.revertedWithCustomError(token, "NotMarket");
    });
  });

  describe("multi-outcome market (3 outcomes)", function () {
    beforeEach(async function () {
      await deploy(["A", "B", "C"]);
      await openForTrading();
    });
    it("buys the third outcome and keeps the solvency invariant", async function () {
      const x = eth(2);
      const expected = refCalcBuy([SEED, SEED, SEED], x, 2);
      await expect(market.connect(alice).buyOutcomeTokens(2, 0, { value: x }))
        .to.emit(market, "OutcomeTokensBought").withArgs(alice.address, 2, x, expected);

      const collateral = await ethers.provider.getBalance(await market.getAddress());
      const reserves = await market.getReserves();
      for (let i = 0; i < 3; i++) {
        expect(reserves[i] + (await token.balanceOf(alice.address, i))).to.equal(collateral);
      }
    });
    it("rejects outcome id 3", async function () {
      await expect(market.connect(alice).buyOutcomeTokens(3, 0, { value: eth(1) }))
        .to.be.revertedWithCustomError(market, "InvalidOutcome").withArgs(3);
    });
  });

  // ───────────────────────── reentrancy ─────────────────────────
  describe("reentrancy protection", function () {
    it("blocks a re-entrant buy from the ERC-1155 receiver hook", async function () {
      await openForTrading();
      const attacker = await (await ethers.getContractFactory("ReentrantBuyer")).deploy();
      const amount = eth(1);
      const quote = await market.calcBuyAmount(amount, 0);

      await attacker.connect(alice).attack(await market.getAddress(), amount, { value: amount * 2n });

      expect(await attacker.attempted()).to.equal(true);
      expect(await attacker.reentrancyBlocked()).to.equal(true);
      expect(await attacker.reentrancySucceeded()).to.equal(false);

      // Exactly one purchase happened, for exactly the outer amount.
      const attackerAddr = await attacker.getAddress();
      expect(await token.balanceOf(attackerAddr, 0)).to.equal(quote);
      expect(await ethers.provider.getBalance(await market.getAddress())).to.equal(SEED + amount);
      // The attacker keeps the ETH its blocked inner call tried to spend.
      expect(await ethers.provider.getBalance(attackerAddr)).to.equal(amount);
    });
  });
});