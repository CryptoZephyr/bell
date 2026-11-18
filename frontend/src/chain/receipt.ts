// A receipt for one order, built only from chain events: what you gave, what you got, on which chain, how many seconds
// it took, and the step-by-step ledger across Lasna, Base and Unichain. Nothing here is a claim without a transaction.
import type { Address, Hex } from "viem";
import { client, logClient } from "./clients";
import { blockAt } from "./account";
import { deskAbi, refereeAbi } from "./abi";
import { DESKS, DESK_CHAIN_IDS, LASNA_ID, POOL_FEE_PPM, REFEREE, type DeskChainId } from "./config";
import type { MyOrder } from "./account";

export type Leg = {
  chainId: DeskChainId;
  kind: "matched" | "pool" | "refund" | "dust";
  token: "USDC" | "WETH";
  amount: bigint; // what arrived in the trader's wallet
  used?: bigint; // pool swaps: how much of the input the pool took
  returned?: bigint; // pool swaps: how much came back unused
  tx: Hex;
  ts: number;
};

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
};

const tsCache = new Map<string, number>();
async function tsOf(chainId: number, block: bigint): Promise<number> {
  const k = `${chainId}:${block}`;
  const hit = tsCache.get(k);
  if (hit) return hit;
  const t = Number((await client(chainId).getBlock({ blockNumber: block })).timestamp);
  tsCache.set(k, t);
  return t;
}

async function fromBlockFor(chainId: number, sinceTs: number): Promise<bigint> {
  const c = client(chainId);
  const head = await c.getBlockNumber();
  const back = head > 600n ? head - 600n : 0n;
  const [a, b] = await Promise.all([c.getBlock({ blockNumber: head }), c.getBlock({ blockNumber: back })]);
  const bt = Math.max(0.2, Number(a.timestamp - b.timestamp) / Number(head - back));
  const blocks = BigInt(Math.ceil((Number(a.timestamp) - sinceTs) / bt) + 40);
  return head > blocks ? head - blocks : 0n;
}

