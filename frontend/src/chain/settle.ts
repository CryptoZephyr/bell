// Settlement words for the bell card, decided from confirmed desk events only (pure functions, so they can be tested).
import type { LegProgress } from "./round";

/** Seconds a chain must go without a new payout or refund before it counts as finished for the round. */
export const QUIET_S = 8;

/**
 * One chain's word during settlement, from confirmed desk events only. "Paid" needs a confirmed payout on that chain,
 * Lasna to have settled (so nothing more is coming), and the chain to have gone quiet. A desk closing an order or the
 * Lasna Settled event never makes a chain say Paid on its own.
 */
export function nodeState(l: LegProgress | undefined, settledOnLasna: boolean, nowMs: number): { word: string; done: boolean } {
  if (!l) return { word: "Waiting", done: false };
  const quiet = l.lastTs === null || nowMs / 1000 - l.lastTs > QUIET_S;
  if (l.payouts > 0) return settledOnLasna && quiet ? { word: "Paid", done: true } : { word: "Paying", done: false };
  if (l.refunds > 0) return settledOnLasna && quiet ? { word: "Refunded", done: true } : { word: "Returning funds", done: false };
  if (l.collected > 0) return { word: settledOnLasna ? "Paying" : "Collecting", done: false };
  return { word: settledOnLasna ? "Nothing to pay here" : "Waiting", done: false };
}

/** True once every chain that moved money this round has gone quiet, and at least one payout or refund is confirmed. */
export function roundPaidOut(legs: LegProgress[] | null, nowMs: number): boolean {
  if (!legs) return false;
  const moved = legs.filter((l) => l.payouts + l.refunds > 0);
  return moved.length > 0 && moved.every((l) => l.lastTs === null || nowMs / 1000 - l.lastTs > QUIET_S);
}

