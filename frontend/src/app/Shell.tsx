// The app shell (sections 5, 9 and 9b): header, tab bar, connect sheet, account sheet, footer, live regions.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Lockup, Mark, FooterSilhouette } from "../ui/Mark";
import { IconArrowUpRight, IconCheck, IconCopy, IconTicket, IconTrade, IconWallet } from "../ui/Icons";
import { Sheet } from "../ui/Sheet";
import { Button } from "../ui/Button";
import { shortAddr } from "../chain/format";
import { useWallet, type Discovered } from "../wallet/wallet";
import { useTheme, type ThemePref } from "./theme";
import { href, type Route } from "./router";
import { addressUrl, chainName } from "../chain/config";

// ---- live regions: one polite for round progress, one assertive for errors ----
type Announce = (msg: string, assertive?: boolean) => void;
const AnnounceCtx = createContext<Announce>(() => {});
export const useAnnounce = () => useContext(AnnounceCtx);

export function Announcer({ children }: { children: ReactNode }) {
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");
  const announce: Announce = (msg, a) => {
    // Clear first so the same sentence can be announced twice.
    if (a) { setAssertive(""); setTimeout(() => setAssertive(msg), 30); }
    else { setPolite(""); setTimeout(() => setPolite(msg), 30); }
  };
  return (
    <AnnounceCtx.Provider value={announce}>
      {children}
      <div className="live-region" role="status" aria-live="polite" aria-atomic="true">{polite}</div>
      <div className="live-region" role="alert" aria-live="assertive" aria-atomic="true">{assertive}</div>
    </AnnounceCtx.Provider>
  );
}

// ---- sheets owned by the shell ----
type Sheets = { openConnect: () => void; openAccount: () => void };
const SheetsCtx = createContext<Sheets>({ openConnect: () => {}, openAccount: () => {} });
export const useSheets = () => useContext(SheetsCtx);

export function ShellProvider({ children }: { children: ReactNode }) {
  const [connect, setConnect] = useState(false);
  const [account, setAccount] = useState(false);
  const w = useWallet();
  useEffect(() => { if (w.status === "connected") setConnect(false); }, [w.status]);
  return (
    <SheetsCtx.Provider value={{ openConnect: () => setConnect(true), openAccount: () => setAccount(true) }}>
      {children}
      <ConnectSheet open={connect} onClose={() => setConnect(false)} />
      <AccountSheet open={account} onClose={() => setAccount(false)} />
    </SheetsCtx.Provider>
  );
}

function ConnectSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const w = useWallet();
  return (
    <Sheet open={open} onClose={onClose} title="Connect your wallet">
      <p className="muted">Bell asks your wallet to do two things: let the desk move your USDC or ETH once, and place your orders. Your funds stay in your wallet until the bell.</p>
      {w.wallets.length === 0 ? (
        <div className="inset stack">
          <h3>No wallet found</h3>
          <p className="muted">Open Bell in a browser with a wallet extension, or in your wallet app's browser. You can still watch a live round without one.</p>
        </div>
      ) : (
        <ul className="wallet-list" aria-label="Wallets">
          {w.wallets.map((d: Discovered) => (
            <li key={d.info.uuid}>
              <button className="wallet-opt" type="button" onClick={() => w.connect(d)} disabled={w.status === "connecting"}>
                {d.info.icon ? <img src={d.info.icon} alt="" width={32} height={32} /> : <IconWallet />}
                <span className="grow">{d.info.name}</span>
                <span className="muted small">{w.status === "connecting" ? "Check your wallet…" : "Connect"}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {w.error && <p className="field-error" role="alert">{w.error}</p>}
      <p className="small muted"><span className="tag-testnet" style={{ color: "var(--warning-text)" }}>Testnet</span> Bell runs on test networks. Use test funds only.</p>
    </Sheet>
  );
}

function ThemeChoice({ onDark = false }: { onDark?: boolean }) {
  const { pref, choose } = useTheme();
  const opts: { v: ThemePref; label: string }[] = [{ v: "system", label: "System" }, { v: "light", label: "Light" }, { v: "dark", label: "Dark" }];
  return (
    <fieldset className={`theme-choice${onDark ? " on-ink" : ""}`}>
      <legend className="sr-only">Theme</legend>
      {opts.map((o) => (
        <label key={o.v}>
          <input type="radio" name={onDark ? "theme-footer" : "theme"} value={o.v} checked={pref === o.v} onChange={() => choose(o.v)} />
          <span>{o.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

function AccountSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const w = useWallet();
  const [copied, setCopied] = useState(false);
  return (
    <Sheet open={open} onClose={onClose} title="Account">
      {w.address && (
        <div className="inset stack">
          <div className="row between">
            <span className="mono">{shortAddr(w.address)}</span>
            <button className="chip-link" type="button" onClick={() => { navigator.clipboard?.writeText(w.address!); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
              {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}{copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="muted small">{w.walletName}{w.chainId ? ` on ${chainName(w.chainId)}` : ""}</p>
        </div>
      )}
      <div className="stack">
        <h3>Theme</h3>
        <ThemeChoice />
        <p className="small muted">Bell follows your device unless you choose.</p>
      </div>
      <nav className="stack" aria-label="More">
        <a className="sheet-link" href={href.contracts} onClick={onClose}>Contracts and proof</a>
        <a className="sheet-link" href={href.help} onClick={onClose}>Help</a>
      </nav>
      <p className="small muted"><span className="tag-testnet" style={{ color: "var(--warning-text)" }}>Testnet</span> Bell runs on test networks. Use test funds only.</p>
      {w.status === "connected" && <Button kind="secondary" label="Disconnect" onPress={() => { w.disconnect(); onClose(); }} />}
    </Sheet>
  );
}

// ---- header ----
export function WalletButton() {
  const w = useWallet();
  const { openConnect, openAccount } = useSheets();
  if (w.status !== "connected" || !w.address) {
    return (
      <span className="bc-focus">
        <button className="wallet-btn bc bc-btn connect" type="button" onClick={openConnect} data-busy={w.status === "connecting" || undefined}>
          <IconWallet size={20} /> <span>{w.status === "connecting" ? "Connecting…" : "Connect wallet"}</span>
        </button>
      </span>
    );
  }
  return (
    <span className="bc-focus">
      <button className="wallet-btn bc bc-btn" type="button" onClick={openAccount} aria-label={`Account ${shortAddr(w.address)}, test network`}>
        <span className="mono">{shortAddr(w.address)}</span><span className="tag-testnet">Testnet</span>
      </button>
    </span>
  );
}

const TABS = [
  { route: "bell", label: "Bell", href: href.bell, icon: <Mark height={22} tone="current" /> },
  { route: "trade", label: "Trade", href: href.trade, icon: <IconTrade size={24} /> },
  { route: "activity", label: "Activity", href: href.activity, icon: <IconTicket size={24} /> },
] as const;

export function Header({ route }: { route: Route }) {
  return (
    <header className="topbar">
      <a className="brand" href={href.landing} aria-label="Bell, home"><Lockup markHeight={32} tone="current" /></a>
      <nav className="tabs-desktop" aria-label="Main">
        {TABS.map((t) => (
          <a key={t.route} className="tab-link" href={t.href} aria-current={route.name === t.route ? "page" : undefined}>{t.label}</a>
        ))}
      </nav>
      <WalletButton />
    </header>
  );
}

export function TabBar({ route }: { route: Route }) {
  return (
    <nav className="tabbar" aria-label="Main">
      {TABS.map((t) => (
        <a key={t.route} href={t.href} aria-current={route.name === t.route ? "page" : undefined}>
          <span className="tab-icon" aria-hidden="true">{t.icon}</span>
          {t.label}
        </a>
      ))}
    </nav>
  );
}

// ---- footer (section 9b): consumer links, no hackathon references, no raw addresses ----
export function Footer({ route }: { route: Route }) {
  const landing = route.name === "landing";
  return (
    <footer className={`footer bc bc-card${landing ? " show-phone" : ""}`} style={{ ["--cut" as string]: "var(--cut-card)" }}>
      <div className="footer-inner">
        <div className="footer-brand">
          <Lockup markHeight={28} tone="fog" />
          <p>Swap across chains. Orders meet at the bell.</p>
        </div>
        <nav className="footer-cols" aria-label="Footer">
          <div><h2>App</h2><ul><li><a href={href.trade}>Trade</a></li><li><a href={href.bell}>Live bell</a></li><li><a href={href.activity}>Activity</a></li></ul></div>
          <div><h2>Learn</h2><ul><li><a href={`${href.landing}#how`}>How it works</a></li><li><a href={href.help}>Help</a></li></ul></div>
          <div><h2>Trust</h2><ul><li><a href={href.contracts}>Contracts and proof</a></li></ul></div>
        </nav>
        <div className="footer-base">
          <ThemeChoice onDark />
          <p><span className="tag-testnet">Testnet</span> Bell runs on test networks. Use test funds only.</p>
          <p className="copy">© 2026 Bell</p>
        </div>
      </div>
      <FooterSilhouette className="footer-silhouette" />
    </footer>
  );
}

export function ExplorerChip({ chainId, addr, label }: { chainId: number; addr: string; label: string }) {
  return (
    <a className="chip-link" href={addressUrl(chainId, addr)} target="_blank" rel="noopener noreferrer">
      {label}<IconArrowUpRight size={14} />
    </a>
  );
}
