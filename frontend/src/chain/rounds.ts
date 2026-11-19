// The public record of rounds. Every number comes from the chains: Lasna for the round, the desks for the money.
// The pure part (grouping, assembling, summing) has no network in it, so it can be tested with hand-made events.
// The rule that matters most: seconds are bell to a confirmed Paid or Swapped event, from block timestamps. A desk whose
// logs can't be read makes that chain "not readable". It never shows as zero, and it never shortens the round's seconds.
import type { Address, Hex } from "viem";
import { client, logClient } from "./clients";
import { deskAbi, refereeAbi } from "./abi";
import { DESKS, DESK_CHAIN_IDS, LASNA_ID, REFEREE, REFEREE_BLOCK, type DeskChainId } from "./config";
import { gaveTokenOf, gotTokenOf, tokenSentTo, tsOf, type Token } from "./payouts";

// ---------------------------------------------------------------------------------------------------------- types

/** One event, from Lasna or from a desk, with its block timestamp where it is known. */
export type LogRec = { name: string; block: bigint; tx: Hex; ts: number | null; args: Record<string, any>; idx?: number };

export type RoundKind = "bell" | "skipped" | "expired";
export type RoundOutcome = "settled" | "unwound" | "skipped" | "expired" | "open";

/** A round as the referee tells it, before any desk has been read. */
export type RoundSeed = {
  kind: RoundKind;
  /** The Lasna block of the bell. Unique per round, so it is the round's id in the URL. */
  block: bigint;
  tx: Hex;
  ts: number | null;
  /** The Lasna events that belong to this round, oldest first. */
  events: LogRec[];
};

export type KnownOrder = { bookId: bigint; chainId: DeskChainId; deskOrderId: number; trader: Address; isBuy: boolean; limit: bigint; qty: bigint };

export type LegKind = "pull" | "payout" | "rounding" | "pool" | "poolfail" | "refund" | "close";
export type RoundLeg = {
  chainId: DeskChainId;
  kind: LegKind;
  tx: Hex;
  ts: number;
  /** Seconds after the bell. */
  seconds: number;
  amount: bigint | null;
  token: Token | null;
  /** The pool took this much of the input, and this much came back unused. */
  used?: bigint;
  returned?: bigint;
  ok: boolean;
  bookId: bigint | null;
};

export type OrderResult = "matched" | "matched and pool" | "pool" | "refunded" | "removed" | "unknown";
export type RoundOrder = KnownOrder & {
  result: OrderResult;
  /** The referee's reason when the order left the book in this round ("settled", "pull failed"). */
  reason: string | null;
  legs: RoundLeg[];
  /** The same wallet has another order on the same chain in this round, so a pool fill can't be told apart. */
  sharedPool: boolean;
};

export type ChainReading = {
  chainId: DeskChainId;
  /** False when the desk's logs could not be read. Nothing is claimed about that chain then. */
  readable: boolean;
  pullSeconds: number | null;
  paidSeconds: number | null;
};

export type Round = {
  key: string; // the bell's Lasna block, as text
  kind: RoundKind;
  outcome: RoundOutcome;
  /** For a skipped round, the referee's reason. */
  reason: string | null;
  bellBlock: bigint;
  bellTx: Hex;
  bellTs: number | null;
  price: bigint | null;
  eligible: number;
  pairs: number;
  settleTx: Hex | null;
  settleTs: number | null;
  /** How many orders were removed because their pull failed. */
  unwound: number;
  /** The desks have been read for this round (orders, chains and ledger are filled in). */
  loaded: boolean;
  orders: RoundOrder[];
  chains: ChainReading[];
  ledger: RoundLeg[];
  /** Bell to the last confirmed payout over all chains. Null if unknown, never a guess. */
  seconds: number | null;
  /** Every chain this round touched was read, so nothing in the numbers is missing. */
  complete: boolean;
};

// ----------------------------------------------------------------------------------------------- grouping (pure)

