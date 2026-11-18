// A trader's balances, approvals and orders, read from the chains.
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { client, logClient } from "./clients";
import { deskAbi, erc20Abi, refereeAbi } from "./abi";
import { DESKS, DESK_CHAIN_IDS, LASNA_ID, REFEREE, REFEREE_BLOCK, type DeskChainId } from "./config";
import { decideOutcome, loadOrderLegs } from "./payouts";

export type ChainBalances = { usdc: bigint; weth: bigint; eth: bigint; allowUsdc: bigint; allowWeth: bigint };
export type Balances = Record<DeskChainId, ChainBalances>;

export async function loadBalances(addr: Address): Promise<Balances> {
  const out = {} as Balances;
  await Promise.all(DESK_CHAIN_IDS.map(async (id) => {
    const d = DESKS[id];
    const c = client(id);
    const [usdc, weth, eth, allowUsdc, allowWeth] = await Promise.all([
      c.readContract({ address: d.usdc, abi: erc20Abi, functionName: "balanceOf", args: [addr] }) as Promise<bigint>,
      c.readContract({ address: d.weth, abi: erc20Abi, functionName: "balanceOf", args: [addr] }) as Promise<bigint>,
      c.getBalance({ address: addr }),
      c.readContract({ address: d.usdc, abi: erc20Abi, functionName: "allowance", args: [addr, d.desk] }) as Promise<bigint>,
      c.readContract({ address: d.weth, abi: erc20Abi, functionName: "allowance", args: [addr, d.desk] }) as Promise<bigint>,
    ]);
    out[id] = { usdc, weth, eth, allowUsdc, allowWeth };
  }));
  return out;
}

/** The four steps of an order ticket: Placed, In the book, Bell, Paid. */
export type TicketStep = 0 | 1 | 2 | 3;
/**
 * settled: a payout in the token the trader asked for is confirmed on a desk chain.
 * refunded: the desk took the funds and gave them back, with no payout.
 * finished: the desk closed the order, but its payout or refund logs can no longer be read (public RPCs prune old logs),
 *   so the app can't say which. It never guesses "paid".
 */
export type OrderOutcome = "open" | "settled" | "refunded" | "finished" | "cancelled" | "dropped" | "expired";

export type MyOrder = {
  chainId: DeskChainId;
  deskOrderId: number;
  isBuy: boolean;
  limit: bigint;
  qty: bigint;
  /** The placement transaction, when the RPC still has it. Old logs get pruned, so this can be null. */
  tx: Hex | null;
  block: bigint | null;
  /** When the order was placed, in seconds. */
  placedTs: number;
  /** How far the order has got, from chain state. A placed order is never shown as filled. */
  step: TicketStep;
  outcome: OrderOutcome;
  /** In the book right now (the referee heard it and has not closed it). */
  inBook: boolean;
  canCancel: boolean;
  bookId: bigint | null;
};

// Finding a wallet's orders. Old desk logs are pruned by public RPCs, so the list comes from the referee on Lasna, which
// heard every accepted order (OrderAdded carries the wallet, the chain and the desk's order id). Orders placed in the last
// few minutes may not have reached Lasna yet, so each desk's recent logs are read too. Prices and sizes come from the desk's
// own state, which never expires.
const added = { scannedTo: REFEREE_BLOCK - 1n, rows: [] as { chainId: number; deskOrderId: bigint; bookId: bigint; trader: string; block: bigint }[] };

async function referee(): Promise<typeof added.rows> {
  const lasna = client(LASNA_ID);
  const head = await lasna.getBlockNumber();
  if (head > added.scannedTo) {
    const logs = (await logClient(LASNA_ID).getContractEvents({ address: REFEREE, abi: refereeAbi, eventName: "OrderAdded", fromBlock: added.scannedTo + 1n, toBlock: head })) as any[];
    for (const l of logs) added.rows.push({ chainId: Number(l.args.chainId), deskOrderId: l.args.deskOrderId as bigint, bookId: l.args.bookId as bigint, trader: String(l.args.trader).toLowerCase(), block: l.blockNumber });
    added.scannedTo = head;
  }
  return added.rows;
}

const blockTimeCache = new Map<number, number>();
async function secPerBlock(chainId: number): Promise<number> {
  const hit = blockTimeCache.get(chainId);
  if (hit) return hit;
  const c = client(chainId);
  const head = await c.getBlockNumber();
  const [a, b] = await Promise.all([c.getBlock({ blockNumber: head }), c.getBlock({ blockNumber: head - 400n })]);
  const v = Math.max(0.2, Number(a.timestamp - b.timestamp) / 400);
  blockTimeCache.set(chainId, v);
  return v;
}

/** The block a desk chain was at around a given time, found from the head and the block time. */
export async function blockAt(chainId: number, ts: number): Promise<bigint> {
  const c = client(chainId);
  const [head, bt] = await Promise.all([c.getBlockNumber(), secPerBlock(chainId)]);
  // Block times drift, so look a little further back than the estimate. Too early is harmless, too late misses events.
  const est = Math.max(0, Math.round((Date.now() / 1000 - ts) / bt));
  const back = BigInt(est + Math.ceil(est * 0.08) + 60);
  return head > back ? head - back : 0n;
}

const terminal = new Map<string, MyOrder>();

