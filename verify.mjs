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
check("edits and commits KPIs", parseInt((await page.locator("#k_edits").innerText()).replace(/,/g, ""), 10) > 1000
  && parseInt(await page.locator("#k_commits").innerText(), 10) > 50);
const secOk = await page.evaluate(() => ["time", "inputs", "output", "outcome", "projects", "method"].every((id) => !!document.getElementById(id)));
check("section anchors", secOk);
check("monthly hours legend capped", (await count("#mleg .lg[data-s]:visible")) === 12);
check("monthly hours more toggle", (await page.locator("#mleg .lgmore").innerText()).includes("more"));
await click("#mleg .lgmore");
check("monthly hours: all series after more", (await count("#mleg .lg[data-s]:visible")) >= 20);
await click("#mleg .lgmore");
check("daily hours 90d", (await count("#hchart rect[data-s]")) > 50);
check("models per day", (await count("#dchart rect[data-s]")) > 50);
check("who is talking", (await count("#uchart rect")) > 20 && (await count("#uchart path")) === 1);
check("tokens grid", (await count("#tcal .cell:visible")) > 150);
check("rhythm grid", (await count("#rhy .cell")) === 168);
check("productivity map", (await count("#pchart circle")) > 10);
check("shipping map + funnel", (await count("#schart circle")) > 10 && (await count("#sfun .row")) > 5);
check("commits map", (await count("#cchart circle[data-s]:not([pointer-events])")) > 10);
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

// edit-path coverage strip: one group of bars per month, message record present in every month, ledger status text and header chip agree
const covSrcs = await page.locator("#pcov rect").evaluateAll((rs) => rs.map((r) => r.dataset.src));
check("edit-path coverage: message record every month", covSrcs.filter((s) => s === "Message record").length === (await count("#pcov text[text-anchor=middle]")) && covSrcs.length > 8);
const ledger = await page.evaluate(() => ({ lines: LEDGER.lines, stale: LEDGER.lines > 0 && LEDGER.last_edit - LEDGER.last > 864e5 }));
const pcsum = await page.locator("#pcsum").innerText();
check("edit-path coverage: ledger status", ledger.lines ? (ledger.stale ? pcsum.startsWith("Edit ledger stale") : /^Edit ledger live since \d{4}-\d{2}-\d{2}/.test(pcsum)) : pcsum.startsWith("Edit ledger inactive"), pcsum.slice(0, 120));
check("ledger chip shown only when inactive or stale", (await page.locator("#k_ledger").isVisible()) === (!ledger.lines || ledger.stale));
check("contribute button present but hidden in snapshot", (await count("#contrib")) === 1 && (await page.locator("#contrib").isHidden()));
check("contribute panel hidden in snapshot", (await count("#cpanel")) === 1 && (await page.locator("#cpanel").isHidden()));
check("insight chip hidden in snapshot", (await count("#k_share")) === 1 && (await page.locator("#k_share").isHidden()));

