import { createPublicClient, http, type PublicClient } from "viem";
import { DESKS, lasna, LASNA_ID, type DeskChainId } from "./config";

// One read client per network. Reads retry on their own, and a failing network is reported, never hidden.
const cache = new Map<number, PublicClient>();

export function client(chainId: number): PublicClient {
  let c = cache.get(chainId);
  if (!c) {
    if (chainId === LASNA_ID) {
      c = createPublicClient({ chain: lasna, transport: http(undefined, { retryCount: 3, retryDelay: 600, timeout: 12_000 }) });
    } else {
      const d = DESKS[chainId as DeskChainId];
      c = createPublicClient({ chain: d.chain, transport: http(d.rpc, { retryCount: 3, retryDelay: 600, timeout: 12_000 }) });
    }
    cache.set(chainId, c);
  }
  return c;
}

const logCache = new Map<number, PublicClient>();

/** A client for log queries. Public RPCs refuse wide log queries, so any long range is split into spans the RPC accepts,
 *  a few at a time. State reads use `client()`, because some RPCs serve stale state right after a transaction. */
export function logClient(chainId: number): PublicClient {
  let c = logCache.get(chainId);
  if (c) return c;
  let url: string | undefined;
  let span = 9500n; // Lasna allows about 10,000 blocks
  let chain;
  if (chainId === LASNA_ID) { chain = lasna; }
  else { const d = DESKS[chainId as DeskChainId]; chain = d.chain; url = d.logRpc; span = d.logSpan; }
  c = createPublicClient({ chain, transport: http(url, { retryCount: 3, retryDelay: 600, timeout: 15_000 }) });
  const orig = c.getContractEvents.bind(c) as (a: any) => Promise<any[]>;
  (c as any).getContractEvents = async (a: any) => {
    if (typeof a.fromBlock !== "bigint" || typeof a.toBlock !== "bigint" || a.toBlock - a.fromBlock < span) return orig(a);
    const jobs: [bigint, bigint][] = [];
    for (let f = a.fromBlock; f <= a.toBlock; f += span) jobs.push([f, f + span - 1n > a.toBlock ? a.toBlock : f + span - 1n]);
    const out: any[][] = new Array(jobs.length);
    let next = 0;
    const worker = async () => { while (next < jobs.length) { const i = next++; out[i] = await orig({ ...a, fromBlock: jobs[i][0], toBlock: jobs[i][1] }); } };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return out.flat();
  };
  logCache.set(chainId, c);
  return c;
}
