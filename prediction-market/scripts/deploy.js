// Deploys MarketFactory, creates sample markets and writes the addresses and ABIs into
// the frontend, so the dApp can talk to the contracts.
//
// Local (two terminals, from prediction-market/):
//   1)  npx hardhat node
//   2)  npx hardhat run scripts/deploy.js --network localhost
//   Accounts:  #0 = creator (deploys + seeds)   #1 = arbitrator   #2 = sample trader
//
// Sepolia testnet (see README "Deploying to Sepolia"):
//   npx hardhat run scripts/deploy.js --network sepolia
//   Your one account is creator AND arbitrator. Markets are seeded with small amounts
//   and there are no sample trades, so it only costs a little test ETH.
const { ethers, network, artifacts } = require("hardhat");
const fs = require("fs");
const path = require("path");

// DEPLOY_OUT_DIR lets tests write somewhere else instead of the frontend.
const OUT_DIR = process.env.DEPLOY_OUT_DIR || path.join(__dirname, "../../frontend/src/contracts");
const MIN = 60;
const DAY = 24 * 60 * MIN;

// question, outcomes, seconds until trading ends, seed in ETH, sample YES buy in ETH
const SAMPLE_MARKETS = [
  ["Will ETH be above $5,000 on 31 Dec 2026?", ["YES", "NO"], 30 * DAY, "10", "3"],
  ["Will it rain at NTU tomorrow?", ["YES", "NO"], 10 * MIN, "5", "1"],
  ["Will our demo run without bugs?", ["YES", "NO"], 2 * MIN, "5", "0"],
];

// Testnet: cheaper and longer, so there's time to demo trading and then resolving.
const TESTNET_MARKETS = [
  ["Will ETH be above $5,000 on 31 Dec 2026?", ["YES", "NO"], 30 * DAY, "0.01", "0"],
  ["Will our demo run without bugs?", ["YES", "NO"], 30 * MIN, "0.01", "0"],
];

const NETWORKS = {
  31337: { file: "deployments.json", rpcUrl: "http://127.0.0.1:8545", explorer: null },
  11155111: {
    file: "deployments.sepolia.json",
    rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    explorer: "https://sepolia.etherscan.io",
  },
};

async function main() {
  const signers = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();
  const local = Number(chainId) === 31337;
  const creator = signers[0];
  const arbitrator = local ? signers[1] : signers[0];
  const trader = local ? signers[2] : null;
  const plan = local ? SAMPLE_MARKETS : TESTNET_MARKETS;
  const info = NETWORKS[Number(chainId)] ?? { file: `deployments.${network.name}.json`, rpcUrl: "", explorer: null };

  console.log(`Network: ${network.name} (chainId ${chainId})`);
  if (!local) {
    const balance = await ethers.provider.getBalance(creator.address);
    console.log(`Deployer: ${creator.address}  balance ${ethers.formatEther(balance)} ETH`);
  }

  const factory = await (await ethers.getContractFactory("MarketFactory")).connect(creator).deploy();
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  console.log(`MarketFactory: ${factoryAddress}`);

  const markets = [];
  for (const [question, outcomes, duration, seed, sampleBuy] of plan) {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    // start slightly in the past so trading is open straight away
    await (await factory.connect(creator).createMarket(question, outcomes, now - 1, now + duration, arbitrator.address)).wait();
    const address = (await factory.getMarkets()).at(-1);
    const market = await ethers.getContractAt("Market", address);
    await (await market.connect(creator).seedLiquidity({ value: ethers.parseEther(seed) })).wait();
    if (trader && sampleBuy !== "0") {
      await (await market.connect(trader).buyOutcomeTokens(0, 0, { value: ethers.parseEther(sampleBuy) })).wait();
    }
    markets.push({ address, question });
    console.log(`  Market: ${address}  "${question}"  (ends in ${Math.round(duration / MIN)} min)`);
  }

  fs.mkdirSync(path.join(OUT_DIR, "abis"), { recursive: true });
  const deployments = {
    network: network.name,
    chainId: Number(chainId),
    rpcUrl: info.rpcUrl,
    explorer: info.explorer,
    factory: factoryAddress,
    arbitrator: arbitrator.address,
    markets,
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(OUT_DIR, info.file), JSON.stringify(deployments, null, 2) + "\n");
  for (const name of ["MarketFactory", "Market", "OutcomeToken"]) {
    const { abi } = await artifacts.readArtifact(name);
    fs.writeFileSync(path.join(OUT_DIR, "abis", `${name}.json`), JSON.stringify(abi, null, 2) + "\n");
  }
  console.log(`\nWrote ${info.file} and ABIs to ${path.relative(process.cwd(), OUT_DIR)}`);
  if (info.explorer) {
    console.log(`\nView on Etherscan:\n  ${info.explorer}/address/${factoryAddress}`);
    for (const m of markets) console.log(`  ${info.explorer}/address/${m.address}`);
  }
  return deployments;
}

module.exports = { main, SAMPLE_MARKETS, TESTNET_MARKETS };

// Run when called with `npx hardhat run scripts/deploy.js`, not when a test imports it.
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
