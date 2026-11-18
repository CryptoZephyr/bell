// Which state is the trader in? One pure function, so every state in the design's matrix can be tested and shown on its own.
import type { ChainBalances } from "./account";

export type Stage =
  | "connect" // wallet not connected
  | "bad-amount" // nothing valid typed yet
  | "too-small" // under the desk's smallest order
  | "too-many" // already at the per-wallet cap
  | "no-price" // the Uniswap price could not be read
  | "no-token" // not enough USDC (buy) or ETH (sell) on that chain
  | "no-gas" // not enough test ETH for gas
  | "switch" // wallet is on another network
  | "wrap" // sell, and the ETH needs wrapping first
  | "approve" // one-time approval needed
  | "join"; // ready to hold to join

export type TradeInput = {
  connected: boolean;
  walletChainId: number | null;
  chainId: 84532 | 1301;
  isBuy: boolean;
  qty: bigint | null; // wei
  minQty: bigint;
  protectionBps: number;
  refPrice: bigint | null; // USDC micro-units per ETH
  balances: ChainBalances | null;
  openOrders: number; // this wallet's orders in the book
  maxOrders: number;
};

export type Plan = {
  stage: Stage;
  limit: bigint | null; // the worst price, USDC micro-units per ETH
  need: bigint | null; // USDC micro-units (buy) or wei (sell) the desk will need
  have: bigint | null;
  wrapAmount: bigint | null;
};

export const GAS_MIN = 30_000_000_000_000n; // 0.00003 ETH, plenty for one testnet transaction

export function planTrade(i: TradeInput): Plan {
  const none: Plan = { stage: "connect", limit: null, need: null, have: null, wrapAmount: null };
  if (!i.connected) return none;
  if (!i.qty) return { ...none, stage: "bad-amount" };
  if (i.qty < i.minQty) return { ...none, stage: "too-small" };
  if (i.openOrders >= i.maxOrders) return { ...none, stage: "too-many" };
  if (!i.refPrice) return { ...none, stage: "no-price" };

  const bps = BigInt(i.protectionBps);
  const limit = i.isBuy ? (i.refPrice * (10_000n + bps)) / 10_000n : (i.refPrice * (10_000n - bps)) / 10_000n;
  // A buyer needs the cost at the order's own limit (the desk checks this at placement). A seller needs the ETH itself.
  const need = i.isBuy ? (i.qty * limit + 10n ** 18n - 1n) / 10n ** 18n : i.qty;
  const base = { limit, need };
  if (!i.balances) return { ...none, ...base, stage: "no-token", have: null, wrapAmount: null };

  const b = i.balances;
  const have = i.isBuy ? b.usdc : b.weth;
  const allowance = i.isBuy ? b.allowUsdc : b.allowWeth;

  let wrapAmount: bigint | null = null;
  if (have < need) {
    // A seller may hold plain ETH. Offer to wrap what is missing, if the ETH covers it and gas.
    const missing = need - have;
    if (!i.isBuy && b.eth >= missing + GAS_MIN) wrapAmount = missing;
    else return { stage: "no-token", ...base, have, wrapAmount: null };
  }
  if (b.eth < GAS_MIN) return { stage: "no-gas", ...base, have, wrapAmount: null };
  if (i.walletChainId !== i.chainId) return { stage: "switch", ...base, have, wrapAmount };
  if (wrapAmount) return { stage: "wrap", ...base, have, wrapAmount };
  if (allowance < need) return { stage: "approve", ...base, have, wrapAmount: null };
  return { stage: "join", ...base, have, wrapAmount: null };
}
