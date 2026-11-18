// Activity: every order from this wallet as a ticket, newest first. Open orders can be cancelled while the desk has not
// collected the funds. Settled orders link to their receipt.
import { useRef, useState } from "react";
import { useWallet, friendlyWalletError } from "../wallet/wallet";
import { useAnnounce, useSheets } from "../app/Shell";
import { useOrders } from "../app/OrdersContext";
import { OrderTicket } from "../ui/Ticket";
import { Button, type ButtonState } from "../ui/Button";
import { IconAlert, IconWallet } from "../ui/Icons";
import { deskAbi } from "../chain/abi";
import { DESKS } from "../chain/config";
import { href } from "../app/router";
import type { MyOrder } from "../chain/account";

function CancelButton({ o, onDone }: { o: MyOrder; onDone: () => Promise<void> }) {
  const w = useWallet();
  const announce = useAnnounce();
  const [st, setSt] = useState<{ state: ButtonState; label: string; progress: number; error: string | null }>({ state: "idle", label: "Cancel order", progress: 0.15, error: null });
  const busy = useRef(false);
  const go = async () => {
    if (busy.current) return;
    busy.current = true;
    setSt({ state: "working", label: "Waiting for your wallet", progress: 0.15, error: null });
    try {
      if (w.chainId !== o.chainId) await w.switchTo(o.chainId);
      await w.write({
        chainId: o.chainId, address: DESKS[o.chainId].desk, abi: deskAbi, functionName: "cancel", args: [BigInt(o.deskOrderId)],
        onStep: (label, progress) => setSt((s) => ({ ...s, state: "working", label, progress })),
      });
      setSt({ state: "success", label: "Cancelled", progress: 1, error: null });
      announce("Order cancelled");
      await onDone();
    } catch (e) {
      const f = friendlyWalletError(e);
      setSt({ state: "failure", label: "Cancel order", progress: 0.15, error: f.text });
      announce(f.text, true);
      setTimeout(() => setSt((s) => ({ ...s, state: "idle" })), 420);
    } finally { busy.current = false; }
  };
  return (
    <div className="ticket-actions">
      <Button kind="secondary" block={false} label={st.label} state={st.state} progress={st.progress} onPress={go} under="var(--card)" />
      {st.error && <p className="field-error" role="alert"><IconAlert size={18} />{st.error}</p>}
    </div>
  );
}

export function Activity() {
  const w = useWallet();
  const { openConnect } = useSheets();
  const { orders, loading, error, refresh } = useOrders();

  return (
    <div className="stack-lg">
      <div className="screen-head">
        <span className="where">Your orders</span>
        <h1>Activity</h1>
        <p>Every order from this wallet, and how far it has got.</p>
      </div>

      {w.status !== "connected" && (
        <div className="inset empty">
          <strong>Connect your wallet to see your orders.</strong>
          <p className="muted">Bell reads your orders from the chains. Nothing is stored anywhere else.</p>
          <div><Button block={false} label="Connect wallet" glyph={<IconWallet />} onPress={openConnect} /></div>
        </div>
      )}

      {w.status === "connected" && error && !orders && (
        <div className="inset notice error" role="alert"><IconAlert size={22} /><div><strong>We couldn't load your orders.</strong><p className="muted">{error}. Trying again on its own.</p></div></div>
      )}

      {w.status === "connected" && !orders && !error && loading && (
        <div className="stack" aria-busy="true"><div className="skeleton" style={{ height: 150 }} /><div className="skeleton" style={{ height: 150 }} /></div>
      )}

      {w.status === "connected" && orders && orders.length === 0 && (
        <div className="inset empty">
          <strong>No orders yet.</strong>
          <p className="muted">Your first order shows up here the moment it's placed.</p>
          <div><Button block={false} label="Place an order" href={href.trade} /></div>
        </div>
      )}

      {orders && orders.length > 0 && (
        <ul className="stack ticket-list" aria-label="Your orders">
          {orders.map((o, i) => (
            <li key={`${o.chainId}-${o.deskOrderId}`} className={i % 2 ? "paired-b-li" : undefined}>
              <OrderTicket o={o}>
                {o.canCancel && <CancelButton o={o} onDone={refresh} />}
                {o.outcome === "settled" && <a className="chip-link" href={href.receipt(o.chainId, o.deskOrderId)}>See receipt</a>}
              </OrderTicket>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
