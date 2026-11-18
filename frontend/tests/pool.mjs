// Moves the Unichain reference pool with Uniswap's PoolSwapTest helper (testnet tooling, the signer's own tokens).
// node tests/pool.mjs prep          approvals, and bring USDC to the signer from the test wallets if needed
// node tests/pool.mjs up <price>    buy WETH with USDC until the pool price reaches <price> USDC per ETH
// node tests/pool.mjs down <price>  sell WETH until the pool price falls to <price>
// node tests/pool.mjs show
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { ethers } = require("ethers");
const rec = JSON.parse(fs.readFileSync(new URL("../../deployments/bell.json", import.meta.url), "utf8"));
const pools = JSON.parse(fs.readFileSync(new URL("../../deployments/pools.json", import.meta.url), "utf8"));
const wallets = JSON.parse(fs.readFileSync(process.env.HOME + "/.config/bell-testnet/wallets.json", "utf8"));
const d = rec.unichainSepolia;
const p = new ethers.JsonRpcProvider("https://unichain-sepolia-rpc.publicnode.com", undefined, { staticNetwork: true, batchMaxCount: 1 });
const s = new ethers.Wallet(process.env.BELL_PRIVATE_KEY, p);
const helperAddr = pools.unichainSepolia.poolSwapTest;
const key = [d.usdc, d.weth, 500, d.tickSpacing, ethers.ZeroAddress];
const poolId = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "uint24", "int24", "address"], key));
const pm = new ethers.Contract(d.poolManager, ["function extsload(bytes32) view returns (bytes32)"], p);
const slot = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [poolId, 6]));
const readP = async () => { const v = BigInt(await pm.extsload(slot)) & ((1n << 160n) - 1n); return Number((10n ** 18n << 192n) / (v * v)) / 1e6; };
const isqrt = (n) => { if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / y) / 2n; } return x; };
const sqrtAt = (price) => isqrt(((10n ** 18n) << 192n) / BigInt(Math.round(price * 1e6)));
const erc = ["function approve(address,uint256) returns (bool)", "function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"];
const usdc = new ethers.Contract(d.usdc, erc, s), weth = new ethers.Contract(d.weth, erc, s);
const helper = new ethers.Contract(helperAddr, ["function swap((address,address,uint24,int24,address) key,(bool,int256,uint160) params,(bool,bool) testSettings,bytes hookData) payable returns (int256)"], s);
const [cmd, arg] = process.argv.slice(2);
if (cmd === "show") console.log("Unichain pool price", await readP());
if (cmd === "prep") {
  for (const t of [usdc, weth]) await (await t.approve(helperAddr, ethers.MaxUint256)).wait();
  let have = await usdc.balanceOf(s.address);
  console.log("signer USDC on Unichain", ethers.formatUnits(have, 6));
  for (const who of ["seller2", "buyer2"]) {
    if (have >= 8_700_000n) break;
    const w = new ethers.Wallet(wallets[who].privateKey, p);
    const bal = await new ethers.Contract(d.usdc, erc, w).balanceOf(w.address);
    const give = bal > 1_000_000n ? bal - 500_000n : 0n;
    if (give > 0n) { await (await new ethers.Contract(d.usdc, erc, w).transfer(s.address, give)).wait(); have += give; console.log(who, "gave", ethers.formatUnits(give, 6), "USDC"); }
  }
  console.log("signer USDC now", ethers.formatUnits(await usdc.balanceOf(s.address), 6), "| pool price", await readP());
}
if (cmd === "up" || cmd === "down") {
  const up = cmd === "up";
  const target = Number(arg);
  const before = await readP();
  const tx = await helper.swap(key, [up, up ? -20_000_000n : -ethers.parseEther("0.02"), sqrtAt(target)], [false, false], "0x");
  const rc = await tx.wait();
  await new Promise((r) => setTimeout(r, 4000));
  console.log(`${cmd}: pool ${before} -> ${await readP()} USDC per ETH`, tx.hash, "block", rc.blockNumber, "ts", (await p.getBlock(rc.blockNumber)).timestamp);
}
