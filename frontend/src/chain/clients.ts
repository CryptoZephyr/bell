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
