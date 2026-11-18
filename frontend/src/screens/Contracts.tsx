// Contracts and proof (section 11): addresses are read from the deployment record, never typed, with copy buttons and
// explorer links. This is the one place full addresses appear.
import { useState } from "react";
import { DESKS, LASNA_ID, REFEREE, SYSTEM_CONTRACT, addressUrl, explorerName } from "../chain/config";
import { ChainMark, IconArrowUpRight, IconCheck, IconCopy } from "../ui/Icons";
import { useAnnounce } from "../app/Shell";

function CopyAddr({ label, addr, chainId }: { label: string; addr: string; chainId: number }) {
  const [done, setDone] = useState(false);
  const announce = useAnnounce();
  const copy = async () => {
    try { await navigator.clipboard.writeText(addr); setDone(true); announce(`${label} address copied`); setTimeout(() => setDone(false), 1600); } catch { announce("Couldn't copy. Select the address and copy it by hand.", true); }
  };
  return (
    <li className="addr-row">
      <div className="addr-main"><strong>{label}</strong><span className="mono addr">{addr}</span></div>
      <div className="addr-actions">
        <button type="button" className="chip-btn" onClick={copy} aria-label={`Copy ${label} address`}>{done ? <><IconCheck size={16} /> Copied</> : <><IconCopy size={16} /> Copy</>}</button>
        <a className="chip-link" href={addressUrl(chainId, addr)} target="_blank" rel="noopener noreferrer">{explorerName(chainId)}<IconArrowUpRight size={14} /></a>
      </div>
    </li>
  );
}

export function Contracts() {
  return (
    <div className="stack-lg">
      <div className="screen-head">
        <span className="where">Trust</span>
        <h1>Contracts and proof</h1>
        <p>Everything Bell does happens in these contracts, on test networks. Read them, check them, and watch every order on a block explorer.</p>
      </div>

      <section className="inset stack" aria-labelledby="c-base">
        <h2 id="c-base" className="row"><ChainMark chain="base" size={20} /> Base Sepolia</h2>
        <ul className="addr-list"><CopyAddr label="Bell desk" addr={DESKS[84532].desk} chainId={84532} /></ul>
      </section>
      <section className="inset stack" aria-labelledby="c-uni">
        <h2 id="c-uni" className="row"><ChainMark chain="unichain" size={20} /> Unichain Sepolia</h2>
        <ul className="addr-list"><CopyAddr label="Bell desk" addr={DESKS[1301].desk} chainId={1301} /></ul>
      </section>
      <section className="inset stack" aria-labelledby="c-las">
        <h2 id="c-las" className="row"><ChainMark chain="lasna" size={20} /> Reactive Lasna</h2>
        <ul className="addr-list"><CopyAddr label="Bell referee" addr={REFEREE} chainId={LASNA_ID} /><CopyAddr label="Reactive system contract" addr={SYSTEM_CONTRACT} chainId={LASNA_ID} /></ul>
      </section>

      <section className="stack" aria-labelledby="rules-h">
        <h2 id="rules-h">What the contracts promise</h2>
        <ul className="rules">
          <li>Your money stays in your wallet until the bell. Orders are never locked in advance.</li>
          <li>The desk never takes more than your order said, and never pays outside your worst price.</li>
          <li>Every order, pull and payout is a transaction you can open on a block explorer.</li>
          <li>One wallet can have at most two open orders, and an order expires 15 minutes after it is placed.</li>
        </ul>
      </section>
    </div>
  );
}
