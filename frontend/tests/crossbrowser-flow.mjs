// A full order in WebKit with an iPhone 14 profile: connect, quick tap does nothing, hold to join, a seller takes the other side, ticket to Paid, receipt. Run with the preview server up.
import { createRequire } from "node:module";
import { installWallet } from "./shim.mjs";
import { execSync } from "node:child_process";
const { webkit, devices } = createRequire("../package.json")("playwright");
const B = "http://localhost:4173";
const b = await webkit.launch();
const ctx = await b.newContext({ ...devices["iPhone 14"] });
const page = await ctx.newPage();
const me = await installWallet(page, "buyer1", 84532);
const errs = []; page.on("pageerror", (e) => errs.push(e.message.slice(0, 100)));
await page.goto(B + "/#/trade"); await page.waitForTimeout(1500);
await page.getByRole("button", { name: /connect wallet/i }).first().click();
await page.getByRole("button", { name: /test wallet/i }).click();
await page.waitForFunction(() => /USDC|ETH/.test(document.querySelector(".chain-bal")?.textContent || ""), null, { timeout: 40000 });
await page.locator("input.amount-input").fill("0.0005");
await page.waitForTimeout(6000);
const btn = page.locator("main .btn").last();
const vp = page.viewportSize();
const bb = await btn.boundingBox(); const tb = await page.locator(".tabbar").boundingBox();
console.log("iPhone 14 viewport", JSON.stringify(vp), "| join button bottom", Math.round(bb.y + bb.height), "vs tab bar top", Math.round(tb.y), "=> button clear of tab bar:", bb.y + bb.height <= tb.y);
console.log("button text:", (await btn.innerText()).trim());
await page.screenshot({ path: "/tmp/xb-webkit-trade.png" });
// short tap does nothing
await btn.tap().catch(() => {}); await page.waitForTimeout(800);
console.log("after a quick tap, txs sent:", me.log.length);
// hold (pointer) 800 ms
const box = await btn.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.waitForTimeout(250);
await page.screenshot({ path: "/tmp/xb-webkit-holding.png" });
await page.waitForTimeout(650); await page.mouse.up();
// a seller takes the other side right away
execSync("node tests/chain.mjs place seller2 uni sell 0.0005", { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
await page.waitForFunction(() => /Watch your bell/.test(document.querySelector("main")?.textContent || ""), null, { timeout: 60000 }).catch(() => console.log("no success text"));
console.log("placed, txs:", me.log.map((l) => l.hash.slice(0, 12)).join(","));
await page.goto(B + "/#/activity");
const seen = [];
for (let i = 0; i < 200; i++) {
  const st = await page.locator("article.ticket .ticket-status").first().innerText().catch(() => "");
  if (st && st !== seen.at(-1)) { seen.push(st); console.log(`[${i * 1}s] newest ticket: ${st}`); }
  if (/^Paid/.test(st) && seen.length > 1) break;
  await page.waitForTimeout(1000);
}
await page.screenshot({ path: "/tmp/xb-webkit-activity.png" });
await page.locator("a", { hasText: /see receipt/i }).first().click().catch(() => {});
await page.waitForSelector(".ledger", { timeout: 60000 }).catch(() => console.log("receipt did not load"));
console.log("receipt:", (await page.locator("main").innerText()).replace(/\n+/g, " | ").slice(0, 220));
await page.screenshot({ path: "/tmp/xb-webkit-receipt.png", fullPage: true });
console.log("page errors:", errs.length ? errs.join(" | ") : "none");
await b.close();
