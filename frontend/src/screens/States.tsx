// A gallery of every state in one place (section 14), for screenshots and the accessibility pass. Development aid.
import { LivingMark } from "../ui/LivingMark";
import { Button } from "../ui/Button";
import { OrderTicket } from "../ui/Ticket";
import { IconAlert } from "../ui/Icons";
import type { MarkState } from "../chain/round";
import type { MyOrder } from "../chain/account";

const MARKS: [MarkState, string, number | null][] = [
  ["quiet", "Market quiet", null], ["open", "Bell in 1:12", 72], ["last10", "Bell in 6 seconds", 6], ["bell", "Bell rang", null],
  ["settling", "Settling", null], ["done", "Paid in 14 seconds", null], ["skipped", "Skipped, price moved", null], ["paused", "Paused", null],
];
const base: MyOrder = { chainId: 84532, deskOrderId: 1, isBuy: true, limit: 2_450_000_000n, qty: 12_000_000_000_000_000n, tx: "0x00" as any, block: 0n, step: 0, outcome: "open", inBook: false, canCancel: true, bookId: null };
const TICKETS: [string, MyOrder][] = [
  ["Placed", base], ["In the book", { ...base, step: 1, inBook: true }], ["Settling", { ...base, chainId: 1301, isBuy: false, step: 2 }],
  ["Paid", { ...base, step: 3, outcome: "settled", canCancel: false }], ["Cancelled", { ...base, outcome: "cancelled", canCancel: false }],
  ["Removed", { ...base, step: 1, outcome: "dropped", canCancel: false }], ["Expired", { ...base, step: 1, outcome: "expired", canCancel: false }],
];

export function States() {
  return (
    <div className="stack-lg">
      <div className="screen-head"><span className="where">Development</span><h1>States</h1><p>Every state in the design, side by side.</p></div>
      <section className="stack" aria-labelledby="s-mark"><h2 id="s-mark">The living mark</h2>
        <div className="states-grid">
          {MARKS.map(([s, label, sec]) => (
            <figure key={s} className="card bc bc-card state-fig">
              <LivingMark state={s} progress={sec ? Math.min(1, sec / 110) : 0} secondsLeft={sec} size={120} label={label} />
              <figcaption>{s}</figcaption>
            </figure>
          ))}
        </div>
      </section>
      <section className="stack" aria-labelledby="s-btn"><h2 id="s-btn">Buttons</h2>
        <div className="stack">
          <Button label="Hold to join the bell" hold />
          <Button label="Waiting for your wallet" state="working" progress={0.35} />
          <Button label="Order placed" state="success" />
          <Button label="Join the bell" state="failure" />
          <Button label="Not enough USDC" disabled />
          <Button kind="secondary" label="Cancel order" />
        </div>
      </section>
      <section className="stack" aria-labelledby="s-tick"><h2 id="s-tick">Order tickets</h2>
        <ul className="stack ticket-list">{TICKETS.map(([n, o]) => <li key={n}><OrderTicket o={o} /></li>)}</ul>
      </section>
      <section className="stack" aria-labelledby="s-misc"><h2 id="s-misc">Notices and empty states</h2>
        <div className="inset notice error"><IconAlert size={22} /><div><strong>We can't reach the chains right now.</strong><p className="muted">Your orders are safe in your wallets. We're retrying on our own.</p></div></div>
        <div className="inset empty"><strong>No orders yet.</strong><p className="muted">Your first order shows up here the moment it's placed.</p></div>
        <div className="skeleton" style={{ height: 120 }} aria-busy="true" />
      </section>
    </div>
  );
}
