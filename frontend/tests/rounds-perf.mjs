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
  const t = {};
  const mark = async (name, fn, arg) => { await page.waitForFunction(fn, arg, { timeout: 150000, polling: 100 }).catch(() => {}); t[name] = ((Date.now() - t0) / 1000).toFixed(1); };
  await mark("first row", () => document.querySelectorAll(".round-row").length >= 1);
  await mark("first seconds", () => document.querySelectorAll(".rr-secs strong").length >= 1);
  await mark("all rows listed (Lasna facts)", () => document.querySelectorAll(".round-row").length >= 15);
  await mark("all rows read (seconds)", () => document.querySelectorAll(".round-row").length >= 15 && ![...document.querySelectorAll(".round-row")].some((r) => r.querySelector(".mini.skeleton")));
  console.log(`speed ${name}:`, JSON.stringify(t));
  await ctx.close();
}
await b.close();
console.log(bad ? `${bad} overflow failures` : "no horizontal overflow");
process.exit(bad ? 1 : 0);
