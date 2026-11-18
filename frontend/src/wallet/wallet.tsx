// Our own wallet layer. No wallet-modal library: wallets announce themselves through EIP-6963, the connect sheet is ours,
// and chain reads and writes go through viem, which has no UI.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createWalletClient, custom, getAddress, type Abi, type Address, type Hex, type WalletClient } from "viem";
import { client } from "../chain/clients";
import { DESKS, DESK_CHAIN_IDS, type DeskChainId } from "../chain/config";

export type Eip1193 = {
  request(args: { method: string; params?: unknown }): Promise<any>;
  on?: (event: string, cb: (...args: any[]) => void) => void;
  removeListener?: (event: string, cb: (...args: any[]) => void) => void;
};
export type WalletInfo = { uuid: string; name: string; icon: string; rdns: string };
export type Discovered = { info: WalletInfo; provider: Eip1193 };

type Status = "disconnected" | "connecting" | "connected";
type Ctx = {
  wallets: Discovered[];
  status: Status;
  address: Address | null;
  chainId: number | null;
  walletName: string | null;
  error: string | null;
  connect: (d: Discovered) => Promise<void>;
  disconnect: () => void;
  switchTo: (id: DeskChainId) => Promise<void>;
  /** Sends a contract write on a desk chain, reporting the real step as it happens. */
  write: (a: WriteArgs) => Promise<{ hash: Hex; seconds: number }>;
};
export type WriteArgs = {
  chainId: DeskChainId;
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
  onStep?: (label: string, progress: number) => void;
};

const WalletCtx = createContext<Ctx | null>(null);
export const useWallet = () => {
  const c = useContext(WalletCtx);
  if (!c) throw new Error("WalletProvider is missing");
  return c;
};

const LAST = "bell-wallet";

const CHAIN_PARAMS: Record<DeskChainId, any> = {
  84532: {
    chainId: "0x14a34", chainName: "Base Sepolia", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://sepolia.base.org"], blockExplorerUrls: ["https://sepolia.basescan.org"],
  },
  1301: {
    chainId: "0x515", chainName: "Unichain Sepolia", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://sepolia.unichain.org"], blockExplorerUrls: ["https://sepolia.uniscan.xyz"],
  },
};

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallets, setWallets] = useState<Discovered[]>([]);
  const [status, setStatus] = useState<Status>("disconnected");
  const [address, setAddress] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [current, setCurrent] = useState<Discovered | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listeners = useRef<{ p: Eip1193; acc: (a: string[]) => void; chain: (c: string) => void } | null>(null);

  // EIP-6963: wallets announce themselves. Fall back to window.ethereum for wallets that do not.
  useEffect(() => {
    const found = new Map<string, Discovered>();
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail as Discovered;
      if (!d?.info?.uuid) return;
      found.set(d.info.uuid, d);
      setWallets([...found.values()]);
    };
    window.addEventListener("eip6963:announceProvider", on);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    const t = setTimeout(() => {
      const eth = (window as any).ethereum as Eip1193 | undefined;
      if (eth && found.size === 0) {
        found.set("injected", { info: { uuid: "injected", name: "Browser wallet", icon: "", rdns: "injected" }, provider: eth });
        setWallets([...found.values()]);
      }
    }, 400);
    return () => { window.removeEventListener("eip6963:announceProvider", on); clearTimeout(t); };
  }, []);

  const detach = useCallback(() => {
    const l = listeners.current;
    if (l) { l.p.removeListener?.("accountsChanged", l.acc); l.p.removeListener?.("chainChanged", l.chain); }
    listeners.current = null;
  }, []);

  const attach = useCallback((d: Discovered) => {
    detach();
    const acc = (a: string[]) => {
      if (!a.length) { setStatus("disconnected"); setAddress(null); setCurrent(null); } else setAddress(getAddress(a[0]));
    };
    const chain = (c: string) => setChainId(parseInt(c, 16));
    d.provider.on?.("accountsChanged", acc);
    d.provider.on?.("chainChanged", chain);
    listeners.current = { p: d.provider, acc, chain };
  }, [detach]);

  const finish = useCallback(async (d: Discovered, accounts: string[]) => {
    const cid = parseInt(await d.provider.request({ method: "eth_chainId" }), 16);
    setCurrent(d);
    setAddress(getAddress(accounts[0]));
    setChainId(cid);
    setStatus("connected");
    setError(null);
    attach(d);
    try { localStorage.setItem(LAST, d.info.rdns); } catch { /* remembering is optional */ }
  }, [attach]);

  // Reconnect quietly to the wallet used last time, if it still has the site connected.
  useEffect(() => {
    let rdns: string | null = null;
    try { rdns = localStorage.getItem(LAST); } catch { /* ignore */ }
    if (!rdns || status !== "disconnected") return;
    const d = wallets.find((w) => w.info.rdns === rdns);
    if (!d) return;
    d.provider.request({ method: "eth_accounts" }).then((a: string[]) => { if (a?.length) finish(d, a); }).catch(() => {});
  }, [wallets, status, finish]);

  const connect = useCallback(async (d: Discovered) => {
    setStatus("connecting");
    setError(null);
    try {
      const accounts: string[] = await d.provider.request({ method: "eth_requestAccounts" });
      if (!accounts?.length) throw new Error("No account shared");
      await finish(d, accounts);
    } catch (e: any) {
      setStatus("disconnected");
      setError(friendlyWalletError(e).text);
    }
  }, [finish]);

  const disconnect = useCallback(() => {
    detach();
    setStatus("disconnected"); setAddress(null); setChainId(null); setCurrent(null);
    try { localStorage.removeItem(LAST); } catch { /* ignore */ }
  }, [detach]);

  const switchTo = useCallback(async (id: DeskChainId) => {
    if (!current) throw new Error("Connect a wallet first");
    try {
      await current.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_PARAMS[id].chainId }] });
    } catch (e: any) {
      if (e?.code === 4902 || /unrecognized chain|not been added/i.test(String(e?.message))) {
        await current.provider.request({ method: "wallet_addEthereumChain", params: [CHAIN_PARAMS[id]] });
      } else throw e;
    }
    setChainId(parseInt(await current.provider.request({ method: "eth_chainId" }), 16));
  }, [current]);

  const write = useCallback(async (a: WriteArgs) => {
    if (!current || !address) throw new Error("Connect a wallet first");
    const d = DESKS[a.chainId];
    a.onStep?.("Waiting for your wallet", 0.2);
    const onRightChain = parseInt(await current.provider.request({ method: "eth_chainId" }), 16) === a.chainId;
    if (!onRightChain) await switchTo(a.chainId);
    const wc: WalletClient = createWalletClient({ account: address, chain: d.chain, transport: custom(current.provider) });
    const hash = await wc.writeContract({ address: a.address, abi: a.abi, functionName: a.functionName, args: a.args as any, value: a.value, account: address, chain: d.chain } as any);
    const t0 = Date.now();
    const tick = setInterval(() => a.onStep?.(`Sending to ${d.key === "base" ? "Base" : "Unichain"}, ${Math.round((Date.now() - t0) / 1000)} s`, 0.6), 1000);
    a.onStep?.(`Sending to ${d.key === "base" ? "Base" : "Unichain"}`, 0.6);
    try {
      const rc = await client(a.chainId).waitForTransactionReceipt({ hash, timeout: 90_000 });
      if (rc.status !== "success") throw new Error("The transaction failed on chain.");
    } finally { clearInterval(tick); }
    const seconds = Math.max(1, Math.round((Date.now() - t0) / 1000));
    a.onStep?.(`Confirmed in ${seconds} s`, 1);
    return { hash, seconds };
  }, [current, address, switchTo]);

  const value = useMemo<Ctx>(() => ({
    wallets, status, address, chainId, walletName: current?.info.name ?? null, error, connect, disconnect, switchTo, write,
  }), [wallets, status, address, chainId, current, error, connect, disconnect, switchTo, write]);

  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>;
}

