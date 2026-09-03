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
const staticHtml = (await import("node:fs")).readFileSync(file, "utf8");
await page.goto("file://" + file);
// the loader is removed by boot() after the first renderAll; waiting on it replaces a fixed sleep
let loaderGone = true;
await page.locator("#loading").waitFor({ state: "detached", timeout: 5000 }).catch(() => { loaderGone = false; });
await page.waitForTimeout(100);

const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok: !!ok, detail }); };
const count = (sel) => page.locator(sel).count();
const click = async (sel) => { await page.locator(sel).first().click(); await page.waitForTimeout(150); };

check("no console errors", errors.length === 0, errors.join(" | ").slice(0, 300));
check("loader in static markup", /<div id="loading"[^>]*>[\s\S]*?Loading [\d,]+ sessions/.test(staticHtml));
check("loader dismissed after first render", loaderGone);
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
check("defaults to family grouping", (await page.locator("#pgroup [data-g=family]").getAttribute("aria-pressed")) === "true"
  && (await page.locator("#dgroup [data-g=family]").getAttribute("aria-pressed")) === "true"
  && (await count("#dleg .lg")) < 15);
check("defaults to planner to builder combos", (await page.locator("#prole [data-r=combo]").getAttribute("aria-pressed")) === "true"
  && (await page.locator("#crole [data-r=combo]").getAttribute("aria-pressed")) === "true"
  && (await page.locator("#psum").innerText()).includes("pairs")
  && (await page.locator("#ctb tr td:first-child").first().innerText()).includes("→"));

// file-overlap attribution (off view): basis split reported, no-credit rows present, funnel ends in shipped
await click("#crole [data-r=off]");
const csum = await page.locator("#csum").innerText();
check("commit attribution basis reported", /\d+ by files touched, \d+ by time/.test(csum), csum.slice(0, 160));
check("advised-only and manual rows", (await count("#crank .row.man")) === 2);
await click("#crole [data-r=combo]");
check("funnel last stage is shipped", (await page.locator("#sfun .fbar i").last().evaluate((e) => e.style.background)).includes("var(--primary)")
  && (await page.locator("#stable th").allInnerTexts()).some((t) => t.startsWith("Shipped")));
check("ship rate has judged and unjudged models", (await page.locator("#stb tr").evaluateAll((rs) => rs.map((r) => r.children[9].innerText))).some((v) => v.endsWith("%"))
  && (await page.locator("#stb tr").evaluateAll((rs) => rs.map((r) => r.children[9].innerText))).some((v) => v === "—"));

