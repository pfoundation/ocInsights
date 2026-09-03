#!/usr/bin/env node
// Smoke-test a built deck in headless Chromium: zero console errors, every chart populated,
// every control responds, tooltips render. Usage: node verify.mjs [opencode_time_full.html]
// Needs playwright; falls back to the copy in the datastudio repo if none is installed here.
import path from "node:path";

const pw = await import("playwright").catch(() => import("/home/ubuntu/dev/datastudio/node_modules/playwright/index.mjs"));
const file = path.resolve(process.argv[2] ?? "opencode_time_full.html");
const browser = await pw.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await page.goto("file://" + file);
await page.waitForTimeout(700);

const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok: !!ok, detail }); };
const count = (sel) => page.locator(sel).count();
const click = async (sel) => { await page.locator(sel).first().click(); await page.waitForTimeout(150); };

check("no console errors", errors.length === 0, errors.join(" | ").slice(0, 300));
check("no unfilled placeholders", !(await page.content()).includes("@@"));
check("kpi cards", (await count(".kpi")) === 6, `${await count(".kpi")} found`);
check("monthly hours: 24 project series", (await count("#mleg .lg")) >= 20);
check("daily hours 90d", (await count("#hchart rect[data-s]")) > 50);
check("models per day", (await count("#dchart rect[data-s]")) > 50);
check("who is talking", (await count("#uchart rect")) > 20 && (await count("#uchart path")) === 1);
check("tokens grid", (await count("#tcal .cell:visible")) > 150);
check("rhythm grid", (await count("#rhy .cell")) === 168);
check("productivity map", (await count("#pchart circle")) > 10);
check("shipping map + funnel", (await count("#schart circle")) > 10 && (await count("#sfun .row")) > 5);
check("commits map", (await count("#cchart circle[data-s]:not([pointer-events])")) > 10);
check("commits by count", (await count("#c2chart circle[data-s]:not([pointer-events])")) > 10);

// file-overlap attribution: basis split reported, no-credit rows present, funnel ends in shipped
const csum = await page.locator("#csum").innerText();
check("commit attribution basis reported", /\d+ by files touched, \d+ by time/.test(csum), csum.slice(0, 160));
check("advised-only and manual rows", (await count("#crank .row.man")) === 2);
check("funnel last stage is shipped", (await page.locator("#sfun .fbar i").last().evaluate((e) => e.style.background)).includes("var(--primary)")
  && (await page.locator("#stable th").allInnerTexts()).some((t) => t.startsWith("Shipped")));
check("ship rate has judged and unjudged models", (await page.locator("#stb tr").evaluateAll((rs) => rs.map((r) => r.children[9].innerText))).some((v) => v.endsWith("%"))
  && (await page.locator("#stb tr").evaluateAll((rs) => rs.map((r) => r.children[9].innerText))).some((v) => v === "—"));

// controls
const before = await count("#cchart circle[data-s]:not([pointer-events])");
await click("#cmin"); check("hide under 5 commits", (await count("#cchart circle[data-s]:not([pointer-events])")) < before); await click("#cmin");
await click('#cwin [data-w="30"]'); check("30-day window", (await page.locator("#csum").innerText()).includes("last 30 days")); await click('#cwin [data-w="0"]');
await click("#crole [data-r=combo]"); check("planner→builder combos", (await count("#cchart circle[pointer-events=none]")) > 0); await click("#crole [data-r=off]");
await click("#dgroup [data-g=provider]"); check("models grouped by provider", (await count("#dleg .lg")) < 12); await click("#dgroup [data-g=model]");
await click("#pmetric [data-y=epd]"); check("edits per dollar view", (await page.locator("#psum").innerText()).includes("zero-cost")); await click("#pmetric [data-y=eph]");
await click("#theme"); check("theme toggle", (await page.locator("#theme").innerText()) === "Dark" || (await page.locator("#theme").innerText()) === "Light"); await click("#theme");
await click("#showall"); check("session depth show all", (await count("#db tr")) >= 20);
const firstBefore = await page.locator("#tb tr").first().innerText();
await click("#lbt th.sortable[data-k='4']"); await click("#lbt th.sortable[data-k='4']");
check("table sorting", (await page.locator("#tb tr").first().innerText()) !== firstBefore);

// tooltips
await page.evaluate(() => document.getElementById("cchart").scrollIntoView({ block: "center" }));
await page.locator("#cchart circle[data-s]:not([pointer-events])").first().hover(); await page.waitForTimeout(120);
check("commit tooltip", (await page.locator("#tip").innerText()).includes("Hours per commit"));
await page.mouse.move(5, 5); await page.keyboard.press("Escape");
check("escape hides tooltip", await page.locator("#tip").isHidden());
check("no console errors after interaction", errors.length === 0, errors.join(" | ").slice(0, 300));

await browser.close();
const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}${c.detail && !c.ok ? " — " + c.detail : ""}`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
