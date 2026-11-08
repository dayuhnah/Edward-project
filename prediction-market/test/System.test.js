const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Task 2b: the whole system end to end at contract level —
// the real deploy script, several markets side by side, many traders,
// one market resolved, one 3-outcome market resolved, one expired, and every wei accounted for.

const eth = (n) => ethers.parseEther(String(n));
const WEEK = 7 * 24 * 3600;

describe("Task 2b: full system", function () {
  describe("deploy script (scripts/deploy.js)", function () {
    let outDir, deployments;

    before(async function () {
      outDir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-"));
      process.env.DEPLOY_OUT_DIR = outDir;
      delete require.cache[require.resolve("../scripts/deploy.js")];
      const { main } = require("../scripts/deploy.js");
      await main();
      deployments = JSON.parse(fs.readFileSync(path.join(outDir, "deployments.json"), "utf8"));
    });

    after(function () {
      delete process.env.DEPLOY_OUT_DIR;
      fs.rmSync(outDir, { recursive: true, force: true });
    });

    it("writes deployments.json with the network, factory, arbitrator and markets", async function () {
      expect(deployments.chainId).to.equal(31337);
      expect(ethers.isAddress(deployments.factory)).to.equal(true);
      expect(deployments.markets).to.have.length(4);
      const [, arbitrator] = await ethers.getSigners();
      expect(deployments.arbitrator).to.equal(arbitrator.address);
    });

    it("deploys the voting contract and hands it one market, with voters and reputation set", async function () {
      const signers = await ethers.getSigners();
      const voting = await ethers.getContractAt("ReputationWeightedVoting", deployments.voting);
      const voted = deployments.markets.filter((m) => m.decidedBy === "voting");
      expect(voted).to.have.length(1);
      expect(await voting.market()).to.equal(voted[0].address);
      const market = await ethers.getContractAt("Market", voted[0].address);
      expect(await market.arbitrator()).to.equal(deployments.voting);
      expect(await voting.admin()).to.equal(signers[0].address);
      expect(deployments.voters.map((v) => v.reputation)).to.deep.equal([3, 5, 2]);
      for (const v of deployments.voters) expect(await voting.reputation(v.address)).to.equal(BigInt(v.reputation));
    });

    it("the factory has code and registers exactly the markets in the file", async function () {
      expect(await ethers.provider.getCode(deployments.factory)).to.not.equal("0x");
      const factory = await ethers.getContractAt("MarketFactory", deployments.factory);
      expect(await factory.getMarkets()).to.deep.equal(deployments.markets.map((m) => m.address));
      for (const m of deployments.markets) expect(await factory.isMarket(m.address)).to.equal(true);
    });

    it("every market is seeded, open for trading and has the question from the file", async function () {
      for (const m of deployments.markets) {
        const market = await ethers.getContractAt("Market", m.address);
        expect(await market.question()).to.equal(m.question);
        expect(await market.liquiditySeeded()).to.equal(true);
        expect(await market.status()).to.equal(1n); // Open
      }
    });

    it("writes the four ABI files the frontend needs, with the key functions", async function () {
      const need = {
        MarketFactory: ["createMarket", "getMarkets", "isMarket"],
        Market: ["buyOutcomeTokens", "calcBuyAmount", "resolve", "claimPayout", "claimRefund", "status", "getReserves"],
        OutcomeToken: ["balanceOf", "safeTransferFrom"],
        ReputationWeightedVoting: ["vote", "finalizeVoting", "updateReputation", "currentReputation", "getVoteTotals"],
      };
      for (const [name, fns] of Object.entries(need)) {
        const abi = JSON.parse(fs.readFileSync(path.join(outDir, "abis", `${name}.json`), "utf8"));
        const names = abi.filter((x) => x.type === "function").map((x) => x.name);
        for (const f of fns) expect(names, `${name}.${f}`).to.include(f);
      }
    });

    it("made the sample trades, so the demo starts with moved odds", async function () {
      const market = await ethers.getContractAt("Market", deployments.markets[0].address);
      const [ry, rn] = await market.getReserves();
      expect(rn * 100n / (ry + rn)).to.be.gt(50n); // YES above 50%
    });
  });

  describe("three markets side by side, from creation to the last claim", function () {
    let factory, creator, arbitrator, traders, A, B, C, start, end;

    async function create(question, outcomes, seed) {
      await factory.connect(creator).createMarket(question, outcomes, start, end, arbitrator.address);
      const m = await ethers.getContractAt("Market", (await factory.getMarkets()).at(-1));
      await m.connect(creator).seedLiquidity({ value: eth(seed) });
      return m;
    }
    const token = async (m) => ethers.getContractAt("OutcomeToken", await m.outcomeToken());
    const bal = (a) => ethers.provider.getBalance(a);

    before(async function () {
      const signers = await ethers.getSigners();
      [creator, arbitrator] = signers;
      traders = signers.slice(2, 8);
      factory = await (await ethers.getContractFactory("MarketFactory")).deploy();
      const now = await time.latest();
      start = now + 10;
      end = now + 10_000;
      A = await create("A: binary, resolves YES", ["YES", "NO"], 10);
      B = await create("B: three outcomes, resolves C", ["A", "B", "C"], 6);
      C = await create("C: binary, never resolved", ["YES", "NO"], 4);
      await time.increaseTo(start);
    });

    it("factory registry and MarketCreated events agree", async function () {
      const events = await factory.queryFilter(factory.filters.MarketCreated());
      expect(events.map((e) => e.args.market)).to.deep.equal(await factory.getMarkets());
      expect(events.map((e) => e.args.arbitrator)).to.deep.equal(Array(3).fill(arbitrator.address));
    });

    it("trading on one market never changes another market's reserves or ETH", async function () {
      const bBefore = [await B.getReserves(), await bal(await B.getAddress())];
      const cBefore = [await C.getReserves(), await bal(await C.getAddress())];
      for (let i = 0; i < 6; i++) await A.connect(traders[i]).buyOutcomeTokens(i % 2, 0, { value: eth(0.5 + i / 4) });
      expect([await B.getReserves(), await bal(await B.getAddress())]).to.deep.equal(bBefore);
      expect([await C.getReserves(), await bal(await C.getAddress())]).to.deep.equal(cBefore);
    });

    it("many traders across all markets: each market stays fully backed", async function () {
      let s = 99;
      const r = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
      for (let k = 0; k < 45; k++) {
        const m = [A, B, C][k % 3];
        const n = Number(await m.getOutcomeCount());
        await m.connect(traders[Math.floor(r() * 6)]).buyOutcomeTokens(Math.floor(r() * n), 0, { value: BigInt(Math.floor(r() * 1.5e18)) + 1n });
      }
      for (const m of [A, B, C]) {
        const t = await token(m);
        const total = await bal(await m.getAddress());
        const res = await m.getReserves();
        for (let i = 0; i < res.length; i++) {
          let held = 0n;
          for (const w of traders) held += await t.balanceOf(w.address, i);
          expect(res[i] + held).to.equal(total);
        }
      }
    });

    it("end of the story: A resolves YES, B resolves C, C expires; every wei is accounted for", async function () {
      // Total ETH held by every participant + every market, before the endgame.
      const everyone = [creator, arbitrator, ...traders];
      const markets = [A, B, C];
      const sumAll = async () => {
        let t = 0n;
        for (const p of everyone) t += await bal(p.address);
        for (const m of markets) t += await bal(await m.getAddress());
        return t;
      };
      const totalBefore = await sumAll();
      let gas = 0n;
      const send = async (txPromise) => { const rc = await (await txPromise).wait(); gas += rc.gasUsed * rc.gasPrice; return rc; };

      await time.increaseTo(end);
      await send(A.connect(arbitrator).resolve(0));
      await send(B.connect(arbitrator).resolve(2));

      // A and B: every holder of the winning outcome claims, and gets exactly their shares
      for (const [m, win] of [[A, 0], [B, 2]]) {
        const t = await token(m);
        let paid = 0n;
        for (const w of traders) {
          const shares = await t.balanceOf(w.address, win);
          if (shares === 0n) {
            await expect(m.connect(w).claimPayout.staticCall()).to.be.revertedWithCustomError(m, "NothingToRedeem");
            continue;
          }
          const before = await bal(w.address);
          const rc = await send(m.connect(w).claimPayout());
          expect((await bal(w.address)) - before + rc.gasUsed * rc.gasPrice).to.equal(shares);
          paid += shares;
        }
        const res = await m.getReserves();
        expect(await bal(await m.getAddress())).to.equal(res[win]); // only the pool's winning reserve is left
        expect(paid).to.be.gt(0n);
      }

      // C: nobody resolves it; after 7 days everyone (and the creator) is refunded in full
      await time.increase(WEEK);
      expect(await C.status()).to.equal(4n); // Expired
      for (const p of [creator, ...traders]) {
        const owed = await C.collateralPaid(p.address);
        if (owed === 0n) continue;
        const before = await bal(p.address);
        const rc = await send(C.connect(p).claimRefund());
        expect((await bal(p.address)) - before + rc.gasUsed * rc.gasPrice).to.equal(owed);
      }
      expect(await bal(await C.getAddress())).to.equal(0n);

      // Nothing was created or lost: total ETH only went down by the gas paid.
      expect(await sumAll()).to.equal(totalBefore - gas);
    });

    it("after the endgame no market accepts trades, and A/B can never be refunded", async function () {
      for (const m of [A, B, C]) {
        await expect(m.connect(traders[0]).buyOutcomeTokens(0, 0, { value: eth(1) })).to.be.reverted;
      }
      await expect(A.connect(traders[0]).claimRefund()).to.be.revertedWithCustomError(A, "NotExpired");
      await expect(B.connect(traders[0]).claimRefund()).to.be.revertedWithCustomError(B, "NotExpired");
    });
  });
});
