// Guards the no-terminal-output invariant: while running inside OpenCode the
// plugin must never write diagnostics to stdout/stderr (the host renders
// those into the TUI). Run: bun plugin/log-check.ts
// Also runs in `make check-logging`, `make publish-npm` and the release
// workflow.
//
// Every runtime case runs in an isolated subprocess with its own HOME (plus
// USERPROFILE for Windows path resolution), so no real contributor files are
// touched and no network leaves the machine (the contribution endpoint is a
// local stub). Uses only node: builtins.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BASE = mkdtempSync(join(tmpdir(), "ocinsights-log-check-"));
const BUN = process.execPath;

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string, extra = ""): void {
  if (cond) {
    pass++;
    console.log(`ok   ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

type RunOut = { out: string; err: string; status: number | null };
function run(
  file: string,
  args: string[],
  env: Record<string, string | undefined>,
  timeoutMs = 60000,
): RunOut {
  const clean: Record<string, string> = { ...process.env } as Record<
    string,
    string
  >;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete clean[k];
    else clean[k] = v;
  }
  const r = spawnSync(BUN, [file, ...args], {
    env: clean,
    timeout: timeoutMs,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return {
    out: (r.stdout ?? "").toString(),
    err: (r.stderr ?? "").toString(),
    status: r.status,
  };
}

function caseDir(name: string): { d: string; home: string } {
  const d = join(BASE, name);
  mkdirSync(d, { recursive: true });
  return { d, home: join(d, "home") };
}

function homeEnv(home: string): Record<string, string> {
  return { HOME: home, USERPROFILE: home };
}

function writeProbe(d: string, code: string): string {
  const p = join(d, "probe.ts");
  writeFileSync(p, code);
  return p;
}

function logPath(home: string): string {
  return join(home, ".local", "share", "ocInsights", "logs", "plugin.log");
}

function logLines(home: string): string[] {
  const f = logPath(home);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
}

function hasLine(lines: string[], sub: string): boolean {
  return lines.some((l) => l.includes(sub));
}

function allJsonService(lines: string[]): boolean {
  return lines.every((l) => {
    try {
      const o = JSON.parse(l) as Record<string, unknown>;
      return (
        o.service === "oc.insights" &&
        typeof o.time === "string" &&
        typeof o.level === "string" &&
        typeof o.message === "string"
      );
    } catch {
      return false;
    }
  });
}

// --- 0. static guard: no console/stdout writes in runtime modules -----------
{
  // Standalone entrypoints that intentionally print; everything else must go
  // through plugin/log.ts.
  const ALLOW = new Set([
    "cli.ts",
    "serve.ts",
    "smoke.ts",
    "shim-check.ts",
    "log-check.ts",
  ]);
  const CONSOLE_RE = /console\.\w+\s*\(/;
  const STDIO_RE = /process\.(stdout|stderr)\b/;
  const files: string[] = [join(ROOT, "index.ts"), join(ROOT, "tui.ts")];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name)) files.push(p);
    }
  };
  walk(join(ROOT, "plugin"));
  const bad: string[] = [];
  for (const f of files) {
    const base = f.split("/").pop()!;
    if (ALLOW.has(base)) continue;
    readFileSync(f, "utf8")
      .split("\n")
      .forEach((line, i) => {
        const code = line.replace(/^\s*\/\/.*$/, "");
        if (CONSOLE_RE.test(code) || STDIO_RE.test(code)) {
          bad.push(`${base}:${i + 1}: ${code.trim().slice(0, 80)}`);
        }
      });
  }
  ok(
    bad.length === 0,
    "static: no console/stdout in runtime modules",
    bad.join("; "),
  );
}

// --- 1. importing the entries is silent and side-effect free ---------------
{
  const { d, home } = caseDir("import");
  const p = writeProbe(
    d,
    `await import(${JSON.stringify(join(ROOT, "index.ts"))});
await import(${JSON.stringify(join(ROOT, "tui.ts"))});
await import(${JSON.stringify(join(ROOT, "plugin", "rpc.ts"))});
`,
  );
  const r = run(p, [], homeEnv(home));
  ok(
    r.status === 0 && r.out === "" && r.err === "",
    "import: silent stdio",
    `status=${r.status} out=${JSON.stringify(r.out.slice(0, 120))} err=${JSON.stringify(r.err.slice(0, 200))}`,
  );
  ok(!existsSync(home), "import: creates no files when nothing to migrate");
}

// --- 2. legacy migration is silent and preserves the contributor -----------
{
  const { d, home } = caseDir("migrate");
  const oldDir = join(home, ".local", "share", "ocProductivity");
  mkdirSync(oldDir, { recursive: true });
  const contrib =
    '{"install":"11111111-2222-3333-4444-555555555555","enabled":false}';
  writeFileSync(join(oldDir, "contributor.json"), contrib);
  const p = writeProbe(
    d,
    `await import(${JSON.stringify(join(ROOT, "index.ts"))});\n`,
  );
  const r = run(p, [], homeEnv(home));
  ok(
    r.status === 0 && r.out === "" && r.err === "",
    "migrate: silent stdio",
    `status=${r.status} err=${JSON.stringify(r.err.slice(0, 200))}`,
  );
  const kept = join(home, ".local", "share", "ocInsights", "contributor.json");
  ok(
    existsSync(kept) && readFileSync(kept, "utf8") === contrib,
    "migrate: contributor UUID and opt-out preserved",
  );
  ok(!existsSync(oldDir), "migrate: old dir renamed away");
  ok(
    hasLine(logLines(home), "migrated") && allJsonService(logLines(home)),
    "migrate: buffered line flushed to the new log",
  );
}

// --- 3. v1 server(): normal bind -------------------------------------------
{
  const { d, home } = caseDir("v1");
  const p = writeProbe(
    d,
    `const { default: def } = await import(${JSON.stringify(join(ROOT, "index.ts"))});
const { stopServer } = await import(${JSON.stringify(join(ROOT, "plugin", "server.ts"))});
const hooks = await def.server({ directory: ${JSON.stringify(d)} }, { port: 0 });
if (typeof hooks["tool.execute.after"] !== "function") throw new Error("no after hook");
if (typeof hooks.event !== "function") throw new Error("no event hook");
await stopServer();
`,
  );
  const r = run(p, [], homeEnv(home));
  ok(
    r.status === 0 && r.out === "" && r.err === "",
    "v1: silent stdio",
    `status=${r.status} err=${JSON.stringify(r.err.slice(0, 300))}`,
  );
  const lines = logLines(home);
  ok(
    hasLine(lines, "contributions on (source: file)") &&
      hasLine(lines, "listening on http://127.0.0.1:") &&
      allJsonService(lines),
    "v1: startup diagnostics in the log file",
  );
}

// --- 4. v1 server(): occupied port ------------------------------------------
{
  const { d, home } = caseDir("v1busy");
  const p = writeProbe(
    d,
    `import { createServer } from "node:http";
const held = createServer(() => {});
await new Promise<void>((res) => held.listen(0, "127.0.0.1", res));
const port = (held.address() as { port: number }).port;
const { default: def } = await import(${JSON.stringify(join(ROOT, "index.ts"))});
await def.server({ directory: ${JSON.stringify(d)} }, { port });
await new Promise<void>((res, rej) => held.close((e) => (e ? rej(e) : res())));
`,
  );
  const r = run(p, [], homeEnv(home));
  ok(
    r.status === 0 && r.out === "" && r.err === "",
    "v1busy: silent stdio",
    `status=${r.status} err=${JSON.stringify(r.err.slice(0, 300))}`,
  );
  ok(
    hasLine(logLines(home), "already bound, reusing"),
    "v1busy: reuse notice in the log file",
  );
}

// --- 5. v2 setup(): normal + failure branches --------------------------------
const V2_PREAMBLE = `
const idx = await import(IDX);
const { stopServer } = await import(SRV);
const seen = { tool: "", rpc: "", handlers: null as unknown };
const toolFake = {
  hook: async () => ({ dispose: () => {} }),
  transform: async (cb: (ed: { add: (t: { name: string }) => void }) => void) => {
    cb({ add: (t) => { seen.tool = t.name; } });
    return { dispose: () => {} };
  },
  reload: async () => {},
};
const rpcFake = {
  register: async (def: { id: string }, handlers: unknown) => {
    seen.rpc = def.id; seen.handlers = handlers;
    return { events: { emit: EMIT }, dispose: () => {} };
  },
};
`;
function v2Probe(emit: string, body: string): string {
  return (
    V2_PREAMBLE.replace("IDX", JSON.stringify(join(ROOT, "index.ts")))
      .replace("SRV", JSON.stringify(join(ROOT, "plugin", "server.ts")))
      .replace("EMIT", emit) +
    body +
    `
await stopServer();
await import("node:fs").then(({ writeFileSync }) =>
  writeFileSync(OUT, JSON.stringify({ tool: seen.tool, rpc: seen.rpc })),
);
`.replace("OUT", JSON.stringify("OUTFILE"))
  );
}
{
  const { d, home } = caseDir("v2");
  const outFile = join(d, "seen.json");
  const p = writeProbe(
    d,
    v2Probe(
      "async () => {}",
      `
const dispose = await idx.default.setup({
  options: { port: 0 },
  location: { directory: ${JSON.stringify(d)} },
  tool: toolFake,
  rpc: rpcFake,
});
dispose();
`,
    ).replace("OUTFILE", outFile),
  );
  const r = run(p, [], homeEnv(home));
  ok(
    r.status === 0 && r.out === "" && r.err === "",
    "v2: silent stdio",
    `status=${r.status} err=${JSON.stringify(r.err.slice(0, 300))}`,
  );
  const lines = logLines(home);
  ok(
    hasLine(lines, "contributions on (source: file)") && allJsonService(lines),
    "v2: startup diagnostics in the log file",
  );
  const seen = JSON.parse(readFileSync(outFile, "utf8")) as {
    tool: string;
    rpc: string;
  };
  ok(
    seen.tool === "insights_contribute" && seen.rpc === "ocInsights",
    "v2: tool and rpc still register",
    JSON.stringify(seen),
  );
}
{
  // tool.transform throws: setup survives, scheduler still starts.
  const { d, home } = caseDir("v2toolfail");
  const outFile = join(d, "seen.json");
  const p = writeProbe(
    d,
    v2Probe(
      "async () => {}",
      `
toolFake.transform = async () => { throw new Error("boom-tool"); };
const dispose = await idx.default.setup({
  options: { port: 0 },
  location: { directory: ${JSON.stringify(d)} },
  tool: toolFake,
  rpc: rpcFake,
});
dispose();
`,
    ).replace("OUTFILE", outFile),
  );
  const r = run(p, [], homeEnv(home));
  ok(
    r.status === 0 && r.out === "" && r.err === "",
    "v2toolfail: silent stdio",
    `status=${r.status} err=${JSON.stringify(r.err.slice(0, 300))}`,
  );
  ok(
    hasLine(logLines(home), "tool register failed"),
    "v2toolfail: failure in the log file",
  );
}
{
  // rpc.register throws.
  const { d, home } = caseDir("v2rpcfail");
  const outFile = join(d, "seen.json");
  const p = writeProbe(
    d,
    v2Probe(
      "async () => {}",
      `
rpcFake.register = async () => { throw new Error("boom-rpc"); };
const dispose = await idx.default.setup({
  options: { port: 0 },
  location: { directory: ${JSON.stringify(d)} },
  tool: toolFake,
  rpc: rpcFake,
});
dispose();
`,
    ).replace("OUTFILE", outFile),
  );
  const r = run(p, [], homeEnv(home));
  ok(
    r.status === 0 && r.out === "" && r.err === "",
    "v2rpcfail: silent stdio",
    `status=${r.status} err=${JSON.stringify(r.err.slice(0, 300))}`,
  );
  ok(
    hasLine(logLines(home), "rpc register failed"),
    "v2rpcfail: failure in the log file",
  );
}
{
  // events.emit throws: exercises safeEmit via setContribute.
  const { d, home } = caseDir("v2emitfail");
  const outFile = join(d, "seen.json");
  const p = writeProbe(
    d,
    v2Probe(
      "async () => { throw new Error('boom-emit'); }",
      `
const dispose = await idx.default.setup({
  options: { port: 0 },
  location: { directory: ${JSON.stringify(d)} },
  tool: toolFake,
  rpc: rpcFake,
});
const h = seen.handlers as { setContribute: (i: unknown) => Promise<unknown> };
await h.setContribute({ enabled: false });
dispose();
`,
    ).replace("OUTFILE", outFile),
  );
  const r = run(p, [], homeEnv(home));
  ok(
    r.status === 0 && r.out === "" && r.err === "",
    "v2emitfail: silent stdio",
    `status=${r.status} err=${JSON.stringify(r.err.slice(0, 300))}`,
  );
  ok(
    hasLine(logLines(home), "event emit failed"),
    "v2emitfail: failure in the log file",
  );
}

// --- 6. scheduler branches (local stub endpoint, no network) -------------------
function contribFixture(): Record<string, unknown> {
  return {
    SESS_COLS: ["day", "role", "child", "model", "prov", "variant", "ocv"],
    CYC_COLS: [
      "sess",
      "i",
      "u",
      "a",
      "tedits",
      "tpaths",
      "teerr",
      "tcost",
      "tship",
      "thrs",
      "tver",
      "tabort",
      "latmed",
      "tshipe",
      "pm",
      "pp",
      "pv",
      "bm",
      "bp",
      "bv",
    ],
    SESS: [["2026-09-01", 1, 0, 0, 0, 0, 0]],
    CYC: [
      [0, 0, 3, 5, 12, 1, 0, 1.5, 1, 0.5, 1, 0, 45.2, 0, -1, -1, -1, 0, 0, 0],
    ],
    SESS_KEY: ["abc123"],
    IDX: {
      model: ["test-model"],
      prov: ["test-prov"],
      variant: ["default"],
      ocv: ["1.18"],
    },
    meta: { generated: "2026-09-07T00:00:00Z", sessions: 1 },
  };
}
function seedContrib(home: string): void {
  const share = join(home, ".local", "share", "ocInsights");
  mkdirSync(share, { recursive: true });
  writeFileSync(
    join(share, "contributor.json"),
    JSON.stringify({
      install: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      enabled: true,
    }),
  );
  writeFileSync(
    join(share, "contributed.json"),
    JSON.stringify({
      schema: 3,
      extractor: "test",
      url: "http://127.0.0.1:9/none",
      generated: "2026-01-01T00:00:00Z",
      lastSent: new Date(Date.now() - 8 * 3600 * 1000).toISOString(),
      lastFail: null,
      rows: {},
    }),
  );
  writeFileSync(join(share, "data.json"), JSON.stringify(contribFixture()));
}
function schedProbe(opts: {
  stub: string; // "ok" | "bad" | "down"
  activity: boolean;
  waitMs: number;
}): string {
  return `import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
const posts = [];
let target = "";
if (${JSON.stringify(opts.stub)} !== "down") {
  const stub = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => { b += c; });
    req.on("end", () => {
      posts.push(b);
      if (${JSON.stringify(opts.stub)} === "ok") {
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ snapshot: "snap-1" }));
      } else {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "bad-shape" }));
      }
    });
  });
  await new Promise((res) => stub.listen(0, "127.0.0.1", () => res(0)));
  const port = (stub.address()).port;
  target = "http://127.0.0.1:" + port + "/v1/contribute";
  process.env.OC_INSIGHTS_CONTRIB_URL = target;
} else {
  const tmp = createServer(() => {});
  await new Promise((res) => tmp.listen(0, "127.0.0.1", () => res(0)));
  const port = (tmp.address()).port;
  await new Promise((res, rej) => tmp.close((e) => (e ? rej(e) : res(0))));
  process.env.OC_INSIGHTS_CONTRIB_URL = "http://127.0.0.1:" + port + "/v1/contribute";
}
const sch = await import(${JSON.stringify(join(ROOT, "plugin", "scheduler.ts"))});
if (${opts.activity ? "true" : "false"}) sch.noteActivity("session.tool.update");
const stop = sch.startScheduler({ emit: async () => {}, tickMs: 100 });
await new Promise((r) => setTimeout(r, ${opts.waitMs}));
stop();
writeFileSync(process.argv[2], JSON.stringify({ posts: posts.length, body: posts[0] ?? "" }));
process.exit(0);
`;
}
{
  const { d, home } = caseDir("schedquiet");
  seedContrib(home);
  const res = join(d, "result.json");
  const p = writeProbe(
    d,
    schedProbe({ stub: "ok", activity: true, waitMs: 500 }),
  );
  const r = run(p, [res], homeEnv(home));
  ok(
    r.status === 0 && r.out === "" && r.err === "",
    "schedquiet: silent stdio",
    `status=${r.status} err=${JSON.stringify(r.err.slice(0, 300))}`,
  );
  const got = JSON.parse(readFileSync(res, "utf8")) as {
    posts: number;
  };
  ok(
    hasLine(logLines(home), "waiting for a quiet moment") && got.posts === 0,
    "schedquiet: waits without sending",
  );
}
{
  const { d, home } = caseDir("schedsend");
  seedContrib(home);
  const res = join(d, "result.json");
  const p = writeProbe(
    d,
    schedProbe({ stub: "ok", activity: false, waitMs: 800 }),
  );
  const r = run(p, [res], homeEnv(home));
  ok(
    r.status === 0 && r.out === "" && r.err === "",
    "schedsend: silent stdio",
    `status=${r.status} err=${JSON.stringify(r.err.slice(0, 300))}`,
  );
  const got = JSON.parse(readFileSync(res, "utf8")) as {
    posts: number;
    body: string;
  };
  const sent = JSON.parse(got.body || "{}") as { rows?: unknown[] };
  ok(
    hasLine(logLines(home), "contributed 1 of 1 cycles, snapshot snap-1") &&
      got.posts === 1 &&
      sent.rows?.length === 1,
    "schedsend: posts one changed row, logs it",
  );
  const after = JSON.parse(
    readFileSync(
      join(home, ".local", "share", "ocInsights", "contributed.json"),
      "utf8",
    ),
  ) as { lastSent: string; rows: Record<string, string> };
  ok(
    Date.now() - Date.parse(after.lastSent) < 60_000 &&
      Object.keys(after.rows).length === 1,
    "schedsend: send recorded for the diff",
  );
}
{
  const { d, home } = caseDir("schedpark");
  seedContrib(home);
  const res = join(d, "result.json");
  const p = writeProbe(
    d,
    schedProbe({ stub: "bad", activity: false, waitMs: 700 }),
  );
  const r = run(p, [res], homeEnv(home));
  ok(
    r.status === 0 && r.out === "" && r.err === "",
    "schedpark: silent stdio",
    `status=${r.status} err=${JSON.stringify(r.err.slice(0, 300))}`,
  );
  const got = JSON.parse(readFileSync(res, "utf8")) as { posts: number };
  ok(
    hasLine(logLines(home), "parked until restart") && got.posts === 1,
    "schedpark: 400 parks after one attempt",
  );
}
{
  const { d, home } = caseDir("schedfail");
  seedContrib(home);
  const res = join(d, "result.json");
  const p = writeProbe(
    d,
    schedProbe({ stub: "down", activity: false, waitMs: 2500 }),
  );
  const r = run(p, [res], homeEnv(home), 30000);
  ok(
    r.status === 0 && r.out === "" && r.err === "",
    "schedfail: silent stdio",
    `status=${r.status} err=${JSON.stringify(r.err.slice(0, 300))}`,
  );
  ok(
    hasLine(logLines(home), "contribute failed"),
    "schedfail: network failure in the log file",
  );
  const after = JSON.parse(
    readFileSync(
      join(home, ".local", "share", "ocInsights", "contributed.json"),
      "utf8",
    ),
  ) as { lastFail: string | null };
  ok(after.lastFail !== null, "schedfail: backoff recorded");
}

// --- 7. extract branches ----------------------------------------------------
function fixtureDb(path: string, wt: string): void {
  // Log-check runs under bun, so bun:sqlite is available.
  const db = new Database(path);
  db.exec(`CREATE TABLE project (id INTEGER PRIMARY KEY, worktree TEXT);
CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id INTEGER, agent TEXT,
  parent_id TEXT, cost REAL, tokens_input INTEGER, tokens_output INTEGER,
  tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER,
  summary_additions INTEGER, summary_deletions INTEGER, model TEXT,
  time_created INTEGER, directory TEXT, version TEXT);
CREATE TABLE session_message (id INTEGER PRIMARY KEY, session_id TEXT,
  type TEXT, data TEXT, time_created INTEGER);
CREATE TABLE part (session_id TEXT, time_created INTEGER, data TEXT);`);
  const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);
  db.query("INSERT INTO project (id, worktree) VALUES (1, ?)").run(wt);
  db.query(
    `INSERT INTO session_v2 (id, project_id, agent, parent_id, cost,
    tokens_input, tokens_output, tokens_reasoning, tokens_cache_read,
    tokens_cache_write, summary_additions, summary_deletions, model,
    time_created, directory, version)
    VALUES ('ses_test', 1, 'build', NULL, 0, 10, 5, 0, 0, 0, NULL, NULL,
    '{"id":"test-model","variant":"default"}', ${T0}, '${wt}', '1.18.21')`,
  ).run();
  db.query(
    "INSERT INTO session_message (session_id, type, data, time_created) VALUES ('ses_test', 'user', '{}', ?)",
  ).run(T0);
  db.query(
    "INSERT INTO session_message (session_id, type, data, time_created) VALUES ('ses_test', 'assistant', ?, ?)",
  ).run(
    '{"agent":"build","model":{"id":"test-model","providerID":"test-prov"},"parts":[]}',
    T0 + 1000,
  );
  db.close();
}
{
  // Failure: empty database file, tables missing.
  const { d, home } = caseDir("extractfail");
  const p = writeProbe(
    d,
    `const { getData } = await import(${JSON.stringify(join(ROOT, "plugin", "extract.ts"))});
