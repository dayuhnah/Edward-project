// Local testing only: resolves a market as the arbitrator (account #1 on the Hardhat node).
//
//   MARKET=0x... OUTCOME=0 npx hardhat run scripts/resolve.js --network localhost
//   (OUTCOME 0 = YES, 1 = NO)
const { ethers } = require("hardhat");

async function main() {
  const address = process.env.MARKET;
  const outcome = Number(process.env.OUTCOME ?? 0);
  if (!address || !ethers.isAddress(address)) throw new Error("Set MARKET=0x... (a market address)");

  const [, arbitrator] = await ethers.getSigners();
  const market = await ethers.getContractAt("Market", address);
  const label = (await market.getOutcomes())[outcome];
  await (await market.connect(arbitrator).resolve(outcome)).wait();
  console.log(`Resolved ${address} as outcome ${outcome} (${label})`);
}

main().catch((e) => {
  console.error(e.shortMessage ?? e);
  process.exitCode = 1;
});
