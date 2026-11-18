// The reactive button (section 7). It presses, turns into progress with the real step, and shows success or failure in
// place. It is a native <button>: while working it sets aria-busy and its label carries the real step.
// "Hold to join" is a pointer hold of 0.6 s. Enter or Space opens a confirm sheet instead (onKeyboardActivate).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconCheck } from "./Icons";

export type ButtonState = "idle" | "working" | "success" | "failure";

type Props = {
  label: string;
  glyph?: ReactNode;
  state?: ButtonState;
  /** 0 to 1, how far through the steps the work is. */
  progress?: number;
  kind?: "primary" | "secondary";
  disabled?: boolean;
  onPress?: () => void;
  /** Hold mode: the action runs only after a 0.6 s hold. Keyboard users get onKeyboardActivate. */
  hold?: boolean;
  onHoldComplete?: () => void;
  onKeyboardActivate?: () => void;
  /** Where the element sits, so the focus ring can leave a clear gap. */
  under?: string;
  block?: boolean;
  type?: "button" | "submit";
  href?: string;
};

const HOLD_MS = 600;

export function Button({
  label, glyph, state = "idle", progress = 0.15, kind = "primary", disabled, onPress, hold, onHoldComplete, onKeyboardActivate,
  under, block = true, type = "button", href,
}: Props) {
  const [holdFrac, setHoldFrac] = useState(0);
  const [pressed, setPressed] = useState(false);
  const raf = useRef<number | null>(null);
  const t0 = useRef(0);
  const done = useRef(false);

  const stop = () => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    setHoldFrac(0);
    setPressed(false);
  };
  useEffect(() => stop, []);

  const busy = state === "working";
  const inert = disabled || busy || state === "success";

  const begin = () => {
    if (inert) return;
    setPressed(true);
    if (!hold) return;
    done.current = false;
    t0.current = performance.now();
    const tick = (now: number) => {
      const f = Math.min(1, (now - t0.current) / HOLD_MS);
      setHoldFrac(f);
      if (f >= 1) {
        done.current = true;
        raf.current = null;
        setPressed(false);
        onHoldComplete?.();
        setHoldFrac(0);
        return;
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  };

  const cls = `btn bc bc-btn${kind === "secondary" ? " secondary" : ""}${block ? "" : " auto"}`;
  const style = { "--progress": progress, "--hold": holdFrac } as React.CSSProperties;

  const inner = (
    <>
      {hold && holdFrac > 0 && (
        <svg className="hold-ring" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="14" /></svg>
      )}
      <span className="glyph" aria-hidden="true">
        {state === "success" ? (
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path className="draw" d="M5 12.5l4.5 4.5L19 7.5" /></svg>
        ) : (
          glyph ?? <IconCheck />
        )}
      </span>
      <span className="label">{label}</span>
    </>
  );

  if (href) {
    return (
      <span className={`bc-focus ${block ? "block" : ""}`} style={{ ["--under" as string]: under }}>
        <a className={cls} href={href} style={style} data-state={state}>{inner}</a>
      </span>
    );
  }

  return (
    <span className={`bc-focus ${block ? "block" : ""}`} style={under ? ({ "--under": under } as React.CSSProperties) : undefined}>
      <button
        type={type}
        className={cls}
        style={style}
        data-state={state}
        data-pressed={pressed || undefined}
        aria-busy={busy || undefined}
        aria-disabled={inert || undefined}
        disabled={disabled && !busy}
        onPointerDown={hold ? begin : () => !inert && setPressed(true)}
        onPointerUp={() => (hold ? stop() : setPressed(false))}
        onPointerLeave={() => (hold ? stop() : setPressed(false))}
        onPointerCancel={stop}
        onContextMenu={(e) => hold && e.preventDefault()}
        onKeyDown={(e) => {
          if (!hold) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (!inert) onKeyboardActivate?.();
          }
        }}
        onClick={(e) => {
          if (inert) { e.preventDefault(); return; }
          if (hold) { e.preventDefault(); return; }
          onPress?.();
        }}
      >
        {inner}
      </button>
    </span>
  );
}
