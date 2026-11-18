// The order ticket (section 8): your order as an Ink ticket with side, amount, chain and worst price, and a four-step
// track along the bottom: Placed, In the book, Bell, Paid. Done steps are solid Signal, the current one pulses slowly,
// the next ones are outlines. Only the last step ever says paid, and only when a payout to the trader is confirmed on a
// desk chain (chain/payouts.ts). A refund or a closed order with unreadable logs ends the ticket without that step.
import { ChainMark, IconCheck } from "./Icons";
import { fmtEth, fmtPrice } from "../chain/format";
import { DESKS } from "../chain/config";
import type { MyOrder } from "../chain/account";

const STEPS = ["Placed", "In the book", "Bell", "Paid"] as const;

export function Track({ step, outcome }: { step: 0 | 1 | 2 | 3; outcome: MyOrder["outcome"] }) {
  const ended = outcome === "cancelled" || outcome === "dropped" || outcome === "expired" || outcome === "rejected" || outcome === "refunded" || outcome === "finished";
  return (
    <ol className="track" aria-label="Order progress">
      {STEPS.map((s, i) => {
        // A refunded or finished order went through the bell (its funds were pulled), so the Bell step is done. Paid stays
        // empty unless a payout was confirmed.
        const done = i < step || (i === step && (outcome === "settled" || outcome === "refunded" || outcome === "finished"));
        const current = i === step && outcome === "open";
        const cls = done ? "done" : current ? "current" : "next";
        return (
          <li key={s} className={cls} aria-current={current ? "step" : undefined}>
            <span className="dot" aria-hidden="true">{done && i === 3 ? <IconCheck size={12} /> : null}</span>
            <span className="step-name">{s}{done ? <span className="sr-only"> done</span> : null}</span>
          </li>
        );
      })}
      {ended && <li className="sr-only">Order {outcome}</li>}
    </ol>
  );
}

/** What a removed order says. The referee gives the reason, so the trader learns why. */
function removedWord(reason: string | null): string {
  if (!reason) return "Removed";
  if (/funds moved/i.test(reason)) return "Removed: your funds moved";
  if (/pull failed/i.test(reason)) return "Removed: the desk could not collect your funds";
  return `Removed: ${reason}`;
}

export function OrderTicket({ o, wide, children }: { o: MyOrder; wide?: boolean; children?: React.ReactNode }) {
  const d = DESKS[o.chainId];
  const word =
    o.outcome === "settled" ? "Paid" : o.outcome === "refunded" ? "Refunded" : o.outcome === "finished" ? "Finished, see receipt" :
    o.outcome === "cancelled" ? "Cancelled" : o.outcome === "dropped" ? removedWord(o.reason) : o.outcome === "rejected" ? "Not accepted. Cancel it to free your slot." : o.outcome === "expired" ? "Expired" :
    o.step === 0 ? "Placed, waiting to be heard" : o.step === 1 ? "In the book" : "Settling";
  return (
    <article className={`ticket card bc bc-card${wide ? " wide" : ""}`} aria-label={`${o.isBuy ? "Buy" : "Sell"} ${fmtEth(o.qty)} ETH on ${d.name}`}>
      <div className="ticket-top">
        <div>
          <div className="ticket-side">{o.isBuy ? "Buy" : "Sell"} {fmtEth(o.qty)} ETH</div>
          <div className="muted small tnum">{o.isBuy ? "Pay up to" : "Get at least"} {fmtPrice(o.limit)} USDC per ETH</div>
        </div>
        <span className="ticket-chain"><ChainMark chain={d.key} size={16} /> {d.key === "base" ? "Base" : "Unichain"}</span>
      </div>
      <Track step={o.step} outcome={o.outcome} />
      <div className="ticket-foot">
        <span className={`ticket-status ${o.outcome}`}>{word}</span>
        {children}
      </div>
    </article>
  );
}
