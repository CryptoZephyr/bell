// The Rounds page's state: the newest rounds first, older ones on request, a quiet poll for new ones, and desk reads that
// only run for rows on screen. Finished rounds come from the viewer's own browser cache when it has them.
import { useCallback, useEffect, useRef, useState } from "react";
import { loadRound, readCache, scanNewer, scanRounds, seedRound, takePreloaded, takeWarmScan, writeCache, type Round, type RoundSeed } from "../chain/rounds";

const PAGE = 20;
const POLL_MS = 12_000;
const RETRY_MS = 15_000;
const CONCURRENT = 8;
const byBlockDesc = (a: Round, b: Round) => (a.bellBlock === b.bellBlock ? 0 : a.bellBlock > b.bellBlock ? -1 : 1);

export type RoundsState = {
  rounds: Round[];
  loading: boolean;
  /** The referee could not be read. The page keeps trying by itself. */
  error: boolean;
  loadingMore: boolean;
  canLoadMore: boolean;
  loadMore: () => void;
  /** Called by a row when it scrolls into view, so its desks are read. */
  ensure: (key: string) => void;
  /** Rounds that appeared after the page opened, so they can slide in once. */
  fresh: Set<string>;
};

export function useRounds(): RoundsState {
  const cache = useRef(new Map(readCache().map((r) => [r.key, r])));
  const [rounds, setRounds] = useState<Round[]>(() => [...cache.current.values()].sort(byBlockDesc).slice(0, PAGE));
  const roundsRef = useRef(rounds);
  roundsRef.current = rounds;
  const seeds = useRef(new Map<string, RoundSeed>());
  const attempts = useRef(new Map<string, number>());
  const queued = useRef(new Set<string>());
  const queue = useRef<string[]>([]);
  const active = useRef(0);
  const fresh = useRef(new Set<string>());
  const first = useRef(true);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [cursor, setCursor] = useState<bigint | null>(null);
  const [done, setDone] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const put = useCallback((next: Round[]) => {
    const map = new Map(roundsRef.current.map((r) => [r.key, r]));
    for (const r of next) map.set(r.key, r);
    const all = [...map.values()].sort(byBlockDesc);
    roundsRef.current = all;
    if (alive.current) setRounds(all);
    writeCache(all);
  }, []);

  const merge = useCallback((list: RoundSeed[], isFresh: boolean) => {
    const out: Round[] = [];
    for (const seed of list) {
      const key = seed.block.toString();
      seeds.current.set(key, seed);
      const base = seedRound(seed);
      const prev = roundsRef.current.find((r) => r.key === key) ?? cache.current.get(key);
      if (prev && prev.loaded && prev.outcome === base.outcome && prev.kind === base.kind) { out.push(prev); continue; }
      if (isFresh && !prev && !first.current) fresh.current.add(key);
      out.push(base);
    }
    put(out);
  }, [put]);

  const ensureRef = useRef<(key: string) => void>(() => {});

  const run = useCallback(async (key: string) => {
    const seed = seeds.current.get(key);
    if (!seed) return;
    attempts.current.set(key, (attempts.current.get(key) ?? 0) + 1);
    const retry = () => setTimeout(() => { if (alive.current) ensureRef.current(key); }, RETRY_MS);
    try {
      const pre = takePreloaded(key);
      let r = pre ? await pre.catch(() => null) : null;
      if (!r) r = await loadRound(seed);
      put([r]);
      // A round that could not be read completely gets another try, since public RPCs have good and bad moments.
      // A young round keeps trying. An old one stops after three, so pruned logs do not cause endless requests.
      const young = r.bellTs !== null && Date.now() / 1000 - r.bellTs < 300;
      if (!r.complete && r.kind === "bell" && (young || (attempts.current.get(key) ?? 0) < 3)) retry();
    } catch {
      retry();
    }
  }, [put]);

  const pump = useCallback(() => {
    while (active.current < CONCURRENT && queue.current.length) {
      const key = queue.current.shift()!;
      active.current++;
      run(key).finally(() => { active.current--; queued.current.delete(key); pump(); });
    }
  }, [run]);

  const ensure = useCallback((key: string) => {
    const r = roundsRef.current.find((x) => x.key === key);
    if (!r || r.kind !== "bell" || queued.current.has(key)) return;
    if (r.loaded && r.complete) return;
    queued.current.add(key);
    queue.current.push(key);
    pump();
  }, [pump]);
  ensureRef.current = ensure;

  // First read of the newest rounds, retried until the referee answers.
  useEffect(() => {
    let stop = false;
    const go = async () => {
      try {
        const warmed = takeWarmScan();
        const s = warmed ? await warmed : await scanRounds(null, PAGE, (part) => { if (!stop) { merge(part, false); setLoading(false); } });
        if (stop) return;
        merge(s.seeds, false);
        first.current = false;
        setCursor(s.cursor); setDone(s.cursor === null); setError(false); setLoading(false); setReady(true);
      } catch {
        if (stop) return;
        setError(true);
        setTimeout(go, 8000);
      }
    };
    go();
    return () => { stop = true; };
  }, [merge]);

  // The first page of rounds is read right away, so the speed summary has numbers before anyone scrolls. Older pages read as they scroll into view.
  const primed = useRef(false);
  useEffect(() => {
    if (primed.current || !ready || rounds.length === 0) return;
    primed.current = true;
    rounds.filter((r) => r.kind === "bell").slice(0, PAGE).forEach((r) => ensure(r.key));
  }, [rounds, ensure, ready]);

  // A quiet poll for new rounds, and for a settling round to finish.
  useEffect(() => {
    const t = setInterval(async () => {
      if (document.hidden || loading) return;
      const newest = roundsRef.current[0]?.bellBlock;
      try {
        const list = await scanNewer(newest ?? 0n);
        if (list.length) merge(list, true);
        setError(false);
      } catch { /* the next poll tries again */ }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [merge, loading]);

  const loadMore = useCallback(async () => {
    if (loadingMore || cursor === null) return;
    setLoadingMore(true);
    try {
      const s = await scanRounds(cursor, PAGE + 1);
      merge(s.seeds, false);
      setCursor(s.cursor); setDone(s.cursor === null);
    } catch { setError(true); } finally { setLoadingMore(false); }
  }, [cursor, loadingMore, merge]);

  return { rounds, loading, error, loadingMore, canLoadMore: !done && cursor !== null, loadMore, ensure, fresh: fresh.current };
}
