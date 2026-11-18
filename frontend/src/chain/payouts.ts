// What actually reached a trader for one order, read only from the desks' events and the token transfers inside them.
// This is the single source of truth for "paid" and "refunded". Desk accounting (closedOf == collectedOf) can't tell the
// two apart, because closeOrder and refundOrder both set it, and the Lasna Settled event only means payouts were
// requested. So an order counts as paid only when a payout to the trader is confirmed on a desk chain.
//
// How the desks report money going out:
// - A matched payout is Paid(orderId = the trader's own desk order id, to = trader) on the counterparty's desk, in the
//   token the trader asked for (WETH for a buyer, USDC for a seller). When both sides are on one chain, that is the
//   trader's own desk.
// - A pool fill is Swapped(to = trader, ok = true) on the trader's own desk. Any unused part comes back in the same
//   transaction (the event's `refunded`).
// - A rounding (dust) refund is Paid(orderId, to = trader) on the trader's own desk, in the token the trader gave.
// - A failed pool swap is refunded as Paid(orderId = 0, to = trader) on the trader's own desk, in the token the trader gave.
// - An unwound or expired order is refunded as Refunded(orderId, to = trader) on the trader's own desk.
// Paid carries no token field, so the token is read from the ERC20 Transfer to the trader in the same transaction.
import type { Address, Hex } from "viem";
import { client, logClient } from "./clients";
import { deskAbi } from "./abi";
import { DESKS, DESK_CHAIN_IDS, type DeskChainId } from "./config";

export type Token = "USDC" | "WETH";

export type Leg = {
  chainId: DeskChainId;
  /** matched and pool are payouts. refund and dust are money coming back in the token the trader gave. */
  kind: "matched" | "pool" | "refund" | "dust";
  token: Token;
  amount: bigint; // what arrived in the trader's wallet
  used?: bigint; // pool swaps: how much of the input the pool took
  returned?: bigint; // pool swaps: how much came back unused, in the token the trader gave
  tx: Hex;
  ts: number;
};

export type OrderRef = { chainId: DeskChainId; deskOrderId: number; isBuy: boolean; placedTs: number };

export type OrderLegs = {
  /** The desk's pull of the trader's funds for this order, if its log is still readable. */
  collect: { tx: Hex; ts: number; amount: bigint; ok: boolean } | null;
  close: { tx: Hex; ts: number } | null;
  legs: Leg[];
  /** Payouts in the token the trader asked for. */
  payouts: Leg[];
  /** Money that came back in the token the trader gave. */
  refunds: Leg[];
  /** False when a needed log query failed, so the absence of a leg proves nothing. */
  complete: boolean;
};

/** The referee refunds a remainder below these instead of swapping it (BellReferee.sol DUST_USDC and DUST_WETH). */
export const DUST_USDC = 10_000n;
export const DUST_WETH = 1_000_000_000_000n;

/** How long after the pull a payout for that pull can land. Rounds are at least about 200 s apart. */
export const PAYOUT_WINDOW_S = 180;

export const gotTokenOf = (isBuy: boolean): Token => (isBuy ? "WETH" : "USDC");
export const gaveTokenOf = (isBuy: boolean): Token => (isBuy ? "USDC" : "WETH");

const tsCache = new Map<string, number>();
export async function tsOf(chainId: number, block: bigint): Promise<number> {
  const k = `${chainId}:${block}`;
  const hit = tsCache.get(k);
  if (hit !== undefined) return hit;
  const t = Number((await client(chainId).getBlock({ blockNumber: block })).timestamp);
  tsCache.set(k, t);
  return t;
}

