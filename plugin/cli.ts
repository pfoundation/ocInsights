// Snapshot CLI: extract, build, install, template, diff, contribute. No Python.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { renderDeck } from "./build.ts";
import { makeTemplate } from "./makeTemplate.ts";
import { extractToFile } from "./metrics/index.ts";
import {
  buildPayload,
  contributeFileStatus,
  loadExtractor,
  loadInstallId,
  runContribute,
  setContributeEnabled,
} from "./contribute.ts";

function usage(): never {
  console.error(`usage: bun plugin/cli.ts <command>

  extract [--out data.json]
  build   [--data data.json] [--template template.html] [--out opencode_time_full.html]
  install [repo]
  template <src> <dst>
  diff    <a.json> <b.json>
  contribute [--data data.json] [--dry-run] [--out payload.json] [--url ...] [--full]
  contribute on|off|status`);
  process.exit(2);
}

function flag(args: string[], name: string, fallback: string): string {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1]) return args[i + 1]!;
  return fallback;
}

function installPlugin(repoArg?: string): void {
  const repo = resolve(repoArg ?? join(import.meta.dir, ".."));
  const cfg = join(homedir(), ".config", "opencode", "opencode.json");
  if (!existsSync(cfg)) {
    console.error(`no ${cfg}; add this to plugins by hand:\n  ${repo}`);
    process.exit(1);
  }
  const data = JSON.parse(readFileSync(cfg, "utf8")) as {
    plugins?: unknown;
  };
  const path = repo;
  const plugins = data.plugins;
  if (Array.isArray(plugins) && plugins.includes(path)) {
    console.log(`already in plugins: ${path}`);
    return;
  }
  if (!Array.isArray(plugins)) data.plugins = [path];
  else plugins.push(path);
  writeFileSync(cfg, JSON.stringify(data, null, 2) + "\n");
  console.log(`installed: ${path} -> ${cfg}`);
}

function fmt(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return Array.isArray(v)
    ? `array(${v.length})`
    : `object(${Object.keys(v as object).length})`;
}

function diffJson(
  a: unknown,
  b: unknown,
  path: string,
  out: string[],
  ignore: Set<string>,
): void {
  if (ignore.has(path)) return;
  if (a === b) return;
  if (typeof a === "number" && typeof b === "number" && a === b) return;
  if (a === null || b === null || a === undefined || b === undefined) {
    out.push(`${path}: ${fmt(a)} vs ${fmt(b)}`);
    return;
  }
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${path}: ${fmt(a)} vs ${fmt(b)}`);
    return;
  }
  if (typeof a !== "object") {
    out.push(`${path}: ${fmt(a)} vs ${fmt(b)}`);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push(`${path}: length ${a.length} vs ${b.length}`);
    }
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++)
      diffJson(a[i], b[i], `${path}[${i}]`, out, ignore);
    return;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.join("\0") !== bk.join("\0")) {
    out.push(`${path}: keys [${ak.join(", ")}] vs [${bk.join(", ")}]`);
  }
  const names = new Set([...ak, ...bk]);
  for (const k of names) {
    diffJson(ao[k], bo[k], path ? `${path}.${k}` : k, out, ignore);
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) usage();
  if (cmd === "extract") {
    const out = flag(rest, "--out", "data.json");
    console.log(extractToFile(out));
    return;
  }
  if (cmd === "build") {
    const dataPath = flag(rest, "--data", "data.json");
    const template = flag(rest, "--template", "template.html");
    const out = flag(rest, "--out", "opencode_time_full.html");
    const data = JSON.parse(readFileSync(dataPath, "utf8")) as Record<
      string,
      unknown
    >;
    const html = await renderDeck(data, template);
    writeFileSync(out, html);
    const m = data.meta as { generated?: string };
    console.log(
      `${out}: ${html.length.toLocaleString("en-US")} bytes · generated from data of ${m.generated ?? "?"}`,
    );
    return;
  }
  if (cmd === "install") {
    installPlugin(rest[0]);
    return;
  }
  if (cmd === "template") {
    if (rest.length < 2) usage();
    console.log(makeTemplate(rest[0]!, rest[1]!));
    return;
  }
  if (cmd === "contribute") {
    const sub = rest[0];
    if (sub === "on" || sub === "off") {
      const st = setContributeEnabled(sub === "on");
      console.log(JSON.stringify({ ok: true, ...st }));
      return;
    }
    if (sub === "status") {
      console.log(
        JSON.stringify({
          ...contributeFileStatus(Date.now(), null),
          parked: false,
        }),
      );
      return;
    }
    const dataPath = flag(rest, "--data", "data.json");
    const out = flag(rest, "--out", "");
    const data = JSON.parse(readFileSync(dataPath, "utf8")) as Record<
      string,
      unknown
    >;
    if (out) {
      const payload = buildPayload(
        data,
        loadInstallId(),
        await loadExtractor(),
      );
      writeFileSync(out, JSON.stringify(payload));
    }
    const res = await runContribute({
      dryRun: rest.includes("--dry-run"),
      refresh: false,
      data,
      url: flag(rest, "--url", ""),
      full: rest.includes("--full"),
    });
    console.log(JSON.stringify(res));
    if (!res.ok) process.exit(1);
    return;
  }
  if (cmd === "diff") {
    if (rest.length < 2) usage();
    const a = JSON.parse(readFileSync(rest[0]!, "utf8")) as unknown;
    const b = JSON.parse(readFileSync(rest[1]!, "utf8")) as unknown;
    const diffs: string[] = [];
    diffJson(a, b, "", diffs, new Set(["meta.generated"]));
    if (!diffs.length) {
      console.log("ok: no diffs");
      return;
    }
    const shown = diffs.slice(0, 80);
    for (const d of shown) console.log(d);
    if (diffs.length > shown.length) {
      console.log(`… ${diffs.length - shown.length} more`);
    }
    console.log(`${diffs.length} diffs`);
    process.exit(1);
  }
  usage();
}

await main();
