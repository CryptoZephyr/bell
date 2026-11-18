// Live test tooling for the v5 gates. Testnet only. Keys come from BELL_PRIVATE_KEY (main) and from the local
// wallets file (~/.config/bell-testnet/wallets.json), which is never in the repo.
//
//   node scripts/live-v5.js status
//   node scripts/live-v5.js approve <who> <base|unichain> <usdc|weth>
//   node scripts/live-v5.js send <to> <base|unichain> <usdc|eth|weth> <amount>      (from main)
//   node scripts/live-v5.js place <who> <base|unichain> <buy|sell> <limitUSDC> <qtyWETH>
//   node scripts/live-v5.js cancel <who> <base|unichain> <deskOrderId>
//   node scripts/live-v5.js revoke <who> <base|unichain> <usdc|weth>
//   node scripts/live-v5.js swap <buy|sell> <amount>        small swap on the Unichain reference pool (from main)
//   node scripts/live-v5.js push <price>                    move the Unichain reference pool to a price (from main)
//   node scripts/live-v5.js scan <lasnaFrom> <baseFrom> <unichainFrom>
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const rec = require("../deployments/bell.json");
const pools = require("../deployments/pools.json");
const refereeIface = new ethers.Interface(require("../artifacts/contracts/BellReferee.sol/BellReferee.json").abi);
const deskIface = new ethers.Interface(require("../artifacts/contracts/BellDesk.sol/BellDesk.json").abi);

const RPC = { base: "https://base-sepolia-rpc.publicnode.com", unichain: "https://sepolia.unichain.org", lasna: "https://lasna-rpc.rnk.dev/" };
const DESK = { base: rec.baseSepolia.desk, unichain: rec.unichainSepolia.desk };
const USDC = { base: rec.baseSepolia.usdc, unichain: rec.unichainSepolia.usdc };
const WETH = "0x4200000000000000000000000000000000000006";
const SYSTEM = "0x8888888888888888888888888888888888888888";
const MIN_SQRT = 4295128739n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (a) => JSON.stringify(a, (k, v) => (typeof v === "bigint" ? v.toString() : v));

const providers = {};
function provider(chain) {
  if (!providers[chain]) providers[chain] = new ethers.JsonRpcProvider(RPC[chain], undefined, { staticNetwork: true, batchMaxCount: 1 });
  return providers[chain];
}
function key(who) {
  if (who === "main") return process.env.BELL_PRIVATE_KEY;
  const f = path.join(process.env.HOME, ".config", "bell-testnet", "wallets.json");
  return JSON.parse(fs.readFileSync(f, "utf8"))[who].privateKey;
}
function addressOf(who) {
  if (who.startsWith("0x")) return who;
  if (who === "main") return new ethers.Wallet(key("main")).address;
  const f = path.join(process.env.HOME, ".config", "bell-testnet", "wallets.json");
  return JSON.parse(fs.readFileSync(f, "utf8"))[who].address;
}
const signer = (who, chain) => new ethers.Wallet(key(who), provider(chain));
const erc = (addr, s) =>
  new ethers.Contract(addr, ["function approve(address,uint256) returns (bool)", "function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function deposit() payable"], s);
const priceAtSqrt = (s) => ((10n ** 18n) << 192n) / (s * s);
function isqrt(n) {
  if (n < 2n) return n;
  let x = n, y = (n + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / y) / 2n; }
  return x;
}

async function unichainPoolSqrt() {
  const pmAddr = rec.unichainSepolia.poolManager;
  const base = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [rec.poolIdB, 6])));
  const pm = new ethers.Contract(pmAddr, ["function extsload(bytes32) view returns (bytes32)"], provider("unichain"));
  return BigInt(await pm.extsload(ethers.toBeHex(base, 32))) & ((1n << 160n) - 1n);
}

async function scan(p, addr, iface, from, names) {
  const to = await p.getBlockNumber();
  const out = [];
  for (let f = from; f <= to; f += 100) {
    for (let a = 0; a < 4; a++) {
      try {
        const logs = await p.getLogs({ address: addr, fromBlock: f, toBlock: Math.min(f + 99, to) });
        for (const lg of logs) {
          let x;
          try { x = iface.parseLog(lg); } catch { continue; }
          if (names.includes(x.name)) out.push(`[${lg.blockNumber}] ${x.name} ${fmt(x.args)} ${lg.transactionHash}`);
        }
        break;
      } catch (e) {
        if (a === 3) out.push("scan error at " + f);
        await sleep(1500);
      }
    }
    await sleep(250);
  }
  return out;
}

async function swapUnichain(s, zeroForOne, amount, limit) {
  const helper = new ethers.Contract(
    pools.unichainSepolia.poolSwapTest,
    ["function swap((address,address,uint24,int24,address),(bool,int256,uint160),(bool,bool),bytes) payable returns (int256)"],
    s
  );
  const k = [USDC.unichain, WETH, 500, 10, ethers.ZeroAddress];
  const tx = await helper.swap(k, [zeroForOne, -amount, limit], [false, false], "0x");
  const r = await tx.wait();
  return r.hash;
}