const tokenCache = new Map<string, Token | null>();
/** Which token a desk transaction sent to the trader, from the ERC20 Transfer logs in its receipt. */
export async function tokenSentTo(chainId: DeskChainId, tx: Hex, trader: Address): Promise<Token | null> {
  const k = `${chainId}:${tx}:${trader.toLowerCase()}`;
  if (tokenCache.has(k)) return tokenCache.get(k)!;
  const d = DESKS[chainId];
  // Read the receipt from the same RPC the logs came from first. The fast read RPC can prune receipts of older
  // transactions (seen on Unichain Sepolia for a 5 hour old payout), while the log RPC still has them.
  let rc;
  try { rc = await logClient(chainId).getTransactionReceipt({ hash: tx }); }
  catch { rc = await client(chainId).getTransactionReceipt({ hash: tx }); }
  let token: Token | null = null;
  for (const lg of rc.logs) {
    const a = lg.address.toLowerCase();
    const t: Token | null = a === d.usdc.toLowerCase() ? "USDC" : a === d.weth.toLowerCase() ? "WETH" : null;
    if (!t || !lg.topics[2]) continue;
    if (BigInt(lg.topics[2]) === BigInt(trader)) { token = t; break; }
  }
  tokenCache.set(k, token);
  return token;
}

/** The first block on a chain at or before a moment, estimated from recent block times, with room to spare. */
export async function fromBlockFor(chainId: number, sinceTs: number): Promise<bigint> {
  const c = client(chainId);
  const head = await c.getBlockNumber();
  const back = head > 600n ? head - 600n : 0n;
  const [a, b] = await Promise.all([c.getBlock({ blockNumber: head }), c.getBlock({ blockNumber: back })]);
  const bt = Math.max(0.2, Number(a.timestamp - b.timestamp) / Number(head - back || 1n));
  const blocks = BigInt(Math.ceil((Number(a.timestamp) - sinceTs) / bt) + 40);
  return head > blocks ? head - blocks : 0n;
}

/**
 * Every payout and refund for one order, classified by the token that actually reached the trader.
 * Legs are only accepted from the order's own settlement window: from its pull (or its placement, if the pull's log is
 * gone) to PAYOUT_WINDOW_S after it. That keeps another order with the same id number on the other desk, or the
 * trader's next round, out of this order's result.
 */
