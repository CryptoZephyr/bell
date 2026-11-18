// Screenshots the Trade stages that need no transaction: bad amount, too small, no token, switch network, wrap. Usage: node tests/stages.mjs <outDir>
import fs from "node:fs";
import { createRequire } from "node:module";
import { installWallet } from "./shim.mjs";
const { chromium } = createRequire(import.meta.url)("playwright");
const out = process.argv[2] || "shots-stages";
const base = process.env.BASE || "http://localhost:4173";
fs.mkdirSync(out, { recursive: true });
const b = await chromium.launch();
async function run(name, startChain, steps) {
  const page = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await installWallet(page, "buyer1", startChain);
  await page.goto(base + "/#/trade");
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: /connect wallet/i }).first().click();
  await page.getByRole("button", { name: /test wallet/i }).click();
  await page.waitForTimeout(7000);
  await steps(page);
  await page.waitForTimeout(600);
  const btn = page.locator("main .btn").last();
  const has = (await btn.count()) > 0;
  if (has) await btn.scrollIntoViewIfNeeded();
  else await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(name, "->", has ? (await btn.innerText()).trim() : "(no button)", "|", (await page.locator("main").innerText()).replace(/\n+/g, " | ").slice(-220));
  await page.context().close();
}
await run("bad-amount", 84532, async () => {});
await run("too-small", 84532, async (p) => { await p.locator("input.amount-input").fill("0.000001"); });
await run("no-token", 84532, async (p) => { await p.locator("input.amount-input").fill("5"); });
await run("switch", 1301, async (p) => { await p.locator("input.amount-input").fill("0.0004"); await p.getByRole("radio", { name: /Base/ }).check({ force: true }); });
await run("sell-no-weth", 84532, async (p) => { await p.getByRole("radio", { name: /Sell ETH/ }).check({ force: true }); await p.locator("input.amount-input").fill("0.0004"); });
await b.close();
