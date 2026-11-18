// The live round, read from the chains. Nothing here is invented: every number is chain state or derived from it.
import type { Address, Hex } from "viem";
import { client } from "./clients";
import { refereeAbi, deskAbi, systemAbi } from "./abi";
import {
  BELL_EVERY_BLOCKS, DESKS, DESK_CHAIN_IDS, LASNA_ID, REFERENCE_CHAIN, REFEREE, REFEREE_BLOCK,
  SYSTEM_CONTRACT, type DeskChainId,
} from "./config";
import { poolPrice } from "./pool";

export type BookOrder = {
  bookId: bigint;
  chainId: DeskChainId;
  deskOrderId: number;
  trader: Address;
  isBuy: boolean;
  limit: bigint; // USDC micro-units per 1 ETH
  qty: bigint; // ETH in wei
  placedAt: number; // unix seconds
};

export type RefEvent = {
  name: "BellRang" | "BellVoid" | "Settled" | "Unwound" | "PullsExpired" | "OrderDropped" | "RoundOpened" | "Observed" | "OrderAdded";
  block: bigint;
  tx: Hex;
  args: Record<string, any>;
};

export type LastRound = {
  bellBlock: bigint;
  bellTx: Hex;
  settleBlock: bigint;
  settleTx: Hex;
  price: bigint;
  eligible: number;
  pairs: number;
  bellTs: number;
  /** Seconds from the bell to the Lasna settle. */
  settleSeconds: number;
  /** Seconds from the bell to the last payout on either chain, from block timestamps. Null until read. */
  payoutSeconds: number | null;
  payouts: { chainId: DeskChainId; seconds: number }[];
};

export type RoundSnapshot = {
  fetchedAt: number; // ms
  lasnaBlock: bigint;
  secPerBlock: number;
  cronOn: boolean;
  pulling: boolean;
  openPrice: bigint;
  settlePrice: bigint;
  roundId: bigint;
  maxBook: number;
  /** Open orders one wallet may hold, and how long an order may sit in the book (seconds). Both are read from the referee. */
  maxPerWallet: number;
  orderTtl: number;
  book: BookOrder[];
  referencePrice: bigint;
  priceAgeSeconds: number | null;
  nextBellAt: number | null; // ms epoch
  paused: boolean;
  pausedReason?: string;
  events: RefEvent[]; // newest last
  lastBellRang: RefEvent | null;
  lastSettled: RefEvent | null;
  lastVoid: RefEvent | null;
  lastBellMs: number | null; // when the last bell rang, ms epoch (estimated from block distance)
  lastSettledMs: number | null;
  lastVoidMs: number | null;
};

const block0 = (n: bigint) => (n < 0n ? 0n : n);

let secPerBlockCache: { at: number; v: number } | null = null;
async function lasnaSecPerBlock(head: bigint): Promise<number> {
  if (secPerBlockCache && Date.now() - secPerBlockCache.at < 90_000) return secPerBlockCache.v;
  const c = client(LASNA_ID);
  const back = block0(head - 200n);
  const [a, b] = await Promise.all([c.getBlock({ blockNumber: head }), c.getBlock({ blockNumber: back })]);
  const v = Number(a.timestamp - b.timestamp) / Number(head - back) || 1.1;
  secPerBlockCache = { at: Date.now(), v };
  return v;
}

async function eventsChunked(from: bigint, to: bigint): Promise<RefEvent[]> {
  const c = client(LASNA_ID);
  const out: RefEvent[] = [];
  for (let f = from; f <= to; f += 500n) {
    const t = f + 499n > to ? to : f + 499n;
    const logs = await c.getContractEvents({ address: REFEREE, abi: refereeAbi, fromBlock: f, toBlock: t });
    for (const l of logs as any[]) {
      if (!l.eventName) continue;
      out.push({ name: l.eventName, block: l.blockNumber, tx: l.transactionHash, args: (l.args ?? {}) as Record<string, any> });
    }
  }
  return out;
}

let observedCache: { block: bigint; ts: number } | null = null;

/** Seconds since the reference pool was last traded, from the referee's own Observed events. */
async function priceAge(head: bigint, windowEvents: RefEvent[]): Promise<number | null> {
  const c = client(LASNA_ID);
  const pick = (evs: RefEvent[]) => [...evs].reverse().find((e) => e.name === "Observed");
  let ev = pick(windowEvents);
  let block: bigint | null = ev ? ev.block : observedCache?.block ?? null;
  if (!ev && !observedCache) {
    // Look further back, up to about an hour, in a few chunks.
    for (let i = 1; i <= 6 && !ev; i++) {
      const to = block0(head - 600n * BigInt(i));
      const from = block0(to - 499n);
      if (to <= REFEREE_BLOCK) break;
      const found = await eventsChunked(from < REFEREE_BLOCK ? REFEREE_BLOCK : from, to);
      ev = pick(found);
      if (ev) block = ev.block;
    }
  }
  if (block === null) return null;
  if (observedCache && observedCache.block === block) return Math.max(0, Date.now() / 1000 - observedCache.ts);
  const ts = Number((await c.getBlock({ blockNumber: block })).timestamp);
  observedCache = { block, ts };
  return Math.max(0, Date.now() / 1000 - ts);
}