(async () => {
  const [cmd, a1, a2, a3, a4, a5] = process.argv.slice(2);
  if (cmd === "status") {
    const L = provider("lasna");
    const ref = new ethers.Contract(rec.referee, refereeIface.fragments, L);
    const sys = new ethers.Contract(SYSTEM, ["function reserves(address) view returns (uint256)", "function debts(address) view returns (uint256)"], L);
    const s = await unichainPoolSqrt();
    console.log("lasna block", await L.getBlockNumber());
    console.log("cronOn", await ref.cronOn(), "pulling", await ref.pulling(), "openPrice", (await ref.openPrice()).toString(), "settlePrice", (await ref.settlePrice()).toString(), "roundId", (await ref.roundId()).toString());
    console.log("reserves", ethers.formatEther(await sys.reserves(rec.referee)), "REACT, debt", ethers.formatEther(await sys.debts(rec.referee).catch(() => 0n)));
    console.log("Unichain reference pool price", Number(priceAtSqrt(s)) / 1e6, "USDC per WETH");
  } else if (cmd === "approve" || cmd === "revoke") {
    const s = signer(a1, a2);
    const t = erc(a3 === "usdc" ? USDC[a2] : WETH, s);
    const r = await (await t.approve(DESK[a2], cmd === "approve" ? ethers.MaxUint256 : 0n)).wait();
    console.log(cmd, a1, a2, a3, r.hash, "status", r.status);
  } else if (cmd === "send") {
    const s = signer("main", a2);
    const to = addressOf(a1);
    let tx;
    if (a3 === "eth") tx = await s.sendTransaction({ to, value: ethers.parseEther(a4) });
    else if (a3 === "usdc") tx = await erc(USDC[a2], s).transfer(to, BigInt(Math.round(Number(a4) * 1e6)));
    else tx = await erc(WETH, s).transfer(to, ethers.parseEther(a4));
    console.log("send", a3, a4, "to", a1, "on", a2, (await tx.wait()).hash);
  } else if (cmd === "place") {
    const s = signer(a1, a2);
    const desk = new ethers.Contract(DESK[a2], deskIface.fragments, s);
    const r = await (await desk.place(a3 === "buy", BigInt(Math.round(Number(a4) * 1e6)), ethers.parseEther(a5))).wait();
    const ev = r.logs.map((l) => { try { return deskIface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "OrderPlaced");
    console.log("place", a1, a2, a3, "deskOrderId", ev ? ev.args.orderId.toString() : "?", "block", r.blockNumber, r.hash);
  } else if (cmd === "cancel") {
    const s = signer(a1, a2);
    const desk = new ethers.Contract(DESK[a2], deskIface.fragments, s);
    const r = await (await desk.cancel(BigInt(a3))).wait();
    console.log("cancel", a1, a2, "order", a3, "block", r.blockNumber, r.hash, "status", r.status);
  } else if (cmd === "swap") {
    const s = signer("main", "unichain");
    for (const t of [erc(USDC.unichain, s), erc(WETH, s)]) await (await t.approve(pools.unichainSepolia.poolSwapTest, ethers.MaxUint256)).wait();
    const buy = a1 === "buy";
    const amount = buy ? BigInt(Math.round(Number(a2) * 1e6)) : ethers.parseEther(a2);
    console.log("swap", a1, a2, await swapUnichain(s, buy, amount, buy ? MIN_SQRT + 1n : MAX_SQRT - 1n));
  } else if (cmd === "push") {
    const s = signer("main", "unichain");
    for (const t of [erc(USDC.unichain, s), erc(WETH, s)]) await (await t.approve(pools.unichainSepolia.poolSwapTest, ethers.MaxUint256)).wait();
    const target = isqrt(((10n ** 18n) << 192n) / BigInt(Math.round(Number(a1) * 1e6)));
    const cur = await unichainPoolSqrt();
    if (cur > target) console.log("push up (buy WETH)", await swapUnichain(s, true, 30_000000n, target));
    else console.log("push down (sell WETH)", await swapUnichain(s, false, ethers.parseEther("0.03"), target));
    await sleep(4000);
    console.log("pool now", Number(priceAtSqrt(await unichainPoolSqrt())) / 1e6);
  } else if (cmd === "scan") {
    console.log("== LASNA referee");
    (await scan(provider("lasna"), rec.referee, refereeIface, Number(a1), ["RoundOpened", "BellRang", "BellVoid", "Settled", "Unwound", "PullsExpired", "Refunded", "Observed", "OrderAdded", "OrderDropped"])).forEach((x) => console.log(" ", x));
    console.log("== BASE desk");
    (await scan(provider("base"), DESK.base, deskIface, Number(a2), ["OrderPlaced", "OrderCancelled", "Collected", "Paid", "Swapped", "Refunded", "Closed"])).forEach((x) => console.log(" ", x));
    console.log("== UNICHAIN desk");
    (await scan(provider("unichain"), DESK.unichain, deskIface, Number(a3), ["OrderPlaced", "OrderCancelled", "Collected", "Paid", "Swapped", "Refunded", "Closed"])).forEach((x) => console.log(" ", x));
  } else {
    console.log(fs.readFileSync(__filename, "utf8").split("\n").slice(0, 14).join("\n"));
  }
})().catch((e) => { console.error(String(e.shortMessage || e.message).slice(0, 400)); process.exitCode = 1; });
