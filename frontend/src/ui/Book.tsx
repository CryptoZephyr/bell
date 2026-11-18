// The meet bar and the book (sections 6c and 8). Both are drawn by us from chain data. No chart library.
import { Fragment } from "react";
import { StatusMark } from "./StatusMark";
import { ChainMark } from "./Icons";
import { fmtEth, fmtPrice, shortAddr } from "../chain/format";
import { DESKS } from "../chain/config";
import { inThisBell, meetBar, type BookOrder } from "../chain/round";

/** The meet bar: buyers grow from the left, sellers from the right, and they meet at the paired line. What sticks out
 *  past the line is hatched and goes to the Uniswap pool. */
export function MeetBar({ book, price }: { book: BookOrder[]; price: bigint | null }) {
  if (!price || book.length === 0) {
    return (
      <div className="meet inset">
        <h3>This bell</h3>
        <p className="muted">No orders yet. The next bell starts when someone places one.</p>
        <div className="meet-track empty" aria-hidden="true"><span className="seam" /></div>
      </div>
    );
  }
  const m = meetBar(book, price);
  const max = m.buy > m.sell ? m.buy : m.sell;
  const pct = (v: bigint) => (max === 0n ? 0 : Number((v * 1000n) / max) / 10); // percent of the larger side, 0 to 100
  const buyW = pct(m.buy), sellW = pct(m.sell);
  const buyPaired = pct(m.paired), sellPaired = pct(m.paired);
  const pool = m.buyOverhang > 0n ? m.buyOverhang : m.sellOverhang;
  const alt =
    m.paired === 0n
      ? `No orders pair off at ${fmtPrice(price)}. ${fmtEth(m.buy + m.sell)} ETH would go to the Uniswap pool.`
      : `${fmtEth(m.paired)} ETH pairs off at ${fmtPrice(price)} USDC per ETH.${pool > 0n ? ` ${fmtEth(pool)} ETH goes to the Uniswap pool.` : ""}`;
  return (
    <div className="meet inset">
      <h3>This bell</h3>
      <p className="muted small">If the bell rang now, at the current Uniswap price.</p>
      <div className="meet-track" role="img" aria-label={alt}>
        <div className="meet-side meet-left" style={{ width: `${buyW / 2}%` }}>
          <span className="meet-solid bc bc-sheet" style={{ width: `${buyW === 0 ? 0 : (buyPaired / buyW) * 100}%`, ["--cut" as string]: "10px" }} />
          {m.buyOverhang > 0n && <span className="meet-hatch" style={{ width: `${((buyW - buyPaired) / buyW) * 100}%` }} />}
        </div>
        <span className="seam" />
        <div className="meet-side meet-right" style={{ width: `${sellW / 2}%` }}>
          <span className="meet-solid bc-br" style={{ width: `${sellW === 0 ? 0 : (sellPaired / sellW) * 100}%`, ["--cut" as string]: "10px" }} />
          {m.sellOverhang > 0n && <span className="meet-hatch" style={{ width: `${((sellW - sellPaired) / sellW) * 100}%` }} />}
        </div>
      </div>
      <div className="meet-legend tnum">
        <span><strong>Buyers</strong> {fmtEth(m.buy)} ETH</span>
        <span><strong>Sellers</strong> {fmtEth(m.sell)} ETH</span>
      </div>
      <p className="meet-note tnum">{alt}</p>
    </div>
  );
}

/** One row per order in the book, in the order the bell takes them. */
export function Book({ book, price, me }: { book: BookOrder[]; price: bigint | null; me?: string | null }) {
  if (book.length === 0) {
    return (
      <div className="inset empty">
        <p>No orders yet.</p>
        <p className="muted">Orders from both chains appear here, one list, tagged by chain.</p>
      </div>
    );
  }
  return (
    <ul className="book" aria-label="The book">
      {book.map((o) => {
        const eligible = price === null ? true : inThisBell(o, price);
        const mine = !!me && o.trader.toLowerCase() === me.toLowerCase();
        const chain = DESKS[o.chainId];
        return (
          <Fragment key={String(o.bookId)}>
            <li className={`book-row${mine ? " mine" : ""}`}>
              <div className="book-main">
                <span className="book-chain"><ChainMark chain={chain.key} size={16} /> {chain.key === "base" ? "Base" : "Unichain"}</span>
                <strong>{o.isBuy ? "Buy" : "Sell"} {fmtEth(o.qty)} ETH</strong>
                <span className="muted small tnum">{o.isBuy ? "pays up to" : "wants at least"} {fmtPrice(o.limit)} USDC</span>
              </div>
              <div className="book-side">
                <StatusMark kind={eligible ? "in-bell" : "outside"} />
                <span className="mono small muted">{mine ? "You" : shortAddr(o.trader)}</span>
              </div>
            </li>
          </Fragment>
        );
      })}
    </ul>
  );
}