export async function loadRound(): Promise<RoundSnapshot> {
  const c = client(LASNA_ID);
  const head = await c.getBlockNumber();
  const read = <T extends string>(fn: T) => c.readContract({ address: REFEREE, abi: refereeAbi, functionName: fn as any } as any) as Promise<any>;

  const [cronOn, pulling, openPrice, settlePrice, roundId, maxBook, secPerBlock, maxPerWallet, orderTtl] = await Promise.all([
    read("cronOn"), read("pulling"), read("openPrice"), read("settlePrice"), read("roundId"), read("MAX_BOOK"), lasnaSecPerBlock(head),
    read("MAX_ORDERS_PER_TRADER"), read("ORDER_TTL"),
  ]);

  // The book, in FIFO order.
  const book: BookOrder[] = [];
  for (let i = 0n; i < BigInt(maxBook as bigint); i++) {
    let id: bigint;
    try {
      id = (await c.readContract({ address: REFEREE, abi: refereeAbi, functionName: "openIds", args: [i] })) as bigint;
    } catch {
      break; // past the end of the list
    }
    const [o, at] = await Promise.all([
      c.readContract({ address: REFEREE, abi: refereeAbi, functionName: "orders", args: [id] }) as Promise<readonly [Address, number, boolean, boolean, number, bigint, bigint]>,
      c.readContract({ address: REFEREE, abi: refereeAbi, functionName: "placedAt", args: [id] }) as Promise<bigint>,
    ]);
    book.push({ bookId: id, trader: o[0], chainId: Number(o[1]) as DeskChainId, deskOrderId: Number(o[4]), isBuy: o[2], limit: o[5], qty: o[6], placedAt: Number(at) });
  }

  const from = head - 599n < REFEREE_BLOCK ? REFEREE_BLOCK : head - 599n;
  const events = (await eventsChunked(from, head)).sort((a, b) => Number(a.block - b.block));
  const last = (n: RefEvent["name"]) => [...events].reverse().find((e) => e.name === n) ?? null;
  const lastBellRang = last("BellRang");
  const lastSettled = last("Settled");
  const lastVoid = last("BellVoid");
  const nowMs = Date.now();
  const msAt = (e: RefEvent | null) => (e ? nowMs - Number(head - e.block) * secPerBlock * 1000 : null);

  const ref = await poolPrice(REFERENCE_CHAIN);
  const age = await priceAge(head, events).catch(() => null);

  // Debt stops a referee from hearing events, so it counts as paused.
  let paused = false;
  let pausedReason: string | undefined;
  try {
    const debt = (await c.readContract({ address: SYSTEM_CONTRACT, abi: systemAbi, functionName: "debts", args: [REFEREE] })) as bigint;
    if (debt > 0n) { paused = true; pausedReason = "debt"; }
  } catch { /* the system contract read is optional */ }

  // The next bell is the block after the next Cron100 tick.
  const blocksToTick = BELL_EVERY_BLOCKS - Number(head % BigInt(BELL_EVERY_BLOCKS));
  const nextBellAt = cronOn || book.length > 0 ? nowMs + (blocksToTick + 1) * secPerBlock * 1000 : null;

  return {
    fetchedAt: nowMs, lasnaBlock: head, secPerBlock, cronOn, pulling, openPrice, settlePrice, roundId, maxBook: Number(maxBook), maxPerWallet: Number(maxPerWallet), orderTtl: Number(orderTtl),
    book, referencePrice: ref.price, priceAgeSeconds: age, nextBellAt, paused, pausedReason, events,
    lastBellRang, lastSettled, lastVoid, lastBellMs: msAt(lastBellRang), lastSettledMs: msAt(lastSettled), lastVoidMs: msAt(lastVoid),
  };
}

// ---- the living mark's state --------------------------------------------------------------------------------

export type MarkState = "quiet" | "open" | "last10" | "bell" | "settling" | "done" | "skipped" | "paused";

export function markStateOf(s: RoundSnapshot, nowMs: number): MarkState {
  if (s.paused) return "paused";
  const since = (ms: number | null) => (ms === null ? Infinity : (nowMs - ms) / 1000);
  if (s.pulling) return since(s.lastBellMs) < 6 ? "bell" : "settling";
  if (since(s.lastSettledMs) < 45) return "done";
  if (s.book.length > 0 && s.lastVoid && /drift/i.test(String(s.lastVoid.args.reason ?? "")) && since(s.lastVoidMs) < 90 &&
      (!s.lastSettledMs || (s.lastVoidMs ?? 0) > s.lastSettledMs)) return "skipped";
  if (s.book.length === 0) return "quiet";
  const left = s.nextBellAt ? (s.nextBellAt - nowMs) / 1000 : Infinity;
  return left <= 10 ? "last10" : "open";
}

