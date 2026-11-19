// Small drawn parts for the Rounds pages: the outcome mark, the seconds strip, the mini ruler on a list row and the full
// split sheet on a round. All are drawn by us in SVG or plain elements from chain data. No chart library.
import { ChainMark, IconClock, IconReturn } from "./Icons";
import { Mark } from "./Mark";
import { clock } from "../chain/format";
import { DESKS, DESK_CHAIN_IDS, type DeskChainId } from "../chain/config";
import type { Round, RoundLeg, RoundOutcome } from "../chain/rounds";

export const OUTCOME_WORD: Record<RoundOutcome, string> = {
  settled: "Settled", unwound: "Settled, one removed", skipped: "Skipped", expired: "Orders expired", open: "Settling",
};

/** A custom mark per outcome. It always sits next to its word, so a picture is never the only signal. */
export function OutcomeMark({ outcome, size = 20 }: { outcome: RoundOutcome; size?: number }) {
  switch (outcome) {
    case "settled":
      return <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor" /><path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="var(--sm-tick, var(--bg))" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
    case "unwound": return <IconReturn size={size} />;
    case "skipped": return <Mark height={size} tone="current" gap={20} outline />;
    case "expired": return <IconClock size={size} />;
    default: return <Mark height={size} tone="current" gap={0} />;
  }
}

const dayMon = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
/** "19 Nov, 14:03:20" */
export function roundTime(ts: number | null): string {
  return ts === null ? "Time unknown" : `${dayMon(ts * 1000)}, ${clock(ts * 1000)}`;
}
/** Seconds as two digits, for the split sheet. Block timestamps are whole seconds, so there are no tenths to show. */
export const two = (s: number) => String(Math.max(0, Math.round(s))).padStart(2, "0");
const chainKey = (id: DeskChainId) => DESKS[id].key;

// ---------------------------------------------------------------------------------------------------- seconds strip

const SCALE_MAX = 15; // one fixed scale, so two strips are always comparable

/**
 * One thin bar per round, oldest on the left and newest on the right, its height the bell-to-last-payout seconds on a
 * fixed 0 to 15 s scale. A round whose payouts could not be read is an outline with no height, never a zero.
 */
export function SecondsStrip({ rounds }: { rounds: Round[] }) {
  // Only rounds whose desks have been read get a bar. One not read yet is simply absent, not drawn as a failure.
  const shown = rounds.filter((r) => (r.outcome === "settled" || r.outcome === "unwound") && r.loaded).slice(0, 40).reverse();
  if (shown.length === 0) return null;
  const H = 80, BAR = 8, GAP = 5;
  const W = shown.length * (BAR + GAP);
  const y = (s: number) => H - (Math.min(SCALE_MAX, s) / SCALE_MAX) * H;
  const summary = `Seconds from the bell to the last payout for the last ${shown.length} rounds, newest on the right, on a scale of 0 to ${SCALE_MAX} seconds.`;
  return (
    <figure className="strip">
      <div className="strip-plot">
        <span className="strip-tick tnum" style={{ top: `${(y(10) / H) * 100}%` }} aria-hidden="true">10 s</span>
        <span className="strip-tick tnum" style={{ top: `${(y(5) / H) * 100}%` }} aria-hidden="true">5 s</span>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="strip-svg" role="img" aria-label={summary} focusable="false">
          <line x1="0" x2={W} y1={y(10)} y2={y(10)} className="strip-grid" />
          <line x1="0" x2={W} y1={y(5)} y2={y(5)} className="strip-grid" />
          <line x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} className="strip-grid base" />
          {shown.map((r, i) => {
            const x = i * (BAR + GAP) + GAP / 2;
            const label = `Round at ${roundTime(r.bellTs)}: ${r.seconds !== null ? `${r.seconds} seconds` : r.complete ? "no payout in this round" : "payout times not readable"}`;
            return r.seconds !== null
              ? <rect key={r.key} x={x} y={y(r.seconds)} width={BAR} height={Math.max(1, H - y(r.seconds))} className={`strip-bar${r.seconds > SCALE_MAX ? " over" : ""}`}><title>{label}</title></rect>
              : <rect key={r.key} x={x} y={H - 6} width={BAR} height={6} className="strip-bar none"><title>{label}</title></rect>;
          })}
        </svg>
      </div>
      <figcaption className="small muted">Bell to last payout, last {shown.length} rounds. Newest on the right.</figcaption>
      <div className="sr-only">
        <table>
          <caption>{summary}</caption>
          <thead><tr><th scope="col">Round</th><th scope="col">Seconds from the bell to the last payout</th></tr></thead>
          <tbody>{shown.map((r) => <tr key={r.key}><td>{roundTime(r.bellTs)}</td><td>{r.seconds !== null ? r.seconds : r.complete ? "No payout in this round" : "Payout times not readable"}</td></tr>)}</tbody>
        </table>
      </div>
    </figure>
  );
}

// ------------------------------------------------------------------------------------------------- mini split sheet

const MINI_MAX = 10;
const pct = (s: number, max: number) => `${Math.min(100, (Math.max(0, s) / max) * 100)}%`;

