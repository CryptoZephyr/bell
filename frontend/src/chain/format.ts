// Raw units never reach the screen. ETH to 4 places, USDC to 2, prices as "805.54 USDC per ETH".
import { formatUnits, getAddress } from "viem";

const nf = (min: number, max: number) => new Intl.NumberFormat("en-US", { minimumFractionDigits: min, maximumFractionDigits: max });
const eth4 = nf(4, 4);
const usd2 = nf(2, 2);

export function fmtEth(wei: bigint): string {
  if (wei === 0n) return eth4.format(0);
  const n = Number(formatUnits(wei, 18));
  if (n < 0.0001) return "<0.0001";
  return eth4.format(n);
}
export function fmtUsdc(micro: bigint): string {
  if (micro === 0n) return usd2.format(0);
  const n = Number(formatUnits(micro, 6));
  if (n < 0.01) return "<0.01";
  return usd2.format(n);
}
/** Price in USDC micro-units per 1 ETH to "805.54". */
export function fmtPrice(microPerEth: bigint): string {
  return usd2.format(Number(formatUnits(microPerEth, 6)));
}
export const fmtPriceUnit = (microPerEth: bigint) => `${fmtPrice(microPerEth)} USDC per ETH`;

export function shortAddr(a: string): string {
  const c = getAddress(a);
  return `${c.slice(0, 6)}…${c.slice(-4)}`;
}
export function shortHash(h: string): string {
  return `${h.slice(0, 8)}…${h.slice(-6)}`;
}

/** Clock time of a moment, like 14:03:20. */
export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}
/** A countdown like 1:14. */
export function countdown(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}
export function ago(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}
export function secondsLabel(s: number): string {
  return `${Math.max(0, Math.round(s))} second${Math.round(s) === 1 ? "" : "s"}`;
}

/** ETH amount typed by a person to wei, or null if it is not a clean positive number. */
export function parseEthInput(s: string): bigint | null {
  const t = s.trim().replace(",", ".");
  if (!/^\d*\.?\d{0,18}$/.test(t) || t === "" || t === ".") return null;
  const [w, f = ""] = t.split(".");
  const wei = BigInt(w || "0") * 10n ** 18n + BigInt((f + "0".repeat(18)).slice(0, 18));
  return wei > 0n ? wei : null;
}