export const isDeskChain = (id: number | null): id is DeskChainId => id !== null && (DESK_CHAIN_IDS as number[]).includes(id);

// ---- errors, in plain words (section 13): what happened, whether anything was lost, and the one thing to do next ----

export type Friendly = { kind: "cancelled" | "gas" | "unfunded" | "too-small" | "network" | "other"; text: string; next: string };

export function friendlyWalletError(e: any): Friendly {
  const msg = String(e?.shortMessage ?? e?.message ?? e ?? "");
  const name = String(e?.name ?? "");
  const code = e?.code ?? e?.cause?.code;
  if (code === 4001 || /user rejected|user denied|rejected the request|cancell?ed/i.test(msg) || /UserRejected/.test(name)) {
    return { kind: "cancelled", text: "You cancelled in your wallet. Nothing was sent.", next: "Tap to try again." };
  }
  if (/insufficient funds for gas|exceeds the balance|gas required exceeds/i.test(msg)) {
    return { kind: "gas", text: "You need a little test ETH on this network for gas. Nothing was sent.", next: "Get test ETH, then try again." };
  }
  if (/NotFunded/.test(msg)) {
    return { kind: "unfunded", text: "The desk could not see enough funds or approval for this order. Nothing was sent.", next: "Check your balance and approval, then try again." };
  }
  if (/OrderTooSmall/.test(msg)) {
    return { kind: "too-small", text: "That order is too small. The smallest is 0.00001 ETH. Nothing was sent.", next: "Raise the amount and try again." };
  }
  if (/chain|network/i.test(msg) && /switch|mismatch|wrong/i.test(msg)) {
    return { kind: "network", text: "Your wallet is on a different network. Nothing was sent.", next: "Switch network and try again." };
  }
  return { kind: "other", text: msg.length > 140 ? msg.slice(0, 140) + "…" : msg || "Something went wrong. Nothing was sent.", next: "Tap to try again." };
}
