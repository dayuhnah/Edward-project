// Deploys MarketFactory, creates a few sample markets and writes the addresses and
// ABIs into the frontend, so the dApp can talk to the contracts.
//
// Usage (two terminals, from prediction-market/):
//   1)  npx hardhat node
//   2)  npx hardhat run scripts/deploy.js --network localhost
//
// Accounts on the local node:  #0 = creator (deploys + seeds)   #1 = arbitrator   #2 = sample trader
const { ethers, network, artifacts } = require("hardhat");
const fs = require("fs");
const path = require("path");

const OUT_DIR = path.join(__dirname, "../../frontend/src/contracts");
const MIN = 60;
const DAY = 24 * 60 * MIN;

// question, outcomes, seconds until trading ends, seed in ETH, sample YES buy in ETH
const SAMPLE_MARKETS = [
  ["Will ETH be above $5,000 on 31 Dec 2026?", ["YES", "NO"], 30 * DAY, "10", "3"],
  ["Will it rain at NTU tomorrow?", ["YES", "NO"], 10 * MIN, "5", "1"],
  ["Will our demo run without bugs?", ["YES", "NO"], 2 * MIN, "5", "0"],
];

async function main() {
  const [creator, arbitrator, trader] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();
  console.log(`Network: ${network.name} (chainId ${chainId})`);

  const factory = await (await ethers.getContractFactory("MarketFactory")).connect(creator).deploy();
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  console.log(`MarketFactory: ${factoryAddress}`);

  const markets = [];
  for (const [question, outcomes, duration, seed, sampleBuy] of SAMPLE_MARKETS) {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    // start slightly in the past so trading is open straight away
    await (await factory.connect(creator).createMarket(question, outcomes, now - 1, now + duration, arbitrator.address)).wait();
    const address = (await factory.getMarkets()).at(-1);
    const market = await ethers.getContractAt("Market", address);
    await (await market.connect(creator).seedLiquidity({ value: ethers.parseEther(seed) })).wait();
    if (sampleBuy !== "0") {
      await (await market.connect(trader).buyOutcomeTokens(0, 0, { value: ethers.parseEther(sampleBuy) })).wait();
    }
    markets.push({ address, question });
    console.log(`  Market: ${address}  "${question}"  (ends in ${Math.round(duration / MIN)} min)`);
  }

  fs.mkdirSync(path.join(OUT_DIR, "abis"), { recursive: true });
  const deployments = {
    network: network.name,
    chainId: Number(chainId),
    rpcUrl: "http://127.0.0.1:8545",
    factory: factoryAddress,
    arbitrator: arbitrator.address,
    markets,
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(OUT_DIR, "deployments.json"), JSON.stringify(deployments, null, 2) + "\n");
  for (const name of ["MarketFactory", "Market", "OutcomeToken"]) {
    const { abi } = await artifacts.readArtifact(name);
    fs.writeFileSync(path.join(OUT_DIR, "abis", `${name}.json`), JSON.stringify(abi, null, 2) + "\n");
  }
  console.log(`\nWrote addresses and ABIs to ${path.relative(process.cwd(), OUT_DIR)}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
