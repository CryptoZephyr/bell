// Unit tests for when Bell may say "paid" (no network, pure functions):
// - decideOutcome (src/chain/payouts.ts): an order is paid only from a confirmed payout, never from desk accounting.
// - nodeState and roundPaidOut (src/chain/settle.ts): a chain says Paid only from confirmed payouts, after Lasna has
//   settled and the chain has gone quiet. The Lasna Settled event or a desk closing an order never does it alone.
// Usage: node tests/paid-truth.mjs
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bell-paid-truth-")), "under-test.mjs");
await esbuild.build({
  stdin: { contents: 'export * from "./src/chain/payouts.ts"; export * from "./src/chain/settle.ts";', resolveDir: path.join(here, ".."), loader: "ts" },
  bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "warning",
  alias: { "@deploy": path.join(here, "../../deployments") },
});
const { decideOutcome, PAYOUT_WINDOW_S, nodeState, roundPaidOut, QUIET_S } = await import(out);

const leg = (kind, token, ts = 1000) => ({ chainId: 84532, kind, token, amount: 1n, tx: "0x1", ts });
const legs = (l, complete = true) => ({
  collect: null, close: null, legs: l, complete,
  payouts: l.filter((x) => x.kind === "matched" || x.kind === "pool"),
  refunds: l.filter((x) => x.kind === "refund" || x.kind === "dust"),
});
const now = 1_000_000;
const recent = now - 30;
const old = now - (PAYOUT_WINDOW_S + 601);

const cases = [
  ["nothing pulled yet", { collected: 0n, closed: 0n, legs: null, placedTs: recent }, "open"],
  ["pulled, payout not landed yet", { collected: 5n, closed: 0n, legs: legs([]), placedTs: recent }, "open"],
  ["closed and paid on the other chain", { collected: 5n, closed: 5n, legs: legs([leg("matched", "WETH")]), placedTs: recent }, "settled"],
  ["paid before the desk closed the order", { collected: 5n, closed: 0n, legs: legs([leg("pool", "WETH")]), placedTs: recent }, "settled"],
  // The bug this fixes: closedOf == collectedOf after a refund used to read as paid.
  ["closed by a refund, nothing paid", { collected: 5n, closed: 5n, legs: legs([leg("refund", "USDC")]), placedTs: recent }, "refunded"],
  ["closed, only rounding came back", { collected: 5n, closed: 5n, legs: legs([leg("dust", "USDC")]), placedTs: recent }, "refunded"],
  ["paid, plus rounding back", { collected: 5n, closed: 5n, legs: legs([leg("matched", "WETH"), leg("dust", "USDC")]), placedTs: recent }, "settled"],
  ["closed, payout still landing", { collected: 5n, closed: 5n, legs: legs([]), placedTs: recent }, "open"],
  ["closed, logs could not be read", { collected: 5n, closed: 5n, legs: legs([], false), placedTs: recent }, "finished"],
  ["closed, legs read failed entirely", { collected: 5n, closed: 5n, legs: null, placedTs: recent }, "finished"],
  ["closed long ago, nothing found", { collected: 5n, closed: 5n, legs: legs([]), placedTs: old }, "finished"],
  ["refund landed but desk not closed yet", { collected: 5n, closed: 0n, legs: legs([leg("refund", "USDC")]), placedTs: recent }, "open"],
];

let bad = 0, n = 0;
const check = (name, got, want) => {
  n++;
  if (got !== want) { bad++; console.log(`FAIL ${name}: got ${got}, want ${want}`); }
  else console.log(`ok   ${name}: ${got}`);
};
for (const [name, input, want] of cases) check(`order: ${name}`, decideOutcome({ ...input, nowS: now }), want);

// Per-chain words while a round settles.
const nowMs = 2_000_000_000;
const lp = (o) => ({ chainId: 84532, collected: 0, payouts: 0, refunds: 0, closed: 0, lastTs: null, ...o });
const quietTs = nowMs / 1000 - (QUIET_S + 1);
const busyTs = nowMs / 1000 - 1;
const node = [
  ["no reading yet", undefined, true, "Waiting"],
  ["collected, Lasna not settled", lp({ collected: 1 }), false, "Collecting"],
  // The bug this fixes: Lasna Settled plus a desk Closed used to read as Paid with no payout at all.
  ["closed by the desk, no payout, Lasna settled", lp({ collected: 1, closed: 1 }), true, "Paying"],
  ["payout confirmed but more may land", lp({ payouts: 1, lastTs: busyTs }), true, "Paying"],
  ["payout confirmed, Lasna not settled", lp({ payouts: 1, lastTs: quietTs }), false, "Paying"],
  ["payout confirmed, settled, quiet", lp({ payouts: 2, lastTs: quietTs }), true, "Paid"],
  ["only a refund, settled, quiet", lp({ refunds: 1, lastTs: quietTs }), true, "Refunded"],
  ["nothing on this chain, settled", lp({}), true, "Nothing to pay here"],
];
for (const [name, l, settled, want] of node) check(`chain: ${name}`, nodeState(l, settled, nowMs).word, want);
check("chain: done only when Paid", nodeState(lp({ payouts: 1, lastTs: quietTs }), true, nowMs).done, true);
check("chain: never done from Closed alone", nodeState(lp({ closed: 3 }), true, nowMs).done, false);

// The round counts as paid out only when a payout or refund is confirmed and every chain that moved money is quiet.
check("round: no legs read", roundPaidOut(null, nowMs), false);
check("round: nothing confirmed", roundPaidOut([lp({ closed: 2 }), lp({ chainId: 1301 })], nowMs), false);
check("round: one chain still landing", roundPaidOut([lp({ payouts: 1, lastTs: quietTs }), lp({ chainId: 1301, payouts: 1, lastTs: busyTs })], nowMs), false);
check("round: all quiet", roundPaidOut([lp({ payouts: 1, lastTs: quietTs }), lp({ chainId: 1301, payouts: 1, lastTs: quietTs })], nowMs), true);

console.log(bad ? `${bad} failing` : `paid-truth: all ${n} checks pass`);
process.exit(bad ? 1 : 0);
