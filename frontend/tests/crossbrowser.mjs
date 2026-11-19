// Runs the app in WebKit (the Safari engine) with an iPhone 14 profile, and Firefox, with the test wallet. Needs: npx playwright install webkit firefox && npx playwright install-deps webkit firefox
// node tests/crossbrowser.mjs <webkit|firefox> <iphone|desktop>   layout, fonts, clip-path, errors on every route
import { createRequire } from "node:module";
import { installWallet } from "./shim.mjs";
const { webkit, firefox, devices } = createRequire("../package.json")("playwright");
const [engine, profile] = process.argv.slice(2);
const B = "http://localhost:4173";
const type = engine === "webkit" ? webkit : firefox;
const browser = await type.launch();
const ctxOpts = profile === "iphone" ? { ...devices["iPhone 14"] } : { viewport: { width: 1280, height: 900 } };
const ctx = await browser.newContext(ctxOpts);
const page = await ctx.newPage();
const errs = []; page.on("pageerror", (e) => errs.push(e.message.slice(0, 120))); page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text().slice(0, 120)); });
console.log(`${engine} ${profile}: UA ${(await page.evaluate(() => navigator.userAgent)).slice(0, 90)}`);
// layout on every route
const over = [];
for (const r of ["/", "/bell", "/trade", "/activity", "/contracts", "/help"]) {
  await page.goto(B + "/#" + r); await page.waitForTimeout(2200);
  const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  over.push(`${r}:${o}`);
}
console.log("horizontal overflow px:", over.join(" "));
await page.goto(B + "/#/"); await page.waitForTimeout(3500);
await page.screenshot({ path: `/tmp/xb-${engine}-${profile}-landing.png` });
const fonts = await page.evaluate(() => document.fonts.size + " fonts, loaded: " + [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family).filter((v, i, a) => a.indexOf(v) === i).join(","));
console.log("fonts:", fonts);
const clip = await page.evaluate(() => { const e = document.querySelector(".btn"); return e ? getComputedStyle(e).clipPath.slice(0, 40) : "no btn"; });
console.log("Bell corner clip-path computed:", clip);
console.log("page errors:", errs.length ? errs.join(" | ") : "none");
await browser.close();