const isDrift = (r: unknown) => /drift/i.test(String(r ?? ""));
const sortLogs = (a: LogRec, b: LogRec) => (a.block === b.block ? (a.idx ?? 0) - (b.idx ?? 0) : a.block < b.block ? -1 : 1);
const ROUND_DROPS = new Set(["settled", "pull failed", "expired"]);

/**
 * Turns the referee's events into rounds, newest first. A round starts at BellRang. A drift-guard BellVoid is a skipped
 * round. A bell that only expired old orders (the book emptied, so no BellRang) is an expired round. The events after a
 * BellRang (Settled, Unwound, PullsExpired and the drops) belong to the latest BellRang before them. Other void reasons
 * (for example "previous round still settling") are not rounds.
 */
export function groupRounds(logs: LogRec[]): RoundSeed[] {
  const all = [...logs].sort(sortLogs);
  const bellTxs = new Set(all.filter((l) => l.name === "BellRang").map((l) => l.tx));
  const seeds: RoundSeed[] = [];
  for (const l of all) {
    if (l.name === "BellRang") seeds.push({ kind: "bell", block: l.block, tx: l.tx, ts: l.ts, events: [l] });
    else if (l.name === "BellVoid" && isDrift(l.args.reason)) seeds.push({ kind: "skipped", block: l.block, tx: l.tx, ts: l.ts, events: [l] });
    else if (l.name === "OrderDropped" && l.args.reason === "expired" && !bellTxs.has(l.tx)) {
      const same = seeds.find((s) => s.kind === "expired" && s.tx === l.tx);
      if (same) same.events.push(l);
      else seeds.push({ kind: "expired", block: l.block, tx: l.tx, ts: l.ts, events: [l] });
    }
  }
  const bells = seeds.filter((s) => s.kind === "bell");
  for (const l of all) {
    if (l.name === "BellRang") continue;
    const takes = l.name === "Settled" || l.name === "Unwound" || l.name === "PullsExpired" || (l.name === "OrderDropped" && ROUND_DROPS.has(String(l.args.reason)));
    if (!takes) continue;
    if (l.name === "OrderDropped" && l.args.reason === "expired" && !bellTxs.has(l.tx)) continue; // belongs to an expired round
    let owner: RoundSeed | null = null;
    for (const s of bells) if (s.block <= l.block) owner = s;
    if (owner) owner.events.push(l);
  }
  for (const s of seeds) s.events.sort(sortLogs);
  return seeds.sort((a, b) => (a.block === b.block ? 0 : a.block > b.block ? -1 : 1));
}

/** A round's facts from the referee's events alone. Everything about money on the desks is filled in later. */
export function seedRound(seed: RoundSeed): Round {
  const ev = (n: string) => seed.events.filter((e) => e.name === n);
  const bell = ev("BellRang")[0];
  const settled = ev("Settled")[0];
  const unwound = ev("Unwound").length;
  const void0 = ev("BellVoid")[0];
  let outcome: RoundOutcome;
  if (seed.kind === "skipped") outcome = "skipped";
  else if (seed.kind === "expired") outcome = "expired";
  else if (!settled) outcome = "open";
  else outcome = unwound > 0 ? "unwound" : "settled";
  return {
    key: seed.block.toString(), kind: seed.kind, outcome,
    reason: seed.kind === "skipped" ? String(void0?.args.reason ?? "") : seed.kind === "expired" ? "expired" : null,
    bellBlock: seed.block, bellTx: seed.tx, bellTs: seed.ts,
    price: bell ? (bell.args.price as bigint) : null,
    eligible: bell ? Number(bell.args.eligibleCount) : seed.kind === "expired" ? seed.events.length : 0,
    pairs: settled ? Number(settled.args.pairCount) : bell ? Number(bell.args.pairCount) : 0,
    settleTx: settled?.tx ?? null, settleTs: settled?.ts ?? null,
    unwound,
    loaded: seed.kind !== "bell", orders: [], chains: [], ledger: [], seconds: null,
    complete: seed.kind !== "bell",
  };
}