// global filters: window, session role, hide-small — every card must follow
const snap = async () => ({
  total: await page.locator("#k_total").innerText(), badge: await page.locator("#k_badge").innerText(),
  edits: await page.locator("#k_edits").innerText(), commitsK: await page.locator("#k_commits").innerText(),
  months: await count("#mchart rect[data-s]"), daily: await count("#hchart rect[data-s]"), models: await count("#dchart rect[data-s]"),
  prod: await count("#pchart circle"), ship: await count("#schart circle"), commits: await count("#cchart circle[data-s]:not([pointer-events])"),
  who: await count("#uchart rect"), tokens: await count("#tcal .cell:visible"), rows: await count("#tb tr"), csum: await page.locator("#csum").innerText(),
  cov: await count("#pcov rect"),
});
const all = await snap();
await click('#gwin [data-w="30"]'); const w30 = await snap();
check("30-day window changes KPIs", w30.total !== all.total && w30.badge !== all.badge && w30.edits !== all.edits);
check("30-day window moves every card", w30.months < all.months && w30.daily < all.daily && w30.models < all.models && w30.tokens < all.tokens && w30.commits <= all.commits && w30.cov < all.cov && w30.csum.includes("last 30 days"));
check("filter chip and reset shown", (await page.locator("#gchip").innerText()).includes("last 30 days") && (await page.locator("#greset").isVisible()));
await click('#gwin [data-w="7"]'); const w7 = await snap();
check("7-day window changes KPIs", w7.total !== w30.total && w7.badge !== w30.badge);
check("7-day chip", (await page.locator("#gchip").innerText()).includes("last 7 days"));
await click('#gwin [data-w="30"]');
await click("#prole [data-r=off]");
check("local build toggle visible when role is off", await page.locator("#pscope").isVisible());
await click('#grole [data-r="plan"]'); const plan = await snap();
check("plan-only scope changes hours and models", plan.total !== w30.total && plan.models !== w30.models);
check("local build toggle hidden under a global role", await page.locator("#pscope").isHidden());
await click("#greset");
await click("#prole [data-r=combo]"); const back = await snap();
check("reset restores everything", back.total === all.total && back.months === all.months && back.commits === all.commits && (await page.locator("#greset").isHidden()));
await click("#gsmall"); const small = await snap();
check("hide small entries", small.commits < all.commits && small.rows <= all.rows && (await page.locator("#gchip").innerText()).includes("small hidden")); await click("#gsmall");
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
await click("#cy [data-y=count]");
check("commits y-axis count", (await page.locator("#cchart text").evaluateAll((ts) => ts.map((t) => t.textContent))).includes("Commits attributed"));
await click("#crankm [data-rk=count]");
check("rank by commits shipped", (await page.locator("#crankt").innerText()) === "Commits shipped");
await click("#cy [data-y=lines]"); await click("#crankm [data-rk=hpc]");
const famLeg = await count("#dleg .lg");
await click("#dgroup [data-g=model]"); const modelLeg = await count("#dleg .lg");
await click("#dgroup [data-g=provider]"); const provLeg = await count("#dleg .lg");
check("models grouped by provider", provLeg < modelLeg && provLeg < 12, `family ${famLeg}, model ${modelLeg}, provider ${provLeg}`);
await click("#dgroup [data-g=family]");
await click("#pmetric [data-y=epd]"); check("edits per dollar view", (await page.locator("#psum").innerText()).includes("zero-cost")); await click("#pmetric [data-y=eph]");
await click("#theme"); check("theme toggle", (await page.locator("#theme").innerText()) === "Dark" || (await page.locator("#theme").innerText()) === "Light"); await click("#theme");
check("projects table merged columns", (await count("#lbt thead th")) === 16 && (await count("#tb tr")) >= 20);
const firstBefore = await page.locator("#tb tr").first().innerText();
await click("#lbt th.sortable[data-k='4']"); await click("#lbt th.sortable[data-k='4']");
check("table sorting", (await page.locator("#tb tr").first().innerText()) !== firstBefore);

