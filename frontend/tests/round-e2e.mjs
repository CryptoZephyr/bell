// Runs one live round through the app with several test wallets at once, and records the evidence: when each ticket said
// Paid in the app, and what the chains did (bell, settled, collected, paid, swapped), so the two can be compared.
// Usage: SCENARIO='[{"who":"buyer1","chain":84532,"side":"buy","qty":"0.0005"},{"who":"seller2","chain":1301,"side":"sell","qty":"0.0005"}]' node tests/round-e2e.mjs <outDir>
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import { installWallet } from "./shim.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const { ethers } = require("ethers");
const rec = JSON.parse(fs.readFileSync(new URL("../../deployments/bell.json", import.meta.url), "utf8"));
const out = process.argv[2] || "round-out";
const base = process.env.BASE || "http://localhost:4173";
const scenario = JSON.parse(process.env.SCENARIO);
fs.mkdirSync(out, { recursive: true });
const t0 = Date.now();
const sec = () => ((Date.now() - t0) / 1000).toFixed(1);
const log = (...a) => console.log(`[${sec()}s]`, ...a);

const RPC = {
  84532: "https://base-sepolia-rpc.publicnode.com",
  1301: "https://sepolia.unichain.org", // logs: keeps history, allows 1000 blocks
  5318007: "https://lasna-rpc.rnk.dev/",
};
const STATE_RPC = { 84532: RPC[84532], 1301: "https://unichain-sepolia-rpc.publicnode.com", 5318007: RPC[5318007] };
const sprov = (id) => new ethers.JsonRpcProvider(STATE_RPC[id], undefined, { staticNetwork: true, batchMaxCount: 1 });
const retry = async (fn, n = 12) => { for (let i = 0; i < n; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 1500)); } throw new Error("still null after retries"); };
const prov = (id) => new ethers.JsonRpcProvider(RPC[id], undefined, { staticNetwork: true, batchMaxCount: 1 });
const deskOf = { 84532: rec.baseSepolia, 1301: rec.unichainSepolia };
const deskIface = new ethers.Interface([
  "event OrderPlaced(uint256 indexed orderId, address indexed trader, bool isBuy, uint256 price, uint256 qty)",
  "event Collected(uint256 indexed orderId, address indexed from, uint256 amount, bool ok)",
  "event Paid(uint256 indexed orderId, address indexed to, uint256 amount, bool ok)",
  "event Swapped(address indexed to, bool sellWeth, uint256 amountIn, uint256 amountUsed, uint256 amountOut, uint256 refunded, bool ok)",
  "event Refunded(uint256 indexed orderId, address indexed to, uint256 amount, bool ok)",
  "event Closed(uint256 indexed orderId, uint256 amount)",
]);
const refIface = new ethers.Interface([
  "event OrderAdded(uint256 indexed bookId, uint256 chainId, uint256 deskOrderId, address trader, bool isBuy)",
  "event OrderDropped(uint256 indexed bookId, string reason)",
  "event RoundOpened(uint256 price)",
  "event BellVoid(string reason)",
  "event BellRang(uint256 price, uint256 eligibleCount, uint256 pairCount)",
  "event Settled(uint256 price, uint256 pairCount)",
]);

const browser = await chromium.launch();
const people = [];
for (const s of scenario) {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const page = await ctx.newPage();
  const shim = await installWallet(page, s.who, s.chain);
  page.on("pageerror", (e) => log(s.who, "PAGE ERROR", e.message));
  people.push({ ...s, ctx, page, shim, paidAt: null, statusLog: [] });
}

// 1. connect on Activity first and count the tickets already there, then fill in the Trade form, all in parallel
await Promise.all(people.map(async (p) => {
  const { page } = p;
  await page.goto(base + "/#/activity");
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: /connect wallet/i }).first().click();
  await page.getByRole("button", { name: /test wallet/i }).click();
  await page.waitForSelector("article.ticket, .empty", { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2500);
  p.before = await page.locator("article.ticket").count();
  await page.goto(base + "/#/trade");
  await page.waitForFunction(() => /USDC|ETH/.test(document.querySelector(".chain-bal")?.textContent || ""), null, { timeout: 40000 });
  await page.getByRole("radio", { name: p.side === "buy" ? /Buy ETH/ : /Sell ETH/ }).check({ force: true });
  await page.getByRole("radio", { name: p.chain === 84532 ? /Base/ : /Unichain/ }).check({ force: true });
  if (p.prot) await page.getByRole("button", { name: new RegExp(p.prot) }).click();
  await page.locator("input.amount-input").fill(p.qty);
  await page.waitForTimeout(1500);
  const btn = page.locator("main .btn").last();
  p.stage = (await btn.innerText()).trim();
  log(p.who, `had ${p.before} tickets, ready, button says:`, p.stage);
}));

const notReady = people.filter((p) => !/join/i.test(p.stage));
if (notReady.length) { log("NOT READY:", notReady.map((p) => `${p.who}: ${p.stage}`).join(" | ")); for (const p of people) await p.page.screenshot({ path: `${out}/${p.who}-notready.png` }); await browser.close(); process.exit(3); }

// 2. place them all within a few seconds
const placed = Date.now();
await Promise.all(people.map(async (p) => {
  const btn = p.page.locator("main .btn").last();
  await btn.scrollIntoViewIfNeeded();
  const box = await btn.boundingBox();
  await p.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p.page.mouse.down();
  await p.page.waitForTimeout(800);
  await p.page.mouse.up();
  p.heldAt = Date.now();
}));
log("held all, waiting for the wallets to send");
await Promise.all(people.map(async (p) => {
  await p.page.waitForFunction(() => /Watch your bell|Nothing was sent|failed/i.test(document.querySelector("main")?.textContent || ""), null, { timeout: 90000 }).catch(() => {});
  p.placeTx = p.shim.log.at(-1)?.hash ?? null;
  p.confirmedAt = Date.now();
  log(p.who, "place tx", p.placeTx);
}));

