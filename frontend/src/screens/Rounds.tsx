// Rounds (ROUNDS_SPEC): every bell on the current contracts, newest first, with the real seconds each one took. It works
// with no wallet and at any hour, because it shows rounds that already happened. Every number is read from the chains.
import { useEffect, useRef } from "react";
import { useRounds } from "../app/rounds";
import { Button } from "../ui/Button";
import { IconAlert, IconPlus, IconTrade } from "../ui/Icons";
import { MiniSplit, OUTCOME_WORD, OutcomeMark, SecondsStrip, roundTime } from "../ui/RoundParts";
import { fmtPriceUnit } from "../chain/format";
import { summarize, foldSkipped, type Round } from "../chain/rounds";
import { href } from "../app/router";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function rowSentence(r: Round, run: number): string {
  const when = roundTime(r.bellTs);
  if (r.outcome === "skipped") return `Round at ${when}, skipped${run > 1 ? `, ${run} bells in a row` : ""}, orders carried to the next bell`;
  if (r.outcome === "expired") return `Round at ${when}, ${plural(r.eligible, "order")} expired`;
  const pairs = plural(r.pairs, "pair");
  const secs = r.outcome === "open" ? "settling, waiting for the payouts" : r.seconds !== null ? `paid out in ${plural(r.seconds, "second")}` : r.loaded ? (r.complete ? "no payout in this round" : "payout times not readable") : "reading the payouts";
  return `Round at ${when}, ${OUTCOME_WORD[r.outcome].toLowerCase()}, ${pairs}, ${secs}`;
}

function Row({ r, run, isNew, ensure }: { r: Round; run: number; isNew: boolean; ensure: (k: string) => void }) {
  const ref = useRef<HTMLAnchorElement>(null);
  // Desks are read only for rows that are on screen, or about to be.
  useEffect(() => {
    const el = ref.current;
    if (!el || r.kind !== "bell" || (r.loaded && r.complete)) return;
    if (typeof IntersectionObserver === "undefined") { ensure(r.key); return; }
    const io = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) ensure(r.key); }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [r.key, r.kind, r.loaded, r.complete, ensure]);

  const secs = r.seconds;
  return (
    <li>
      <a ref={ref} className={`round-row${isNew ? " is-new" : ""}`} href={href.round(r.key)} aria-label={rowSentence(r, run)}>
        <div className="rr-top">
          <span className="rr-time tnum">{roundTime(r.bellTs)}</span>
          <span className={`rr-outcome ${r.outcome}`}><OutcomeMark outcome={r.outcome} size={18} />{OUTCOME_WORD[r.outcome]}</span>
        </div>
        <div className="rr-facts tnum">
          {r.outcome === "skipped" ? <span>The price jumped{run > 1 ? `. ${run} bells in a row` : ""}</span>
            : r.outcome === "expired" ? <span>{plural(r.eligible, "order")} expired</span>
            : <><span>{r.price !== null ? fmtPriceUnit(r.price) : ""}</span><span>{plural(r.eligible, "order")}, {plural(r.pairs, "pair")}</span></>}
        </div>
        {(r.outcome === "settled" || r.outcome === "unwound" || r.outcome === "open") && (
          <div className="rr-split">
            <MiniSplit round={r} />
            <span className="rr-secs tnum">
              {secs !== null ? <><strong>{secs}</strong> s</> : r.outcome === "open" ? "Settling" : r.loaded ? (r.complete ? "No payout" : "Not readable") : "Reading"}
            </span>
          </div>
        )}
        {(r.outcome === "skipped" || r.outcome === "expired") && <MiniSplit round={r} />}
      </a>
    </li>
  );
}

export function Rounds() {
  const s = useRounds();
  const sum = summarize(s.rounds);
  const entries = foldSkipped(s.rounds);

  return (
    <div className="rounds-screen stack-lg">
      <div className="screen-head">
        <span className="where">Proof</span>
        <h1>Rounds</h1>
        <p>Every bell on the current contracts, newest first. Each one links to its transactions.</p>
      </div>

      {s.error && (
        <div className="inset notice error" role="alert">
          <IconAlert size={22} />
          <div>
            <strong>We can't reach the chains right now.</strong>
            <p className="muted">The rounds below are what we last read. We're retrying on our own.</p>
          </div>
        </div>
      )}

      <section className="card bc bc-card rounds-summary" aria-labelledby="speed-h">
        <h2 id="speed-h" className="h3">How fast it pays</h2>
        {sum.counted > 0 ? (
          <>
            <div className="rs-head">
              <div>
                <div className="rs-big tnum">{Number.isInteger(sum.median) ? sum.median : sum.median!.toFixed(1)}<small> s</small></div>
                <p className="muted small">Median from the bell to the last payout, of {plural(sum.counted, "round")}</p>
              </div>
              <dl className="rs-facts tnum">
                <div><dt>Fastest</dt><dd>{sum.fastest} s</dd></div>
                <div><dt>Slowest</dt><dd>{sum.slowest} s</dd></div>
                <div><dt>Rounds settled</dt><dd>{sum.rounds}</dd></div>
                <div><dt>Pairs matched</dt><dd>{sum.pairs}</dd></div>
                <div><dt>Orders settled</dt><dd>{sum.orders}</dd></div>
              </dl>
            </div>
            <SecondsStrip rounds={s.rounds} />
          </>
        ) : s.loading || s.rounds.filter((r) => r.kind === "bell").slice(0, 10).some((r) => !r.loaded) ? (
          <div className="skeleton" style={{ height: 120 }} aria-busy="true" />
        ) : (
          <p className="muted">No settled round has payout times we can read yet.</p>
        )}
        <p className="muted small">These are testnet rounds, many of them placed from our own wallets. They show how fast the contracts pay, not market volume.</p>
      </section>

      <section aria-labelledby="rounds-h" className="stack">
        <h2 id="rounds-h">The rounds</h2>
        {s.loading && s.rounds.length === 0 ? (
          <ul className="round-list" aria-busy="true" aria-label="Loading the rounds">
            {[0, 1, 2, 3].map((i) => <li key={i}><div className="skeleton round-skel" /></li>)}
          </ul>
        ) : s.rounds.length === 0 ? (
          <div className="inset empty">
            <strong>No rounds yet on these contracts.</strong>
            <p className="muted">The first order starts the first bell.</p>
            <div><Button block={false} label="Go to Trade" glyph={<IconTrade />} href={href.trade} /></div>
          </div>
        ) : (
          <ul className="round-list">
            {entries.map(({ round, skippedRun }) => <Row key={round.key} r={round} run={skippedRun} isNew={s.fresh.has(round.key)} ensure={s.ensure} />)}
          </ul>
        )}
        {s.canLoadMore && (
          <div>
            <Button block={false} kind="secondary" glyph={<IconPlus />} label={s.loadingMore ? "Loading older rounds" : "Load older rounds"} state={s.loadingMore ? "working" : "idle"} onPress={s.loadMore} />
          </div>
        )}
        {!s.canLoadMore && !s.loading && s.rounds.length > 0 && <p className="muted small">That is every round on these contracts.</p>}
      </section>
    </div>
  );
}
