require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");

// Keys come from the environment, never from this file.
// BELL_PRIVATE_KEY is the test wallet key. Set it in the shell or the session environment.
const accounts = process.env.BELL_PRIVATE_KEY ? [process.env.BELL_PRIVATE_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    hardhat: {},
    baseSepolia: {
      url: "https://sepolia.base.org",
      chainId: 84532,
      accounts,
    },
    unichainSepolia: {
      url: "https://sepolia.unichain.org",
      chainId: 1301,
      accounts,
    },
    lasna: {
      url: "https://lasna-rpc.rnk.dev/",
      chainId: 5318007,
      accounts,
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};