/** Book ids that left the book in this round because they settled or their pull failed. These are the round's orders. */
export function roundBookIds(seed: RoundSeed): { bookId: bigint; reason: string }[] {
  return seed.events
    .filter((e) => e.name === "OrderDropped" && (e.args.reason === "settled" || e.args.reason === "pull failed"))
    .map((e) => ({ bookId: e.args.bookId as bigint, reason: String(e.args.reason) }));
}

// ---------------------------------------------------------------------------------------------- assembling (pure)

export type DeskRead = { chainId: DeskChainId; ok: boolean; events: LogRec[]; /** Why a read failed, for diagnosis. Never shown as a number. */ error?: string };

const eqAddr = (a: unknown, b: string) => String(a).toLowerCase() === b.toLowerCase();

/**
 * Builds the full round from the referee's events, the orders in it and what each desk reported.
 * `tokens` maps "chainId:tx:wallet" to the token that reached that wallet, for payouts the events alone can't classify
 * (a payout on the trader's own desk can be the match or a rounding refund). Without it such a payout is simply "payout".
 */
export function assembleRound(seed: RoundSeed, orders: KnownOrder[], desks: DeskRead[], tokens: Record<string, Token | null> = {}): Round {
  const base = seedRound(seed);
  if (seed.kind !== "bell") return base;
  const bellTs = seed.ts;
  if (bellTs === null) return { ...base, loaded: true, complete: false };

  const drops = roundBookIds(seed);
  const byBook = new Map(orders.map((o) => [o.bookId.toString(), o]));
  const readable = new Map<DeskChainId, DeskRead>(desks.map((d) => [d.chainId, d]));
  const involved = new Set<DeskChainId>(drops.map((d) => byBook.get(d.bookId.toString())?.chainId).filter((c): c is DeskChainId => c !== undefined));
  const roundOrders: RoundOrder[] = [];
  const ledger: RoundLeg[] = [];

  const secs = (ts: number) => Math.max(0, ts - bellTs);
  const inWindow = (e: LogRec) => e.ts !== null && e.ts >= bellTs - 2;
  const deskEvents = (c: DeskChainId) => (readable.get(c)?.ok ? readable.get(c)!.events.filter(inWindow) : []);

  for (const d of drops) {
    const o = byBook.get(d.bookId.toString());
    if (!o) continue;
    const legs: RoundLeg[] = [];
    const own = deskEvents(o.chainId);
    const sameChainSameTrader = drops.filter((x) => {
      const y = byBook.get(x.bookId.toString());
      return y && y.bookId !== o.bookId && y.chainId === o.chainId && eqAddr(y.trader, o.trader);
    }).length > 0;

    for (const e of own) {
      if (e.name === "Collected" && Number(e.args.orderId) === o.deskOrderId) legs.push({ chainId: o.chainId, kind: "pull", tx: e.tx, ts: e.ts!, seconds: secs(e.ts!), amount: e.args.amount as bigint, token: gaveTokenOf(o.isBuy), ok: Boolean(e.args.ok), bookId: o.bookId });
      if (e.name === "Closed" && Number(e.args.orderId) === o.deskOrderId) legs.push({ chainId: o.chainId, kind: "close", tx: e.tx, ts: e.ts!, seconds: secs(e.ts!), amount: e.args.amount as bigint, token: null, ok: true, bookId: o.bookId });
      if (e.name === "Refunded" && Number(e.args.orderId) === o.deskOrderId && eqAddr(e.args.to, o.trader)) legs.push({ chainId: o.chainId, kind: "refund", tx: e.tx, ts: e.ts!, seconds: secs(e.ts!), amount: e.args.amount as bigint, token: gaveTokenOf(o.isBuy), ok: Boolean(e.args.ok), bookId: o.bookId });
      if (e.name === "Swapped" && eqAddr(e.args.to, o.trader)) {
        const out = e.args.amountOut as bigint;
        if (e.args.ok === true && out > 0n) legs.push({ chainId: o.chainId, kind: "pool", tx: e.tx, ts: e.ts!, seconds: secs(e.ts!), amount: out, token: gotTokenOf(o.isBuy), used: e.args.amountUsed as bigint, returned: e.args.refunded as bigint, ok: true, bookId: o.bookId });
        else if (e.args.ok !== true) legs.push({ chainId: o.chainId, kind: "poolfail", tx: e.tx, ts: e.ts!, seconds: secs(e.ts!), amount: e.args.amountIn as bigint, token: gaveTokenOf(o.isBuy), ok: false, bookId: o.bookId });
      }
    }
    // Payouts can land on either desk. A Paid names the receiver's own desk order id, so it ties to this order exactly.
    for (const c of DESK_CHAIN_IDS) {
      for (const e of deskEvents(c)) {
        if (e.name !== "Paid" || !eqAddr(e.args.to, o.trader) || e.args.ok !== true) continue;
        const id = Number(e.args.orderId);
        const amount = e.args.amount as bigint;
        if (id === 0) { // a failed pool swap, returned to the trader on their own desk
          if (c === o.chainId) legs.push({ chainId: c, kind: "refund", tx: e.tx, ts: e.ts!, seconds: secs(e.ts!), amount, token: gaveTokenOf(o.isBuy), ok: true, bookId: o.bookId });
          continue;
        }
        if (id !== o.deskOrderId) continue;
        if (c !== o.chainId) { legs.push({ chainId: c, kind: "payout", tx: e.tx, ts: e.ts!, seconds: secs(e.ts!), amount, token: gotTokenOf(o.isBuy), ok: true, bookId: o.bookId }); continue; }
        const t = tokens[`${c}:${e.tx}:${o.trader.toLowerCase()}`] ?? null;
        legs.push({ chainId: c, kind: t === gaveTokenOf(o.isBuy) ? "rounding" : "payout", tx: e.tx, ts: e.ts!, seconds: secs(e.ts!), amount, token: t, ok: true, bookId: o.bookId });
      }
    }
    legs.sort((a, b) => a.ts - b.ts);
    const hasMatch = legs.some((l) => l.kind === "payout");
    const hasPool = legs.some((l) => l.kind === "pool");
    const hasRefund = legs.some((l) => l.kind === "refund");
    // What was found is true even if another chain could not be read. What was not found only proves something when
    // every chain this round touched was read.
    const everyRead = [...involved].every((c) => readable.get(c)?.ok === true);
    let result: OrderResult = "unknown";
    if (hasMatch && hasPool) result = "matched and pool";
    else if (hasMatch) result = "matched";
    else if (hasPool) result = "pool";
    else if (hasRefund) result = "refunded";
    else if (everyRead && d.reason === "pull failed") result = "removed";
    roundOrders.push({ ...o, result, reason: d.reason, legs, sharedPool: sameChainSameTrader });
    ledger.push(...legs);
  }

  // Per chain. A chain counts as readable only when its desk read worked. A chain with a working read and no events in
  // the window simply paid nothing there. Seconds on a chain are the last payout that landed on it.
  const chains: ChainReading[] = [...involved].sort((x, y) => x - y).map((c) => {
    const ok = readable.get(c)?.ok === true;
    const here = ledger.filter((l) => l.chainId === c);
    const pulls = here.filter((l) => l.kind === "pull").map((l) => l.seconds);
    const paid = here.filter((l) => l.kind === "payout" || l.kind === "rounding" || l.kind === "pool").map((l) => l.seconds);
    return { chainId: c, readable: ok, pullSeconds: ok && pulls.length ? Math.max(...pulls) : null, paidSeconds: ok && paid.length ? Math.max(...paid) : null };
  });

  const allRead = chains.length > 0 && chains.every((c) => c.readable);
  const paidAll = chains.map((c) => c.paidSeconds).filter((s): s is number => s !== null);
  // A pool fill shared by two orders of one wallet is one transaction, so it appears once.
  const seen = new Set<string>();
  const unique = ledger.filter((l) => { const k = `${l.chainId}:${l.tx}:${l.kind}:${l.amount}`; if (seen.has(k)) return false; seen.add(k); return true; });
  unique.sort((a, b) => a.ts - b.ts);
  const finished = base.outcome === "settled" || base.outcome === "unwound";
  return {
    ...base, loaded: true, orders: roundOrders, chains, ledger: unique,
    seconds: allRead && finished && paidAll.length ? Math.max(...paidAll) : null,
    complete: allRead && finished,
  };
}

