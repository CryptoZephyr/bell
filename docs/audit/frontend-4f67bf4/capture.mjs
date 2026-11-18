// Captures every screen at 390px and 1280px, in light and dark, against a running build (npm run build, then npx vite preview --port 4173 in frontend/).
// Usage: node docs/audit/frontend-4f67bf4/capture.mjs [outDir]. BASE overrides the preview URL.
import { createRequire } from "node:module";
const { chromium } = createRequire(new URL("../../../frontend/", import.meta.url))("playwright");
const out = process.argv[2] || "docs/audit/frontend-4f67bf4";
const routes = ["/", "/bell", "/trade", "/activity", "/contracts", "/help", "/states"];
// Uses the HTTPS proxy when one is set (as in a cloud session), so the app can read the live testnets.
const b = await chromium.launch(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: "127.0.0.1,localhost" } } : {});
for (const [s, vp] of [["phone", { width: 390, height: 844 }], ["desktop", { width: 1280, height: 900 }]]) for (const scheme of ["light", "dark"]) {
  const ctx = await b.newContext({ viewport: vp, colorScheme: scheme, deviceScaleFactor: 1 });
  const p = await ctx.newPage(); const errs = [];
  p.on("pageerror", e => errs.push(e.message)); p.on("console", m => m.type() === "error" && errs.push(m.text()));
  for (const r of routes) {
    await p.goto("" + (process.env.BASE || "http://127.0.0.1:4173") + "/#" + r); await p.waitForTimeout(4000);
    const ov = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    const n = (r.replace(/\W+/g, "") || "landing") + `-${s}-${scheme}.png`;
    await p.screenshot({ path: `${out}/${n}`, fullPage: true });
    console.log(n, "overflow", ov);
  }
  if (errs.length) console.log(s, scheme, "errors:", [...new Set(errs)].slice(0, 5).join(" | "));
  await ctx.close();
}
await b.close();
