// RP-5: keeps the Rounds page open and records when a new round appears at the top and what seconds it shows.
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
const base = process.env.BASE || "http://localhost:4173";
const limitS = Number(process.env.WAIT_S || 400);
const b = await chromium.launch();
const page = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(base + "/#/rounds");
await page.waitForSelector(".round-row", { timeout: 40000 });
await page.waitForTimeout(8000);
const known = new Set(await page.$$eval(".round-row", (a) => a.map((x) => x.getAttribute("href"))));
console.log("watching, rounds known:", known.size, new Date().toISOString());
const t0 = Date.now();
let seen = null;
while ((Date.now() - t0) / 1000 < limitS) {
  await page.waitForTimeout(2000);
  const rows = await page.$$eval(".round-row", (a) => a.slice(0, 3).map((x) => ({ href: x.getAttribute("href"), label: x.getAttribute("aria-label"), isNew: x.classList.contains("is-new") })));
  const top = rows.find((r) => !known.has(r.href));
  if (top) {
    if (!seen) { seen = top.href; console.log("new round appeared", new Date().toISOString(), top.href, "isNew animation:", top.isNew); }
    console.log(new Date().toISOString(), top.label);
    if (/paid out in/.test(top.label)) break;
  }
}
console.log("errors:", JSON.stringify(errors));
await b.close();
