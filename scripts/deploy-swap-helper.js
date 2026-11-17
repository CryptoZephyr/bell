// Deploys Uniswap v4's PoolSwapTest helper on the chain given by --network. Testnet tooling only.
const { ethers, network } = require("hardhat");
const POOL_MANAGER = {
  unichainSepolia: "0x00B036B58a818B1BC34d502D3fE730Db729e62AC",
  baseSepolia: "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408",
};
(async () => {
  const F = await ethers.getContractFactory("PoolSwapTest");
  const c = await F.deploy(POOL_MANAGER[network.name]);
  await c.waitForDeployment();
  console.log(network.name, "PoolSwapTest", await c.getAddress());
})().catch((e) => { console.error(e.shortMessage || e.message); process.exitCode = 1; });
