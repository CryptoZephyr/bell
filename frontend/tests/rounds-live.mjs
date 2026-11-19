// Live check of the Rounds pages against the real chains. Usage: OUT=/tmp/rp node tests/rounds-live.mjs [list|round <block>]
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
const base = process.env.BASE || "http://localhost:4173";
const out = process.env.OUT || "/tmp/rp";
const mode = process.argv[2] || "list";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: Number(process.env.W || 390), height: 900 }, colorScheme: process.env.SCHEME || "light", deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
const t0 = Date.now();
if (mode === "list") {
  await page.goto(base + "/#/rounds");
  await page.waitForSelector(".round-row", { timeout: 30000 });
  console.log("first rows after", Date.now() - t0, "ms");
  await page.waitForFunction(() => document.querySelectorAll(".rr-secs strong").length > 0, { timeout: 60000 }).catch(() => console.log("no seconds read within 60 s"));
  console.log("seconds shown after", Date.now() - t0, "ms");
  await page.waitForTimeout(Number(process.env.WAIT || 15000));
  const rows = await page.$$eval(".round-row", (els) => els.map((e) => e.getAttribute("aria-label")));
  console.log(rows.join("\n"));
  console.log("SUMMARY:", (await page.$eval(".rounds-summary", (e) => e.innerText)).replace(/\n+/g, " | "));
  await page.screenshot({ path: `${out}/list-${process.env.W || 390}-${process.env.SCHEME || "light"}.png`, fullPage: true });
} else {
  await page.goto(base + "/#/round/" + process.argv[3]);
  await page.waitForSelector(".round-hero", { timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll(".ledger .led").length > 3, { timeout: 60000 }).catch(() => console.log("ledger short"));
  await page.waitForTimeout(Number(process.env.WAIT || 6000));
  console.log((await page.$eval(".round-page", (e) => e.innerText)).replace(/\n+/g, " | "));
  const links = await page.$$eval(".ledger a", (a) => a.map((x) => x.href));
  console.log("ledger links:", links.length);
  await page.screenshot({ path: `${out}/round-${process.argv[3]}-${process.env.W || 390}-${process.env.SCHEME || "light"}.png`, fullPage: true });
}
console.log("errors:", JSON.stringify(errors));
await b.close();
