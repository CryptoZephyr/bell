// Moves one USDC/WETH fee-500 pool to a target price, adds a position of our own around it, then checks the
// depth with a test swap. Run once per chain:
//   TARGET=800 npx hardhat run scripts/align-pools.js --network unichainSepolia
//   TARGET=800 npx hardhat run scripts/align-pools.js --network baseSepolia
// Testnet tooling only. The liquidity is ours, on a real Uniswap v4 pool. It is not market depth.
//
// Env: TARGET (USDC per WETH, default 800), WETH_AMOUNT (default 0.01), USDC_AMOUNT (default 8),
//      BAND_PCT (default 10), SKIP_LIQUIDITY=1 to only align the price.
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const CHAINS = {
  unichainSepolia: {
    pm: "0x00B036B58a818B1BC34d502D3fE730Db729e62AC",
    usdc: "0x31d0220469e10c4E71834a79b1f276d740d3768F",
    tickSpacing: 10,
  },
  baseSepolia: {
    pm: "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    tickSpacing: 20,
  },
};
const WETH = "0x4200000000000000000000000000000000000006";
const Q96 = 2n ** 96n;
const MIN_SQRT = 4295128739n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n;

function isqrt(n) {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / y) / 2n;
  }
  return x;
}
const sqrtAtPrice = (p) => isqrt(((10n ** 18n) << 192n) / p); // p is USDC micro-units per 1 WETH
const priceAtSqrt = (s) => ((10n ** 18n) << 192n) / (s * s);
const settle = () => new Promise((r) => setTimeout(r, 5000));
const tickAtPrice = (p) => Math.round(Math.log(1e18 / Number(p)) / Math.log(1.0001));

