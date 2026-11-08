// Resolves a market as its arbitrator (account #1 locally, the deployer on Sepolia).
//
//   MARKET=0x... OUTCOME=0 npx hardhat run scripts/resolve.js --network localhost
//   MARKET=0x... OUTCOME=0 npx hardhat run scripts/resolve.js --network sepolia
//   (OUTCOME 0 = YES, 1 = NO)
const { ethers } = require("hardhat");

async function main() {
  const address = process.env.MARKET;
  const outcome = Number(process.env.OUTCOME ?? 0);
  if (!address || !ethers.isAddress(address)) throw new Error("Set MARKET=0x... (a market address)");

  const signers = await ethers.getSigners();
  const market = await ethers.getContractAt("Market", address);
  const expected = await market.arbitrator();
  const arbitrator = signers.find((s) => s.address.toLowerCase() === expected.toLowerCase());
  if (!arbitrator) throw new Error(`None of your accounts is this market's arbitrator (${expected})`);

  const label = (await market.getOutcomes())[outcome];
  await (await market.connect(arbitrator).resolve(outcome)).wait();
  console.log(`Resolved ${address} as outcome ${outcome} (${label})`);
}

main().catch((e) => {
  console.error(e.shortMessage ?? e.message ?? e);
  process.exitCode = 1;
});
