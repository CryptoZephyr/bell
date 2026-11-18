// Custom status marks for the book and the receipt (section 8). Each one is drawn from the logo and always sits next to
// a word, so meaning never depends on a picture alone.
import type { ReactNode } from "react";
import { Mark } from "./Mark";
import { ChainMark, IconReturn, IconWave } from "./Icons";

export type StatusKind = "in-bell" | "waiting" | "outside" | "removed" | "paid" | "pool" | "refunded";

const WORDS: Record<StatusKind, string> = {
  "in-bell": "In this bell",
  waiting: "Waiting",
  outside: "Carries to next bell",
  removed: "Removed, funds moved",
  paid: "Paid",
  pool: "Filled on Uniswap",
  refunded: "Refunded",
};

export function StatusMark({ kind, chain, word }: { kind: StatusKind; chain?: "base" | "unichain"; word?: string }) {
  let glyph: ReactNode;
  switch (kind) {
    case "in-bell": glyph = <Mark height={20} tone="current" gap={0} />; break; // hooks locked
    case "waiting": glyph = <Mark height={20} tone="current" gap={20} outline />; break; // hooks apart
    case "outside":
      glyph = (
        <span className="sm-stack">
          <Mark height={20} tone="current" gap={20} outline />
          <svg viewBox="0 0 12 12" width="10" height="10" className="sm-arrow" aria-hidden="true"><path d="M2 6h8M7 3l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </span>
      );
      break;
    case "removed":
      glyph = (
        <span className="sm-stack">
          <Mark height={20} tone="current" gap={20} outline />
          <svg viewBox="0 0 24 24" width="22" height="22" className="sm-strike" aria-hidden="true"><path d="M3 21L21 3" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></svg>
        </span>
      );
      break;
    case "paid":
      glyph = (
        <span className="sm-paid">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor" /><path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="var(--sm-tick, #fff)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          {chain && <ChainMark chain={chain} size={14} />}
        </span>
      );
      break;
    case "pool": glyph = <IconWave size={20} />; break;
    case "refunded": glyph = <IconReturn size={20} />; break;
  }
  return (
    <span className={`status-mark sm-${kind}`}>
      <span className="sm-glyph" aria-hidden="true">{glyph}</span>
      <span className="sm-word">{word ?? WORDS[kind]}</span>
    </span>
  );
}