// ---------------------------------------------------------------------------------------------- summary (pure)

export type Summary = {
  /** Rounds that settled and whose payouts were read. */
  counted: number;
  median: number | null;
  fastest: number | null;
  slowest: number | null;
  rounds: number;
  pairs: number;
  orders: number;
};

/** The speed summary, from the rounds loaded so far. Rounds whose payouts were not read are left out of the seconds. */
export function summarize(rounds: Round[]): Summary {
  const settled = rounds.filter((r) => r.outcome === "settled" || r.outcome === "unwound");
  const secs = settled.map((r) => r.seconds).filter((s): s is number => s !== null).sort((a, b) => a - b);
  const mid = secs.length ? (secs.length % 2 ? secs[(secs.length - 1) / 2] : (secs[secs.length / 2 - 1] + secs[secs.length / 2]) / 2) : null;
  return {
    counted: secs.length, median: mid, fastest: secs.length ? secs[0] : null, slowest: secs.length ? secs[secs.length - 1] : null,
    rounds: settled.length, pairs: settled.reduce((s, r) => s + r.pairs, 0), orders: settled.reduce((s, r) => s + Math.max(0, r.eligible - r.unwound), 0),
  };
}

/**
 * What the round paired and what went to the pool, from confirmed payouts only. `pairedEth` is what the buyers were paid by
 * matches. It is null when a payout on a trader's own desk could not be told from a rounding refund yet.
 */
