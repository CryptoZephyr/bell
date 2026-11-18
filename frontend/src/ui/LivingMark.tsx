// The living mark (section 8). The logo is the status object. Its hooks and the ring around it tell the round's state.
// All motion is CSS and SVG. Every animation has a reduced-motion version that changes state without movement
// (the global reduced-motion rule in base.css removes the durations).
import type { CSSProperties } from "react";
import { HOOK_A, HOOK_B } from "./Mark";
import type { MarkState } from "../chain/round";

type Props = {
  state: MarkState;
  /** 0 to 1, the share of the wait left. The ring drains as the bell nears. */
  progress?: number;
  /** Seconds to the bell, used to close the hooks in the last 10 seconds. */
  secondsLeft?: number | null;
  size?: number;
  /** Text for assistive tech. The visible sentence under the mark says the same thing. */
  label: string;
};

const RING_R = 92;
const RING_LEN = 2 * Math.PI * RING_R;

export function LivingMark({ state, progress = 0, secondsLeft = null, size = 200, label }: Props) {
  // How far apart the hooks rest, in mark units (0 locked, 20 widest).
  let gap = 14;
  if (state === "quiet" || state === "paused") gap = 20;
  if (state === "last10" && secondsLeft !== null) gap = Math.max(0, Math.min(14, (14 * secondsLeft) / 10));
  if (state === "bell" || state === "settling" || state === "done") gap = 0;
  const showRing = state === "open" || state === "last10";
  const dash = showRing ? RING_LEN * Math.max(0, Math.min(1, progress)) : 0;
  const s = 0.29; // mark scale inside the 200 unit viewBox
  const markW = 380 * s, markH = 313 * s;
  const tx = 100 - markW / 2, ty = 100 - markH / 2;

  return (
    <svg
      className="living-mark"
      data-state={state}
      viewBox="0 0 200 200"
      width={size}
      height={size}
      role="img"
      aria-label={label}
      focusable="false"
      style={{ "--gap": `${gap}px` } as CSSProperties}
    >
      {/* the ring: empty when quiet, draining towards the bell when open */}
      <circle className="lm-ring-track" cx="100" cy="100" r={RING_R} fill="none" strokeWidth="5" />
      <circle
        className="lm-ring"
        cx="100" cy="100" r={RING_R} fill="none" strokeWidth="5" strokeLinecap="round"
        strokeDasharray={`${dash} ${RING_LEN}`}
        strokeOpacity={dash > 0 ? 1 : 0}
        transform="rotate(-90 100 100)"
      />
      {state === "bell" && <circle className="lm-pulse" cx="100" cy="100" r={RING_R} fill="none" strokeWidth="3" />}
      <g transform={`translate(${tx} ${ty}) scale(${s})`}>
        <g className="lm-turn">
          <path className="lm-hook lm-hook-a" d={HOOK_A} />
          <path className="lm-hook lm-hook-b" d={HOOK_B} />
        </g>
      </g>
      {state === "done" && <path className="lm-tick" d="M84 168l11 11 22-24" fill="none" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}
