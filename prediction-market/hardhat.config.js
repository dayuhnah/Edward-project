require("@nomicfoundation/hardhat-toolbox");
const { vars } = require("hardhat/config");

// Sepolia settings come from `npx hardhat vars set NAME`, which stores them outside the
// project so keys never end up in git. The network is only added when both are set.
const sepolia =
  vars.has("SEPOLIA_RPC_URL") && vars.has("SEPOLIA_PRIVATE_KEY")
    ? {
        sepolia: {
          url: vars.get("SEPOLIA_RPC_URL"),
          accounts: [vars.get("SEPOLIA_PRIVATE_KEY")],
          chainId: 11155111,
        },
      }
    : {};

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun", // required by OpenZeppelin v5 (uses mcopy)
    },
  },
  networks: {
    ...sepolia,
  },
  // optional, only needed for `npx hardhat verify`
  etherscan: {
    apiKey: vars.has("ETHERSCAN_API_KEY") ? vars.get("ETHERSCAN_API_KEY") : "",
  },
  sourcify: { enabled: false },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};