/** On a list row: a 0 to 10 s ruler per chain, with a tick for the last pull and one for the last payout. */
export function MiniSplit({ round }: { round: Round }) {
  if (round.outcome === "skipped") return <p className="mini-note small muted">{round.reason ? "The price jumped inside one window, so nothing moved. Orders carry to the next bell." : ""}</p>;
  if (round.outcome === "expired") return <p className="mini-note small muted">Old orders left the book. Nothing was pulled.</p>;
  if (!round.loaded) return <div className="mini skeleton" style={{ height: 40 }} aria-hidden="true" />;
  if (round.chains.length === 0) return <p className="mini-note small muted">Payout times not readable</p>;
  if (round.complete && round.seconds === null) return <p className="mini-note small muted">Nothing was paid out. Funds went back to the traders.</p>;
  return (
    <div className="mini" aria-hidden="true">
      {DESK_CHAIN_IDS.map((id) => {
        const c = round.chains.find((x) => x.chainId === id);
        if (!c) return null;
        return (
          <div className="mini-lane" key={id}>
            <span className="mini-chain"><ChainMark chain={chainKey(id)} size={14} /></span>
            {c.readable
              ? <div className="mini-rule">
                  {c.pullSeconds !== null && <i className="mini-pull" style={{ left: pct(c.pullSeconds, MINI_MAX) }} />}
                  {c.paidSeconds !== null && <i className="mini-paid" style={{ left: pct(c.paidSeconds, MINI_MAX) }} />}
                </div>
              : <span className="mini-na small muted">Payout times not readable</span>}
          </div>
        );
      })}
    </div>
  );
}

// -------------------------------------------------------------------------------------------------- full split sheet

const LEG_WORD: Record<RoundLeg["kind"], string> = { pull: "Pull", payout: "Paid", rounding: "Rounding", pool: "Pool fill", poolfail: "Pool failed", refund: "Returned", close: "Closed" };

/**
 * The Chronograph: the bell and every chain's last pull and last payout in large tabular figures, then a three-lane ruler
 * (Lasna, Base, Unichain) with each leg pinned at its real second after the bell.
 */
export function SplitSheet({ round }: { round: Round }) {
  const base = round.bellTs;
  const settleAt = round.settleTs !== null && base !== null ? round.settleTs - base : null;
  const legSeconds = round.ledger.map((l) => l.seconds);
  const max = Math.max(MINI_MAX, Math.ceil(Math.max(0, settleAt ?? 0, ...legSeconds) + 1));
  const marks: { label: string; value: string | null; na?: boolean }[] = [{ label: "Bell", value: two(0) }];
  for (const id of DESK_CHAIN_IDS) {
    const c = round.chains.find((x) => x.chainId === id);
    if (!c) continue;
    const name = id === 84532 ? "Base" : "Unichain";
    marks.push({ label: `Pull ${name}`, value: c.readable && c.pullSeconds !== null ? two(c.pullSeconds) : null, na: !c.readable });
  }
  for (const id of DESK_CHAIN_IDS) {
    const c = round.chains.find((x) => x.chainId === id);
    if (!c) continue;
    const name = id === 84532 ? "Base" : "Unichain";
    marks.push({ label: `Paid ${name}`, value: c.readable && c.paidSeconds !== null ? two(c.paidSeconds) : null, na: !c.readable });
  }
  const text = marks.map((m) => `${m.label} ${m.value !== null ? `${Number(m.value)} seconds` : m.na ? "not readable" : "nothing"}`).join(". ");
  return (
    <div className="split-sheet">
      <ol className="chrono tnum" aria-label={text}>
        {marks.map((m) => (
          <li key={m.label} className={m.value === null ? "na" : undefined}>
            <span className="chrono-label">{m.label}</span>
            <span className="chrono-num">{m.value !== null ? m.value : m.na ? "n/a" : "none"}<small>{m.value !== null ? " s" : ""}</small></span>
            {m.na && <span className="chrono-note">Payout times not readable</span>}
          </li>
        ))}
      </ol>
      <div className="lanes" role="img" aria-label={`Ruler from 0 to ${max} seconds after the bell. ${text}.${settleAt !== null ? ` Lasna settled at ${settleAt} seconds.` : ""}`}>
        <div className="lane">
          <span className="lane-name"><ChainMark chain="lasna" size={14} /> Lasna</span>
          <div className="lane-rule">
            <i className="leg bell" style={{ left: pct(0, max) }} title="The bell" />
            {settleAt !== null && <i className="leg settle" style={{ left: pct(settleAt, max) }} title={`Settled at ${settleAt} s`} />}
          </div>
        </div>
        {DESK_CHAIN_IDS.map((id) => {
          const c = round.chains.find((x) => x.chainId === id);
          if (!c) return null;
          return (
            <div className="lane" key={id}>
              <span className="lane-name"><ChainMark chain={chainKey(id)} size={14} /> {id === 84532 ? "Base" : "Unichain"}</span>
              <div className="lane-rule">
                {c.readable
                  ? round.ledger.filter((l) => l.chainId === id).map((l, i) => <i key={`${l.tx}${l.kind}${i}`} className={`leg ${l.kind}`} style={{ left: pct(l.seconds, max) }} title={`${LEG_WORD[l.kind]} at ${l.seconds} s`} />)
                  : <span className="lane-na small muted">Not readable</span>}
              </div>
            </div>
          );
        })}
        <div className="lane-scale tnum small muted"><span>0 s</span><span>{Math.round(max / 2)} s</span><span>{max} s</span></div>
      </div>
    </div>
  );
}