// human turns to ship: strips by default, radar behind a toggle
check("turns strips", (await count("#tstrips circle[data-s]")) > 20);
check("turns defaults to relative", (await page.locator("#tscale [data-s=relative]").getAttribute("aria-pressed")) === "true");
await click("#tscale [data-s=minmax]");
await click("#torient [data-o=raw]");
const sLo = parseFloat(await page.locator('#tstrips text[data-tick="0-min"]').textContent()), sHi = parseFloat(await page.locator('#tstrips text[data-tick="0-max"]').textContent());
check("turns orientation raw", sLo < sHi);
await click("#torient [data-o=better]");
const bLo = parseFloat(await page.locator('#tstrips text[data-tick="0-min"]').textContent()), bHi = parseFloat(await page.locator('#tstrips text[data-tick="0-max"]').textContent());
const cLo = parseFloat(await page.locator('#tstrips text[data-tick="5-min"]').textContent()), cHi = parseFloat(await page.locator('#tstrips text[data-tick="5-max"]').textContent());
check("turns orientation better-right", bLo > bHi && cLo > cHi);
const evW = await page.locator('#tstrips text[data-tick="0-min"]').textContent();
await click("#tev [data-e=raw]");
check("turns evidence toggle", (await page.locator('#tstrips text[data-tick="0-min"]').textContent()) !== evW);
await click("#tev [data-e=weighted]");
check("turns weighted note", (await page.locator("#snote").innerText()).includes("k = 10"));
await click("#tscale [data-s=relative]");
check("turns relative ticks", (await count('#tstrips text[data-tick^="0-r"]')) >= 1 && (await page.locator('#tstrips text[data-tick="0-r0"]').textContent()) === "pool");
const poolRel = await count("#tstrips line[data-pool]");
await click("#tscale [data-s=minmax]");
const poolMin = await count("#tstrips line[data-pool]");
await click("#tscale [data-s=relative]");
check("turns pool lines", poolRel === 6 && poolMin === 0);
const emphs = await page.locator("#tstrips circle[data-s]").evaluateAll((cs) => cs.map((c) => parseFloat(c.style.opacity)));
check("turns emphasis by core", emphs.some((o) => o === 1) && emphs.some((o) => o < 0.5) && emphs.every((o) => o >= 0.28 && o <= 1));
await page.locator("#tstrips circle[data-s]").first().hover({ force: true }); await page.waitForTimeout(120);
check("turns connector lines", (await count("#tstrips path[data-line]")) >= 3 && (await count("#tstrips path.hot")) === 1);
await page.mouse.move(5, 5);
await click("#tview [data-v=radar]");
check("turns view toggle", await page.locator("#tradarw").isVisible() && await page.locator("#tstripsw").isHidden());
check("turns rank", (await count("#trank .row")) > 3);
check("turns radar", (await count("#rchart path[data-s]")) >= 3 && (await count("#rchart circle[data-s]")) >= 12);
check("turns table", (await count("#ttb tr")) > 3);
const tsum0 = await page.locator("#tsum").innerText();
await click("#tmetric [data-m=tpe10]");
check("turns metric toggle", (await page.locator("#tsum").innerText()) !== tsum0 && (await page.locator("#tsum").innerText()).includes("turns per 10 shipped edits"));
await click("#tmetric [data-m=tts]");
await click("#trole [data-r=off]"); await click("#trole [data-r=split]");
check("turns role split", (await count("#ttb tr")) > 0 && (await page.locator("#tsum").innerText()).includes("by phase"));
await click("#trole [data-r=combo]");
const tRows0 = await count("#ttb tr");
await click("#gsmall");
check("turns hide small", (await count("#ttb tr")) < tRows0);
await click("#gsmall");
const tsumAll = await page.locator("#tsum").innerText();
await click('#gwin [data-w="30"]');
check("turns card follows window", (await page.locator("#tsum").innerText()) !== tsumAll);
await click("#greset");
check("radar primary labels", (await count('#ochart text[font-weight="600"]')) === 2 && (await count('#rchart text[font-weight="600"]')) === 3 && (await count("#ochart path[data-sector]")) === 0 && (await count("#rchart path[data-sector]")) === 0);
check("turns core column", (await count("#ttable thead th")) === 13 && /\d/.test(await page.locator("#ttb tr td:nth-child(7)").first().innerText()));
const tJudged = await page.locator("#ttb tr td:nth-child(2)").evaluateAll((tds) => tds.map((t) => parseInt(t.innerText)));
check("turns default sort judged", tJudged.length > 3 && tJudged.every((v, i) => i === 0 || v <= tJudged[i - 1]));
check("turns KPI", (await page.locator(".kpis .ctitle").allInnerTexts()).includes("Human turns to ship") && /^\d+\.\d$/.test((await page.locator("#k_tts").innerText()).trim()));
check("human turn labels", (await page.locator("#pmetric [data-y=epp]").innerText()) === "Edits per your turn" && (await page.locator("#sx [data-x=pph]").innerText()) === "Turns per hour");
await click("#torient [data-o=raw]");
check("turns radar raw mode", (await page.locator("#rnote").innerText()).includes("mirrored so outward is more"));
await click("#torient [data-o=better]");

