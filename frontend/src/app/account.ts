import { useCallback, useEffect, useRef, useState } from "react";
import { loadBalances, loadMyOrders, type Balances, type MyOrder } from "../chain/account";
import { useWallet } from "../wallet/wallet";

function usePolled<T>(load: (() => Promise<T>) | null, ms: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const busy = useRef(false);
  const read = useCallback(async () => {
    if (!load || busy.current) return;
    busy.current = true;
    try { setData(await load()); setError(null); }
    catch (e: any) { setError(String(e?.shortMessage ?? e?.message ?? e).slice(0, 140)); }
    finally { busy.current = false; setLoading(false); }
  }, [load]);
  useEffect(() => {
    if (!load) { setData(null); return; }
    setLoading(true);
    read();
    const t = setInterval(() => { if (document.visibilityState === "visible") read(); }, ms);
    return () => clearInterval(t);
  }, [load, read, ms]);
  return { data, error, loading, refresh: read };
}

/** Balances and approvals for the connected wallet on both chains. */
export function useBalances() {
  const { address } = useWallet();
  const load = useCallback(() => loadBalances(address!), [address]);
  return usePolled<Balances>(address ? load : null, 10_000);
}

/** The connected wallet's orders, with how far each has got. */
export function useMyOrders() {
  const { address } = useWallet();
  const load = useCallback(() => loadMyOrders(address!), [address]);
  return usePolled<MyOrder[]>(address ? load : null, 8_000);
}
