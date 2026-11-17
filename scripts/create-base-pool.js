// Creates the USDC/WETH fee-500 pool on Base Sepolia at the reference price, and seeds a small position.
// Testnet tooling only. The liquidity is ours, on a real Uniswap v4 pool.
const { ethers, network } = require("hardhat");

const PM = "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const WETH = "0x4200000000000000000000000000000000000006";
const SQRT_PRICE = 2760719981086153677930553539409802n; // reference pool price on Unichain at the last observation
const TICK = 209180;
const TICK_SPACING = 20;

(async () => {
  if (network.name !== "baseSepolia") throw new Error("run with --network baseSepolia");
  const [signer] = await ethers.getSigners();
  const key = { currency0: USDC, currency1: WETH, fee: 500, tickSpacing: TICK_SPACING, hooks: ethers.ZeroAddress };

  const Helper = await ethers.getContractFactory("PoolModifyLiquidityTest");
  const helper = await Helper.deploy(PM);
  await helper.waitForDeployment();
  const helperAddr = await helper.getAddress();
  console.log("helper", helperAddr);

  const weth = await ethers.getContractAt(["function deposit() payable", "function approve(address,uint256) returns (bool)"], WETH, signer);
  await (await weth.deposit({ value: ethers.parseEther("0.01") })).wait();
  await (await weth.approve(helperAddr, ethers.MaxUint256)).wait();
  const usdc = await ethers.getContractAt(["function approve(address,uint256) returns (bool)"], USDC, signer);
  await (await usdc.approve(helperAddr, ethers.MaxUint256)).wait();

  const pm = await ethers.getContractAt(["function initialize((address,address,uint24,int24,address) key, uint160 sqrtPriceX96) returns (int24)"], PM, signer);
  const init = await (await pm.initialize([USDC, WETH, 500, TICK_SPACING, ethers.ZeroAddress], SQRT_PRICE)).wait();
  console.log("initialize", init.hash, "status", init.status);

  const h = await (await helper.modifyLiquidity([USDC, WETH, 500, TICK_SPACING, ethers.ZeroAddress],
    { tickLower: TICK - 3000, tickUpper: TICK + 3000, liquidityDelta: 800000000000n, salt: ethers.ZeroHash }, "0x")).wait();
  console.log("liquidity", h.hash, "status", h.status);
})().catch((e) => { console.error(String(e.shortMessage || e.message).slice(0, 400)); process.exitCode = 1; });
