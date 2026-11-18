// The Bell mark: two identical hooks, one turned half a turn, locked together without touching.
// Geometry is copied from the logo kit (bell-mark.svg, viewBox 360 x 313). Hook B is hook A turned 180 degrees about
// the centre of the mark. B can slide right by up to 20 units, which widens the seam from 10 (the regular cut)
// to 30 (the small cut) and is what the living mark uses to open and close.
import type { CSSProperties } from "react";

export const HOOK_A =
  "M 110.82 13.18 A 45.00 45.00 0 0 1 142.64 0.00 L 219.00 0.00 A 26.00 26.00 0 0 1 245.00 26.00 L 245.00 79.00 A 26.00 26.00 0 0 1 219.00 105.00 L 135.00 105.00 A 30.00 30.00 0 0 0 105.00 135.00 L 105.00 217.00 A 26.00 26.00 0 0 1 79.00 243.00 L 26.00 243.00 A 26.00 26.00 0 0 1 0.00 217.00 L 0.00 142.64 A 45.00 45.00 0 0 1 13.18 110.82 Z";
export const HOOK_B =
  "M 249.18 299.82 A 45.00 45.00 0 0 1 217.36 313.00 L 141.00 313.00 A 26.00 26.00 0 0 1 115.00 287.00 L 115.00 234.00 A 26.00 26.00 0 0 1 141.00 208.00 L 225.00 208.00 A 30.00 30.00 0 0 0 255.00 178.00 L 255.00 96.00 A 26.00 26.00 0 0 1 281.00 70.00 L 334.00 70.00 A 26.00 26.00 0 0 1 360.00 96.00 L 360.00 170.36 A 45.00 45.00 0 0 1 346.82 202.18 Z";

type MarkProps = {
  /** Height in px. Width follows the mark's proportions. */
  height?: number;
  /** "ink" and "fog" are the two brand tones. "current" follows the CSS colour. The mark is never Signal. */
  tone?: "ink" | "fog" | "current";
  /** Extra seam in units, 0 to 20. 0 is the regular locked cut, 20 is the small cut (seam 30). */
  gap?: number;
  /** Outline only, for small status marks (waiting, removed, paused). */
  outline?: boolean;
  title?: string;
  className?: string;
  style?: CSSProperties;
};

const TONES = { ink: "#0E1320", fog: "#DDE2EA", current: "currentColor" } as const;

/** Static mark. Below 33px tall it uses the small cut, so the two hooks stay visibly apart. */
export function Mark({ height = 28, tone = "ink", gap, outline, title, className, style }: MarkProps) {
  const g = gap ?? (height <= 32 ? 20 : 0);
  const w = 360 + g;
  const fill = TONES[tone];
  return (
    <svg
      className={className}
      style={style}
      viewBox={`0 0 ${w} 313`}
      height={height}
      width={(height * w) / 313}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <path d={HOOK_A} fill={outline ? "none" : fill} stroke={outline ? fill : undefined} strokeWidth={outline ? 18 : undefined} strokeLinejoin="round" />
      <path d={HOOK_B} fill={outline ? "none" : fill} stroke={outline ? fill : undefined} strokeWidth={outline ? 18 : undefined} strokeLinejoin="round" transform={g ? `translate(${g} 0)` : undefined} />
    </svg>
  );
}

/** The lockup: the mark and the word Bell. Wordmark cap height is 62% of the mark, the gap is 42% of the mark. */
export function Lockup({ markHeight = 28, tone = "ink" }: { markHeight?: number; tone?: "ink" | "fog" | "current" }) {
  const capHeight = markHeight * 0.62;
  const fontSize = capHeight / 0.7; // Schibsted Grotesk cap height is about 0.7 of the font size
  return (
    <span className="lockup" style={{ display: "inline-flex", alignItems: "center", gap: markHeight * 0.42, color: TONES[tone] }}>
      <Mark height={markHeight} tone="current" />
      <span style={{ fontWeight: 800, fontSize, letterSpacing: "-0.01em", lineHeight: 1 }} aria-hidden="true">Bell</span>
      <span className="sr-only">Bell</span>
    </span>
  );
}

/** The footer silhouette: the top 55% of the full mark, one tone, decorative. Cropped by the page edge. */
export function FooterSilhouette({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 360 172" aria-hidden="true" focusable="false" preserveAspectRatio="xMidYMin slice">
      <path d={HOOK_A} fill="currentColor" />
      <path d={HOOK_B} fill="currentColor" />
    </svg>
  );
}
