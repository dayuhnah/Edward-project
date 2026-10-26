// Local testing only: moves the Hardhat node's clock forward so you can test
// end times, resolution and the 7-day expiry without waiting.
//
//   SECONDS=600 npx hardhat run scripts/advance-time.js --network localhost      (10 minutes)
//   SECONDS=604800 npx hardhat run scripts/advance-time.js --network localhost   (7 days)
const { network, ethers } = require("hardhat");

async function main() {
  const seconds = Number(process.env.SECONDS ?? 3600);
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
  const t = (await ethers.provider.getBlock("latest")).timestamp;
  console.log(`Moved forward ${seconds}s. Chain time is now ${new Date(t * 1000).toISOString()}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
