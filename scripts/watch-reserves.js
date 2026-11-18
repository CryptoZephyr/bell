// Reserve alarm for the referee. A contract in debt stops hearing events, and every accepted order costs a reaction,
// so reserves are the one resource spam can drain. Testnet tooling only.
//   node scripts/watch-reserves.js                 checks every 60 s and prints a line each time
//   ONCE=1 MIN=1.0 node scripts/watch-reserves.js   checks once, exits 2 if reserves are under MIN or there is debt
// Env: MIN (REACT, default 1.0), INTERVAL (seconds, default 60), ONCE=1
const { ethers } = require("ethers");
const rec = require("../deployments/bell.json");
const SYSTEM = "0x8888888888888888888888888888888888888888";
const min = ethers.parseEther(process.env.MIN || "1.0");
const every = Number(process.env.INTERVAL || 60) * 1000;

async function check() {
  const p = new ethers.JsonRpcProvider("https://lasna-rpc.rnk.dev/", undefined, { staticNetwork: true, batchMaxCount: 1 });
  const sys = new ethers.Contract(SYSTEM, ["function reserves(address) view returns (uint256)", "function debts(address) view returns (uint256)"], p);
  const [reserves, debt] = await Promise.all([sys.reserves(rec.referee), sys.debts(rec.referee).catch(() => 0n)]);
  const low = reserves < min || debt > 0n;
  console.log(`${new Date().toISOString()} reserves ${ethers.formatEther(reserves)} REACT, debt ${ethers.formatEther(debt)}${low ? "  LOW: top up with scripts/top-up-reserves.js" : ""}`);
  return low;
}

(async () => {
  if (process.env.ONCE) { process.exitCode = (await check()) ? 2 : 0; return; }
  for (;;) { try { await check(); } catch (e) { console.log("check failed:", String(e.shortMessage || e.message).slice(0, 100)); } await new Promise((r) => setTimeout(r, every)); }
})();
