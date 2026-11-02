require("@nomicfoundation/hardhat-toolbox");
const { vars } = require("hardhat/config");

// Testnet settings are stored with `npx hardhat vars set NAME` (kept on your computer,
// outside the project folder), so no keys ever end up in git. The Sepolia network only
// appears once both values are set; local development works without them.
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
  // Optional: lets `npx hardhat verify` publish the source code on Etherscan.
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
