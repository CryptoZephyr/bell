// Runs axe-core on every screen at phone and desktop width, in light and dark. Exit code 1 if any violation is found.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const axeSrc = require("node:fs").readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const base = process.env.BASE || "http://localhost:4173";
const routes = process.argv.slice(2).length ? process.argv.slice(2) : ["/", "/bell", "/trade", "/activity", "/contracts", "/help", "/states"];
const b = await chromium.launch();
let bad = 0;
for (const [name, vp] of [["phone", { width: 390, height: 844 }], ["desktop", { width: 1280, height: 900 }]]) {
  for (const scheme of ["light", "dark"]) {
    const page = await (await b.newContext({ viewport: vp, colorScheme: scheme })).newPage();
    for (const r of routes) {
      await page.goto(base + "/#" + r);
      await page.waitForTimeout(3500);
      await page.evaluate(axeSrc);
      const res = await page.evaluate(() => window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "best-practice"] }));
      for (const v of res.violations) {
        bad++;
        console.log(`${name}/${scheme} ${r}: ${v.id} (${v.impact}) ${v.nodes.length} node(s) e.g. ${v.nodes[0].target.join(" ")} :: ${(v.nodes[0].failureSummary || "").split("\n")[1] || ""}`);
      }
    }
    await page.context().close();
  }
}
console.log(bad ? `${bad} violation group(s)` : "axe: no violations");
await b.close();
process.exit(bad ? 1 : 0);