export async function loadReceipt(order: MyOrder, trader: Address): Promise<Receipt> {
  const own = client(order.chainId);
  const d = DESKS[order.chainId];
  const lasna = client(LASNA_ID);
  const ownHead = await own.getBlockNumber();
  const orderId = BigInt(order.deskOrderId);

  const placedTs = order.placedTs;
  const fromOwn = await blockAt(order.chainId, placedTs - 10);

  const [collected, closed] = await Promise.all([
    logClient(order.chainId).getContractEvents({ address: d.desk, abi: deskAbi, eventName: "Collected", args: { orderId }, fromBlock: fromOwn, toBlock: ownHead }),
    logClient(order.chainId).getContractEvents({ address: d.desk, abi: deskAbi, eventName: "Closed", args: { orderId }, fromBlock: fromOwn, toBlock: ownHead }),
  ]);
  const collect = (collected as any[]).find((e) => e.args.ok) ?? (collected as any[])[0] ?? null;
  const close = (closed as any[])[0] ?? null;
  const collectTs = collect ? await tsOf(order.chainId, collect.blockNumber) : null;
  const closeTs = close ? await tsOf(order.chainId, close.blockNumber) : null;

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

  // Payout legs to this trader, on both chains, around the time the order settled.
  const lower = (collectTs ?? bellTs ?? placedTs) - 5;
  const upper = (closeTs ?? (bellTs ? bellTs + 90 : lower + 120)) + 15;
  const legs: Leg[] = [];
  await Promise.all(DESK_CHAIN_IDS.map(async (id) => {
    const c = client(id);
    const dk = DESKS[id];
    const head = await c.getBlockNumber();
    const fromBlock = await fromBlockFor(id, lower);
    const [paid, swapped, refunded] = await Promise.all([
      logClient(id).getContractEvents({ address: dk.desk, abi: deskAbi, eventName: "Paid", args: { to: trader, orderId }, fromBlock, toBlock: head }),
      logClient(id).getContractEvents({ address: dk.desk, abi: deskAbi, eventName: "Swapped", args: { to: trader }, fromBlock, toBlock: head }),
      logClient(id).getContractEvents({ address: dk.desk, abi: deskAbi, eventName: "Refunded", args: { to: trader, orderId }, fromBlock, toBlock: head }),
    ]);
    for (const e of paid as any[]) {
      if (!e.args.ok) continue;
      const ts = await tsOf(id, e.blockNumber);
      if (ts < lower || ts > upper) continue;
      // The token that arrived is read from the ERC20 Transfer to the trader in the same transaction.
      const rc = await c.getTransactionReceipt({ hash: e.transactionHash });
      let token: "USDC" | "WETH" | null = null;
      for (const lg of rc.logs) {
        const a = lg.address.toLowerCase();
        if (a === dk.usdc.toLowerCase()) token = "USDC";
        else if (a === dk.weth.toLowerCase()) token = "WETH";
        else continue;
        if (lg.topics[2] && BigInt(lg.topics[2]) === BigInt(trader)) break;
        token = null;
      }
      if (!token) continue;
      const dust = (token === "USDC" && e.args.amount <= 10n) || (token === "WETH" && e.args.amount < 10n ** 12n);
      legs.push({ chainId: id, kind: dust ? "dust" : "matched", token, amount: e.args.amount, tx: e.transactionHash, ts });
    }
    for (const e of swapped as any[]) {
      if (!e.args.ok) continue;
      const ts = await tsOf(id, e.blockNumber);
      if (ts < lower || ts > upper) continue;
      legs.push({ chainId: id, kind: "pool", token: e.args.sellWeth ? "USDC" : "WETH", amount: e.args.amountOut, used: e.args.amountUsed, returned: e.args.refunded, tx: e.transactionHash, ts });
    }
    for (const e of refunded as any[]) {
      if (!e.args.ok) continue;
      const ts = await tsOf(id, e.blockNumber);
      if (ts < lower || ts > upper) continue;
      legs.push({ chainId: id, kind: "refund", token: order.isBuy ? "USDC" : "WETH", amount: e.args.amount, tx: e.transactionHash, ts });
    }
  }));
  legs.sort((a, b) => a.ts - b.ts);

  // What you got: the main token of this order's other side, matched plus pool.
  const gotToken: "USDC" | "WETH" = order.isBuy ? "WETH" : "USDC";
  const main = legs.filter((l) => (l.kind === "matched" || l.kind === "pool") && l.token === gotToken);
  const gotAmount = main.reduce((s, l) => s + l.amount, 0n);
  const biggest = [...main].sort((a, b) => (b.amount > a.amount ? 1 : -1))[0] ?? null;
  const lastTs = legs.length ? Math.max(...legs.map((l) => l.ts)) : null;

  // A match pays no pool fee. The saving shown is that fee on the matched value. Price impact is not counted.
  const matched = legs.filter((l) => l.kind === "matched" && l.token === gotToken);
  let matchedValueUsdc = 0n;
  for (const m of matched) matchedValueUsdc += gotToken === "USDC" ? m.amount : price ? (m.amount * price) / 10n ** 18n : 0n;
  const feeSavedUsdc = (matchedValueUsdc * POOL_FEE_PPM) / 1_000_000n;

  return {
    order, placedTs, addedTx, bellTx, bellTs, price, endTx, endReason,
    collectTx: collect ? collect.transactionHash : null, closeTx: close ? close.transactionHash : null,
    gaveToken: order.isBuy ? "USDC" : "WETH",
    gave: collect && collect.args.ok ? (collect.args.amount as bigint) : 0n,
    legs, got: gotAmount > 0n ? { token: gotToken, amount: gotAmount } : null, paidChain: biggest ? biggest.chainId : null,
    seconds: lastTs !== null && bellTs !== null ? Math.max(0, lastTs - bellTs) : null,
    matchedValueUsdc, feeSavedUsdc,
  };
}
