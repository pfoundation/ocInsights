// Guards the zero-runtime-dependency invariant. Run after any
// `@opencode-ai/plugin` upgrade and before every publish:
//   bun plugin/shim-check.ts
// Also runs in `make publish-npm` and the release workflow.
//
// 1. Parity: the vendored defineRpc/defineTui (plugin/define.ts) must stay
//    behavior-identical to the installed SDK's.
// 2. Scanner: no shipped TS file may carry a runtime bare import (anything
//    outside relative paths and node:/bun: builtins). `import type` is fine —
//    hosts strip it without resolving.
// 3. Packaging: package.json must declare no installable dependencies.
//
// This file itself is dev-only and intentionally imports the SDK; it is
// excluded from the scan.
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Rpc } from "@opencode-ai/plugin/rpc";
// Direct submodule so the check never needs solid-js (the "./tui" index
// re-exports solid-backed helpers our plugin never uses).
import { define as realTuiDefine } from "@opencode-ai/plugin/tui/plugin";
import { defineRpc, defineTui } from "./define.ts";
import { Insights } from "./rpc.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// --- 1. parity -----------------------------------------------------------
const sample = {
  id: "probe",
  methods: {
    m: {
      input: { type: "object", properties: {} },
      output: { type: "boolean" },
      errors: { boom: { type: "object", properties: {} } },
    },
  },
  events: {
    e: { schema: { type: "object", properties: {} } },
  },
} as const;
assert.deepEqual(
  defineRpc(structuredClone(sample)),
  Rpc.define(structuredClone(sample)),
  "defineRpc diverged from the SDK",
);
// The reserved-prefix guard must throw identically.
const bad = {
  id: "probe",
  methods: {
    m: {
      input: { type: "object", properties: {} },
      output: { type: "boolean" },
      errors: { "rpc.nope": { type: "object", properties: {} } },
    },
  },
  events: {},
} as const;
// The type system already rejects this statically (which proves the vendored
// generic keeps the SDK's constraint); cast to exercise the runtime guard.
const badAsDef = bad as unknown as Rpc.Definition;
assert.throws(
  () => defineRpc(structuredClone(badAsDef)),
  /reserved/,
  "defineRpc lost the reserved-prefix guard",
);
assert.throws(
  () => Rpc.define(structuredClone(badAsDef)),
  /reserved/,
  "SDK changed its reserved-prefix guard",
);
// Our real contract round-trips through the SDK unchanged.
assert.deepEqual(
  Insights,
  Rpc.define(structuredClone(Insights)),
  "Insights diverged from the SDK",
);
// TUI define is identity on both sides.
const tuiIn = { id: "probe.tui", setup: () => {} };
assert.equal(defineTui(tuiIn), tuiIn, "defineTui is not identity");
assert.equal(realTuiDefine(tuiIn), tuiIn, "SDK TUI define is not identity");

// --- 2. runtime bare-import scan ------------------------------------------
const SKIP = new Set(["shim-check.ts"]);
const STATIC_RE =
  /^\s*import\s+(?!type\b)(?:[^"']*?\sfrom\s+)?["']([^"']+)["']/;
// Multiline imports put the specifier on its own `} from "…"` line.
const FROM_RE = /^\s*}?\s*from\s+["']([^"']+)["']/;
// Re-exports (index.ts/tui.ts re-export relative entries; bare ones would leak).
const EXPORT_RE = /^\s*export\s+(?!type\b)[^"']*?\sfrom\s+["']([^"']+)["']/;
const DYNAMIC_RE = /(?:import|require)\(\s*["']([^"']+)["']\s*\)/g;

function isBare(spec: string): boolean {
  return !(
    spec.startsWith(".") ||
    spec.startsWith("/") ||
    spec.startsWith("node:") ||
    spec.startsWith("bun:") ||
    spec.startsWith("file:")
  );
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      out.push(...tsFiles(p));
    } else if (/\.(ts|tsx)$/.test(name) && !SKIP.has(name)) {
      out.push(p);
    }
  }
  return out;
}

const violations: string[] = [];
const files = [
  join(ROOT, "index.ts"),
  join(ROOT, "tui.ts"),
  ...tsFiles(join(ROOT, "plugin")),
];
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  // Inside a multiline `import type` / `export type` statement: its `} from`
  // continuation carries no runtime import.
  let inTypeIO = false;
  lines.forEach((line, i) => {
    // Whole-line comments carry no imports.
    const code = line.replace(/^\s*\/\/.*$/, "");
    if (/^\s*(import|export)\s+type\b/.test(code) && !code.includes(";")) {
      inTypeIO = true;
    }
    for (const re of [STATIC_RE, FROM_RE, EXPORT_RE]) {
      // STATIC_RE/EXPORT_RE already exclude `import type`/`export type` via
      // lookahead; only the `} from` continuation needs the state flag.
      if (re === FROM_RE && inTypeIO) continue;
      const m = code.match(re);
      if (m && isBare(m[1])) {
        violations.push(`${file}:${i + 1}: static bare import "${m[1]}"`);
      }
    }
    for (const d of code.matchAll(DYNAMIC_RE)) {
      if (isBare(d[1]))
        violations.push(`${file}:${i + 1}: dynamic bare import "${d[1]}"`);
    }
    if (code.includes(";")) inTypeIO = false;
  });
}
assert.equal(
  violations.join("\n"),
  "",
  `runtime bare imports found (zero-dependency invariant broken):\n${violations.join("\n")}`,
);

// --- 3. packaging ----------------------------------------------------------
const pkg = JSON.parse(
  readFileSync(join(ROOT, "package.json"), "utf8"),
) as Record<string, unknown>;
for (const key of [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
]) {
  assert.equal(
    pkg[key],
    undefined,
    `package.json must not declare "${key}" (zero-dependency invariant broken)`,
  );
}

const sdk = JSON.parse(
  readFileSync(
    join(ROOT, "node_modules", "@opencode-ai", "plugin", "package.json"),
    "utf8",
  ),
) as { version?: unknown };
console.log(
  `shim-check ok: SDK ${sdk.version}, ${files.length} files scanned, no runtime bare imports, no installable dependencies`,
);
