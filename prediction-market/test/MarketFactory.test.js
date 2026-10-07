const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time, setBalance } = require("@nomicfoundation/hardhat-network-helpers");

describe("Task 1a: MarketFactory / Market / OutcomeToken", function () {
  let factory, creator, arbitrator, user, start, end;
  const Q = "Will ETH exceed $5,000 by 31 Dec 2026?";
  const OUTCOMES = ["YES", "NO"];

  beforeEach(async function () {
    [creator, arbitrator, user] = await ethers.getSigners();
    factory = await (await ethers.getContractFactory("MarketFactory")).deploy();
    const now = await time.latest();
    start = now + 100;
    end = now + 10_000;
  });

  async function create(q = Q, o = OUTCOMES, s = start, e = end, a = arbitrator.address, from = creator) {
    return factory.connect(from).createMarket(q, o, s, e, a);
  }

  /** Parse every log in a receipt that any of the given interfaces can decode. */
  function parseLogs(receipt, interfaces) {
    const out = [];
    for (const log of receipt.logs) {
      for (const iface of interfaces) {
        try {
          const parsed = iface.parseLog(log);
          if (parsed) { out.push({ ...parsed, address: log.address, parsed }); break; }
        } catch { /* not this interface */ }
      }
    }
    return out;
  }

  describe("successful creation", function () {
    it("registers the market once and emits a matching MarketCreated event", async function () {
      const rc = await (await create()).wait();
      const ev = parseLogs(rc, [factory.interface]).find((p) => p.name === "MarketCreated");

      expect(await factory.getMarketCount()).to.equal(1);
      const markets = await factory.getMarkets();
      expect(markets.length).to.equal(1);

      expect(ev.args.market).to.equal(markets[0]);
      expect(ev.args.creator).to.equal(creator.address);
      expect(ev.args.arbitrator).to.equal(arbitrator.address);
      expect(ev.args.question).to.equal(Q);
      expect(ev.args.startTime).to.equal(start);
      expect(ev.args.endTime).to.equal(end);
    });

    it("stores all creation data in the Market", async function () {
      await create();
      const m = await ethers.getContractAt("Market", (await factory.getMarkets())[0]);
      expect(await m.question()).to.equal(Q);
      expect(await m.creator()).to.equal(creator.address);
      expect(await m.arbitrator()).to.equal(arbitrator.address);
      expect(await m.startTime()).to.equal(start);
      expect(await m.endTime()).to.equal(end);
      expect(await m.resolved()).to.equal(false);
      expect(await m.winningOutcome()).to.equal(0);
      expect(await m.getOutcomeCount()).to.equal(2);
      expect(await m.getOutcomes()).to.deep.equal(OUTCOMES);
    });

    it("supports more than two outcomes", async function () {
      await create(Q, ["A", "B", "C"]);
      const m = await ethers.getContractAt("Market", (await factory.getMarkets())[0]);
      expect(await m.getOutcomeCount()).to.equal(3);
    });

    it("tracks multiple markets with distinct addresses and token contracts", async function () {
      await create();
      await create("Another?", ["YES", "NO"], start, end, arbitrator.address, user);
      const [a, b] = await factory.getMarkets();
      expect(a).to.not.equal(b);
      const ma = await ethers.getContractAt("Market", a);
      const mb = await ethers.getContractAt("Market", b);
      expect(await mb.creator()).to.equal(user.address);
      expect(await ma.outcomeToken()).to.not.equal(await mb.outcomeToken());
    });
  });

  describe("Market creation events", function () {
    const Market = () => ethers.getContractFactory("Market");
    let receipt, market, marketAddr;

    beforeEach(async function () {
      receipt = await (await create(Q, ["YES", "NO", "MAYBE"])).wait();
      marketAddr = (await factory.getMarkets())[0];
      market = await ethers.getContractAt("Market", marketAddr);
    });

    it("emits OutcomeTokenDeployed from the Market with the real token address", async function () {
      const ev = parseLogs(receipt, [market.interface]).find((p) => p.name === "OutcomeTokenDeployed");
      expect(ev, "OutcomeTokenDeployed not found").to.not.equal(undefined);
      expect(ev.address).to.equal(marketAddr);
      expect(ev.args.outcomeToken).to.equal(await market.outcomeToken());
    });

    it("emits one OutcomeRegistered per outcome, in order, with matching labels", async function () {
      const evs = parseLogs(receipt, [market.interface]).filter((p) => p.name === "OutcomeRegistered");
      expect(evs.length).to.equal(3);
      const labels = await market.getOutcomes();
      evs.forEach((e, i) => {
        expect(e.address).to.equal(marketAddr);
        expect(e.args.outcomeId).to.equal(i);
        expect(e.args.label).to.equal(labels[i]);
      });
    });

    it("emits MarketInitialized with data matching stored state", async function () {
      const ev = parseLogs(receipt, [market.interface]).find((p) => p.name === "MarketInitialized");
      expect(ev, "MarketInitialized not found").to.not.equal(undefined);
      expect(ev.address).to.equal(marketAddr);
      expect(ev.args.creator).to.equal(await market.creator());
      expect(ev.args.arbitrator).to.equal(await market.arbitrator());
      expect(ev.args.outcomeToken).to.equal(await market.outcomeToken());
      expect(ev.args.question).to.equal(await market.question());
      expect(ev.args.startTime).to.equal(await market.startTime());
      expect(ev.args.endTime).to.equal(await market.endTime());
      expect(ev.args.outcomeCount).to.equal(await market.getOutcomeCount());
    });

    it("emits MarketInitialized last among Market events, after the token is deployed", async function () {
      const names = parseLogs(receipt, [market.interface]).map((p) => p.name);
      expect(names[names.length - 1]).to.equal("MarketInitialized");
      expect(names.indexOf("OutcomeTokenDeployed")).to.be.lessThan(names.indexOf("MarketInitialized"));
    });

    it("emits MarketCreated (Factory) alongside the Market events in one transaction", async function () {
      const Factory = factory.interface;
      const names = parseLogs(receipt, [factory.interface, market.interface]).map((p) => p.name);
      expect(names).to.include.members(["OutcomeRegistered", "OutcomeTokenDeployed", "MarketInitialized", "MarketCreated"]);
      expect(Factory.getEvent("MarketCreated")).to.not.equal(null);
    });

    it("emits no creation events when creation reverts", async function () {
      await expect(create("")).to.be.reverted;
      expect(await factory.getMarketCount()).to.equal(1); // only the one from beforeEach
    });
  });

  describe("invalid creation reverts", function () {
    it("empty question", async function () {
      await expect(create("")).to.be.reverted;
    });
    it("fewer than 2 outcomes", async function () {
      await expect(create(Q, [])).to.be.reverted;
      await expect(create(Q, ["YES"])).to.be.reverted;
    });
    it("empty outcome label", async function () {
      await expect(create(Q, ["YES", ""])).to.be.reverted;
    });
    it("duplicate outcome labels", async function () {
      await expect(create(Q, ["YES", "YES"])).to.be.reverted;
    });
    it("startTime >= endTime", async function () {
      await expect(create(Q, OUTCOMES, end, start)).to.be.reverted;
      await expect(create(Q, OUTCOMES, start, start)).to.be.reverted;
    });
    it("endTime in the past", async function () {
      const now = await time.latest();
      await expect(create(Q, OUTCOMES, now - 200, now - 100)).to.be.reverted;
    });
    it("zero arbitrator", async function () {
      await expect(create(Q, OUTCOMES, start, end, ethers.ZeroAddress)).to.be.reverted;
    });
    it("does not register anything on failure", async function () {
      await expect(create("")).to.be.reverted;
      expect(await factory.getMarketCount()).to.equal(0);
    });
  });

  describe("OutcomeToken access control & events", function () {
    let market, token, marketAddr;
    beforeEach(async function () {
      await create();
      marketAddr = (await factory.getMarkets())[0];
      market = await ethers.getContractAt("Market", marketAddr);
      token = await ethers.getContractAt("OutcomeToken", await market.outcomeToken());
    });

    /** Act as the Market contract (only it may mint/burn). */
    async function asMarket() {
      await network.provider.request({ method: "hardhat_impersonateAccount", params: [marketAddr] });
      await setBalance(marketAddr, ethers.parseEther("1"));
      return ethers.getSigner(marketAddr);
    }

    it("is owned by its Market", async function () {
      expect(await token.market()).to.equal(marketAddr);
    });
    it("users cannot mint", async function () {
      await expect(token.connect(user).mint(user.address, 0, 1)).to.be.revertedWithCustomError(token, "NotMarket");
    });
    it("users cannot burn", async function () {
      await expect(token.connect(user).burn(user.address, 0, 1)).to.be.revertedWithCustomError(token, "NotMarket");
    });
    it("creator and arbitrator cannot mint or burn directly", async function () {
      await expect(token.connect(creator).mint(creator.address, 0, 1)).to.be.revertedWithCustomError(token, "NotMarket");
      await expect(token.connect(arbitrator).burn(arbitrator.address, 0, 1)).to.be.revertedWithCustomError(token, "NotMarket");
    });
    it("balanceOf starts at zero", async function () {
      expect(await token.balanceOf(user.address, 0)).to.equal(0);
    });
    it("cannot deploy a token with a zero market", async function () {
      const F = await ethers.getContractFactory("OutcomeToken");
      await expect(F.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(F, "ZeroMarket");
    });

    it("Market can mint: updates balance and emits SharesMinted", async function () {
      const m = await asMarket();
      await expect(token.connect(m).mint(user.address, 1, 50))
        .to.emit(token, "SharesMinted").withArgs(user.address, 1, 50);
      expect(await token.balanceOf(user.address, 1)).to.equal(50);
      expect(await token.balanceOf(user.address, 0)).to.equal(0);
    });

    it("Market mint also emits the standard ERC-1155 TransferSingle", async function () {
      const m = await asMarket();
      await expect(token.connect(m).mint(user.address, 0, 7))
        .to.emit(token, "TransferSingle").withArgs(marketAddr, ethers.ZeroAddress, user.address, 0, 7);
    });

    it("Market can burn: updates balance and emits SharesBurned", async function () {
      const m = await asMarket();
      await token.connect(m).mint(user.address, 0, 10);
      await expect(token.connect(m).burn(user.address, 0, 4))
        .to.emit(token, "SharesBurned").withArgs(user.address, 0, 4);
      expect(await token.balanceOf(user.address, 0)).to.equal(6);
    });

    it("burning more than the balance reverts and emits nothing", async function () {
      const m = await asMarket();
      await token.connect(m).mint(user.address, 0, 1);
      await expect(token.connect(m).burn(user.address, 0, 2)).to.be.reverted;
      expect(await token.balanceOf(user.address, 0)).to.equal(1);
    });
  });
});