// One round (ROUNDS_SPEC section 3): the split sheet, the match, the orders and a ledger of every transaction in time order.
import { useEffect, useState } from "react";
import { useOrders } from "../app/OrdersContext";
import { ChainMark, IconAlert, IconArrowUpRight, IconBack } from "../ui/Icons";
import { OUTCOME_WORD, OutcomeMark, SplitSheet, roundTime } from "../ui/RoundParts";
import { DESKS, LASNA_ID, chainName, txUrl, type DeskChainId } from "../chain/config";
import { fmtEth, fmtPrice, fmtPriceUnit, fmtUsdc, shortAddr, shortHash } from "../chain/format";
import { loadRound, matchFacts, seedAt, seedRound, type Round, type RoundLeg, type RoundOrder } from "../chain/rounds";
import { href } from "../app/router";

const amt = (token: "USDC" | "WETH" | null, n: bigint | null) => (n === null ? "" : token === "USDC" ? `${fmtUsdc(n)} USDC` : token === "WETH" ? `${fmtEth(n)} ETH` : "");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const LEG_TITLE: Record<RoundLeg["kind"], string> = {
  pull: "Funds moved to the desk", payout: "Match payout", rounding: "Rounding returned", pool: "Pool fill", poolfail: "Pool fill failed, funds returned", refund: "Returned", close: "The desk closed the order",
};
function legText(l: RoundLeg): string | undefined {
  switch (l.kind) {
    case "pull": return l.ok ? `${amt(l.token, l.amount)} pulled.` : "The pull failed. Nothing was taken.";
    case "payout": return l.amount !== null && l.token ? `${amt(l.token, l.amount)} paid out.` : "Paid out.";
    case "rounding": return `${amt(l.token, l.amount)} came back as rounding.`;
    case "pool": return `The pool took ${l.used !== undefined && l.token ? amt(l.token === "WETH" ? "USDC" : "WETH", l.used) : "the input"} and gave ${amt(l.token, l.amount)}.${l.returned && l.returned > 0n && l.token ? ` ${amt(l.token === "WETH" ? "USDC" : "WETH", l.returned)} came back.` : ""}`;
    case "refund": return l.amount !== null && l.token ? `${amt(l.token, l.amount)} returned.` : undefined;
    default: return undefined;
  }
}

function Step({ chainId, tx, title, text, secs }: { chainId: number; tx: string; title: string; text?: string; secs: number | null }) {
  return (
    <li className="led done">
      <span className="led-dot" aria-hidden="true" />
      <div className="led-body">
        <strong>{title}{secs !== null && <span className="led-secs tnum"> · {secs === 0 ? "at the bell" : `${secs} s after the bell`}</span>}</strong>
        {text && <p className="muted">{text}</p>}
        <a className="chip-link" href={txUrl(chainId, tx)} target="_blank" rel="noopener noreferrer">
          <span className="chain-dot"><ChainMark chain={chainId === LASNA_ID ? "lasna" : DESKS[chainId as DeskChainId].key} size={14} /></span>
          {chainName(chainId)} <span className="mono">{shortHash(tx)}</span><IconArrowUpRight size={14} />
        </a>
      </div>
    </li>
  );
}

const RESULT_WORD: Record<RoundOrder["result"], string> = {
  matched: "Matched with another trader and paid",
  "matched and pool": "Matched, and the rest filled on the Uniswap pool",
  pool: "Filled on the Uniswap pool",
  refunded: "Refunded",
  removed: "Removed, its pull failed. Nothing was taken",
  unknown: "Not readable right now",
};

function OrderRow({ o, offset }: { o: RoundOrder; offset: boolean }) {
  return (
    <li className={`ro${offset ? " offset" : ""}`}>
      <div className="ro-top">
        <span className="book-chain"><ChainMark chain={DESKS[o.chainId].key} size={14} /> {DESKS[o.chainId].name}</span>
        <strong>{o.isBuy ? "Buy" : "Sell"} {fmtEth(o.qty)} ETH</strong>
      </div>
      <p className="muted small tnum">{o.isBuy ? "Pay up to" : "Get at least"} {fmtPriceUnit(o.limit)} · {shortAddr(o.trader)}</p>
      <p className={`ro-result ${o.result.replace(/ /g, "-")}`}>{RESULT_WORD[o.result]}</p>
      {o.legs.filter((l) => l.kind === "payout" || l.kind === "pool").map((l, i) => <p key={i} className="muted small">{legText(l)}</p>)}
      {o.sharedPool && <p className="muted small">This wallet has two orders on this chain in this round, so a pool fill here is shared between them.</p>}
    </li>
  );
}

