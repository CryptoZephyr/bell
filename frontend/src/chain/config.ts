// Networks, addresses and constants. Addresses come from the repo's deployment record (deployments/bell.json),
// never from copies, so a redeploy only needs the record to change.
import rec from "@deploy/bell.json";
import { defineChain, type Address, type Chain } from "viem";
import { baseSepolia, unichainSepolia } from "viem/chains";

export type DeskChainId = 84532 | 1301;
export const DESK_CHAIN_IDS: DeskChainId[] = [84532, 1301];
export const LASNA_ID = 5318007;

export const lasna: Chain = defineChain({
  id: LASNA_ID,
  name: "Reactive Lasna",
  nativeCurrency: { name: "REACT", symbol: "REACT", decimals: 18 },
  rpcUrls: { default: { http: ["https://lasna-rpc.rnk.dev/"] } },
  blockExplorers: { default: { name: "Reactscan", url: "https://lasna.reactscan.net" } },
});

export type DeskChain = {
  id: DeskChainId;
  key: "base" | "unichain";
  name: string;
  chain: Chain;
  rpc: string;
  /** The RPC used for log queries, and the most blocks it allows in one query. State reads use `rpc`. */
  logRpc: string;
  logSpan: bigint;
  explorer: string;
  explorerName: string;
  desk: Address;
  deskBlock: bigint;
  usdc: Address;
  weth: Address;
  poolManager: Address;
  tickSpacing: number;
  faucetUsdc: string;
  faucetEth: string;
};

const r = rec as unknown as {
  referee: Address; refereeBlock: number; poolIdB: `0x${string}`;
  baseSepolia: { desk: Address; block: number; usdc: Address; weth: Address; poolManager: Address; tickSpacing: number };
  unichainSepolia: { desk: Address; block: number; usdc: Address; weth: Address; poolManager: Address; tickSpacing: number };
};

export const REFEREE: Address = r.referee;
export const REFEREE_BLOCK = BigInt(r.refereeBlock);
export const REFERENCE_POOL_ID = r.poolIdB;
export const SYSTEM_CONTRACT: Address = "0x8888888888888888888888888888888888888888";

export const DESKS: Record<DeskChainId, DeskChain> = {
  84532: {
    id: 84532, key: "base", name: "Base Sepolia", chain: baseSepolia,
    rpc: "https://base-sepolia-rpc.publicnode.com",
    logRpc: "https://base-sepolia-rpc.publicnode.com", logSpan: 9000n,
    explorer: "https://sepolia.basescan.org", explorerName: "Basescan",
    desk: r.baseSepolia.desk, deskBlock: BigInt(r.baseSepolia.block),
    usdc: r.baseSepolia.usdc, weth: r.baseSepolia.weth, poolManager: r.baseSepolia.poolManager, tickSpacing: r.baseSepolia.tickSpacing,
    faucetUsdc: "https://faucet.circle.com",
    faucetEth: "https://docs.base.org/base-chain/tools/network-faucets",
  },
  1301: {
    id: 1301, key: "unichain", name: "Unichain Sepolia", chain: unichainSepolia,
    rpc: "https://unichain-sepolia-rpc.publicnode.com", // reads: fresh right after a transaction
    // Logs: publicnode prunes Unichain history after about 20,000 blocks. The official RPC keeps days, at 1000 blocks per query.
    logRpc: "https://sepolia.unichain.org", logSpan: 1000n,
    explorer: "https://sepolia.uniscan.xyz", explorerName: "Uniscan",
    desk: r.unichainSepolia.desk, deskBlock: BigInt(r.unichainSepolia.block),
    usdc: r.unichainSepolia.usdc, weth: r.unichainSepolia.weth, poolManager: r.unichainSepolia.poolManager, tickSpacing: r.unichainSepolia.tickSpacing,
    faucetUsdc: "https://faucet.circle.com",
    faucetEth: "https://www.alchemy.com/faucets/unichain-sepolia",
  },
};

export const REFERENCE_CHAIN: DeskChainId = 1301; // the reference pool lives on Unichain
export const LASNA_EXPLORER = "https://lasna.reactscan.net";
export const BELL_EVERY_BLOCKS = 100; // Cron100
export const POOL_FEE_PPM = 500n;
export const PRICE_STALE_SECONDS = 180;

export function chainName(id: number): string {
  return id === LASNA_ID ? "Reactive Lasna" : DESKS[id as DeskChainId]?.name ?? `Chain ${id}`;
}
export function txUrl(chainId: number, hash: string): string {
  return chainId === LASNA_ID ? `${LASNA_EXPLORER}/tx/${hash}` : `${DESKS[chainId as DeskChainId].explorer}/tx/${hash}`;
}
export function addressUrl(chainId: number, addr: string): string {
  return chainId === LASNA_ID ? `${LASNA_EXPLORER}/address/${addr}` : `${DESKS[chainId as DeskChainId].explorer}/address/${addr}`;
}
export function explorerName(chainId: number): string {
  return chainId === LASNA_ID ? "Reactscan" : DESKS[chainId as DeskChainId].explorerName;
}
