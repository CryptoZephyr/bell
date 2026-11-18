import { useEffect, useRef, useState } from "react";
import { useRoundCtx } from "../app/RoundContext";
import { useWallet } from "../wallet/wallet";
import { useAnnounce } from "../app/Shell";
import { BellCard, sentenceFor } from "../ui/BellCard";
import { Book, MeetBar } from "../ui/Book";
import { LastBell } from "../ui/LastBell";
import { Button } from "../ui/Button";
import { IconAlert, IconTrade } from "../ui/Icons";
import { href } from "../app/router";
import { loadLegProgress, type LegProgress } from "../chain/round";

/** While a round settles, read what each desk has done since the bell, so the Base and Unichain nodes fill for real. */
function useLegs(active: boolean, sinceMs: number | null): LegProgress[] | null {
  const [legs, setLegs] = useState<LegProgress[] | null>(null);
  const busy = useRef(false);
  useEffect(() => {
    if (!active || sinceMs === null) { setLegs(null); return; }
    let alive = true;
    const read = async () => {
      if (busy.current) return;
      busy.current = true;
      try { const l = await loadLegProgress(sinceMs); if (alive) setLegs(l); } finally { busy.current = false; }
    };
    read();
    const t = setInterval(read, 3000);
    return () => { alive = false; clearInterval(t); };
  }, [active, sinceMs]);
  return legs;
}

export function Bell() {
  const r = useRoundCtx();
  const w = useWallet();
  const announce = useAnnounce();
  const { snap, mark, secondsLeft, last } = r;

  const settlingNow = mark === "bell" || mark === "settling" || mark === "done";
  const legs = useLegs(settlingNow, snap?.lastBellMs ?? null);

  // Round progress goes to the polite live region. The countdown itself is never announced every second.
  const prev = useRef<string | null>(null);
  useEffect(() => {
    if (!mark || prev.current === mark) return;
    prev.current = mark;
    if (mark === "bell") announce("Bell rang");
    if (mark === "settling") announce("Settling on Base and Unichain");
    if (mark === "done") announce(sentenceFor({ state: "done", nextBellAt: null, secondsLeft: null, doneSeconds: last?.payoutSeconds ?? last?.settleSeconds ?? null }));
    if (mark === "skipped") announce("This bell was skipped because the price jumped. Orders carry to the next one.");
  }, [mark, last, announce]);

  const total = snap ? 100 * snap.secPerBlock + snap.secPerBlock : 110;
  const progress = secondsLeft !== null ? Math.max(0, Math.min(1, secondsLeft / total)) : 0;
  const empty = snap ? snap.book.length === 0 : true;

  return (
    <div className="bell-screen">
      <div className="screen-head">
        <span className="where">Live round</span>
        <h1>Bell</h1>
        <p>Orders from Base and Unichain meet here at one fair price.</p>
      </div>

      {r.error && (
        <div className="inset notice error" role="alert">
          <IconAlert size={22} />
          <div>
            <strong>We can't reach the chains right now.</strong>
            <p className="muted">Your orders are safe in your wallets. We're retrying on our own.</p>
          </div>
        </div>
      )}

      <div className="bell-grid">
        <div className="bell-left">
          <BellCard
            state={mark ?? "quiet"}
            secondsLeft={secondsLeft}
            nextBellAt={snap?.nextBellAt ?? null}
            progress={progress}
            referencePrice={snap?.referencePrice ?? null}
            priceAgeSeconds={snap?.priceAgeSeconds ?? null}
            doneSeconds={last ? (last.payoutSeconds ?? last.settleSeconds) : null}
            legs={legs}
            loading={r.loading && !snap}
          />
          <Button href={href.trade} glyph={<IconTrade />} label={empty ? "Place the first order" : "Place an order"} />
        </div>
        <div className="bell-right stack-lg">
          <MeetBar book={snap?.book ?? []} price={snap?.referencePrice ?? null} />
          <section aria-labelledby="book-h" className="stack">
            <div className="row between">
              <h2 id="book-h">The book</h2>
              {snap && <span className="small muted tnum">{snap.book.length} of {snap.maxBook} places</span>}
            </div>
            {r.loading && !snap ? <div className="skeleton" style={{ height: 96 }} /> : <Book book={snap?.book ?? []} price={snap?.referencePrice ?? null} me={w.address} />}
          </section>
          <LastBell last={last} loading={r.loading && !snap} />
        </div>
      </div>
    </div>
  );
}
