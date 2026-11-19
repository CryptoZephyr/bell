// A receipt for one order, built only from chain events: what you gave, what you got, on which chain, how many seconds
// it took, and the step-by-step ledger across Lasna, Base and Unichain. Nothing here is a claim without a transaction.
import type { Address, Hex } from "viem";
import { client, logClient } from "./clients";
import { refereeAbi } from "./abi";
import { LASNA_ID, POOL_FEE_PPM, REFEREE, type DeskChainId } from "./config";
import type { MyOrder } from "./account";
import { gaveTokenOf, gotTokenOf, loadOrderLegs, tsOf, type Leg } from "./payouts";

export type { Leg } from "./payouts";

export type Receipt = {
  order: MyOrder;
  placedTs: number;
  addedTx: Hex | null;
  bellTx: Hex | null;
  bellTs: number | null;
  price: bigint | null;
  endTx: Hex | null;
  endReason: string | null;
  collectTx: Hex | null;
  closeTx: Hex | null;
  gaveToken: "USDC" | "WETH";
  gave: bigint;
  legs: Leg[];
  got: { token: "USDC" | "WETH"; amount: bigint } | null;
  paidChain: DeskChainId | null;
  /** Seconds from the bell to the last payout to this trader. */
  seconds: number | null;
  matchedValueUsdc: bigint;
  feeSavedUsdc: bigint;
  /** What the desk pulled from the wallet for this bell, before anything came back. */
  took: bigint;
  /** What came back in the token you gave: the part of a pool swap the pool could not fill inside your limit, a failed swap, and rounding. */
  cameBack: bigint;
};

export async function loadReceipt(order: MyOrder, trader: Address): Promise<Receipt> {
  const lasna = client(LASNA_ID);
  const placedTs = order.placedTs;

  // The pull, the close and every payout or refund, from the shared payouts reader (chain/payouts.ts).
  const ol = await loadOrderLegs({ chainId: order.chainId, deskOrderId: order.deskOrderId, isBuy: order.isBuy, placedTs }, trader);
  const collect = ol.collect;
  const close = ol.close;

  // The referee's side of the story, found by the order's book id.
  let addedTx: Hex | null = null, endTx: Hex | null = null, endReason: string | null = null, bellTx: Hex | null = null, bellTs: number | null = null, price: bigint | null = null;
  if (order.bookId !== null) {
    const lh = await lasna.getBlockNumber();
    const spanFrom = lh > 30_000n ? lh - 30_000n : 0n;
    const [added, dropped] = await Promise.all([
      logClient(LASNA_ID).getContractEvents({ address: REFEREE, abi: refereeAbi, eventName: "OrderAdded", args: { bookId: order.bookId }, fromBlock: spanFrom, toBlock: lh }),
      logClient(LASNA_ID).getContractEvents({ address: REFEREE, abi: refereeAbi, eventName: "OrderDropped", args: { bookId: order.bookId }, fromBlock: spanFrom, toBlock: lh }),
    ]);
    const a = (added as any[])[0];
    const e = (dropped as any[])[0];
    if (a) addedTx = a.transactionHash;
    if (e) {
      endTx = e.transactionHash;
      endReason = String(e.args.reason);
      const bells = await logClient(LASNA_ID).getContractEvents({ address: REFEREE, abi: refereeAbi, eventName: "BellRang", fromBlock: a ? a.blockNumber : e.blockNumber - 800n, toBlock: e.blockNumber });
      const bell = (bells as any[]).at(-1);
      if (bell) { bellTx = bell.transactionHash; bellTs = await tsOf(LASNA_ID, bell.blockNumber); price = bell.args.price as bigint; }
    }
  }

  const legs: Leg[] = ol.legs;

  // What you got: the main token of this order's other side, matched plus pool.
  const gotToken = gotTokenOf(order.isBuy);
  const main = ol.payouts;
  const gotAmount = main.reduce((s, l) => s + l.amount, 0n);
  const biggest = [...main].sort((a, b) => (b.amount > a.amount ? 1 : -1))[0] ?? null;
  // Bell to payout counts only payouts, never refunds or the desk closing the order.
  const lastTs = main.length ? Math.max(...main.map((l) => l.ts)) : null;

  // A match pays no pool fee. The saving shown is that fee on the matched value. Price impact is not counted.
  const matched = legs.filter((l) => l.kind === "matched" && l.token === gotToken);
  let matchedValueUsdc = 0n;
  for (const m of matched) matchedValueUsdc += gotToken === "USDC" ? m.amount : price ? (m.amount * price) / 10n ** 18n : 0n;
  const feeSavedUsdc = (matchedValueUsdc * POOL_FEE_PPM) / 1_000_000n;

  // Net of everything that came back in the token you gave. A pool swap that fills only part of an order hands the rest
  // back in the same transaction, so "gave" is what you really spent, not what the desk pulled first.
  const took = collect && collect.ok ? collect.amount : 0n;
  const gaveTok = gaveTokenOf(order.isBuy);
  let cameBack = 0n;
  for (const l of legs) {
    if (l.kind === "pool") cameBack += l.returned ?? 0n;
    else if ((l.kind === "refund" || l.kind === "dust") && l.token === gaveTok) cameBack += l.amount;
  }
  if (cameBack > took) cameBack = took;

  return {
    order, placedTs, addedTx, bellTx, bellTs, price, endTx, endReason,
    collectTx: collect ? collect.tx : null, closeTx: close ? close.tx : null,
    gaveToken: gaveTok,
    gave: took - cameBack, took, cameBack,
    legs, got: gotAmount > 0n ? { token: gotToken, amount: gotAmount } : null, paidChain: biggest ? biggest.chainId : null,
    seconds: lastTs !== null && bellTs !== null ? Math.max(0, lastTs - bellTs) : null,
    matchedValueUsdc, feeSavedUsdc,
  };
}
