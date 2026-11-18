// Places one small buy with the test wallet, then cancels it. Usage: node tests/place-e2e.mjs <outDir>
import fs from "node:fs";
import { createRequire } from "node:module";
import { installWallet } from "./shim.mjs";
const { chromium } = createRequire(import.meta.url)("playwright");
const out = process.argv[2] || "shots-place";
const base = process.env.BASE || "http://localhost:4173";
fs.mkdirSync(out, { recursive: true });
const b = await chromium.launch();
const page = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
const me = await installWallet(page, "buyer1", 84532);
await page.goto(base + "/#/trade");
await page.waitForTimeout(1200);
await page.getByRole("button", { name: /connect wallet/i }).first().click();
await page.getByRole("button", { name: /test wallet/i }).click();
await page.waitForTimeout(7000);
await page.locator("input.amount-input").fill("0.0004");
await page.waitForTimeout(800);
const primary = () => page.locator("main .btn").last();
console.log("stage button:", (await primary().innerText()).trim());
await page.screenshot({ path: `${out}/1-filled.png`, fullPage: true });
for (let i = 0; i < 3; i++) {
  const t = (await primary().innerText()).trim();
  if (/approve/i.test(t)) { console.log("approving"); await primary().click(); await page.waitForTimeout(500); await page.screenshot({ path: `${out}/2-approving.png` }); await page.waitForFunction(() => !/Approving|Waiting|Sending/i.test(document.querySelector("main .btn:last-of-type")?.textContent || "") , null, { timeout: 90000 }).catch(() => {}); await page.waitForTimeout(12000); }
}
const t = (await primary().innerText()).trim();
console.log("before hold:", t);
if (/join|hold/i.test(t)) {
  await primary().scrollIntoViewIfNeeded();
  const box = await primary().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/3-holding.png` });
  await page.waitForTimeout(500);
  await page.mouse.up();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/4-sending.png` });
  await page.waitForFunction(() => /Order placed|placed/i.test(document.querySelector("main")?.textContent || ""), null, { timeout: 90000 }).catch((e) => console.log("no placed text"));
  await page.screenshot({ path: `${out}/5-placed.png`, fullPage: true });
  console.log("after:", (await page.locator("main").innerText()).replace(/\n+/g, " | ").slice(-300));
  console.log("txs:", JSON.stringify(me.log));
}
await page.getByRole("link", { name: /watch your bell/i }).click().catch(() => {});
await page.waitForSelector("text=Cancel order", { timeout: 30000 }).catch(() => console.log("no cancel button"));
await page.screenshot({ path: `${out}/6-activity.png`, fullPage: true });
const cancel = page.getByRole("button", { name: /cancel order/i }).first();
if (await cancel.count()) {
  await cancel.click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/7-cancelling.png` });
  await page.waitForTimeout(20000);
  await page.screenshot({ path: `${out}/8-cancelled.png`, fullPage: true });
  console.log("activity:", (await page.locator("main").innerText()).replace(/\n+/g, " | ").slice(0, 500));
}
console.log("txs:", JSON.stringify(me.log));
console.log("errors:", errs);
await b.close();