let threw = "";
try {
  await getData(true);
} catch (e) {
  threw = e instanceof Error ? e.message : String(e);
}
if (!threw) throw new Error("expected extract to fail");
`,
  );
  const r = run(p, [], {
    ...homeEnv(home),
    OC_DB: join(d, "missing.db"),
    OC_INSIGHTS_CACHE: join(d, "data.json"),
  });
  ok(
    r.status === 0 && r.out === "" && r.err === "",
    "extractfail: silent stdio",
    `status=${r.status} err=${JSON.stringify(r.err.slice(0, 300))}`,
  );
  ok(
    hasLine(logLines(home), "extract failed"),
    "extractfail: failure in the log file",
  );
}
{
  // Success through the Bun Worker on a fixture database.
  const { d, home } = caseDir("extractok");
  const wt = join(d, "wt");
  const emptyRoot = join(d, "devroot");
  mkdirSync(wt, { recursive: true });
  mkdirSync(emptyRoot, { recursive: true });
  fixtureDb(join(d, "fix.db"), wt);
  const outFile = join(d, "data.json");
  const p = writeProbe(
    d,
    `const { getData } = await import(${JSON.stringify(join(ROOT, "plugin", "extract.ts"))});
const data = await getData(true);
const meta = data.meta as { sessions?: number };
if (meta.sessions !== 1) throw new Error("expected 1 session, got " + meta.sessions);
`,
  );
  const r = run(p, [], {
    ...homeEnv(home),
    OC_DB: join(d, "fix.db"),
    OC_DEV_ROOT: emptyRoot,
    OC_INSIGHTS_CACHE: outFile,
  });
  ok(
    r.status === 0 && r.out === "" && r.err === "",
    "extractok: silent stdio",
    `status=${r.status} err=${JSON.stringify(r.err.slice(0, 400))}`,
  );
  const lines = logLines(home);
  ok(
    hasLine(lines, "extract done in ") &&
      hasLine(lines, "sessions") &&
      allJsonService(lines),
    "extractok: completion + summary in the log file",
  );
  ok(existsSync(outFile), "extractok: cache written");
}
{
  // Worker unloadable: warns, falls back to the subprocess, stays silent.
  const { d, home } = caseDir("extractfallback");
  const wt = join(d, "wt");
  const emptyRoot = join(d, "devroot");
  mkdirSync(wt, { recursive: true });
  mkdirSync(emptyRoot, { recursive: true });
  fixtureDb(join(d, "fix.db"), wt);
  const outFile = join(d, "data.json");
  const worker = join(ROOT, "plugin", "metrics", "worker.ts");
  const hidden = `${worker}.hidden-log-check`;
  const p = writeProbe(
    d,
    `import { renameSync } from "node:fs";
