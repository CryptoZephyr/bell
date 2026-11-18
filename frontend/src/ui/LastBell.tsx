// The last bell's split sheet (section 18, screen 3): what the last round did, in real seconds from block timestamps.
import { ChainMark, IconArrowUpRight } from "./Icons";
import { fmtPrice } from "../chain/format";
import { LASNA_ID, explorerName, txUrl } from "../chain/config";
import type { LastRound } from "../chain/round";

export function LastBell({ last, loading }: { last: LastRound | null; loading?: boolean }) {
  if (!last) {
    return (
      <div className="inset empty">
        <h3>Last bell</h3>
        <p className="muted">{loading ? "Reading the last bell…" : "No bell has rung recently. When one does, how fast it paid shows here."}</p>
      </div>
    );
  }
  const seconds = last.payoutSeconds ?? last.settleSeconds;
  return (
    <div className="inset last-bell stack">
      <div className="row between">
        <h3>Last bell</h3>
        <span className="small muted tnum">Settled in {Math.round(seconds)} s</span>
      </div>
      <dl className="split tnum">
        <div><dt>Price</dt><dd>{fmtPrice(last.price)} USDC per ETH</dd></div>
        <div><dt>Orders in the bell</dt><dd>{last.eligible}</dd></div>
        <div><dt>Pairs</dt><dd>{last.pairs}</dd></div>
        {last.payouts.map((p) => (
          <div key={p.chainId}>
            <dt><ChainMark chain={p.chainId === 84532 ? "base" : "unichain"} size={14} /> Last payout on {p.chainId === 84532 ? "Base" : "Unichain"}</dt>
            <dd>{p.seconds} s after the bell</dd>
          </div>
        ))}
      </dl>
      <div className="row wrap">
        <a className="chip-link" href={txUrl(LASNA_ID, last.bellTx)} target="_blank" rel="noopener noreferrer">The bell on {explorerName(LASNA_ID)}<IconArrowUpRight size={14} /></a>
        <a className="chip-link" href={txUrl(LASNA_ID, last.settleTx)} target="_blank" rel="noopener noreferrer">The settlement<IconArrowUpRight size={14} /></a>
      </div>
    </div>
  );
}
