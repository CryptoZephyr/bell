// RP-4 and RP-6: a skipped round shows its reason and no seconds, and a chain whose logs can't be read says
// "Payout times not readable" with no number. Unreadable logs are made by blocking eth_getLogs on one chain's RPC.
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
const base = process.env.BASE || "http://localhost:4173";
const b = await chromium.launch();
let bad = 0;
const check = (name, ok, extra = "") => { if (!ok) bad++; console.log(ok ? "ok  " : "FAIL", name, extra); };

// RP-6: Base logs blocked
{
  const page = await (await b.newContext({ viewport: { width: 390, height: 900 } })).newPage();
  await page.route("**/base-sepolia-rpc.publicnode.com/**", async (route) => {
    const body = route.request().postData() || "";
    if (body.includes("eth_getLogs")) return route.abort();
    return route.continue();
  });
  await page.goto(base + "/#/rounds");
  await page.waitForSelector(".round-row", { timeout: 40000 });
  await page.waitForTimeout(45000);
  const rows = await page.$$eval(".round-row", (a) => a.slice(0, 12).map((x) => ({ label: x.getAttribute("aria-label"), text: x.innerText.replace(/\n+/g, " | ") })));
  const unread = rows.filter((r) => /not readable/i.test(r.text));
  check("RP-6: rows touching Base say Payout times not readable", unread.length > 0, `${unread.length} of ${rows.length}`);
  check("RP-6: none of them shows a seconds number", unread.every((r) => !/paid out in \d/.test(r.label || "")), "");
  const strip = await page.$$eval(".strip-bar.none", (e) => e.length);
  console.log("   strip outline bars:", strip, "| sample:", unread[0]?.label);
  const summary = await page.$eval(".rounds-summary", (e) => e.innerText.replace(/\n+/g, " | ").slice(0, 200));
  console.log("   summary:", summary);
  // one detail page with Base blocked
  const href = await page.$eval(".round-row", (a) => a.getAttribute("href"));
  const href2 = await page.$$eval(".round-row", (a) => a.map((x) => x.getAttribute("href")));
  await page.goto(base + "/" + href2[1]);
  await page.waitForSelector(".round-hero", { timeout: 30000 });
  await page.waitForTimeout(20000);
  const detail = await page.$eval(".round-page", (e) => e.innerText.replace(/\n+/g, " | "));
  check("RP-6: detail says not readable, with n/a in place of a number", /not readable/i.test(detail) && /n\/a/.test(detail), detail.slice(0, 300));
  await page.screenshot({ path: "/tmp/rp/rp6-detail.png", fullPage: true });
  void href;
}

// RP-4: skipped round
{
  const page = await (await b.newContext({ viewport: { width: 390, height: 900 } })).newPage();
  await page.goto(base + "/#/rounds");
  await page.waitForSelector(".round-row", { timeout: 40000 });
  await page.getByRole("button", { name: /load older/i }).click();
  await page.waitForTimeout(15000);
  const skipped = await page.$$eval(".round-row", (a) => a.filter((x) => /skipped/i.test(x.getAttribute("aria-label") || "")).map((x) => ({ href: x.getAttribute("href"), label: x.getAttribute("aria-label"), text: x.innerText.replace(/\n+/g, " | ") })));
  check("RP-4: skipped rounds are listed", skipped.length >= 2, skipped.map((s) => s.label).join(" ; "));
  check("RP-4: no seconds on a skipped row", skipped.every((s) => !/\d\s*s\b/.test(s.text.replace(/\d{2}:\d{2}:\d{2}/g, "").replace(/\d+ bells/, ""))), skipped[0]?.text);
  await page.goto(base + "/" + skipped[0].href);
  await page.waitForSelector(".round-hero", { timeout: 30000 });
  await page.waitForTimeout(3000);
  const detail = await page.$eval(".round-page", (e) => e.innerText.replace(/\n+/g, " | "));
  check("RP-4: detail gives the reason and the bell transaction", /skipped/i.test(detail) && /drift guard/i.test(detail) && /0x[0-9a-f]{6}/i.test(detail), detail.slice(0, 260));
  await page.screenshot({ path: "/tmp/rp/rp4-detail.png", fullPage: true });
}
await b.close();
console.log(bad ? `${bad} failing` : "rounds states: all pass");
process.exit(bad ? 1 : 0);
