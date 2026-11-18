// A local test wallet for browser tests. It speaks EIP-1193 and EIP-6963, and signs with a test key read from
// ~/.config/bell-testnet/wallets.json. The key never enters the repo or the page: signing happens in node.
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createWalletClient, http, defineChain } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");

const CHAINS = {
  84532: defineChain({ id: 84532, name: "Base Sepolia", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://base-sepolia-rpc.publicnode.com"] } } }),
  1301: defineChain({ id: 1301, name: "Unichain Sepolia", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://sepolia.unichain.org"] } } }),
};

export async function installWallet(page, who = "buyer1", startChain = 84532) {
  const w = JSON.parse(fs.readFileSync(`${os.homedir()}/.config/bell-testnet/wallets.json`, "utf8"))[who];
  const account = privateKeyToAccount(w.privateKey);
  let chainId = startChain;
  const log = [];
  await page.exposeFunction("__shimSend", async (tx) => {
    const wc = createWalletClient({ account, chain: CHAINS[chainId], transport: http() });
    const hash = await wc.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined });
    log.push({ chainId, to: tx.to, hash });
    return hash;
  });
  await page.exposeFunction("__shimChain", (id) => { chainId = id; });
  await page.addInitScript(({ address, chainId }) => {
    let cid = chainId;
    const subs = {};
    const provider = {
      request: async ({ method, params }) => {
        switch (method) {
          case "eth_requestAccounts": case "eth_accounts": return [window.__accountOverride || address];
          case "eth_chainId": return "0x" + cid.toString(16);
          case "wallet_switchEthereumChain": if (window.__rejectNext) { window.__rejectNext = false; throw Object.assign(new Error("User rejected the request."), { code: 4001 }); } cid = parseInt(params[0].chainId, 16); await window.__shimChain(cid); (subs.chainChanged || []).forEach((f) => f("0x" + cid.toString(16))); return null;
          case "eth_sendTransaction":
            if (window.__rejectNext) { window.__rejectNext = false; throw Object.assign(new Error("User rejected the request."), { code: 4001 }); }
            return window.__shimSend(params[0]);
          default: throw Object.assign(new Error("Unsupported " + method), { code: -32601 });
        }
      },
      on: (e, f) => { (subs[e] ||= []).push(f); },
      removeListener: (e, f) => { subs[e] = (subs[e] || []).filter((x) => x !== f); },
    };
    const info = { uuid: "test-wallet", name: "Test wallet", icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=", rdns: "test.wallet" };
    const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
  }, { address: account.address, chainId });
  return { address: account.address, log };
}
