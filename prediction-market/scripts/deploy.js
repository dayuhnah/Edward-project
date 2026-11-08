// Deploys MarketFactory, creates sample markets and writes the addresses and ABIs into
// the frontend, so the dApp can talk to the contracts.
//
// Local (two terminals, from prediction-market/):
//   1)  npx hardhat node
//   2)  npx hardhat run scripts/deploy.js --network localhost
//   Accounts:  #0 = creator (deploys + seeds) and voting admin   #1 = arbitrator
//              #2 = sample trader   #2, #3, #4 = voters with reputation 3, 5, 2
//
// One market is decided by reputation-weighted voting: its arbitrator is the
// ReputationWeightedVoting contract, and finalizing the vote resolves the market.
//
// Sepolia testnet (see README "Deploying to Sepolia"):
//   npx hardhat run scripts/deploy.js --network sepolia
//   Your one account is creator, arbitrator and voting admin. Markets are seeded with small
//   amounts and there are no sample trades, so it only costs a little test ETH.
//   Your account gets reputation 1. To add more voters (e.g. a groupmate's address):
//   VOTERS=0xAbc...:5,0xDef...:2 npx hardhat run scripts/deploy.js --network sepolia
const { ethers, network, artifacts } = require("hardhat");
const fs = require("fs");
const path = require("path");

// DEPLOY_OUT_DIR lets tests write somewhere else instead of the frontend.
const OUT_DIR = process.env.DEPLOY_OUT_DIR || path.join(__dirname, "../../frontend/src/contracts");
const MIN = 60;
const DAY = 24 * 60 * MIN;

// question, outcomes, seconds until trading ends, seed in ETH, sample YES buy in ETH,
// and true if the market is decided by reputation voting
const SAMPLE_MARKETS = [
  ["Will ETH be above $5,000 on 31 Dec 2026?", ["YES", "NO"], 30 * DAY, "10", "3"],
  ["Will it rain at NTU tomorrow?", ["YES", "NO"], 10 * MIN, "5", "1"],
  ["Will our demo run without bugs?", ["YES", "NO"], 2 * MIN, "5", "0"],
  ["Will it be sunny at NTU on demo day?", ["YES", "NO"], 5 * MIN, "5", "0", true],
];

// Testnet: cheaper and longer, so there's time to demo trading and then resolving.
const TESTNET_MARKETS = [
  ["Will ETH be above $5,000 on 31 Dec 2026?", ["YES", "NO"], 30 * DAY, "0.01", "0"],
  ["Will our demo run without bugs?", ["YES", "NO"], 30 * MIN, "0.01", "0"],
  ["Will it be sunny at NTU on demo day?", ["YES", "NO"], 20 * MIN, "0.01", "0", true],
];

// How long voting stays open after a voted market's trading ends.
const VOTE_WINDOW = { local: 5 * MIN, testnet: 10 * MIN };

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

  // Bonus: reputation-weighted voting. The deployer is its admin.
  const voting = await (await ethers.getContractFactory("ReputationWeightedVoting")).connect(creator).deploy();
  await voting.waitForDeployment();
  const votingAddress = await voting.getAddress();
  console.log(`ReputationWeightedVoting: ${votingAddress}`);
  const voters = local
    ? [[signers[2].address, 3], [signers[3].address, 5], [signers[4].address, 2]]
    : [[creator.address, 1], ...parseVoters(process.env.VOTERS)];

  const markets = [];
  for (const [question, outcomes, duration, seed, sampleBuy, voted] of plan) {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const decider = voted ? votingAddress : arbitrator.address;
    // start slightly in the past so trading is open straight away
    await (await factory.connect(creator).createMarket(question, outcomes, now - 1, now + duration, decider)).wait();
    const address = (await factory.getMarkets()).at(-1);
    const market = await ethers.getContractAt("Market", address);
    await (await market.connect(creator).seedLiquidity({ value: ethers.parseEther(seed) })).wait();
    if (trader && sampleBuy !== "0") {
      await (await market.connect(trader).buyOutcomeTokens(0, 0, { value: ethers.parseEther(sampleBuy) })).wait();
    }
    if (voted) {
      await (await voting.connect(creator).initializeMarket(address, local ? VOTE_WINDOW.local : VOTE_WINDOW.testnet)).wait();
      for (const [voter, weight] of voters) {
        await (await voting.connect(creator).setReputation(voter, weight)).wait();
      }
    }
    markets.push({ address, question, ...(voted ? { decidedBy: "voting" } : {}) });
    console.log(`  Market: ${address}  "${question}"  (ends in ${Math.round(duration / MIN)} min${voted ? ", decided by vote" : ""})`);
  }
  if (voters.length) {
    console.log(`  Voters: ${voters.map(([a, w]) => `${a.slice(0, 8)}… reputation ${w}`).join(", ")}`);
  }

  fs.mkdirSync(path.join(OUT_DIR, "abis"), { recursive: true });
  const deployments = {
    network: network.name,
    chainId: Number(chainId),
    rpcUrl: info.rpcUrl,
    explorer: info.explorer,
    factory: factoryAddress,
    arbitrator: arbitrator.address,
    voting: votingAddress,
    voters: voters.map(([address, reputation]) => ({ address, reputation })),
    markets,
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(OUT_DIR, info.file), JSON.stringify(deployments, null, 2) + "\n");
  for (const name of ["MarketFactory", "Market", "OutcomeToken", "ReputationWeightedVoting"]) {
    const { abi } = await artifacts.readArtifact(name);
    fs.writeFileSync(path.join(OUT_DIR, "abis", `${name}.json`), JSON.stringify(abi, null, 2) + "\n");
  }
  console.log(`\nWrote ${info.file} and ABIs to ${path.relative(process.cwd(), OUT_DIR)}`);
  if (info.explorer) {
    console.log(`\nView on Etherscan:\n  ${info.explorer}/address/${factoryAddress}`);
    console.log(`  ${info.explorer}/address/${votingAddress}`);
    for (const m of markets) console.log(`  ${info.explorer}/address/${m.address}`);
  }
  return deployments;
}

// "0xAbc:5,0xDef:2" -> [["0xAbc", 5], ["0xDef", 2]]
function parseVoters(text) {
  if (!text) return [];
  return text.split(",").map((pair) => {
    const [address, weight] = pair.trim().split(":");
    if (!ethers.isAddress(address) || !(Number(weight) > 0)) {
      throw new Error(`VOTERS entry "${pair}" should look like 0xAddress:5`);
    }
    return [address, Number(weight)];
  });
}

module.exports = { main, SAMPLE_MARKETS, TESTNET_MARKETS };

// Run when called with `npx hardhat run scripts/deploy.js`, not when a test imports it.
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
