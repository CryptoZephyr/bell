// Landing (section 5): the living mark and the real countdown first, three plain steps, two buttons, and the meet bar.
import { useRoundCtx } from "../app/RoundContext";
import { sentenceFor } from "../ui/BellCard";
import { LivingMark } from "../ui/LivingMark";
import { Button } from "../ui/Button";
import { MeetBar } from "../ui/Book";
import { IconTrade } from "../ui/Icons";
import { clock, countdown } from "../chain/format";
import { href } from "../app/router";

const STEPS = [
  { n: 1, title: "Place an order", text: "Choose buy or sell, how much, and your worst price. Your money stays in your wallet." },
  { n: 2, title: "Wait for the bell", text: "Every couple of minutes the bell rings. Buyers and sellers from both chains meet at one fair Uniswap price." },
  { n: 3, title: "Get paid", text: "Matched orders are paid straight away. Whatever finds no match goes through the Uniswap pool, inside your limit." },
];

export function Landing() {
  const r = useRoundCtx();
  const { snap, mark, secondsLeft } = r;
  const line = snap?.nextBellAt && secondsLeft !== null ? `Next bell at ${clock(snap.nextBellAt)}, in ${countdown(secondsLeft)}` : sentenceFor({ state: mark ?? "quiet", nextBellAt: null, secondsLeft: null, doneSeconds: null });
  const total = snap ? 100 * snap.secPerBlock + snap.secPerBlock : 110;
  return (
    <div className="landing stack-lg">
      <section className="hero" aria-labelledby="hero-h">
        <div className="hero-copy">
          <h1 id="hero-h">Swap across chains. No bridge.</h1>
          <p className="lede">Bell lines up buyers and sellers from Base and Unichain and settles them at one fair price. Your money stays in your wallet until the bell rings.</p>
          <div className="hero-cta">
            <Button block={false} label="Start trading" glyph={<IconTrade />} href={href.trade} />
            <Button block={false} kind="secondary" label="Watch a live round" href={href.bell} />
          </div>
        </div>
        <div className="hero-mark">
          <LivingMark state={mark ?? "quiet"} progress={secondsLeft !== null ? Math.max(0, Math.min(1, secondsLeft / total)) : 0} secondsLeft={secondsLeft} size={220} label={line} />
          <p className="hero-line" aria-live="off">{line}</p>
        </div>
      </section>

      <section id="how" aria-labelledby="how-h" className="stack">
        <h2 id="how-h">How it works</h2>
        <ol className="steps">
          {STEPS.map((s, i) => (
            <li key={s.n} className={`step-card card bc ${i % 2 ? "bc-br" : "bc-card"}`}>
              <span className="step-n" aria-hidden="true">{s.n}</span>
              <h3>{s.title}</h3>
              <p className="muted">{s.text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="live-h" className="stack">
        <h2 id="live-h">The bell right now</h2>
        <MeetBar book={snap?.book ?? []} price={snap?.referencePrice ?? null} />
      </section>
    </div>
  );
}
