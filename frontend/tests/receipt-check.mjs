// Prints what the app's receipt says for given orders. Usage: node tests/receipt-check.mjs <who> <chainId>:<orderId> ...
import { createRequire } from "node:module";
import { installWallet } from "./shim.mjs";
const { chromium } = createRequire(import.meta.url)("playwright");
const [who, ...orders] = process.argv.slice(2);
const base = process.env.BASE || "http://localhost:4173";
const out = process.env.OUT || "/tmp";
const b = await chromium.launch();
const page = await (await b.newContext({ viewport: { width: 430, height: 900 } })).newPage();
await installWallet(page, who, 84532);
await page.goto(base + "/#/activity"); await page.waitForTimeout(1200);
await page.getByRole("button", { name: /connect wallet/i }).first().click();
await page.getByRole("button", { name: /test wallet/i }).click();
await page.waitForSelector("article.ticket", { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(1500);
console.log(who, "activity:", (await page.locator("main").innerText()).replace(/\n+/g, " | ").slice(0, 500));
for (const o of orders) {
  await page.goto(base + `/#/receipt/${o.replace(":", "/")}`);
  await page.waitForSelector(".ledger, .notice, .empty", { timeout: 90000 }).catch(() => console.log("receipt did not finish loading in 90s"));
  await page.waitForTimeout(1500);
  console.log("RECEIPT", o, ":", (await page.locator("main").innerText()).replace(/\n+/g, " | ").slice(0, 900));
  await page.screenshot({ path: `${out}/receipt-${who}-${o.replace(":", "-")}.png`, fullPage: true });
}
await b.close();
