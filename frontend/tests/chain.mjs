// Direct chain actions for the test wallets (no browser), for tests the app cannot drive.
// node tests/chain.mjs place <who> <base|uni> <buy|sell> <qtyEth> [limitUsdcPerEth]
// node tests/chain.mjs cancel <who> <base|uni> <orderId>
// node tests/chain.mjs approve <who> <base|uni> <usdc|weth> <0|max>
// node tests/chain.mjs send <who> <base|uni> <usdc|weth> <amount> <toWho>
// node tests/chain.mjs call-cancel <who> <base|uni> <orderId>     (eth_call only, prints the revert reason)
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { ethers } = require("ethers");
const rec = JSON.parse(fs.readFileSync(new URL("../../deployments/bell.json", import.meta.url), "utf8"));
const wallets = JSON.parse(fs.readFileSync(process.env.HOME + "/.config/bell-testnet/wallets.json", "utf8"));
const net = { base: ["https://base-sepolia-rpc.publicnode.com", rec.baseSepolia], uni: ["https://unichain-sepolia-rpc.publicnode.com", rec.unichainSepolia] };
const abi = ["function place(bool,uint256,uint256) returns (uint256)", "function cancel(uint256)", "event OrderPlaced(uint256 indexed orderId, address indexed trader, bool isBuy, uint256 price, uint256 qty)", "error AlreadyFrozen()", "error NotOrderTrader()", "error OrderTooSmall()", "error NotFunded()"];
const erc = ["function approve(address,uint256) returns (bool)", "function transfer(address,uint256) returns (bool)"];
const [cmd, who, chain, ...rest] = process.argv.slice(2);
const [rpc, d] = net[chain];
const p = new ethers.JsonRpcProvider(rpc, undefined, { staticNetwork: true, batchMaxCount: 1 });
const s = new ethers.Wallet(wallets[who].privateKey, p);
const desk = new ethers.Contract(d.desk, abi, s);
const tokDec = (t) => (t === "usdc" ? 6 : 18);
const done = async (tx) => { const rc = await tx.wait(); console.log(cmd, who, chain, rc.status === 1 ? "ok" : "FAILED", tx.hash, "block", rc.blockNumber, "ts", (await p.getBlock(rc.blockNumber)).timestamp); return rc; };
if (cmd === "place") {
  const [side, qty, limit] = rest; const isBuy = side === "buy";
  const price = limit ? ethers.parseUnits(limit, 6) : BigInt(Math.round(Number(process.env.REF || 800.685862) * (isBuy ? 1.02 : 0.98) * 1e6));
  const rc = await done(await desk.place(isBuy, price, ethers.parseEther(qty)));
  for (const l of rc.logs) { try { const e = desk.interface.parseLog(l); if (e?.name === "OrderPlaced") console.log("orderId", String(e.args.orderId), "limit", Number(e.args.price) / 1e6); } catch {} }
} else if (cmd === "cancel") await done(await desk.cancel(BigInt(rest[0])));
else if (cmd === "approve") await done(await new ethers.Contract(d[rest[0]], erc, s).approve(d.desk, rest[1] === "max" ? ethers.MaxUint256 : 0n));
else if (cmd === "send") { const [tok, amt, to] = rest; await done(await new ethers.Contract(d[tok], erc, s).transfer(wallets[to].address, ethers.parseUnits(amt, tokDec(tok)))); }
else if (cmd === "call-cancel") {
  try { await p.call({ from: s.address, to: d.desk, data: desk.interface.encodeFunctionData("cancel", [BigInt(rest[0])]) }); console.log("call-cancel: no revert"); }
  catch (e) { const data = e.data || e.info?.error?.data; try { console.log("call-cancel reverts", desk.interface.parseError(data).name); } catch { console.log("call-cancel reverts", String(e.shortMessage || e.message).slice(0, 100)); } }
}