// global filters: window, session role, hide-small — every card must follow
const snap = async () => ({
  total: await page.locator("#k_total").innerText(), badge: await page.locator("#k_badge").innerText(),
  months: await count("#mchart rect[data-s]"), daily: await count("#hchart rect[data-s]"), models: await count("#dchart rect[data-s]"),
  prod: await count("#pchart circle"), ship: await count("#schart circle"), commits: await count("#cchart circle[data-s]:not([pointer-events])"),
  who: await count("#uchart rect"), tokens: await count("#tcal .cell:visible"), rows: await count("#tb tr"), csum: await page.locator("#csum").innerText(),
});
const all = await snap();
await click('#gwin [data-w="30"]'); const w30 = await snap();
check("30-day window changes KPIs", w30.total !== all.total && w30.badge !== all.badge);
check("30-day window moves every card", w30.months < all.months && w30.daily < all.daily && w30.models < all.models && w30.tokens < all.tokens && w30.commits <= all.commits && w30.csum.includes("last 30 days"));
check("filter chip and reset shown", (await page.locator("#gchip").innerText()).includes("last 30 days") && (await page.locator("#greset").isVisible()));
await click("#prole [data-r=off]");
check("local build toggle visible when role is off", await page.locator("#pscope").isVisible());
await click('#grole [data-r="plan"]'); const plan = await snap();
check("plan-only scope changes hours and models", plan.total !== w30.total && plan.models !== w30.models);
check("local build toggle hidden under a global role", await page.locator("#pscope").isHidden());
await click("#greset");
await click("#prole [data-r=combo]"); const back = await snap();
check("reset restores everything", back.total === all.total && back.months === all.months && back.commits === all.commits && (await page.locator("#greset").isHidden()));
await click("#gsmall"); const small = await snap();
check("hide small entries", small.commits < all.commits && small.rows <= all.rows && (await page.locator("#gchip").innerText()).includes("small entries hidden")); await click("#gsmall");
await click("#mrole"); check("monthly hours stacked by role", (await page.locator("#mleg .lg").allInnerTexts()).join(" ").includes("build")); await click("#mrole");
const mRects = await count("#mchart rect[data-s]");
await click("#mmode"); check("monthly hours share view", (await page.locator("#mchart text").evaluateAll((ts) => ts.map((t) => t.textContent))).some((t) => t.endsWith("%")) && (await count("#mchart rect[data-s]")) === mRects); await click("#mmode");
const hRects = await count("#hchart rect[data-s]");
await click("#hmode"); check("daily hours share view", (await page.locator("#hchart text").evaluateAll((ts) => ts.map((t) => t.textContent))).some((t) => t.endsWith("%")) && (await count("#hchart rect[data-s]")) === hRects); await click("#hmode");
check("no console errors after global filters", errors.length === 0, errors.join(" | ").slice(0, 300));

// plan / build phases on the model cards (defaults are combo; cycle through every mode)
await click("#prole [data-r=off]"); check("productivity: off view", (await count("#pchart circle")) >= 10 && !(await page.locator("#psum").innerText()).includes("pairs"));
await click("#prole [data-r=split]"); check("productivity: plan vs build phases", (await count("#pchart circle[stroke-dasharray]")) > 5 && (await page.locator("#psum").innerText()).includes("by phase"));
await click("#prole [data-r=combo]"); check("productivity: planner→builder combos", (await count("#pchart circle[pointer-events=none]")) > 5 && (await page.locator("#pchart text.lbl").evaluateAll((ts) => ts.map((t) => t.textContent))).some((t) => t.includes("→")));
check("shipping: combos drive funnel and table by default", (await page.locator("#sfun .row .lab").first().innerText()).includes("→") && (await page.locator("#stb tr").first().innerText()).includes("→"));
await click("#srole [data-r=off]"); await click("#srole [data-r=split]"); await click("#srole [data-r=combo]");
await click('#grole [data-r="plan"]'); check("plan scope reports phase hours (~a third of all time)", parseFloat(await page.locator("#k_total").innerText()) > 200); await click("#greset");

// local controls (commit cards default to combo + family; cycle through every mode)
check("planner→builder combos", (await count("#cchart circle[pointer-events=none]")) > 0);
check("commit combos keep cross-model pairs (planner ≠ builder)", (await page.locator("#ctb tr td:first-child").allInnerTexts()).some((t) => { const [a, b] = t.split("→").map((s) => s.trim()); return a && b && a !== b; }));
check("commit combos cover most windows, not only separate plan sessions", parseInt((await page.locator("#csum").innerText()).match(/(\d+) commits/)[1]) > 300);
await click("#crole [data-r=off]"); await click("#crole [data-r=split]"); await click("#crole [data-r=combo]");
await click("#c2role [data-r=off]"); await click("#c2role [data-r=split]"); await click("#c2role [data-r=combo]");
const famLeg = await count("#dleg .lg");
await click("#dgroup [data-g=model]"); const modelLeg = await count("#dleg .lg");
await click("#dgroup [data-g=provider]"); const provLeg = await count("#dleg .lg");
check("models grouped by provider", provLeg < modelLeg && provLeg < 12, `family ${famLeg}, model ${modelLeg}, provider ${provLeg}`);
await click("#dgroup [data-g=family]");
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
