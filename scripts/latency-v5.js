// Latency of one round, read from block timestamps. Testnet only.
// Usage: node scripts/latency-v5.js <lasnaFromBlock> <baseFromBlock> <unichainFromBlock>
// Chain clocks differ by about 2 seconds, so every figure here is good to roughly that resolution.
const { ethers } = require("ethers");
const rec = require("../deployments/bell.json");
const ri = new ethers.Interface(require("../artifacts/contracts/BellReferee.sol/BellReferee.json").abi);
const di = new ethers.Interface(require("../artifacts/contracts/BellDesk.sol/BellDesk.json").abi);
const mk = (u) => new ethers.JsonRpcProvider(u, undefined, { staticNetwork: true, batchMaxCount: 1 });
const L = mk("https://lasna-rpc.rnk.dev/");
const B = mk("https://base-sepolia-rpc.publicnode.com");
const U = mk("https://sepolia.unichain.org");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tsCache = new Map();
const ts = async (p, n) => { const k = p._u + n; if (!tsCache.has(k)) { tsCache.set(k, Number((await p.getBlock(n)).timestamp)); await sleep(150); } return tsCache.get(k); };
L._u = "L"; B._u = "B"; U._u = "U";

async function logsOf(p, addr, iface, from, names) {
  const to = await p.getBlockNumber();
  const out = [];
  for (let f = from; f <= to; f += 100) {
    for (let a = 0; a < 4; a++) {
      try {
        const logs = await p.getLogs({ address: addr, fromBlock: f, toBlock: Math.min(f + 99, to) });
        for (const lg of logs) { try { const x = iface.parseLog(lg); if (names.includes(x.name)) out.push({ name: x.name, args: x.args, block: lg.blockNumber, tx: lg.transactionHash }); } catch {} }
        break;
      } catch { await sleep(1500); }
    }
    await sleep(200);
  }
  return out;
}

(async () => {
  const [lf, bf, uf] = process.argv.slice(2).map(Number);
  const lasna = await logsOf(L, rec.referee, ri, lf, ["OrderAdded", "BellRang", "Settled"]);
  const names = ["OrderPlaced", "Collected", "Paid", "Refunded", "Swapped", "Closed"];
  const desks = [["Base", B, await logsOf(B, rec.baseSepolia.desk, di, bf, names)], ["Unichain", U, await logsOf(U, rec.unichainSepolia.desk, di, uf, names)]];
  const bell = lasna.find((e) => e.name === "BellRang");
  const settled = lasna.find((e) => e.name === "Settled");
  if (!bell || !settled) { console.log("no completed round found in that range"); return; }
  const bellT = await ts(L, bell.block);
  const res = { bellBlock: bell.block, settledBlock: settled.block, eligible: Number(bell.args.eligibleCount), pairs: Number(bell.args.pairCount), orderToBook: [], pulls: [], payouts: {} };

  const placed = {};
  for (const [name, p, evs] of desks) for (const e of evs) if (e.name === "OrderPlaced") placed[name + ":" + e.args.orderId] = await ts(p, e.block);
  for (const e of lasna.filter((x) => x.name === "OrderAdded")) {
    const key = (Number(e.args.chainId) === 84532 ? "Base" : "Unichain") + ":" + e.args.deskOrderId;
    if (placed[key] !== undefined) res.orderToBook.push({ order: key, seconds: (await ts(L, e.block)) - placed[key] });
  }
  let firstPull = null, lastPayout = null;
  for (const [name, p, evs] of desks) {
    for (const e of evs.filter((x) => x.name === "Collected")) {
      const t = (await ts(p, e.block)) - bellT;
      res.pulls.push({ chain: name, order: e.args.orderId.toString(), ok: e.args.ok, secondsAfterBell: t });
      firstPull = firstPull === null ? t : Math.min(firstPull, t);
    }
    const pays = evs.filter((x) => ["Paid", "Refunded", "Swapped", "Closed"].includes(x.name));
    for (const e of pays) { const t = (await ts(p, e.block)) - bellT; lastPayout = lastPayout === null ? t : Math.max(lastPayout, t); res.payouts[name] = Math.max(res.payouts[name] ?? 0, t); }
  }
  res.bellToFirstPull = firstPull;
  res.bellToLastPayout = lastPayout;
  res.settledOnLasnaAfterBell = (await ts(L, settled.block)) - bellT;
  const firstPlaced = Math.min(...Object.values(placed));
  res.firstOrderToLastPayout = lastPayout === null ? null : bellT + lastPayout - firstPlaced;
  console.log(JSON.stringify(res, null, 2));
})().catch((e) => { console.error(String(e.shortMessage || e.message).slice(0, 300)); process.exitCode = 1; });