// cycles are the judged unit: more cycles than sessions, one session spans several,
// the KPI equals a recomputation from CYC, and the funnel follows the combo/off unit
const cyc = await page.evaluate(() => {
  const CC = {}; CYC_COLS.forEach((c, i) => CC[c] = i);
  const SC2 = {}; SESS_COLS.forEach((c, i) => SC2[c] = i);
  const per = {};
  CYC.forEach((c) => per[c[CC.sess]] = (per[c[CC.sess]] || 0) + 1);
  const j = CYC.filter((c) => !SESS[c[CC.sess]][SC2.child] && c[CC.a] > 0 && c[CC.tedits] > 0 && c[CC.tpaths]);
  const sh = j.filter((c) => c[CC.tship]);
  return { n: CYC.length, s: SESS.length, multi: Math.max(...Object.values(per)), kpi: (j.reduce((a, c) => a + c[CC.u], 0) / sh.length).toFixed(1) };
});
check("cycles dataset", cyc.n >= cyc.s && cyc.multi > 1, `${cyc.n} cycles, ${cyc.s} sessions, max ${cyc.multi}/session`);
check("KPI matches cycle recomputation", cyc.kpi === (await page.locator("#k_tts").innerText()).trim(), `page ${await page.locator("#k_tts").innerText()}, cyc ${cyc.kpi}`);
check("turns card counts cycles", (await page.locator("#tsum").innerText()).includes("judged cycles"));
check("funnel counts cycles in combo", (await page.locator("#sfund").innerText()).startsWith("Share of cycles"));
await click("#srole [data-r=off]");
check("funnel counts sessions when off", (await page.locator("#sfund").innerText()).startsWith("Share of sessions"));
await click("#srole [data-r=combo]");

// tooltips
await page.evaluate(() => document.getElementById("cchart").scrollIntoView({ block: "center" }));
await page.locator("#cchart circle[data-s]:not([pointer-events])").first().hover(); await page.waitForTimeout(120);
check("commit tooltip", (await page.locator("#tip").innerText()).includes("Hours per commit"));
await page.evaluate(() => document.getElementById("rchart").scrollIntoView({ block: "center" }));
await page.locator("#rchart circle[data-s]").first().hover({ force: true }); await page.waitForTimeout(120);
check("turns radar tooltip", (await page.locator("#tip").innerText()).includes("Turns to ship"));
await click("#tview [data-v=strips]");

