
const { ethers } = require("hardhat");

async function main() {
  const [admin, alice, bob, charlie] =
    await ethers.getSigners();

  // 1. Deploy voting contract
  const Voting = await ethers.getContractFactory(
    "ReputationWeightedVoting"
  );

  const voting = await Voting.deploy();
  await voting.waitForDeployment();

  const votingAddress = await voting.getAddress();

  console.log("Voting contract:", votingAddress);

  // 2. Deploy market factory
  const Factory = await ethers.getContractFactory(
    "MarketFactory"
  );

  const factory = await Factory.deploy();
  await factory.waitForDeployment();

  // 3. Create a market
  const block = await ethers.provider.getBlock("latest");
  const now = block.timestamp;

  const start = now + 60;
  const end = now + 3600;

  await (
    await factory.createMarket(
      "Will ETH reach $5000?",
      ["YES", "NO"],
      start,
      end,
      votingAddress
    )
  ).wait();

  const markets = await factory.getMarkets();
  const marketAddress = markets[0];

  console.log("Market address:", marketAddress);

  // 4. Initialize voting
  await (
    await voting.initializeMarket(marketAddress, 600)
  ).wait();

  // 5. Assign reputation weights
  await (
    await voting.setReputation(alice.address, 5)
  ).wait();

  await (
    await voting.setReputation(bob.address, 2)
  ).wait();

  await (
    await voting.setReputation(charlie.address, 3)
  ).wait();

  console.log("Reputation assigned:");
  console.log("Alice: 5");
  console.log("Bob: 2");
  console.log("Charlie: 3");

  console.log("Deployment successful!");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