renameSync(${JSON.stringify(worker)}, ${JSON.stringify(hidden)});
try {
  const { getData } = await import(${JSON.stringify(join(ROOT, "plugin", "extract.ts"))});
  const data = await getData(true);
  const meta = data.meta as { sessions?: number };
  if (meta.sessions !== 1) throw new Error("expected 1 session");
} finally {
  renameSync(${JSON.stringify(hidden)}, ${JSON.stringify(worker)});
}
`,
  );
  const r = run(p, [], {
    ...homeEnv(home),
    OC_DB: join(d, "fix.db"),
    OC_DEV_ROOT: emptyRoot,
    OC_INSIGHTS_CACHE: outFile,
  });
  if (!existsSync(worker) && existsSync(hidden)) {
    // Probe died mid-flight: restore unconditionally so the tree is intact.
    renameSync(hidden, worker);
  }
  ok(
    r.status === 0 && r.out === "" && r.err === "",
    "extractfallback: silent stdio",
    `status=${r.status} err=${JSON.stringify(r.err.slice(0, 400))}`,
  );
  ok(
    hasLine(logLines(home), "falling back to bun subprocess") &&
      existsSync(outFile),
    "extractfallback: warns, still produces the cache",
  );
  ok(
    existsSync(worker) && !existsSync(hidden),
    "extractfallback: worker.ts restored",
  );
}

// --- 8. logger units: levels, rotation, locks, unwritable dirs --------------
{
  const { d } = caseDir("levels");
  const p = writeProbe(
    d,
    `const { configureLog, log } = await import(${JSON.stringify(join(ROOT, "plugin", "log.ts"))});
