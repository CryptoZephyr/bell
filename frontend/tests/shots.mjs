// Screenshots of the built screens at phone and desktop width, in light and dark. Usage: node tests/shots.mjs <outDir> [route ...]
import fs from "node:fs";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
const out = process.argv[2] || "shots";
const routes = process.argv.slice(3).length ? process.argv.slice(3) : ["/"];
const base = process.env.BASE || "http://localhost:4173";
fs.mkdirSync(out, { recursive: true });
const sizes = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 900 } };
const browser = await chromium.launch();
for (const [sname, vp] of Object.entries(sizes)) {
  for (const scheme of ["light", "dark"]) {
    const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    for (const r of routes) {
      await page.goto(base + "/#" + r, { waitUntil: "load" });
      await page.waitForTimeout(Number(process.env.WAIT || 2500));
      const name = `${r.replace(/[^a-z0-9]+/gi, "_") || "home"}-${sname}-${scheme}.png`;
      await page.screenshot({ path: `${out}/${name}`, fullPage: process.env.FULL === "1" });
      console.log("wrote", name);
    }
    if (errs.length) console.log("page errors:", errs.join(" | "));
    await ctx.close();
  }
}
await browser.close();
