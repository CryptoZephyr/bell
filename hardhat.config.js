require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");

// Keys come from the environment, never from this file.
// BELL_PRIVATE_KEY is the test wallet key. Set it in the shell or the session environment.
const accounts = process.env.BELL_PRIVATE_KEY ? [process.env.BELL_PRIVATE_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    // Uniswap v4 uses transient storage, so Cancun is required.
    compilers: [
      {
        // Uniswap v4 core pins 0.8.26.
        version: "0.8.26",
        settings: {
          evmVersion: "cancun",
          optimizer: { enabled: true, runs: 200 },
        },
      },
      {
        // reactive-lib-omni requires ^0.8.29.
        version: "0.8.29",
        settings: {
          evmVersion: "cancun",
          optimizer: { enabled: true, runs: 200 },
        },
      },
    ],
  },
  networks: {
    hardhat: { accounts: { count: 40 } },
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