configureLog({ dir: process.argv[2] });
log.debug("dbg"); log.info("inf"); log.warn("wrn"); log.error("err");
`,
  );
  const dir = join(d, "logs");
  let r = run(p, [dir], { OC_INSIGHTS_LOG_LEVEL: "error" });
  let lines = existsSync(join(dir, "plugin.log"))
    ? readFileSync(join(dir, "plugin.log"), "utf8").split("\n").filter(Boolean)
    : [];
  ok(
    r.status === 0 &&
      r.out === "" &&
      r.err === "" &&
      lines.length === 1 &&
      lines[0].includes('"err"'),
    "levels: error-only keeps one record",
  );
  rmSync(dir, { recursive: true, force: true });
  r = run(p, [dir], { OC_INSIGHTS_LOG_LEVEL: "off" });
  ok(
    r.status === 0 && !existsSync(join(dir, "plugin.log")),
    "levels: off writes nothing",
  );
  r = run(p, [dir], { OC_INSIGHTS_LOG_LEVEL: "bogus" });
  lines = readFileSync(join(dir, "plugin.log"), "utf8")
    .split("\n")
    .filter(Boolean);
  ok(
    r.status === 0 &&
      lines.length === 3 &&
      !lines.some((l) => l.includes('"dbg"')),
    "levels: invalid value falls back to info",
  );
}
{
  // Rotation at 1 MiB keeps every record across plugin.log + plugin.log.1.
  const { d } = caseDir("rotate");
  const dir = join(d, "logs");
  const p = writeProbe(
    d,
    `const { configureLog, log } = await import(${JSON.stringify(join(ROOT, "plugin", "log.ts"))});