export function matchFacts(r: Round): { pairedEth: bigint | null; poolEth: bigint; poolUsdc: bigint } {
  let paired = 0n, unknown = false, poolEth = 0n, poolUsdc = 0n;
  const seen = new Set<string>();
  for (const o of r.orders) {
    for (const l of o.legs) {
      if (l.kind === "payout" && o.isBuy) { if (l.token === "WETH" && l.amount !== null) paired += l.amount; else unknown = true; }
      if (l.kind === "pool" && l.amount !== null) {
        const k = `${l.tx}`; if (seen.has(k)) continue; seen.add(k);
        if (l.token === "WETH") poolEth += l.amount; else poolUsdc += l.amount;
      }
    }
  }
  return { pairedEth: unknown ? null : paired, poolEth, poolUsdc };
}

/** Folds runs of skipped rounds into one entry for the list, so a long price jump does not fill the page. */
export type ListEntry = { round: Round; skippedRun: number };
export function foldSkipped(rounds: Round[]): ListEntry[] {
  const out: ListEntry[] = [];
  for (const r of rounds) {
    const prev = out[out.length - 1];
    if (r.outcome === "skipped" && prev && prev.round.outcome === "skipped") { prev.skippedRun++; continue; }
    out.push({ round: r, skippedRun: 1 });
  }
  return out;
}

// -------------------------------------------------------------------------------------------------------- readers

const REF_EVENTS = ["BellRang", "BellVoid", "Settled", "Unwound", "PullsExpired", "OrderDropped"];
const refEventAbi = refereeAbi.filter((x) => x.type === "event" && REF_EVENTS.includes(x.name));
const WINDOW = 9000n; // Lasna accepts about 10,000 blocks per log query, so one window is one request

async function readWindow(from: bigint, to: bigint): Promise<LogRec[]> {
  const logs = await logClient(LASNA_ID).getLogs({ address: REFEREE, events: refEventAbi as any, fromBlock: from, toBlock: to });
  return (logs as any[]).map((l) => ({ name: l.eventName, block: l.blockNumber, tx: l.transactionHash, ts: null, idx: Number(l.logIndex ?? 0), args: (l.args ?? {}) as Record<string, any> }));
}