export async function loadOrderLegs(order: OrderRef, trader: Address): Promise<OrderLegs> {
  const own = order.chainId;
  const d = DESKS[own];
  const orderId = BigInt(order.deskOrderId);
  const got = gotTokenOf(order.isBuy);
  const gave = gaveTokenOf(order.isBuy);
  let complete = true;

  // The pull and the close, on the trader's own desk.
  let collect: OrderLegs["collect"] = null;
  let close: OrderLegs["close"] = null;
  try {
    const head = await client(own).getBlockNumber();
    const from = await fromBlockFor(own, order.placedTs - 10);
    const [cl, cs] = await Promise.all([
      logClient(own).getContractEvents({ address: d.desk, abi: deskAbi, eventName: "Collected", args: { orderId }, fromBlock: from, toBlock: head }),
      logClient(own).getContractEvents({ address: d.desk, abi: deskAbi, eventName: "Closed", args: { orderId }, fromBlock: from, toBlock: head }),
    ]);
    const c0 = (cl as any[]).find((e) => e.args.ok) ?? (cl as any[])[0];
    if (c0) collect = { tx: c0.transactionHash, ts: await tsOf(own, c0.blockNumber), amount: c0.args.amount as bigint, ok: Boolean(c0.args.ok) };
    const z = (cs as any[])[0];
    if (z) close = { tx: z.transactionHash, ts: await tsOf(own, z.blockNumber) };
  } catch {
    complete = false;
  }

  const lower = (collect?.ts ?? order.placedTs) - 5;
  const upper = (collect?.ts ?? order.placedTs) + PAYOUT_WINDOW_S;
  const inWindow = (ts: number) => ts >= lower && ts <= upper;
  const legs: Leg[] = [];

  await Promise.all(DESK_CHAIN_IDS.map(async (id) => {
    const dk = DESKS[id];
    try {
      const head = await client(id).getBlockNumber();
      const fromBlock = await fromBlockFor(id, lower);
      const isOwn = id === own;
      const [paid, paidZero, swapped, refunded] = await Promise.all([
        logClient(id).getContractEvents({ address: dk.desk, abi: deskAbi, eventName: "Paid", args: { orderId, to: trader }, fromBlock, toBlock: head }),
        isOwn ? logClient(id).getContractEvents({ address: dk.desk, abi: deskAbi, eventName: "Paid", args: { orderId: 0n, to: trader }, fromBlock, toBlock: head }) : Promise.resolve([]),
        isOwn ? logClient(id).getContractEvents({ address: dk.desk, abi: deskAbi, eventName: "Swapped", args: { to: trader }, fromBlock, toBlock: head }) : Promise.resolve([]),
        isOwn ? logClient(id).getContractEvents({ address: dk.desk, abi: deskAbi, eventName: "Refunded", args: { orderId, to: trader }, fromBlock, toBlock: head }) : Promise.resolve([]),
      ]);

      for (const e of [...(paid as any[]), ...(paidZero as any[])]) {
        if (!e.args.ok) continue;
        const ts = await tsOf(id, e.blockNumber);
        if (!inWindow(ts)) continue;
        let token: Token | null = null;
        try { token = await tokenSentTo(id, e.transactionHash, trader); }
        catch {
          // No receipt from either RPC. On the counterparty's desk a Paid for this order can only be a match payout,
          // because rounding refunds and failed-swap refunds only ever happen on the trader's own desk. On the own desk
          // the token can't be known without the receipt, so leave the leg out and mark the result incomplete.
          if (!isOwn && e.args.orderId !== 0n) token = got;
          else { complete = false; continue; }
        }
        if (!token) continue;
        if (token === got) legs.push({ chainId: id, kind: "matched", token, amount: e.args.amount, tx: e.transactionHash, ts });
        // Money in the token the trader gave is never a payout. On the own desk it is a refund: rounding when it is below
        // the referee's dust limits (DUST_USDC, DUST_WETH in BellReferee.sol), otherwise funds coming back.
        else if (isOwn) {
          const amount = e.args.amount as bigint;
          const dust = e.args.orderId !== 0n && (token === "USDC" ? amount < DUST_USDC : amount < DUST_WETH);
          legs.push({ chainId: id, kind: dust ? "dust" : "refund", token, amount, tx: e.transactionHash, ts });
        }
      }
      for (const e of swapped as any[]) {
        if (!e.args.ok) continue; // a failed swap moved nothing, its refund arrives as Paid(0)
        const ts = await tsOf(id, e.blockNumber);
        if (!inWindow(ts)) continue;
        const amountOut = e.args.amountOut as bigint;
        const back = e.args.refunded as bigint;
        if (amountOut > 0n) legs.push({ chainId: id, kind: "pool", token: e.args.sellWeth ? "USDC" : "WETH", amount: amountOut, used: e.args.amountUsed, returned: back, tx: e.transactionHash, ts });
        else if (back > 0n) legs.push({ chainId: id, kind: "refund", token: gave, amount: back, tx: e.transactionHash, ts });
      }
      for (const e of refunded as any[]) {
        if (!e.args.ok) continue;
        const ts = await tsOf(id, e.blockNumber);
        if (!inWindow(ts)) continue;
        legs.push({ chainId: id, kind: "refund", token: gave, amount: e.args.amount, tx: e.transactionHash, ts });
      }
    } catch {
      complete = false;
    }
  }));

  legs.sort((a, b) => a.ts - b.ts);
  const payouts = legs.filter((l) => (l.kind === "matched" || l.kind === "pool") && l.token === got);
  const refunds = legs.filter((l) => l.kind === "refund" || l.kind === "dust");
  return { collect, close, legs, payouts, refunds, complete };
}

export type Outcome = "open" | "settled" | "refunded" | "finished";

/**
 * The outcome of an order whose funds the desk pulled, decided from desk state and confirmed legs only.
 * - settled: at least one payout in the token the trader asked for is confirmed.
 * - refunded: the desk closed the order and gave the funds back, with no payout.
 * - finished: the desk closed the order but neither a payout nor a refund can be read (pruned logs or a failed read,
 *   or nothing turned up long after the round). It never guesses paid.
 * - open: still settling.
 */
export function decideOutcome(i: { collected: bigint; closed: bigint; legs: OrderLegs | null; placedTs: number; nowS: number }): Outcome {
  if (i.collected === 0n) return "open";
  const closed = i.closed > 0n && i.closed === i.collected;
  if (i.legs && i.legs.payouts.length > 0) return "settled";
  if (i.legs && closed && i.legs.refunds.length > 0) return "refunded";
  if (closed && (!i.legs || !i.legs.complete || i.nowS - i.placedTs > PAYOUT_WINDOW_S + 600)) return "finished";
  return "open";
}