// 3. Resolve each order id from its tx, then watch tickets in the app until all show Paid (or give up)
for (const p of people) {
  if (!p.placeTx) continue;
  const rc = await retry(() => sprov(p.chain).getTransactionReceipt(p.placeTx));
  for (const l of rc.logs) { try { const e = deskIface.parseLog(l); if (e?.name === "OrderPlaced") p.orderId = Number(e.args.orderId); } catch {} }
  p.placedBlockTs = (await retry(() => sprov(p.chain).getBlock(rc.blockNumber))).timestamp;
  await p.page.goto(base + "/#/activity");
}
const observer = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
await observer.goto(base + "/#/bell");
const obsLog = [];
const deadline = Date.now() + (Number(process.env.WAIT_S || 330)) * 1000;
let lastObs = "";
while (Date.now() < deadline) {
  const snap = (await observer.locator(".bell-card").first().innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  if (snap && snap.replace(/\d+:\d+|\d+ s/g, "#") !== lastObs.replace(/\d+:\d+|\d+ s/g, "#")) { obsLog.push({ t: Date.now(), text: snap.slice(0, 160) }); lastObs = snap; }
  for (const p of people) {
    const count = await p.page.locator("article.ticket").count();
    if (count <= p.before) continue; // our order is not listed yet, the first ticket is an older order
    if (!p.listedAt) { p.listedAt = Date.now(); log(p.who, "new ticket listed"); }
    const row = p.page.locator("article.ticket").first();
    const st = (await row.locator(".ticket-status").first().innerText().catch(() => "")).trim();
    if (st && st !== p.statusLog.at(-1)?.text) { p.statusLog.push({ t: Date.now(), text: st }); log(p.who, "ticket:", st); }
    if (/^(Paid|Cancelled|Removed|Expired|Refunded)/.test(st) && !p.paidAt) p.paidAt = Date.now();
  }
  if (people.every((p) => p.paidAt || !p.placeTx)) break;
  if (Date.now() > deadline) break;
  await observer.waitForTimeout(700);
}
for (let i = 0; i < 16; i++) { const snap = (await observer.locator(".bell-card").first().innerText().catch(() => "")).replace(/\s+/g, " ").trim(); if (snap && snap !== lastObs) { obsLog.push({ t: Date.now(), text: snap.slice(0, 160) }); lastObs = snap; } await observer.waitForTimeout(700); }
for (const p of people) await p.page.screenshot({ path: `${out}/${p.who}-activity.png`, fullPage: true });
await observer.screenshot({ path: `${out}/observer-bell.png`, fullPage: true });

// 4. chain evidence
const lasna = prov(5318007);
const lh = await lasna.getBlockNumber();
const lstart = lh - 700;
const rlogs = await lasna.getLogs({ address: rec.referee, fromBlock: lstart, toBlock: lh });
const ev = [];
for (const l of rlogs) {
  try { const e = refIface.parseLog(l); const ts = (await retry(() => lasna.getBlock(l.blockNumber))).timestamp; ev.push({ chain: "lasna", name: e.name, args: e.args.toArray().map(String).join(","), block: l.blockNumber, ts, tx: l.transactionHash }); } catch {}
}
for (const id of [84532, 1301]) {
  const pv = prov(id);
  const head = await pv.getBlockNumber();
  const span = id === 84532 ? 400 : 900;
  const logs = await pv.getLogs({ address: deskOf[id].desk, fromBlock: head - span, toBlock: head });
  for (const l of logs) {
    try { const e = deskIface.parseLog(l); const ts = (await retry(() => sprov(id).getBlock(l.blockNumber))).timestamp; ev.push({ chain: id, name: e.name, args: e.args.toArray().map(String).join(","), block: l.blockNumber, ts, tx: l.transactionHash }); } catch {}
  }
}
ev.sort((a, b) => a.ts - b.ts);
const first = Math.min(...people.map((p) => p.placedBlockTs).filter(Boolean)) - 5;
const mine = ev.filter((e) => e.ts >= first);
fs.writeFileSync(`${out}/evidence.json`, JSON.stringify({ people: people.map((p) => ({ who: p.who, before: p.before, listedAt: p.listedAt, chain: p.chain, side: p.side, qty: p.qty, orderId: p.orderId, placeTx: p.placeTx, placedBlockTs: Number(p.placedBlockTs), heldAt: p.heldAt, statusLog: p.statusLog, paidAt: p.paidAt })), events: mine, obsLog }, (k, v) => (typeof v === "bigint" ? String(v) : v), 2));
for (const e of mine) console.log(new Date(e.ts * 1000).toISOString().slice(11, 19), String(e.chain).padEnd(8), e.name.padEnd(12), e.args.slice(0, 70), e.tx.slice(0, 12));
for (const p of people) console.log(p.who, "order", p.orderId, "ticket log:", p.statusLog.map((s) => `${((s.t - placed) / 1000).toFixed(0)}s ${s.text}`).join(" > "));
console.log("observer:", obsLog.map((o) => `${((o.t - placed) / 1000).toFixed(0)}s ${o.text.slice(0, 60)}`).join("\n          "));
await browser.close();
