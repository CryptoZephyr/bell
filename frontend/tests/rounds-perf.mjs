// RP-7 (no overflow) and RP-8 (speed). Usage: node tests/rounds-perf.mjs
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
const base = process.env.BASE || "http://localhost:4173";
const b = await chromium.launch();
let bad = 0;
// no horizontal overflow
for (const w of process.env.SPEED_ONLY ? [] : [320, 390, 768, 1280, 1440]) {
  for (const r of ["/rounds", "/round/8643401"]) {
    const page = await (await b.newContext({ viewport: { width: w, height: 900 } })).newPage();
    await page.goto(base + "/#" + r);
    await page.waitForSelector(r === "/rounds" ? ".round-row" : ".round-hero", { timeout: 40000 });
    await page.waitForTimeout(r === "/rounds" ? 12000 : 9000);
    const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    const ok = o.sw <= o.cw;
    if (!ok) bad++;
    console.log(ok ? "ok  " : "FAIL", `overflow ${w}px ${r}`, JSON.stringify(o));
    if (w === 1280 || w === 390) {
      for (const scheme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(500);
        await page.screenshot({ path: `/tmp/rp/shot-${r.replace(/\//g, "_")}-${w}-${scheme}.png`, fullPage: true });
      }
    }
    await page.context().close();
  }
}
// speed
for (const [name, slow] of [["normal", false], ["Slow 4G", true]]) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  if (slow) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
  }
  const t0 = Date.now();
  await page.goto(base + "/#/rounds");
  await page.waitForSelector(".round-row", { timeout: 120000 });
  const facts = Date.now() - t0;
  await page.waitForFunction(() => document.querySelectorAll(".rr-secs strong").length > 0, { timeout: 120000 }).catch(() => {});
  const secs = Date.now() - t0;
  const at = {};
  for (const n of [5, 10]) {
    await page.waitForFunction((k) => [...document.querySelectorAll(".round-row")].filter((r) => !r.querySelector(".mini.skeleton") && !/Reading$/.test(r.querySelector(".rr-secs")?.textContent || "")).length >= k, n, { timeout: 120000 }).catch(() => {});
    at[n] = Date.now() - t0;
  }
  console.log(`speed ${name}: Lasna facts (first rows) ${(facts / 1000).toFixed(1)} s, first seconds ${(secs / 1000).toFixed(1)} s, 5 rows read ${(at[5] / 1000).toFixed(1)} s, 10 rows read ${(at[10] / 1000).toFixed(1)} s`);
  await ctx.close();
}
await b.close();
console.log(bad ? `${bad} overflow failures` : "no horizontal overflow");
process.exit(bad ? 1 : 0);
