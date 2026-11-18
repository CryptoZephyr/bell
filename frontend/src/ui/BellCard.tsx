// The bell card (sections 5, 6c, 8, 11): the living mark inside a ring that drains towards the bell, the countdown as a
// clock time and a count, one sentence saying what is happening, and the live reference price. While settling, the
// Base and Unichain cards pair up like the two hooks and fill as each desk confirms.
import { LivingMark } from "./LivingMark";
import { ChainMark } from "./Icons";
import { clock, countdown, fmtPrice, ago } from "../chain/format";
import { PRICE_STALE_SECONDS } from "../chain/config";
import type { LegProgress, MarkState } from "../chain/round";

export type BellCardProps = {
  state: MarkState;
  secondsLeft: number | null;
  nextBellAt: number | null;
  /** 0 to 1, the share of the wait left. */
  progress: number;
  referencePrice: bigint | null;
  priceAgeSeconds: number | null;
  /** Seconds the last round took, for the done state. */
  doneSeconds: number | null;
  legs: LegProgress[] | null;
  /** True before the first read arrives. */
  loading?: boolean;
  skippedReason?: string;
};

export function sentenceFor(p: Pick<BellCardProps, "state" | "nextBellAt" | "secondsLeft" | "doneSeconds">): string {
  switch (p.state) {
    case "quiet": return "Market quiet. The next bell starts when someone places an order.";
    case "open":
    case "last10":
      return p.nextBellAt && p.secondsLeft !== null ? `Bell at ${clock(p.nextBellAt)}, in ${countdown(p.secondsLeft)}` : "Waiting for the next bell";
    case "bell": return "The bell rang. Collecting from both chains.";
    case "settling": return "Settling across Base and Unichain.";
    case "done": return p.doneSeconds !== null ? `Settled in ${Math.round(p.doneSeconds)} second${Math.round(p.doneSeconds) === 1 ? "" : "s"}.` : "Settled.";
    case "skipped": return "The price jumped more than 10%, so this bell was skipped. Orders carry to the next one.";
    case "paused": return "The bell is paused right now. New orders may not be heard.";
  }
}

function bigFor(p: BellCardProps): { text: string; kind: "number" | "word" } {
  switch (p.state) {
    case "open":
    case "last10": return { text: p.secondsLeft !== null ? countdown(p.secondsLeft) : "—:——", kind: "number" };
    case "done": return { text: p.doneSeconds !== null ? `${Math.round(p.doneSeconds)} s` : "Done", kind: "number" };
    case "bell": return { text: "Bell", kind: "word" };
    case "settling": return { text: "Settling", kind: "word" };
    case "skipped": return { text: "Skipped", kind: "word" };
    case "paused": return { text: "Paused", kind: "word" };
    default: return { text: "Quiet", kind: "word" };
  }
}

function nodeState(l: LegProgress | undefined): { word: string; done: boolean } {
  if (!l) return { word: "Waiting", done: false };
  if (l.closed > 0) return { word: "Paid", done: true };
  if (l.paid > 0) return { word: "Paying", done: false };
  if (l.collected > 0) return { word: "Collecting", done: false };
  return { word: "Waiting", done: false };
}

export function BellCard(p: BellCardProps) {
  const big = bigFor(p);
  const sentence = sentenceFor(p);
  const stale = p.priceAgeSeconds !== null && p.priceAgeSeconds > PRICE_STALE_SECONDS;
  const showNodes = p.state === "bell" || p.state === "settling" || p.state === "done";
  const base = p.legs?.find((l) => l.chainId === 84532);
  const uni = p.legs?.find((l) => l.chainId === 1301);

  if (p.loading) {
    return (
      <section className="bell-card card bc bc-card" aria-label="The bell" aria-busy="true">
        <div className="bell-mark"><LivingMark state="quiet" size={200} label="Reading Base, Unichain and Lasna" /></div>
        <div className="skeleton" style={{ height: 72, width: 200, margin: "0 auto" }} />
        <p className="bell-sentence">Reading Base, Unichain and Lasna</p>
      </section>
    );
  }

  return (
    <section className="bell-card card bc bc-card" aria-label="The bell">
      <div className="bell-mark">
        <LivingMark state={p.state} progress={p.progress} secondsLeft={p.secondsLeft} size={200} label={sentence} />
      </div>
      <div className={`bell-big tnum ${big.kind}`} aria-hidden="true">{big.text}</div>
      <p className="bell-sentence">{sentence}</p>

      {showNodes && (
        <div className="nodes" aria-label="Settlement on each chain">
          <div className={`node bc bc-sheet${nodeState(base).done ? " done" : ""}`} style={{ ["--cut" as string]: "14px" }}>
            <ChainMark chain="base" size={18} />
            <div><strong>Base</strong><span>{p.state === "done" ? "Paid" : nodeState(base).word}</span></div>
          </div>
          <div className={`node node-b bc-br${nodeState(uni).done ? " done" : ""}`} style={{ ["--cut" as string]: "14px" }}>
            <ChainMark chain="unichain" size={18} />
            <div><strong>Unichain</strong><span>{p.state === "done" ? "Paid" : nodeState(uni).word}</span></div>
          </div>
        </div>
      )}

      <div className="bell-price">
        <span className="muted">Uniswap price</span>
        {p.referencePrice !== null ? (
          <span className="tnum"><strong>{fmtPrice(p.referencePrice)}</strong> USDC per ETH</span>
        ) : (
          <span className="skeleton" style={{ width: 120, height: 20 }} />
        )}
      </div>
      {stale && p.priceAgeSeconds !== null && (
        <p className="price-age" role="note">Price from {ago(p.priceAgeSeconds)}. Nobody has traded the pool since.</p>
      )}
    </section>
  );
}