function sentence(r: Round): string {
  switch (r.outcome) {
    case "settled": return r.seconds !== null ? `Settled at ${fmtPrice(r.price!)} USDC per ETH. Paid out ${plural(r.seconds, "second")} after the bell.` : `Settled at ${fmtPrice(r.price!)} USDC per ETH. Payout times are not readable right now.`;
    case "unwound": return `${plural(r.unwound, "order")} had a failed pull and was removed. The others settled${r.seconds !== null ? `, ${plural(r.seconds, "second")} after the bell` : ""}.`;
    case "skipped": return "The price on the Uniswap pool jumped more than 10 percent inside one window, so this bell was skipped. No money moved and orders carry to the next bell.";
    case "expired": return `${plural(r.eligible, "order")} sat in the book too long and ${r.eligible === 1 ? "was" : "were"} removed. Nothing was pulled.`;
    default: return "This round is still settling. This page updates by itself.";
  }
}

export function RoundPage({ block }: { block: string }) {
  const { orders: mine } = useOrders();
  const [round, setRound] = useState<Round | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "missing" | "error">("loading");

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setRound(null); setState("loading");
    let tries = 0;
    const go = async () => {
      try {
        const seed = await seedAt(BigInt(block));
        if (stop) return;
        if (!seed) { setState("missing"); return; }
        const base = seedRound(seed);
        setRound((prev) => prev ?? base);
        setState("ok");
        const full = await loadRound(seed, { tokens: true });
        if (stop) return;
        setRound(full);
        // Try again while the round is still settling, or while a chain could not be read. A pruned log stops after a few tries.
        const young = seed.ts !== null && Date.now() / 1000 - seed.ts < 300;
        if ((!full.complete && seed.kind === "bell") && (young || ++tries < 3)) timer = setTimeout(go, young ? 6000 : 15000);
      } catch {
        if (stop) return;
        setState((s) => (s === "ok" ? s : "error"));
        timer = setTimeout(go, 8000);
      }
    };
    go();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [block]);

  const back = <a className="chip-link back" href={href.rounds}><IconBack size={16} /> Rounds</a>;

  if (state === "missing") {
    return (
      <div className="stack-lg"><div className="screen-head">{back}<h1>Round</h1></div>
        <div className="inset empty"><strong>We can't find a round at that block on these contracts.</strong><p className="muted">Rounds on older deployments are not shown.</p></div></div>
    );
  }
  if (!round) {
    return (
      <div className="stack-lg"><div className="screen-head">{back}<h1>Round</h1></div>
        {state === "error" && <div className="inset notice error" role="alert"><IconAlert size={22} /><div><strong>We can't reach the chains right now.</strong><p className="muted">We're retrying on our own.</p></div></div>}
        <div className="skeleton" style={{ height: 260 }} aria-busy="true" /></div>
    );
  }

  const facts = matchFacts(round);
  const mineHere = (mine ?? []).filter((m) => round.orders.some((o) => o.chainId === m.chainId && o.deskOrderId === m.deskOrderId));
  const bellTs = round.bellTs;
  const settleSecs = round.settleTs !== null && bellTs !== null ? round.settleTs - bellTs : null;
  const showSheet = round.kind === "bell" && round.loaded;

  return (
    <div className="stack-lg round-page">
      <div className="screen-head">
        {back}
        <span className="where">Round at</span>
        <h1 className="tnum">{roundTime(round.bellTs)}</h1>
        <p className="rr-outcome-line"><span className={`rr-outcome ${round.outcome}`}><OutcomeMark outcome={round.outcome} size={18} />{OUTCOME_WORD[round.outcome]}</span></p>
      </div>

      <section className="card bc bc-card round-hero" aria-label="Summary">
        <p className="round-sentence">{sentence(round)}</p>
        {showSheet ? <SplitSheet round={round} /> : round.kind === "bell" ? <div className="skeleton" style={{ height: 140 }} aria-busy="true" /> : null}
        {round.kind === "bell" && round.loaded && !round.complete && round.outcome !== "open" && (
          <p className="muted small">Some payout times could not be read from the public RPCs, so no total is shown. We keep trying.</p>
        )}
      </section>

      {round.kind === "bell" && (
        <section aria-labelledby="match-h" className="stack">
          <h2 id="match-h">The match</h2>
          <dl className="split tnum inset">
            <div><dt>Price</dt><dd>{round.price !== null ? fmtPriceUnit(round.price) : "Not found"}</dd></div>
            <div><dt>Orders in the bell</dt><dd>{round.eligible}</dd></div>
            <div><dt>Pairs</dt><dd>{round.pairs}</dd></div>
            {round.loaded && <div><dt>Paired</dt><dd>{facts.pairedEth === null ? "Reading" : `${fmtEth(facts.pairedEth)} ETH`}</dd></div>}
            {round.loaded && (facts.poolEth > 0n || facts.poolUsdc > 0n) && (
              <div><dt>Went to the Uniswap pool</dt><dd>{[facts.poolEth > 0n ? `${fmtEth(facts.poolEth)} ETH bought` : "", facts.poolUsdc > 0n ? `${fmtUsdc(facts.poolUsdc)} USDC bought` : ""].filter(Boolean).join(", ")}</dd></div>
            )}
          </dl>
        </section>
      )}

      {round.orders.length > 0 && (
        <section aria-labelledby="orders-h" className="stack">
          <h2 id="orders-h">The orders</h2>
          <ul className="ro-list">
            {round.orders.filter((o) => o.isBuy).map((o) => <OrderRow key={o.bookId.toString()} o={o} offset={false} />)}
            {round.orders.filter((o) => !o.isBuy).map((o) => <OrderRow key={o.bookId.toString()} o={o} offset={round.pairs > 0} />)}
          </ul>
          {mineHere.length > 0 && (
            <div className="row wrap">{mineHere.map((m) => <a key={`${m.chainId}${m.deskOrderId}`} className="chip-link" href={href.receipt(m.chainId, m.deskOrderId)}>Your receipt, order {m.deskOrderId}<IconArrowUpRight size={14} /></a>)}</div>
          )}
        </section>
      )}

      <section aria-labelledby="ledger-h" className="stack">
        <h2 id="ledger-h">How this round settled</h2>
        <ol className="ledger">
          <Step chainId={LASNA_ID} tx={round.bellTx} secs={round.kind === "bell" ? 0 : null}
            title={round.kind === "skipped" ? "The bell was skipped" : round.kind === "expired" ? "The bell removed old orders" : "The bell rang"}
            text={round.kind === "bell" && round.price !== null ? `One price for everyone: ${fmtPriceUnit(round.price)}.` : round.kind === "skipped" ? round.reason ?? undefined : undefined} />
          {round.ledger.filter((l) => l.kind === "pull").map((l) => <Step key={l.tx + l.bookId} chainId={l.chainId} tx={l.tx} secs={l.seconds} title={LEG_TITLE.pull} text={legText(l)} />)}
          {round.settleTx && <Step chainId={LASNA_ID} tx={round.settleTx} secs={settleSecs} title="Lasna settled the round" text={`${plural(round.pairs, "pair")} matched. The payouts were requested.`} />}
          {round.ledger.filter((l) => l.kind !== "pull").map((l, i) => <Step key={l.tx + l.kind + i} chainId={l.chainId} tx={l.tx} secs={l.seconds} title={LEG_TITLE[l.kind]} text={legText(l)} />)}
        </ol>
        {round.kind === "bell" && round.loaded && round.chains.some((c) => !c.readable) && (
          <p className="muted small">{round.chains.filter((c) => !c.readable).map((c) => DESKS[c.chainId].name).join(" and ")}: payout times not readable right now, so its steps are not listed.</p>
        )}
      </section>
      <p className="muted small tnum">Seconds are counted from the bell's block timestamp to each transaction's block timestamp, so they are whole seconds. Each chain keeps its own clock, and the clocks can differ by a second, so a step can show an earlier second than the step before it. The steps are listed in the order they had to happen.</p>
    </div>
  );
}