/** The referee's round events between two blocks, in windows the RPC accepts, a few at a time. */
async function readRef(from: bigint, to: bigint): Promise<LogRec[]> {
  const jobs: [bigint, bigint][] = [];
  for (let f = from; f <= to; f += WINDOW) jobs.push([f, f + WINDOW - 1n > to ? to : f + WINDOW - 1n]);
  const parts: LogRec[][] = new Array(jobs.length);
  let next = 0;
  const worker = async () => { while (next < jobs.length) { const i = next++; parts[i] = await readWindow(jobs[i][0], jobs[i][1]); } };
  await Promise.all([worker(), worker(), worker()]);
  return parts.flat();
}

/** Block timestamps for the events that need them, which is only the bell, settle, void and expiry blocks. */
async function stamp(seeds: RoundSeed[]): Promise<void> {
  const need = new Set<bigint>();
  for (const s of seeds) for (const e of s.events) if (e.name === "BellRang" || e.name === "Settled" || e.name === "BellVoid" || e.name === "OrderDropped" || e.name === "PullsExpired") need.add(e.block);
  const blocks = [...need];
  const ts = new Map<bigint, number>();
  let i = 0;
  const worker = async () => { while (i < blocks.length) { const b = blocks[i++]; ts.set(b, await tsOf(LASNA_ID, b)); } };
  await Promise.all([worker(), worker(), worker(), worker()]);
  for (const s of seeds) { s.ts = ts.get(s.block) ?? null; for (const e of s.events) e.ts = ts.get(e.block) ?? null; }
}

export type Scan = { seeds: RoundSeed[]; /** Pass this back to load older rounds. Null once the first block of the referee is reached. */ cursor: bigint | null };

/**
 * Reads the referee's events newest first until `want` rounds are found. Two windows are read at a time, and `onProgress`
 * gets the rounds found so far, so the page can paint rows while the older windows are still loading.
 */
export async function scanRounds(upTo: bigint | null, want = 20, onProgress?: (seeds: RoundSeed[]) => void): Promise<Scan> {
  const head = upTo ?? (await client(LASNA_ID).getBlockNumber());
  let to = head;
  let acc: LogRec[] = [];
  let seeds: RoundSeed[] = [];
  while (to >= REFEREE_BLOCK) {
    const w = (hi: bigint): [bigint, bigint] => [hi - WINDOW + 1n < REFEREE_BLOCK ? REFEREE_BLOCK : hi - WINDOW + 1n, hi];
    const first = w(to);
    const second: [bigint, bigint] | null = first[0] > REFEREE_BLOCK ? w(first[0] - 1n) : null;
    const got = await Promise.all([readWindow(...first), second ? readWindow(...second) : Promise.resolve([] as LogRec[])]);
    acc = acc.concat(got[0], got[1]);
    const lowest = second ? second[0] : first[0];
    seeds = groupRounds(acc);
    // One more than asked for, so the oldest round kept has every event it owns.
    const enough = seeds.length > want;
    const atStart = lowest <= REFEREE_BLOCK;
    if (enough || atStart) {
      const keep = enough ? seeds.slice(0, want) : seeds;
      await stamp(keep);
      return { seeds: keep, cursor: enough ? keep[keep.length - 1].block : null };
    }
    if (onProgress && seeds.length) { const part = seeds.slice(0, want); await stamp(part); onProgress(part); }
    to = lowest - 1n;
  }
  await stamp(seeds);
  return { seeds, cursor: null };
}

/** Rounds that rang after a known block, for the page's own polling. Re-reads a little before it, so a settling round updates. */
export async function scanNewer(afterBlock: bigint): Promise<RoundSeed[]> {
  const head = await client(LASNA_ID).getBlockNumber();
  const from = afterBlock > 450n ? afterBlock - 450n : 0n;
  const seeds = groupRounds(await readRef(from < REFEREE_BLOCK ? REFEREE_BLOCK : from, head));
  await stamp(seeds);
  return seeds;
}