// ---- how an order stands at the current price ---------------------------------------------------------------

/** A buyer is in the bell when their limit allows the price, a seller when theirs does. */
export function inThisBell(o: BookOrder, referencePrice: bigint): boolean {
  return o.isBuy ? o.limit >= referencePrice : o.limit <= referencePrice;
}

/** If the bell rang at the current price: how much pairs off and what is left over for the Uniswap pool. */
export function meetBar(book: BookOrder[], price: bigint) {
  let buy = 0n, sell = 0n;
  for (const o of book) {
    if (!inThisBell(o, price)) continue;
    if (o.isBuy) buy += o.qty; else sell += o.qty;
  }
  const paired = buy < sell ? buy : sell;
  return { buy, sell, paired, buyOverhang: buy - paired, sellOverhang: sell - paired };
}

// ---- the last bell, with real payout seconds ----------------------------------------------------------------

const blockTimeCache = new Map<number, { at: number; v: number }>();
async function blockTime(chainId: number): Promise<number> {
  const hit = blockTimeCache.get(chainId);
  if (hit && Date.now() - hit.at < 120_000) return hit.v;
  const c = client(chainId);
  const head = await c.getBlockNumber();
  const back = block0(head - 600n);
  const [a, b] = await Promise.all([c.getBlock({ blockNumber: head }), c.getBlock({ blockNumber: back })]);
  const v = Math.max(0.2, Number(a.timestamp - b.timestamp) / Number(head - back));
  blockTimeCache.set(chainId, { at: Date.now(), v });
  return v;
}

/** Reads the bell and settle timestamps, then the desk legs, to say how many seconds each payout took. */
export async function loadLastRound(bell: RefEvent, settled: RefEvent): Promise<LastRound> {
  const lc = client(LASNA_ID);
  const [bb, sb] = await Promise.all([lc.getBlock({ blockNumber: bell.block }), lc.getBlock({ blockNumber: settled.block })]);
  const bellTs = Number(bb.timestamp);
  const out: LastRound = {
    bellBlock: bell.block, bellTx: bell.tx, settleBlock: settled.block, settleTx: settled.tx,
    price: bell.args.price as bigint, eligible: Number(bell.args.eligibleCount), pairs: Number(bell.args.pairCount),
    bellTs, settleSeconds: Number(sb.timestamp) - bellTs, payoutSeconds: null, payouts: [],
  };
  const nowS = Date.now() / 1000;
  await Promise.all(DESK_CHAIN_IDS.map(async (id) => {
    try {
      const c = client(id);
      const bt = await blockTime(id);
      const head = await c.getBlockNumber();
      const lookback = BigInt(Math.ceil((nowS - bellTs + 40) / bt));
      const fromBlock = block0(head - lookback);
      const logs = await c.getContractEvents({ address: DESKS[id].desk, abi: deskAbi, fromBlock, toBlock: head });
      const legs = (logs as any[]).filter((l) => ["Paid", "Swapped", "Refunded", "Closed"].includes(l.eventName));
      let lastTs = 0;
      for (const l of legs) {
        const ts = Number((await c.getBlock({ blockNumber: l.blockNumber })).timestamp);
        if (ts >= bellTs - 2 && ts <= bellTs + 90 && ts > lastTs) lastTs = ts;
      }
      if (lastTs) out.payouts.push({ chainId: id, seconds: lastTs - bellTs });
    } catch { /* a chain that cannot be read just has no leg shown */ }
  }));
  if (out.payouts.length) out.payoutSeconds = Math.max(...out.payouts.map((p) => p.seconds));
  return out;
}

// ---- progress of the round that is settling right now, from the desks' own events ---------------------------

export type LegProgress = { chainId: DeskChainId; collected: number; paid: number; closed: number };

/** What each desk has done since the bell rang. Drives the Base and Unichain nodes while settling. */
export async function loadLegProgress(sinceMs: number): Promise<LegProgress[]> {
  const nowS = Date.now() / 1000;
  return Promise.all(DESK_CHAIN_IDS.map(async (id) => {
    const out: LegProgress = { chainId: id, collected: 0, paid: 0, closed: 0 };
    try {
      const c = client(id);
      const bt = await blockTime(id);
      const head = await c.getBlockNumber();
      const lookback = BigInt(Math.ceil((nowS - sinceMs / 1000 + 20) / bt));
      const logs = await c.getContractEvents({ address: DESKS[id].desk, abi: deskAbi, fromBlock: block0(head - lookback), toBlock: head });
      for (const l of logs as any[]) {
        if (l.eventName === "Collected") out.collected++;
        else if (l.eventName === "Paid" || l.eventName === "Swapped" || l.eventName === "Refunded") out.paid++;
        else if (l.eventName === "Closed") out.closed++;
      }
    } catch { /* an unreadable chain shows no progress, never a wrong one */ }
    return out;
  }));
}
