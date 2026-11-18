// A trader's balances, approvals and orders, read from the chains.
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { client } from "./clients";
import { deskAbi, erc20Abi, refereeAbi } from "./abi";
import { DESKS, DESK_CHAIN_IDS, REFEREE, type DeskChainId } from "./config";

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
export type OrderOutcome = "open" | "settled" | "cancelled" | "dropped" | "expired";

export type MyOrder = {
  chainId: DeskChainId;
  deskOrderId: number;
  isBuy: boolean;
  limit: bigint;
  qty: bigint;
  tx: Hex;
  block: bigint;
  /** How far the order has got, from chain state. A placed order is never shown as filled. */
  step: TicketStep;
  outcome: OrderOutcome;
  /** In the book right now (the referee heard it and has not closed it). */
  inBook: boolean;
  canCancel: boolean;
  bookId: bigint | null;
};

export async function loadMyOrders(trader: Address): Promise<MyOrder[]> {
  const rows: MyOrder[] = [];
  const rc = client(1301 as number); // referee reads go through Lasna below
  void rc;
  const lasna = client(5318007);
  for (const id of DESK_CHAIN_IDS) {
    const d = DESKS[id];
    const c = client(id);
    const head = await c.getBlockNumber();
    const placed: any[] = await c.getContractEvents({ address: d.desk, abi: deskAbi, eventName: "OrderPlaced", args: { trader }, fromBlock: d.deskBlock, toBlock: head });
    for (const p of placed) {
      const orderId = p.args.orderId as bigint;
      const [collected, closed, frozen] = await Promise.all([
        c.readContract({ address: d.desk, abi: deskAbi, functionName: "collectedOf", args: [orderId] }) as Promise<bigint>,
        c.readContract({ address: d.desk, abi: deskAbi, functionName: "closedOf", args: [orderId] }) as Promise<bigint>,
        c.readContract({ address: d.desk, abi: deskAbi, functionName: "frozen", args: [orderId] }) as Promise<boolean>,
      ]);
      const key = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [BigInt(id), orderId]));
      const bookId = (await lasna.readContract({ address: REFEREE, abi: refereeAbi, functionName: "bookIdOf", args: [key] })) as bigint;
      let inBook = false;
      if (bookId > 0n) {
        const o = (await lasna.readContract({ address: REFEREE, abi: refereeAbi, functionName: "orders", args: [bookId] })) as readonly [Address, number, boolean, boolean, number, bigint, bigint];
        inBook = o[3];
      }
      const cancelled = (await c.getContractEvents({ address: d.desk, abi: deskAbi, eventName: "OrderCancelled", args: { orderId }, fromBlock: p.blockNumber, toBlock: head })).length > 0;

      let outcome: OrderOutcome = "open";
      let step: TicketStep = 0;
      if (closed > 0n && closed === collected) { outcome = "settled"; step = 3; }
      else if (collected > 0n) { step = 2; }
      else if (cancelled) { outcome = "cancelled"; }
      else if (inBook) { step = 1; }
      else if (frozen) { outcome = "dropped"; }
      else if (bookId > 0n) { outcome = "dropped"; step = 1; }
      rows.push({
        chainId: id, deskOrderId: Number(orderId), isBuy: p.args.isBuy, limit: p.args.price, qty: p.args.qty, tx: p.transactionHash, block: p.blockNumber,
        step, outcome, inBook, canCancel: outcome === "open" && collected === 0n && !frozen, bookId: bookId > 0n ? bookId : null,
      });
    }
  }
  return rows.sort((a, b) => Number(b.block - a.block));
}