/** One round by its bell block. Reads the referee from the bell to long enough after it for a lost delivery to expire. */
export async function seedAt(block: bigint): Promise<RoundSeed | null> {
  const head = await client(LASNA_ID).getBlockNumber();
  const to = block + 450n > head ? head : block + 450n;
  const from = block > 5n ? block - 5n : block;
  const seeds = groupRounds(await readRef(from, to));
  const seed = seeds.find((x) => x.block === block) ?? null;
  if (seed) await stamp([seed]);
  return seed;
}

// ---- the orders in a round (the referee keeps the record after an order leaves the book) ----

const orderCache = new Map<string, KnownOrder>();
export async function readOrders(bookIds: bigint[]): Promise<KnownOrder[]> {
  const c = client(LASNA_ID);
  return Promise.all(bookIds.map(async (id) => {
    const k = id.toString();
    const hit = orderCache.get(k);
    if (hit) return hit;
    const o = (await c.readContract({ address: REFEREE, abi: refereeAbi, functionName: "orders", args: [id] })) as readonly [Address, number, boolean, boolean, number, bigint, bigint];
    const rec: KnownOrder = { bookId: id, trader: o[0], chainId: Number(o[1]) as DeskChainId, deskOrderId: Number(o[4]), isBuy: o[2], limit: o[5], qty: o[6] };
    orderCache.set(k, rec);
    return rec;
  }));
}

// ---- finding the block at a time on a desk chain, by interpolation between blocks already seen ----

const samples = new Map<number, { b: bigint; t: number }[]>();
function note(chainId: number, b: bigint, t: number) {
  const arr = samples.get(chainId) ?? [];
  if (!arr.some((s) => s.b === b)) { arr.push({ b, t }); arr.sort((x, y) => (x.b < y.b ? -1 : 1)); }
  samples.set(chainId, arr);
}
async function sampleBlock(chainId: number, b: bigint): Promise<number> {
  const t = Number((await client(chainId).getBlock({ blockNumber: b })).timestamp);
  note(chainId, b, t);
  return t;
}

/** A block at or just before a moment (within `slack` blocks), found from block timestamps. Never assumes a block time. */
export async function blockNear(chainId: DeskChainId, ts: number, slack = 20n): Promise<bigint> {
  const c = client(chainId);
  const head = await c.getBlockNumber();
  if (!(samples.get(chainId) ?? []).some((s) => s.b === head)) await sampleBlock(chainId, head);
  let lo = DESKS[chainId].deskBlock;
  if (!(samples.get(chainId) ?? []).some((s) => s.b === lo)) await sampleBlock(chainId, lo);
  for (let i = 0; i < 40; i++) {
    const arr = samples.get(chainId)!;
    const below = [...arr].reverse().find((s) => s.t < ts) ?? arr[0];
    const above = arr.find((s) => s.t >= ts && s.b > below.b) ?? arr[arr.length - 1];
    if (above.b - below.b <= slack) return below.b;
    let guess = below.b + BigInt(Math.floor(Number(above.b - below.b) * ((ts - below.t) / Math.max(1, above.t - below.t))));
    if (i > 6) guess = below.b + (above.b - below.b) / 2n; // interpolation is stalling, bisect
    if (guess <= below.b) guess = below.b + 1n;
    if (guess >= above.b) guess = above.b - 1n;
    await sampleBlock(chainId, guess);
  }
  return samples.get(chainId)![0].b;
}