configureLog({ dir: process.argv[2], level: "info" });
const pad = "x".repeat(900);
for (let i = 0; i < 1200; i++) log.info("rec-" + i + "-" + pad);
`,
  );
  const r = run(p, [dir], {});
  const f1 = join(dir, "plugin.log");
  const f2 = join(dir, "plugin.log.1");
  const n =
    (existsSync(f1)
      ? readFileSync(f1, "utf8").split("\n").filter(Boolean).length
      : 0) +
    (existsSync(f2)
      ? readFileSync(f2, "utf8").split("\n").filter(Boolean).length
      : 0);
  ok(
    r.status === 0 &&
      r.out === "" &&
      r.err === "" &&
      existsSync(f1) &&
      existsSync(f2) &&
      n === 1200,
    "rotate: 1 MiB rolls to one backup without loss",
    `n=${n}`,
  );
}
{
  // Stale lock is stolen (rotation proceeds); fresh lock is respected.
  const { d } = caseDir("locks");
  const dir = join(d, "logs");
  mkdirSync(dir, { recursive: true });
  const big = "y".repeat(1100);
  const p = writeProbe(
    d,
    `import { writeFileSync } from "node:fs";
const { configureLog, log } = await import(${JSON.stringify(join(ROOT, "plugin", "log.ts"))});
configureLog({ dir: process.argv[2], level: "info" });
for (let i = 0; i < 1100; i++) log.info("fill-" + i + "-" + ${JSON.stringify(big)});
log.info("trigger-rotation");
`,
  );
  // Stale lock: rotation must still happen.
  writeFileSync(join(dir, ".plugin.log.lock"), `999999:${Date.now() - 60000}`);
  let r = run(p, [dir], {});
  ok(
    r.status === 0 &&
      existsSync(join(dir, "plugin.log.1")) &&
      !existsSync(join(dir, ".plugin.log.lock")),
    "locks: stale lock stolen, backup written, lock released",
    `status=${r.status} err=${JSON.stringify(r.err.slice(0, 200))}`,
  );
  // Fresh lock: rotation skipped, append continues, lock untouched.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".plugin.log.lock"), `999999:${Date.now()}`);
  r = run(p, [dir], {});
  const main = existsSync(join(dir, "plugin.log"))
    ? readFileSync(join(dir, "plugin.log"), "utf8")
    : "";
  ok(
    r.status === 0 &&
      !existsSync(join(dir, "plugin.log.1")) &&
      main.includes("trigger-rotation") &&
      existsSync(join(dir, ".plugin.log.lock")),
    "locks: fresh lock skips rotation without stalling",
  );
}
{
  // Unwritable destination: calls are silent no-ops, never throws.
  const { d } = caseDir("unwritable");
  const blocked = join(d, "blocked");
  writeFileSync(blocked, "not a dir");
  const p = writeProbe(
    d,
    `const { configureLog, log } = await import(${JSON.stringify(join(ROOT, "plugin", "log.ts"))});
