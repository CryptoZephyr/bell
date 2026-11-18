// The receipt (section 10): what you gave, what you got, where, how many seconds it took, and a ledger of every step with
// a link to its transaction. Only chain events are shown. A matched leg is not a claim of a saving unless it was matched.
import { useEffect, useState } from "react";
import { useWallet } from "../wallet/wallet";
import { useSheets } from "../app/Shell";
import { useOrders } from "../app/OrdersContext";
import { Button } from "../ui/Button";
import { ChainMark, IconAlert, IconArrowUpRight, IconBack, IconWallet } from "../ui/Icons";
import { chainName, DESKS, LASNA_ID, txUrl } from "../chain/config";
import { fmtEth, fmtUsdc, secondsLabel, shortHash } from "../chain/format";
import { loadReceipt, type Leg, type Receipt as R } from "../chain/receipt";
import { href } from "../app/router";

const amt = (token: "USDC" | "WETH", n: bigint) => (token === "USDC" ? `${fmtUsdc(n)} USDC` : `${fmtEth(n)} ETH`);

function legWords(l: Leg): string {
  switch (l.kind) {
    case "matched": return `Matched with another trader. You received ${amt(l.token, l.amount)}.`;
    case "pool": return `Filled in the Uniswap pool. You received ${amt(l.token, l.amount)}.`;
    case "refund": return `Returned to you: ${amt(l.token, l.amount)}.`;
    case "dust": return `A tiny rounding amount, ${amt(l.token, l.amount)}, paid out.`;
  }
}

function Step({ chainId, tx, title, text, done }: { chainId: number; tx: string | null; title: string; text?: string; done?: boolean }) {
  return (
    <li className={tx || done ? "led done" : "led"}>
      <span className="led-dot" aria-hidden="true" />
      <div className="led-body">
        <strong>{title}</strong>
        {text && <p className="muted">{text}</p>}
        {tx && (
          <a className="chip-link" href={txUrl(chainId, tx)} target="_blank" rel="noopener noreferrer">
            <span className="chain-dot"><ChainMark chain={chainId === LASNA_ID ? "lasna" : DESKS[chainId as 84532 | 1301].key} size={14} /></span>
            {chainName(chainId)} <span className="mono">{shortHash(tx)}</span><IconArrowUpRight size={14} />
          </a>
        )}
      </div>
    </li>
  );
}

