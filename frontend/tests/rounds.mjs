// Unit tests for the Rounds page's data layer (src/chain/rounds.ts). No network: every event set is made by hand.
// The rule under test: seconds are bell to a confirmed Paid or Swapped event, and a desk whose logs could not be read
// makes that chain "not readable". It is never shown as zero seconds and never shortens the round's total.
// Usage: node tests/rounds.mjs
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bell-rounds-")), "under-test.mjs");
await esbuild.build({
  stdin: { contents: 'export * from "./src/chain/rounds.ts";', resolveDir: path.join(here, ".."), loader: "ts" },
  bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "warning",
  alias: { "@deploy": path.join(here, "../../deployments") },
});
const { groupRounds, seedRound, assembleRound, summarize, foldSkipped, isCacheable } = await import(out);

let bad = 0, n = 0;
const check = (name, got, want) => {
  n++;
  const g = JSON.stringify(got, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  const w = JSON.stringify(want, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  if (g !== w) { bad++; console.log(`FAIL ${name}: got ${g}, want ${w}`); } else console.log(`ok   ${name}: ${g}`);
};

const BASE = 84532, UNI = 1301;
const A = "0x00000000000000000000000000000000000000a1"; // buyer
const B = "0x00000000000000000000000000000000000000b2"; // seller
const C = "0x00000000000000000000000000000000000000c3";
const tx = (s) => `0x${s.padStart(64, "0")}`;
const L = (name, block, t, ts, args = {}, idx = 0) => ({ name, block: BigInt(block), tx: tx(`${name}${block}${idx}`), ts, args, idx });
const sameTx = (e, t) => ({ ...e, tx: tx(t) });
const T0 = 10_000;
const price = 800_000_000n;

const bell = (extra = {}) => L("BellRang", 1000, 0, T0, { price, eligibleCount: 2n, pairCount: 1n, ...extra });
const settled = (block = 1002, ts = T0 + 2, pairs = 1n) => L("Settled", block, 0, ts, { price, pairCount: pairs });
const drop = (id, reason, block = 1002, ts = T0 + 2) => L("OrderDropped", block, 0, ts, { bookId: BigInt(id), reason }, Number(id));

const buyerBase = { bookId: 1n, chainId: BASE, deskOrderId: 7, trader: A, isBuy: true, limit: 900_000_000n, qty: 500_000_000_000_000n };
const sellerUni = { bookId: 2n, chainId: UNI, deskOrderId: 3, trader: B, isBuy: false, limit: 700_000_000n, qty: 500_000_000_000_000n };

const col = (id, ts, ok = true, from = A) => L("Collected", 5000 + ts, 0, ts, { orderId: BigInt(id), from, amount: 400_000n, ok });
const paid = (id, to, ts, amount, ok = true) => L("Paid", 6000 + ts, 0, ts, { orderId: BigInt(id), to, amount, ok });
const closed = (id, ts) => L("Closed", 7000 + ts, 0, ts, { orderId: BigInt(id), amount: 1n });

// ---- 1. One pair across two chains ----
{
  const seed = groupRounds([bell(), settled(), drop(1, "settled"), drop(2, "settled")])[0];
  const desks = [
    { chainId: BASE, ok: true, events: [col(7, T0 + 2), paid(3, B, T0 + 5, 400_000n), closed(7, T0 + 6)] },
    { chainId: UNI, ok: true, events: [col(3, T0 + 3, true, B), paid(7, A, T0 + 6, 500_000_000_000_000n), closed(3, T0 + 6)] },
  ];
  const r = assembleRound(seed, [buyerBase, sellerUni], desks);
  check("pair: outcome", r.outcome, "settled");
  check("pair: price and counts", [r.price, r.eligible, r.pairs], [price, 2, 1]);
  check("pair: bell to last payout", r.seconds, 6);
  const on = (id) => r.chains.find((c) => c.chainId === id);
  check("pair: Base last payout and pull", [on(BASE).pullSeconds, on(BASE).paidSeconds], [2, 5]);
  check("pair: Unichain last payout and pull", [on(UNI).pullSeconds, on(UNI).paidSeconds], [3, 6]);
  check("pair: both orders matched", r.orders.map((o) => o.result), ["matched", "matched"]);
  check("pair: complete", r.complete, true);
  check("pair: ledger is in time order", r.ledger.map((l) => l.seconds), [2, 3, 5, 6, 6, 6]);
}

// ---- 2. A buyer filled on the pool ----
{
  const seed = groupRounds([bell({ eligibleCount: 1n, pairCount: 0n }), settled(1002, T0 + 2, 0n), drop(1, "settled")])[0];
  const swapped = L("Swapped", 6100, 0, T0 + 4, { to: A, sellWeth: false, amountIn: 3_925_324n, amountUsed: 516_476n, amountOut: 646_864_038_275_667n, refunded: 3_408_848n, ok: true });
  const r = assembleRound(seed, [buyerBase], [{ chainId: BASE, ok: true, events: [col(7, T0 + 2), swapped, closed(7, T0 + 5)] }]);
  check("pool: result", r.orders[0].result, "pool");
  check("pool: seconds", r.seconds, 4);
  const pool = r.orders[0].legs.find((l) => l.kind === "pool");
  check("pool: used and returned", [pool.used, pool.returned], [516_476n, 3_408_848n]);
  check("pool: no pairs", r.pairs, 0);
}

// ---- 3. A failed pull: the others settle ----
{
  const failed = { ...buyerBase, bookId: 3n, deskOrderId: 9, trader: C };
  const seed = groupRounds([
    bell({ eligibleCount: 3n }), L("Unwound", 1002, 0, T0 + 2, { failedBookId: 3n }), drop(3, "pull failed"), settled(), drop(1, "settled"), drop(2, "settled"),
  ])[0];
  const desks = [
    { chainId: BASE, ok: true, events: [col(7, T0 + 2), col(9, T0 + 2, false, C), paid(3, B, T0 + 5, 400_000n), closed(7, T0 + 6)] },
    { chainId: UNI, ok: true, events: [col(3, T0 + 3, true, B), paid(7, A, T0 + 6, 500_000_000_000_000n), closed(3, T0 + 6)] },
  ];
  const r = assembleRound(seed, [buyerBase, sellerUni, failed], desks);
  check("failed pull: outcome", r.outcome, "unwound");
  check("failed pull: one unwound", r.unwound, 1);
  check("failed pull: the failed order is removed", r.orders.find((o) => o.bookId === 3n).result, "removed");
  check("failed pull: the others matched", r.orders.filter((o) => o.bookId !== 3n).map((o) => o.result), ["matched", "matched"]);
  check("failed pull: seconds still read", r.seconds, 6);
}

// ---- 4. A drift-guard skip ----
{
  const seeds = groupRounds([
    L("BellVoid", 2000, 0, T0, { reason: "previous round still settling" }),
    L("BellVoid", 2100, 0, T0 + 110, { reason: "drift guard: round skipped, orders carry" }),
  ]);
  check("skip: only the drift void is a round", seeds.length, 1);
  const r = seedRound(seeds[0]);
  check("skip: outcome and reason", [r.outcome, /drift/.test(r.reason)], ["skipped", true]);
  check("skip: no seconds", [r.seconds, r.price, r.eligible], [null, null, 0]);
  const run = foldSkipped([r, { ...r, key: "2200", bellBlock: 2200n }, { ...r, outcome: "settled", key: "2300" }]);
  check("skip: a run of skipped bells folds into one row", run.map((e) => [e.round.outcome, e.skippedRun]), [["skipped", 2], ["settled", 1]]);
}

// ---- 5. Expired orders only ----
{
  const exp = (id) => ({ ...drop(id, "expired", 3000, T0), tx: tx("expiry") });
  const seeds = groupRounds([exp(5), exp(6)]);
  check("expired: one row for the bell that dropped them", seeds.length, 1);
  const r = seedRound(seeds[0]);
  check("expired: outcome and count", [r.outcome, r.eligible], ["expired", 2]);
  // Expired drops inside a bell that also rang are not a separate round.
  const b = bell();
  const inBell = { ...drop(8, "expired", 1000, T0), tx: b.tx };
  check("expired: drops inside a ringing bell are not a separate round", groupRounds([b, inBell, settled()]).length, 1);
}

// ---- 6. A chain whose logs could not be read ----
{
  const seed = groupRounds([bell(), settled(), drop(1, "settled"), drop(2, "settled")])[0];
  const desks = [
    { chainId: BASE, ok: true, events: [col(7, T0 + 2), paid(3, B, T0 + 5, 400_000n), closed(7, T0 + 6)] },
    { chainId: UNI, ok: false, events: [] },
  ];
  const r = assembleRound(seed, [buyerBase, sellerUni], desks);
  const uni = r.chains.find((c) => c.chainId === UNI);
  check("unreadable: the chain is not readable", uni.readable, false);
  check("unreadable: its seconds are null, never 0", [uni.paidSeconds, uni.pullSeconds], [null, null]);
  check("unreadable: the round's seconds are unknown, not the shorter Base number", r.seconds, null);
  check("unreadable: the round is not complete", r.complete, false);
  check("unreadable: the buyer, paid on the unread chain, is unknown", r.orders.find((o) => o.bookId === 1n).result, "unknown");
  check("unreadable: the seller, paid on the read chain, is still matched", r.orders.find((o) => o.bookId === 2n).result, "matched");
  const none = assembleRound(seed, [buyerBase, sellerUni], [{ chainId: BASE, ok: false, events: [] }, { chainId: UNI, ok: false, events: [] }]);
  check("unreadable: both chains unread, nothing is claimed", [none.seconds, none.orders.map((o) => o.result)], [null, ["unknown", "unknown"]]);
}

// ---- 7. A lost delivery: the round is closed by a later bell ----
{
  const first = bell();
  const second = L("BellRang", 1400, 0, T0 + 440, { price, eligibleCount: 1n, pairCount: 0n });
  const late = [
    sameTx(L("PullsExpired", 1300, 0, T0 + 330, { roundId: 1n, missing: 1n }), "late"),
    sameTx(L("Unwound", 1300, 0, T0 + 330, { failedBookId: 1n }), "late"),
    sameTx(drop(1, "pull failed", 1300, T0 + 330), "late"),
    sameTx(settled(1300, T0 + 330, 0n), "late"),
  ];
  const seeds = groupRounds([first, second, ...late, drop(4, "settled", 1402, T0 + 442), L("Settled", 1402, 0, T0 + 442, { price, pairCount: 0n })]);
  check("lost delivery: two rounds", seeds.length, 2);
  const old = seeds.find((s) => s.block === 1000n);
  check("lost delivery: the expiry belongs to the first round", old.events.map((e) => e.name), ["BellRang", "PullsExpired", "Unwound", "Settled", "OrderDropped"]);
  check("lost delivery: the first round is unwound", seedRound(old).outcome, "unwound");
}

// ---- 8. A round that has not settled yet, and a payout on the trader's own desk ----
{
  const seed = groupRounds([bell()])[0];
  check("open: a bell with no Settled yet is open", seedRound(seed).outcome, "open");
  const both = { ...sellerUni, chainId: BASE, deskOrderId: 4 };
  const s2 = groupRounds([bell(), settled(), drop(1, "settled"), drop(2, "settled")])[0];
  const matchTx = tx("match"), dustTx = tx("dust");
  const ev = [
    { ...paid(7, A, T0 + 4, 500_000_000_000_000n), tx: matchTx },
    { ...paid(7, A, T0 + 5, 2n), tx: dustTx },
    paid(4, B, T0 + 4, 400_000n),
  ];
  const tokens = { [`${BASE}:${matchTx}:${A}`]: "WETH", [`${BASE}:${dustTx}:${A}`]: "USDC" };
  const r = assembleRound(s2, [buyerBase, both], [{ chainId: BASE, ok: true, events: ev }], tokens);
  const buyer = r.orders.find((o) => o.bookId === 1n);
  check("same chain: the match and the rounding refund are told apart", buyer.legs.map((l) => l.kind), ["payout", "rounding"]);
}

// ---- 9. Summary and cache rules ----
{
  const mk = (seconds, outcome = "settled") => ({ outcome, seconds, pairs: 1, eligible: 2, unwound: 0 });
  const s = summarize([mk(5), mk(9), mk(3), mk(null), mk(7, "skipped"), mk(6)]);
  check("summary: median of the rounds with read payouts", [s.counted, s.median, s.fastest, s.slowest], [4, 5.5, 3, 9]);
  check("summary: rounds, pairs and orders count settled rounds", [s.rounds, s.pairs, s.orders], [5, 5, 10]);
  check("summary: nothing read gives no median", summarize([mk(null)]).median, null);
  const done = { loaded: true, complete: true, kind: "bell", bellTs: 1000, outcome: "settled" };
  check("cache: a finished, complete round", isCacheable(done, 2000), true);
  check("cache: a round still inside 100 s is not cached", isCacheable(done, 1050), false);
  check("cache: a round whose payouts were not readable is not cached", isCacheable({ ...done, complete: false }, 2000), false);
  check("cache: an open round is not cached", isCacheable({ ...done, outcome: "open" }, 2000), false);
}

console.log(bad ? `${bad} failing` : `rounds: all ${n} checks pass`);
process.exit(bad ? 1 : 0);