export async function readDesk(chainId: DeskChainId, fromTs: number, toTs: number): Promise<DeskRead> {
  try {
    const [from, to] = await Promise.all([blockNear(chainId, fromTs - 3), blockNear(chainId, toTs + 3)]);
    const head = await client(chainId).getBlockNumber();
    const hi = to + 80n > head ? head : to + 80n;
    const logs = await logClient(chainId).getContractEvents({ address: DESKS[chainId].desk, abi: deskAbi, fromBlock: from, toBlock: hi });
    const keep = (logs as any[]).filter((l) => ["Collected", "Paid", "Swapped", "Refunded", "Closed"].includes(l.eventName));
    const out: LogRec[] = [];
    let i = 0;
    const worker = async () => {
      while (i < keep.length) {
        const l = keep[i++];
        out.push({ name: l.eventName, block: l.blockNumber, tx: l.transactionHash, ts: await tsOf(chainId, l.blockNumber), idx: Number(l.logIndex ?? 0), args: (l.args ?? {}) as Record<string, any> });
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return { chainId, ok: true, events: out };
  } catch (e) {
    return { chainId, ok: false, events: [], error: String((e as Error)?.message ?? e).slice(0, 160) };
  }
}

/** Payouts on a trader's own desk can be the match or a rounding refund. The token that arrived tells them apart. */
async function resolveTokens(seed: RoundSeed, orders: KnownOrder[], desks: DeskRead[]): Promise<Record<string, Token | null>> {
  const out: Record<string, Token | null> = {};
  const wanted: [DeskChainId, Hex, Address][] = [];
  const bell = seed.ts ?? 0;
  for (const d of desks) {
    if (!d.ok) continue;
    for (const e of d.events) {
      if (e.name !== "Paid" || e.args.ok !== true || Number(e.args.orderId) === 0 || e.ts === null || e.ts < bell - 2) continue;
      const o = orders.find((x) => x.chainId === d.chainId && x.deskOrderId === Number(e.args.orderId) && x.trader.toLowerCase() === String(e.args.to).toLowerCase());
      if (o) wanted.push([d.chainId, e.tx, o.trader]);
    }
  }
  await Promise.all(wanted.map(async ([c, tx, who]) => { try { out[`${c}:${tx}:${who.toLowerCase()}`] = await tokenSentTo(c, tx, who); } catch { /* left unknown */ } }));
  return out;
}

/** Reads the orders and the desks for one round and assembles it. */
export async function loadRound(seed: RoundSeed, opts: { tokens?: boolean } = {}): Promise<Round> {
  if (seed.kind !== "bell") return seedRound(seed);
  const bell = seed.ts;
  if (bell === null) return assembleRound(seed, [], []);
  const drops = roundBookIds(seed);
  let orders: KnownOrder[] = [];
  try { orders = await readOrders(drops.map((d) => d.bookId)); } catch { return { ...seedRound(seed), loaded: true, complete: false }; }
  const chains = [...new Set(orders.map((o) => o.chainId))];
  // A lost delivery expires the round about 300 s later, so read to the last event the referee shows for it.
  const endTs = Math.max(bell, ...seed.events.map((e) => e.ts ?? 0)) + 60;
  const desks = await Promise.all(chains.map((c) => readDesk(c, bell, Math.max(endTs, bell + 90))));
  const tokens = opts.tokens ? await resolveTokens(seed, orders, desks) : {};
  return assembleRound(seed, orders, desks, tokens);
}

// ----------------------------------------------------------------------------------------------------- the cache

const KEY = `bell.rounds.${REFEREE.toLowerCase()}`;
const enc = (_: string, v: unknown) => (typeof v === "bigint" ? { $b: v.toString() } : v);
const dec = (_: string, v: any) => (v && typeof v === "object" && typeof v.$b === "string" ? BigInt(v.$b) : v);

/** Finished rounds are cached in the viewer's own browser. Storage may be blocked, so every touch is guarded. */
export function readCache(): Round[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw, dec) as Round[]) : [];
  } catch { return []; }
}
export function writeCache(rounds: Round[]) {
  try {
    const keep = rounds.filter(isCacheable).slice(0, 60);
    window.localStorage.setItem(KEY, JSON.stringify(keep, enc));
  } catch { /* storage blocked or full: the page works without it */ }
}
/** A round can't change once it is well past its bell and was read completely. A round with unread payouts gets another try. */
export function isCacheable(r: Round, nowS = Date.now() / 1000): boolean {
  if (!r.loaded || !r.complete) return false;
  if (r.kind === "bell" && (r.bellTs === null || nowS - r.bellTs < 100)) return false;
  return r.outcome !== "open";
}
