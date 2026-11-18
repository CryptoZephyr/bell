// Collects the chain evidence for rounds that were already placed. Usage: SINCE_TS=<unix seconds> node tests/evidence.mjs
// Prints every referee and desk event since that time, with its chain timestamp, in order.
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { ethers } = require("ethers");
const rec = JSON.parse(fs.readFileSync(new URL("../../deployments/bell.json", import.meta.url), "utf8"));
const since = Number(process.env.SINCE_TS);
const P = (u) => new ethers.JsonRpcProvider(u, undefined, { staticNetwork: true, batchMaxCount: 1 });
const lasna = P("https://lasna-rpc.rnk.dev/");
const nets = { 84532: { logs: P("https://base-sepolia-rpc.publicnode.com"), state: P("https://base-sepolia-rpc.publicnode.com"), d: rec.baseSepolia, span: 9000 }, 1301: { logs: P("https://sepolia.unichain.org"), state: P("https://unichain-sepolia-rpc.publicnode.com"), d: rec.unichainSepolia, span: 900 } };
const refI = new ethers.Interface(["event OrderAdded(uint256 indexed bookId, uint256 chainId, uint256 deskOrderId, address trader, bool isBuy)", "event OrderDropped(uint256 indexed bookId, string reason)", "event RoundOpened(uint256 price)", "event BellVoid(string reason)", "event BellRang(uint256 price, uint256 eligibleCount, uint256 pairCount)", "event Settled(uint256 price, uint256 pairCount)", "event Unwound(uint256 failedBookId)", "event PullsExpired(uint256 indexed roundId, uint256 missing)"]);
const deskI = new ethers.Interface(["event OrderPlaced(uint256 indexed orderId, address indexed trader, bool isBuy, uint256 price, uint256 qty)", "event OrderCancelled(uint256 indexed orderId, address indexed trader)", "event Collected(uint256 indexed orderId, address indexed from, uint256 amount, bool ok)", "event Paid(uint256 indexed orderId, address indexed to, uint256 amount, bool ok)", "event Swapped(address indexed to, bool sellWeth, uint256 amountIn, uint256 amountUsed, uint256 amountOut, uint256 refunded, bool ok)", "event Refunded(uint256 indexed orderId, address indexed to, uint256 amount, bool ok)", "event Closed(uint256 indexed orderId, uint256 amount)"]);
const wallets = JSON.parse(fs.readFileSync(process.env.HOME + "/.config/bell-testnet/wallets.json", "utf8"));
const names = Object.fromEntries(Object.entries(wallets).map(([k, v]) => [v.address.toLowerCase(), k]));
const retry = async (fn, n = 12) => { for (let i = 0; i < n; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 1500)); } throw new Error("null"); };
const fmt = (v) => (typeof v === "string" && v.startsWith("0x") && v.length === 42 ? names[v.toLowerCase()] ?? v.slice(0, 8) : String(v));
const ev = [];
const lh = await lasna.getBlockNumber();
for (const l of await lasna.getLogs({ address: rec.referee, fromBlock: lh - Math.min(9000, Math.ceil((Date.now() / 1000 - since) / 1.1) + 100), toBlock: lh })) {
  try { const e = refI.parseLog(l); const ts = (await retry(() => lasna.getBlock(l.blockNumber))).timestamp; ev.push({ chain: "lasna", name: e.name, args: e.args.toArray().map(fmt).join(","), block: l.blockNumber, ts, tx: l.transactionHash }); } catch {}
}
for (const [id, n] of Object.entries(nets)) {
  const head = Math.min(await n.state.getBlockNumber(), await n.logs.getBlockNumber());
  const hb = await n.state.getBlock(head - 300); const hh = await n.state.getBlock(head); const bt = Math.max(0.15, Number(hh.timestamp - hb.timestamp) / 300);
  const from = Math.max(0, head - Math.ceil((Date.now() / 1000 - since) / bt) - 100);
  for (let f = from; f <= head; f += n.span) {
    for (const l of await n.logs.getLogs({ address: n.d.desk, fromBlock: f, toBlock: Math.min(head, f + n.span - 1) })) {
      try { const e = deskI.parseLog(l); const ts = (await retry(() => n.state.getBlock(l.blockNumber))).timestamp; ev.push({ chain: id === "84532" ? "base" : "uni", name: e.name, args: e.args.toArray().map(fmt).join(","), block: l.blockNumber, ts, tx: l.transactionHash }); } catch {}
    }
  }
}
ev.sort((a, b) => a.ts - b.ts).filter((e) => e.ts >= since).forEach((e) => console.log(new Date(e.ts * 1000).toISOString().slice(11, 19), String(e.chain).padEnd(6), e.name.padEnd(12), e.args.slice(0, 80).padEnd(80), e.tx));
