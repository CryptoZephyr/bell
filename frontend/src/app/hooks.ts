import { useCallback, useEffect, useRef, useState } from "react";
import { loadLastRound, loadRound, type LastRound, type RoundSnapshot } from "../chain/round";

/** A clock that ticks once a second. The countdown uses it so nothing else has to re-read the chain. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export type RoundState = {
  snap: RoundSnapshot | null;
  /** Set when the last read failed. The previous snapshot stays on screen, so the app never goes blank. */
  error: string | null;
  loading: boolean;
  refresh: () => void;
};

/** Reads the round every few seconds, and again when the tab becomes visible. */
export function useRound(pollMs = 6000): RoundState {
  const [snap, setSnap] = useState<RoundSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const busy = useRef(false);

  const read = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const s = await loadRound();
      setSnap((prev) => smoothNextBell(prev, s));
      setError(null);
    } catch (e: any) {
      setError(String(e?.shortMessage ?? e?.message ?? e).slice(0, 160));
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    read();
    const t = setInterval(() => { if (document.visibilityState === "visible") read(); }, pollMs);
    const vis = () => { if (document.visibilityState === "visible") read(); };
    document.addEventListener("visibilitychange", vis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", vis); };
  }, [read, pollMs]);

  return { snap, error, loading, refresh: read };
}

/** Block times wobble by a second or two between reads. Keep the countdown steady unless the bell really moved. */
function smoothNextBell(prev: RoundSnapshot | null, next: RoundSnapshot): RoundSnapshot {
  if (!prev || prev.nextBellAt === null || next.nextBellAt === null) return next;
  if (Math.abs(prev.nextBellAt - next.nextBellAt) < 4000 && next.lasnaBlock >= prev.lasnaBlock) {
    return { ...next, nextBellAt: prev.nextBellAt };
  }
  return next;
}

/** The last settled round, with real payout seconds. Loaded once per round. */
export function useLastRound(snap: RoundSnapshot | null): LastRound | null {
  const [last, setLast] = useState<LastRound | null>(null);
  const key = useRef<string>("");
  useEffect(() => {
    const bell = snap?.lastBellRang;
    const settled = snap?.lastSettled;
    if (!bell || !settled || settled.block < bell.block) return;
    const k = `${bell.tx}:${settled.tx}`;
    if (key.current === k) return;
    key.current = k;
    let alive = true;
    loadLastRound(bell, settled).then((r) => { if (alive) setLast(r); }).catch(() => { key.current = ""; });
    return () => { alive = false; };
  }, [snap?.lastBellRang, snap?.lastSettled]);
  return last;
}