export function Receipt({ chainId, orderId }: { chainId: number; orderId: number }) {
  const w = useWallet();
  const { openConnect } = useSheets();
  const { orders } = useOrders();
  const [rc, setRc] = useState<R | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const order = orders?.find((o) => o.chainId === chainId && o.deskOrderId === orderId) ?? null;

  useEffect(() => {
    if (!order || !w.address) return;
    let alive = true;
    setRc(null); setErr(null);
    loadReceipt(order, w.address).then((r) => alive && setRc(r)).catch((e) => alive && setErr(String(e?.shortMessage ?? e?.message ?? e).slice(0, 140)));
    return () => { alive = false; };
  }, [order?.chainId, order?.deskOrderId, order?.outcome, w.address]);

  const back = <a className="chip-link back" href={href.activity}><IconBack size={16} /> Activity</a>;

  if (w.status !== "connected") {
    return (
      <div className="stack-lg">
        <div className="screen-head">{back}<h1>Receipt</h1></div>
        <div className="inset empty"><strong>Connect the wallet that placed this order.</strong><p className="muted">A receipt is built from your own order, read from the chains.</p>
          <div><Button block={false} label="Connect wallet" glyph={<IconWallet />} onPress={openConnect} /></div></div>
      </div>
    );
  }
  if (!orders) return <div className="stack-lg"><div className="screen-head">{back}<h1>Receipt</h1></div><div className="skeleton" style={{ height: 220 }} aria-busy="true" /></div>;
  if (!order) {
    return (
      <div className="stack-lg"><div className="screen-head">{back}<h1>Receipt</h1></div>
        <div className="inset empty"><strong>We can't find that order in this wallet.</strong><p className="muted">Check you're connected with the wallet that placed it.</p></div></div>
    );
  }

  const ended = order.outcome !== "settled";
  const dh = DESKS[order.chainId];
  return (
    <div className="stack-lg">
      <div className="screen-head">
        {back}
        <h1>Receipt</h1>
        <p>{order.isBuy ? "Buy" : "Sell"} {fmtEth(order.qty)} ETH on {dh.name}</p>
      </div>

      {err && <div className="inset notice error" role="alert"><IconAlert size={22} /><div><strong>We couldn't read the whole receipt.</strong><p className="muted">{err}</p></div></div>}
      {!rc && !err && <div className="skeleton" style={{ height: 240 }} aria-busy="true" />}

      {rc && (
        <>
          <section className="card bc bc-card receipt-hero" aria-label="Summary">
            {ended ? (
              <>
                <h2 className="receipt-head">{order.outcome === "cancelled" ? "Cancelled" : order.outcome === "expired" ? "Expired" : order.outcome === "dropped" ? "Removed from the book" : order.outcome === "rejected" ? "Not accepted" : order.outcome === "refunded" ? "Refunded" : order.outcome === "finished" ? "Finished" : "Not settled yet"}</h2>
                <p className="muted">{
                  order.outcome === "open" ? (rc.gave > 0n ? "Your funds are with the desk for this bell. This receipt fills in once the payout lands." : "This receipt fills in once the order is paid.")
                  : order.outcome === "refunded" ? `The desk took ${amt(rc.gaveToken, rc.gave)} for this bell and gave it back. No trade happened.`
                  : order.outcome === "rejected" ? "The bell had no room for this order or you already had the most open orders. Cancel it to free your slot. Nothing was taken from your wallet."
                  : order.outcome === "dropped" && order.reason ? `The bell removed this order: ${order.reason}. Nothing was taken from your wallet.`
                  : order.outcome === "finished" ? "The desk closed this order, but its payout records are too old to read now. Check the desk on the block explorer."
                  : "Nothing was taken from your wallet for this order."}</p>
              </>
            ) : (
              <>
                <div className="receipt-pair">
                  <div><span className="muted small">You gave</span><div className="receipt-num">{rc.gave > 0n ? amt(rc.gaveToken, rc.gave) : "Nothing recorded"}</div></div>
                  <div><span className="muted small">You got</span><div className="receipt-num">{rc.got ? amt(rc.got.token, rc.got.amount) : "Nothing recorded"}</div></div>
                </div>
                <dl className="split">
                  <div><dt>Paid on</dt><dd>{rc.paidChain ? DESKS[rc.paidChain].name : "Not found"}</dd></div>
                  <div><dt>Bell to payout</dt><dd>{rc.seconds !== null ? secondsLabel(rc.seconds) : "Not found"}</dd></div>
                  {rc.feeSavedUsdc >= 10_000n && <div><dt>Pool fee avoided on matched part</dt><dd>{fmtUsdc(rc.feeSavedUsdc)} USDC</dd></div>}
                </dl>
              </>
            )}
          </section>

          <section aria-labelledby="ledger-h" className="stack">
            <h2 id="ledger-h">How this settled</h2>
            <ol className="ledger">
              <Step chainId={order.chainId} tx={order.tx} done title="You placed the order" text={`${order.isBuy ? "Pay up to" : "Get at least"} ${fmtUsdc(order.limit)} USDC per ETH.`} />
              <Step chainId={LASNA_ID} tx={rc.addedTx} title="The order joined the book" />
              {rc.bellTx && <Step chainId={LASNA_ID} tx={rc.bellTx} title="The bell rang" text={rc.price ? `One price for everyone: ${fmtUsdc(rc.price)} USDC per ETH.` : undefined} />}
              {rc.collectTx && <Step chainId={order.chainId} tx={rc.collectTx} title="Your funds moved to the desk for this bell" />}
              {rc.legs.map((l) => <Step key={l.tx + l.kind} chainId={l.chainId} tx={l.tx} title={l.kind === "pool" ? "Pool fill" : l.kind === "refund" ? "Returned" : l.kind === "dust" ? "Rounding" : "Match payout"} text={legWords(l)} />)}
              {rc.closeTx && <Step chainId={order.chainId} tx={rc.closeTx} title="The desk closed your order" />}
              {rc.endTx && order.outcome !== "settled" && order.outcome !== "refunded" && <Step chainId={LASNA_ID} tx={rc.endTx} title="The order left the book" text={rc.endReason ?? undefined} />}
            </ol>
          </section>
        </>
      )}
    </div>
  );
}