// overall score card: same factory, nine axes in five tiers, ranked by score
const ov = await page.locator("#orank .row > span:last-child").evaluateAll((es) => es.map((e) => parseFloat(e.innerText)));
check("overall rank", ov.length > 3 && ov.every((v, i) => i === 0 || v <= ov[i - 1]));
check(
  "overall ranking floor",
  await page.evaluate(() => {
    const judged = {};
    document.querySelectorAll('#otb tr').forEach((tr) => {
      judged[tr.children[0].innerText] = parseInt(tr.children[1].innerText.replace(/,/g, ''));
    });
    const ranked = [...document.querySelectorAll('#orank .row .lab')].map((e) => e.innerText);
    return ranked.length > 0 && ranked.every((l) => judged[l] >= 10);
  }),
);
check("overall unranked dimmed", (await count("#otb tr[data-unr]")) > 0);
check("overall legend hidden in radar", await page.locator("#oleg").isHidden());
check("overall defaults to relative", (await page.locator("#oscale [data-s=relative]").getAttribute("aria-pressed")) === "true");
await page.locator("#orank .row").nth(0).click(); await page.waitForTimeout(150);
await page.locator("#orank .row").nth(1).click(); await page.waitForTimeout(150);
check("overall compare panel", (await page.locator("#ocomp").isVisible()) && (await count("#ocomp tbody tr")) === 17);
check("overall compare isolates two", await page.locator("#ochart").evaluate((el) => [...el.querySelectorAll("path[data-s]").values()].filter((p) => p.style.display !== "none").length) === 2);
await page.locator("#ocomp .lgreset").click(); await page.waitForTimeout(150);
check("overall compare clear", (await count("#ocomp tbody tr")) === 0);
await click("#oview [data-v=strips]");
check("overall strips", (await count("#ostrips line[data-pool]")) === 10);
await click("#oview [data-v=radar]");
check("overall radar", (await count("#ochart line")) === 10);
check("overall radar dir colours", (await count("#ochart text[data-dir=hi]")) === 4 && (await count("#ochart text[data-dir=lo]")) === 6 && ((await page.locator("#ochart text[data-dir=hi]").first().getAttribute("fill")) || "").includes("chart-2"));
check("radar dir blocks", (await count("#ochart path[data-bg]")) === 10 && (await count("#rchart path[data-bg]")) === 6 && (await page.locator("#ochart text[data-dir]").evaluateAll((ts) => ts.map((t) => t.dataset.dir).join(""))) === "hihihihilolololololo" && (await page.locator("#rchart text[data-dir]").evaluateAll((ts) => ts.map((t) => t.dataset.dir).join(""))) === "hihihihilolo" && (await page.locator("#ochart text[data-dir]").evaluateAll((ts) => ts.map((t) => t.textContent).join("|"))) === "Ship %|One-shot %|Verified %|Edits/turn|Time/step|Hours/ship|$/ship|Tool errors|Aborts|Turns/ship");
await click("#oview [data-v=strips]");
check("overall table", (await count("#otable thead th")) === 20);
const osum = await page.locator("#osum").innerText();
const wsum = ((osum.match(/weights ([\d/]+)/) || [, ""])[1]).split("/").filter(Boolean).map(Number);
check("overall weights sum to 100", wsum.length === 6 && wsum.reduce((a, b) => a + b, 0) === 100, osum.slice(0, 160));
check("overall pool scores 50", (await page.evaluate(() => window.__opoolScore)) === 50);
check("overall sensitivity line", /top-3 (stable|sensitive) to ±10 tier weights/.test(osum), osum.slice(0, 220));
const otiers = await page.locator("#otb tr").evaluateAll((rs) => rs.flatMap((r) => [...r.children].slice(4, 10).map((td) => td.innerText)));
check("overall tier scores in range", otiers.length > 0 && otiers.every((v) => /^\d+[*]?$/.test(v) && +v.replace("*", "") >= 0 && +v.replace("*", "") <= 100), otiers.slice(0, 8).join(","));
check("overall imputed tiers marked 50*", otiers.filter((v) => v.includes("*")).every((v) => v === "50*"));
const noCost = await page.locator("#otb tr").evaluateAll((rs) => rs.filter((r) => [...r.children][14].innerText === "—").map((r) => [...r.children][3].innerText));
check("overall zero-cost scored not dropped", noCost.length > 0 && noCost.every((v) => v !== "—"), noCost.join(",") || "no zero-cost group");
const noCostIdx = await page.locator("#otb tr").evaluateAll((rs) => rs.findIndex((r) => [...r.children][14].innerText === "—"));
if (noCostIdx >= 0) { await page.locator("#otb tr").nth(noCostIdx).hover(); await page.waitForTimeout(150); }
check("overall zero-cost flagged", noCostIdx < 0 || (await page.locator("#tip").innerText()).includes("cost unknown"));
await page.mouse.move(5, 5);
await click("#oev [data-e=raw]");
const zeroErr = await page.locator("#otb tr").evaluateAll((rs) => rs.filter((r) => [...r.children][15].innerText === "0.0%").map((r) => [...r.children][3].innerText + "/" + [...r.children][6].innerText));
check("overall zero-error scored best not dropped", zeroErr.length > 0 && zeroErr.every((v) => !v.startsWith("—")), zeroErr.join(",") || "no zero-error group");
await click("#oev [data-e=weighted]");
check("overall latency values", (await page.locator("#otb tr td:nth-child(20)").allInnerTexts()).some((v) => /^\d+\.\d$/.test(v)));
check("overall one-shot alive", (await page.locator("#otb tr td:nth-child(12)").allInnerTexts()).some((v) => v !== '0%' && v !== '—'));
check("no NaN in any table", !(await page.locator("tbody").allInnerTexts()).join(" ").includes("NaN"));
await page.mouse.move(5, 5); await page.keyboard.press("Escape");
check("escape hides tooltip", await page.locator("#tip").isHidden());
check("no console errors after interaction", errors.length === 0, errors.join(" | ").slice(0, 300));

await browser.close();
const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}${c.detail && !c.ok ? " — " + c.detail : ""}`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
