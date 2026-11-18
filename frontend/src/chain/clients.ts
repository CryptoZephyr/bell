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
    chunkEvents(c);
    cache.set(chainId, c);
  }
  return c;
}

const SPAN = 9000n; // public RPCs cap a log query at 10,000 blocks or fewer

/** Public RPCs refuse wide log queries. This splits any long range into spans they accept and runs a few at a time. */
function chunkEvents(c: PublicClient) {
  const orig = c.getContractEvents.bind(c) as (a: any) => Promise<any[]>;
  (c as any).getContractEvents = async (a: any) => {
    if (typeof a.fromBlock !== "bigint" || typeof a.toBlock !== "bigint" || a.toBlock - a.fromBlock < SPAN) return orig(a);
    const jobs: [bigint, bigint][] = [];
    for (let f = a.fromBlock; f <= a.toBlock; f += SPAN) jobs.push([f, f + SPAN - 1n > a.toBlock ? a.toBlock : f + SPAN - 1n]);
    const out: any[][] = new Array(jobs.length);
    let next = 0;
    const worker = async () => { while (next < jobs.length) { const i = next++; out[i] = await orig({ ...a, fromBlock: jobs[i][0], toBlock: jobs[i][1] }); } };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return out.flat();
  };
}