async function main() {
  const cfg = CHAINS[network.name];
  if (!cfg) throw new Error("run with --network unichainSepolia or baseSepolia");
  const [signer] = await ethers.getSigners();
  const target = BigInt(Math.round(Number(process.env.TARGET || 800) * 1e6));
  const wethAmt = ethers.parseEther(process.env.WETH_AMOUNT || "0.01");
  const usdcAmt = BigInt(Math.round(Number(process.env.USDC_AMOUNT || 8) * 1e6));
  const band = Number(process.env.BAND_PCT || 10) / 100;

  const key = [cfg.usdc, WETH, 500, cfg.tickSpacing, ethers.ZeroAddress];
  const poolId = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "uint24", "int24", "address"], key)
  );
  const pm = await ethers.getContractAt(["function extsload(bytes32) view returns (bytes32)"], cfg.pm, signer);
  const base = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [poolId, 6])));
  const readSqrt = async () => BigInt(await pm.extsload(ethers.toBeHex(base, 32))) & ((1n << 160n) - 1n);
  const readLiq = async () => BigInt(await pm.extsload(ethers.toBeHex(base + 3n, 32))) & ((1n << 128n) - 1n);
  const show = async (label) => {
    const s = await readSqrt();
    console.log(`${label}: price ${Number(priceAtSqrt(s)) / 1e6} USDC/WETH, liquidity ${await readLiq()}`);
    return s;
  };

  const record = path.join(__dirname, "..", "deployments", "pools.json");
  const saved = fs.existsSync(record) ? JSON.parse(fs.readFileSync(record)) : {};
  saved[network.name] = saved[network.name] || {};

  // Helpers: Uniswap v4's own test routers, deployed once per chain.
  async function helper(name, field) {
    if (saved[network.name][field]) return ethers.getContractAt(name, saved[network.name][field], signer);
    const F = await ethers.getContractFactory(name);
    const c = await F.deploy(cfg.pm);
    await c.waitForDeployment();
    saved[network.name][field] = await c.getAddress();
    fs.writeFileSync(record, JSON.stringify(saved, null, 2) + "\n");
    console.log(name, saved[network.name][field]);
    return c;
  }
  const swapper = await helper("PoolSwapTest", "poolSwapTest");
  const liquidity = await helper("PoolModifyLiquidityTest", "poolModifyLiquidityTest");

  const usdc = await ethers.getContractAt(
    ["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"],
    cfg.usdc,
    signer
  );
  const weth = await ethers.getContractAt(
    ["function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"],
    WETH,
    signer
  );
  for (const h of [swapper, liquidity]) {
    const a = await h.getAddress();
    await (await usdc.approve(a, ethers.MaxUint256)).wait();
    await (await weth.approve(a, ethers.MaxUint256)).wait();
  }

  const swap = async (zeroForOne, amountIn, limit) => {
    const tx = await swapper.swap(
      key,
      { zeroForOne, amountSpecified: -amountIn, sqrtPriceLimitX96: limit },
      { takeClaims: false, settleUsingBurn: false },
      "0x"
    );
    return tx.wait();
  };

  // 1. Move the pool to the target price. The price limit stops the swap exactly there.
  let s = await show("before");
  const tSqrt = sqrtAtPrice(target);
  if (s > tSqrt) {
    // p is below target. Buy WETH with USDC to push p up (zeroForOne, sqrtP down).
    const r = await swap(true, 20_000000n, tSqrt);
    console.log("align (buy WETH) tx", r.hash);
  } else if (s < tSqrt) {
    const r = await swap(false, ethers.parseEther("0.02"), tSqrt);
    console.log("align (sell WETH) tx", r.hash);
  }
  s = await show("aligned");

  // 2. Add a position around the target. L is the largest that fits both token budgets.
  if (!process.env.SKIP_LIQUIDITY) {
    const lowerP = BigInt(Math.round(Number(target) * (1 - band))); // lower price, higher tick
    const upperP = BigInt(Math.round(Number(target) * (1 + band)));
    const spacing = cfg.tickSpacing;
    const tickA = Math.floor(tickAtPrice(upperP) / spacing) * spacing; // upper price is the lower tick
    const tickB = Math.ceil(tickAtPrice(lowerP) / spacing) * spacing;
    const sqrtA = (BigInt(Math.round(Math.pow(1.0001, tickA / 2) * 2 ** 48)) * Q96) / 2n ** 48n;
    const sqrtB = (BigInt(Math.round(Math.pow(1.0001, tickB / 2) * 2 ** 48)) * Q96) / 2n ** 48n;
    // amount0 (USDC) = L * Q96 * (sqrtB - sP) / (sP * sqrtB). amount1 (WETH) = L * (sP - sqrtA) / Q96.
    const L0 = (usdcAmt * s * sqrtB) / (Q96 * (sqrtB - s));
    const L1 = (wethAmt * Q96) / (s - sqrtA);
    const L = L0 < L1 ? L0 : L1;
    console.log(`position ticks [${tickA}, ${tickB}] liquidityDelta ${L}`);

    const have = await weth.balanceOf(signer.address);
    if (have < wethAmt) {
      const need = wethAmt - have;
      console.log("wrapping", ethers.formatEther(need), "ETH");
      await (await weth.deposit({ value: need })).wait();
    }
    const r = await liquidity.modifyLiquidity(
      key,
      { tickLower: tickA, tickUpper: tickB, liquidityDelta: L, salt: ethers.ZeroHash },
      "0x"
    );
    const rc = await r.wait();
    console.log("liquidity tx", rc.hash);
    saved[network.name].position = { tickLower: tickA, tickUpper: tickB, liquidity: L.toString(), tx: rc.hash };
  }
  s = await show("with our liquidity");

  // 3. Verify with a test swap. Sell 0.002 WETH, read the move, then buy the WETH back.
  const before = priceAtSqrt(s);
  const sellIn = ethers.parseEther("0.002");
  const haveW = await weth.balanceOf(signer.address);
  if (haveW < sellIn) await (await weth.deposit({ value: sellIn - haveW })).wait();
  const usdc0 = await usdc.balanceOf(signer.address);
  await swap(false, sellIn, MAX_SQRT - 1n);
  await settle(); // some RPC nodes serve a stale read right after a transaction
  const mid = await readSqrt();
  const got = (await usdc.balanceOf(signer.address)) - usdc0;
  const moved = (Number(priceAtSqrt(mid)) / Number(before) - 1) * 100;
  console.log(`test sell 0.002 WETH: got ${Number(got) / 1e6} USDC, price moved ${moved.toFixed(2)}%`);
  await swap(true, got, MIN_SQRT + 1n);
  await settle();
  const after = await show("after test round trip");
  saved[network.name].alignedTo = Number(target) / 1e6;
  saved[network.name].testSwapMovePct = Number(moved.toFixed(2));
  fs.writeFileSync(record, JSON.stringify(saved, null, 2) + "\n");
  void after;
}

main().catch((e) => {
  console.error(String(e.shortMessage || e.message).slice(0, 600));
  process.exitCode = 1;
});
