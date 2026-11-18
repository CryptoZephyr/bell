import { createContext, useContext, type ReactNode } from "react";
import { useLastRound, useNow, useRound, type RoundState } from "./hooks";
import type { LastRound, MarkState } from "../chain/round";
import { markStateOf } from "../chain/round";

type Ctx = RoundState & { now: number; last: LastRound | null; mark: MarkState | null; secondsLeft: number | null };
const C = createContext<Ctx | null>(null);

/** One shared reading of the round for every screen, so the dock, Bell, Trade and Landing always agree. */
export function RoundProvider({ children }: { children: ReactNode }) {
  const r = useRound();
  const now = useNow();
  const last = useLastRound(r.snap);
  const raw = r.snap ? markStateOf(r.snap, now) : null;
  // Lasna's Settled event only means the payouts were requested. Until this round's payouts are read from the desk
  // chains, every screen (Landing, the dock, Bell) shows "settling", never "done".
  const paidOutRead = !!(last && r.snap?.lastBellRang && last.bellTx === r.snap.lastBellRang.tx && last.payoutSeconds !== null);
  const mark: MarkState | null = raw === "done" && !paidOutRead ? "settling" : raw;
  const secondsLeft = r.snap?.nextBellAt ? Math.max(0, (r.snap.nextBellAt - now) / 1000) : null;
  return <C.Provider value={{ ...r, now, last, mark, secondsLeft }}>{children}</C.Provider>;
}

export function useRoundCtx(): Ctx {
  const c = useContext(C);
  if (!c) throw new Error("RoundProvider is missing");
  return c;
}