configureLog({ dir: process.argv[2] });
log.info("dropped-1"); log.error("dropped-2", new Error("x"));
`,
  );
  const r = run(p, [join(blocked, "logs")], {});
  ok(
    r.status === 0 && r.out === "" && r.err === "",
    "unwritable: silent no-op",
    `status=${r.status} err=${JSON.stringify(r.err.slice(0, 200))}`,
  );
}

// --- 9. standalone compatibility ---------------------------------------------
{
  const r = run(join(ROOT, "plugin", "cli.ts"), ["contribute", "status"], {});
  let parsed = false;
  try {
    JSON.parse(r.out);
    parsed = true;
  } catch {
    // Not JSON.
  }
  ok(
    r.status === 0 && parsed,
    "standalone: contribute status still prints JSON",
    `status=${r.status} out=${JSON.stringify(r.out.slice(0, 120))}`,
  );
}
{
  const r = run(
    join(ROOT, "plugin", "cli.ts"),
    ["diff", join(ROOT, "package.json"), join(ROOT, "package.json")],
    {},
  );
  ok(
    r.status === 0 && r.out.includes("ok: no diffs"),
    "standalone: diff output unchanged",
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
// Keep the scratch for forensics on failure; otherwise clean up.
rmSync(BASE, { recursive: true, force: true });