export async function loadMyOrders(trader: Address): Promise<MyOrder[]> {
  const me = trader.toLowerCase();
  const lasna = client(LASNA_ID);
  const known = new Map<string, { chainId: DeskChainId; id: bigint; lasnaBlock: bigint | null; tx: Hex | null; block: bigint | null }>();

  // 1. Everything the referee heard from this wallet.
  for (const r of (await referee()).filter((x) => x.trader === me)) {
    if (r.chainId !== 84532 && r.chainId !== 1301) continue;
    known.set(`${r.chainId}:${r.deskOrderId}`, { chainId: r.chainId, id: r.deskOrderId, lasnaBlock: r.block, tx: null, block: null });
  }
  // 2. Orders placed in the last few minutes, straight from each desk.
  await Promise.all(DESK_CHAIN_IDS.map(async (id) => {
    const d = DESKS[id];
    try {
      const head = await client(id).getBlockNumber();
      const from = head > 900n ? head - 900n : 0n;
      const logs = (await logClient(id).getContractEvents({ address: d.desk, abi: deskAbi, eventName: "OrderPlaced", args: { trader }, fromBlock: from < d.deskBlock ? d.deskBlock : from, toBlock: head })) as any[];
      for (const l of logs) known.set(`${id}:${l.args.orderId}`, { chainId: id, id: l.args.orderId as bigint, lasnaBlock: known.get(`${id}:${l.args.orderId}`)?.lasnaBlock ?? null, tx: l.transactionHash, block: l.blockNumber });
    } catch { /* the referee list still shows everything older */ }
  }));

  const rows = await Promise.all([...known.entries()].map(async ([key, k]) => {
    const cached = terminal.get(key);
    if (cached) return cached;
    const c = client(k.chainId);
    const d = DESKS[k.chainId];
    const orderId = k.id;
    const [o, collected, closed, frozen] = await Promise.all([
      c.readContract({ address: d.desk, abi: deskAbi, functionName: "orders", args: [orderId] }) as Promise<readonly [Address, boolean, bigint, bigint]>,
      c.readContract({ address: d.desk, abi: deskAbi, functionName: "collectedOf", args: [orderId] }) as Promise<bigint>,
      c.readContract({ address: d.desk, abi: deskAbi, functionName: "closedOf", args: [orderId] }) as Promise<bigint>,
      c.readContract({ address: d.desk, abi: deskAbi, functionName: "frozen", args: [orderId] }) as Promise<boolean>,
    ]);
    if (o[0].toLowerCase() !== me) return null;
    const bookKey = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [BigInt(k.chainId), orderId]));
    const bookId = (await lasna.readContract({ address: REFEREE, abi: refereeAbi, functionName: "bookIdOf", args: [bookKey] })) as bigint;
    let inBook = false;
    if (bookId > 0n) {
      const r = (await lasna.readContract({ address: REFEREE, abi: refereeAbi, functionName: "orders", args: [bookId] })) as readonly [Address, number, boolean, boolean, number, bigint, bigint];
      inBook = r[3];
    }

    // When it was placed: from the desk block if we have it, else from the Lasna block the referee heard it in.
    let placedTs: number;
    if (k.block !== null) placedTs = Number((await c.getBlock({ blockNumber: k.block })).timestamp);
    else if (k.lasnaBlock !== null) placedTs = Number((await lasna.getBlock({ blockNumber: k.lasnaBlock })).timestamp) - 3;
    else placedTs = Math.floor(Date.now() / 1000);

    // Was it cancelled? Only logs say so, so look near the order's life. A pruned log just means we cannot tell.
    let cancelled = false;
    if (collected === 0n && !inBook) {
      try {
        const from = await blockAt(k.chainId, placedTs - 5);
        const head = await c.getBlockNumber();
        cancelled = ((await logClient(k.chainId).getContractEvents({ address: d.desk, abi: deskAbi, eventName: "OrderCancelled", args: { orderId }, fromBlock: from, toBlock: head })) as any[]).length > 0;
      } catch { /* unknown */ }
    }

    let outcome: OrderOutcome = "open";
    let step: TicketStep = 0;
    // Settled only when a payout to this trader is confirmed. The desk closing the order proves nothing on its own,
    // because a refund closes it the same way.
    let lastLegTs: number | null = null;
    if (collected > 0n) {
      step = 2;
      const ol = await loadOrderLegs({ chainId: k.chainId, deskOrderId: Number(orderId), isBuy: o[1], placedTs }, trader).catch(() => null);
      if (ol) lastLegTs = ol.legs.length ? ol.legs[ol.legs.length - 1].ts : null;
      outcome = decideOutcome({ collected, closed, legs: ol, placedTs, nowS: Date.now() / 1000 });
      if (outcome === "settled") step = 3;
    }
    else if (cancelled) { outcome = "cancelled"; }
    else if (inBook) { step = 1; }
    else if (frozen) { outcome = "dropped"; }
    else if (bookId > 0n) { outcome = "dropped"; step = 1; }
    const row: MyOrder = {
      chainId: k.chainId, deskOrderId: Number(orderId), isBuy: o[1], limit: o[2], qty: o[3], tx: k.tx, block: k.block, placedTs,
      step, outcome, inBook, canCancel: outcome === "open" && collected === 0n && !frozen, bookId: bookId > 0n ? bookId : null,
    };
    // Remember finished orders, but keep re-reading a paid or refunded one while more legs of its round may still land
    // (a match payout and a pool fill for the same order can arrive seconds apart), and keep re-reading "finished"
    // in case the RPC catches up.
    const quiet = lastLegTs === null || Date.now() / 1000 - lastLegTs > 60;
    if (outcome === "cancelled" || outcome === "dropped" || ((outcome === "settled" || outcome === "refunded") && quiet)) terminal.set(key, row);
    return row;
  }));
  return rows.filter((r): r is MyOrder => r !== null).sort((a, b) => b.placedTs - a.placedTs);
}
