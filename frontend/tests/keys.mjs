// Keyboard-only pass: tab order on each screen, the sheet opens and closes with the keyboard and returns focus, and every
// focused control has a visible focus style.
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
const base = process.env.BASE || "http://localhost:4173";
const b = await chromium.launch();
const page = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
let bad = 0;
const fail = (m) => { bad++; console.log("FAIL", m); };
for (const r of ["/", "/bell", "/trade", "/activity", "/contracts", "/help", "/rounds", "/round/8643401"]) {
  await page.goto(base + "/#" + r);
  await page.waitForTimeout(2500);
  const seen = [];
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const e = document.activeElement;
      if (!e || e === document.body) return null;
      const cs = getComputedStyle(e);
      const wrap = e.closest(".bc-focus");
      const ws = wrap ? getComputedStyle(wrap) : null;
      const outlined = (ws && ws.filter !== "none") || (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== "none" || (ws && ws.boxShadow !== "none");
      const r = e.getBoundingClientRect();
      return { name: (e.getAttribute("aria-label") || e.textContent || e.tagName).trim().slice(0, 30), outlined, h: Math.round(r.height), w: Math.round(r.width), tag: e.tagName };
    });
    if (!info) continue;
    seen.push(info.name);
    if (!info.outlined) fail(`${r}: no visible focus on "${info.name}"`);
    if ((info.h < 44 || info.w < 44) && !["INPUT"].includes(info.tag)) console.log(`note ${r}: small target "${info.name}" ${info.w}x${info.h}`);
  }
  console.log(r, "tab stops:", seen.length, seen.slice(0, 8).join(" > "));
}
// connect sheet by keyboard
await page.goto(base + "/#/trade");
await page.waitForTimeout(1500);
const btn = page.getByRole("button", { name: /connect wallet/i }).first();
await btn.focus();
await page.keyboard.press("Enter");
await page.waitForTimeout(400);
if (!(await page.locator("dialog[open]").count())) fail("connect sheet did not open with Enter");
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
if (await page.locator("dialog[open]").count()) fail("sheet did not close with Escape");
const back = await page.evaluate(() => document.activeElement?.textContent?.trim());
if (!/connect/i.test(back || "")) fail(`focus did not return to the opener, it is on "${back}"`);
console.log(bad ? `${bad} failures` : "keyboard pass: ok");
await b.close();
process.exit(bad ? 1 : 0);
