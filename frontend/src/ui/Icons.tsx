// Custom icons and chain marks. Everything here is drawn by us on a 24px grid with a 2px stroke and rounded ends,
// to match the mark. No icon pack. Icons are decorative unless a label is passed.
import type { ReactNode, SVGProps } from "react";

type P = { size?: number; label?: string } & Omit<SVGProps<SVGSVGElement>, "children">;

function Base({ size = 24, label, children, ...rest }: P & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" role={label ? "img" : undefined} aria-label={label}
      aria-hidden={label ? undefined : true} focusable="false" {...rest}
    >
      {children}
    </svg>
  );
}

/** Two opposing arrows: two sides swapping. */
export const IconTrade = (p: P) => (<Base {...p}><path d="M4 8h13" /><path d="M14 5l3 3-3 3" /><path d="M20 16H7" /><path d="M10 13l-3 3 3 3" /></Base>);
/** A ticket with two notches. */
export const IconTicket = (p: P) => (<Base {...p}><path d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4Z" /><path d="M14 6v2M14 11v2M14 16v2" /></Base>);
/** The key for approvals. */
export const IconKey = (p: P) => (<Base {...p}><circle cx="8" cy="15" r="4" /><path d="M11 12l8-8" /><path d="M16 7l2.5 2.5" /><path d="M14 9l2 2" /></Base>);
export const IconCheck = (p: P) => (<Base {...p}><path d="M5 12.5l4.5 4.5L19 7.5" /></Base>);
export const IconClose = (p: P) => (<Base {...p}><path d="M6 6l12 12M18 6L6 18" /></Base>);
export const IconCopy = (p: P) => (<Base {...p}><rect x="9" y="9" width="11" height="11" rx="3" /><path d="M15 9V7a3 3 0 0 0-3-3H7a3 3 0 0 0-3 3v5a3 3 0 0 0 3 3h2" /></Base>);
export const IconArrowUpRight = (p: P) => (<Base {...p}><path d="M7 17L17 7" /><path d="M8 7h9v9" /></Base>);
export const IconHelp = (p: P) => (<Base {...p}><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.1.9-1.1 1.8" /><path d="M12 17h.01" /></Base>);
export const IconAlert = (p: P) => (<Base {...p}><path d="M12 4l9 15H3Z" /><path d="M12 10v4" /><path d="M12 17h.01" /></Base>);
export const IconInfo = (p: P) => (<Base {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></Base>);
/** A return arrow for refunds. */
export const IconReturn = (p: P) => (<Base {...p}><path d="M9 7L5 11l4 4" /><path d="M5 11h9a5 5 0 0 1 5 5v1" /></Base>);
/** A wave for a fill on the Uniswap pool. */
export const IconWave = (p: P) => (<Base {...p}><path d="M3 9c2 0 2-2 4.5-2S10 9 12 9s2-2 4.5-2S19 9 21 9" /><path d="M3 15c2 0 2-2 4.5-2S10 15 12 15s2-2 4.5-2S19 15 21 15" /></Base>);
export const IconWallet = (p: P) => (<Base {...p}><path d="M4 8a3 3 0 0 1 3-3h11v4" /><rect x="4" y="8" width="16" height="11" rx="3" /><path d="M16 13.5h.01" /></Base>);
export const IconShare = (p: P) => (<Base {...p}><path d="M12 15V4" /><path d="M8 8l4-4 4 4" /><path d="M5 13v4a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-4" /></Base>);
export const IconBack = (p: P) => (<Base {...p}><path d="M15 6l-6 6 6 6" /></Base>);
export const IconClock = (p: P) => (<Base {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Base>);
export const IconPlus = (p: P) => (<Base {...p}><path d="M12 5v14M5 12h14" /></Base>);

/** Chain marks. Bell never uses chain brand colours or logos. Base is a solid square, Unichain a ring, Lasna a diamond. */
export function ChainMark({ chain, size = 16 }: { chain: "base" | "unichain" | "lasna"; size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" focusable="false" fill="currentColor">
      {chain === "base" && <rect x="2.5" y="2.5" width="11" height="11" rx="2" />}
      {chain === "unichain" && <circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth="2.4" />}
      {chain === "lasna" && <path d="M8 1.8l6.2 6.2L8 14.2 1.8 8Z" />}
    </svg>
  );
}
