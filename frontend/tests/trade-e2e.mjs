// Drives the built app with the test wallet. Usage: node tests/trade-e2e.mjs <outDir> [who]
import fs from "node:fs";
import { createRequire } from "node:module";
import { installWallet } from "./shim.mjs";
const { chromium } = createRequire(import.meta.url)("playwright");
const out = process.argv[2] || "shots-e2e";
const who = process.argv[3] || "buyer1";
const base = process.env.BASE || "http://localhost:4173";
fs.mkdirSync(out, { recursive: true });
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "light" });
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
const me = await installWallet(page, who);
console.log("wallet", me.address);
await page.goto(base + "/#/trade");
await page.waitForTimeout(1500);
await page.getByRole("button", { name: /connect wallet/i }).first().click();
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/1-connect-sheet.png` });
await page.getByRole("button", { name: /test wallet/i }).click();
await page.waitForTimeout(6000);
await page.screenshot({ path: `${out}/2-trade-connected.png`, fullPage: true });
console.log("body:", (await page.locator("main").innerText()).replace(/\n+/g, " | ").slice(0, 700));
await page.goto(base + "/#/activity");
await page.waitForTimeout(9000);
await page.screenshot({ path: `${out}/3-activity.png`, fullPage: true });
console.log("activity:", (await page.locator("main").innerText()).replace(/\n+/g, " | ").slice(0, 900));
const link = await page.getByRole("link", { name: /see receipt/i }).first().getAttribute("href").catch(() => null);
if (link) {
  await page.goto(base + "/" + link);
  await page.waitForTimeout(12000);
  await page.screenshot({ path: `${out}/4-receipt.png`, fullPage: true });
  console.log("receipt:", (await page.locator("main").innerText()).replace(/\n+/g, " | ").slice(0, 1400));
}
console.log("errors:", errs);
await b.close();
