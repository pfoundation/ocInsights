// Vendored plugin-definition helpers — byte-identical to the SDK's, with zero
// runtime imports.
//
// Both @opencode-ai/plugin entrypoints we used are identity functions:
//   - Rpc.define(d) returns d (plus a reserved "rpc." error-prefix check)
//   - TUI Plugin.define(p) returns p
// so the host cannot distinguish these from the real ones — the objects it
// receives are deep-equal. The SDK stays a devDependency for types only,
// which keeps user installs to just this tarball: no effect/zod/solid tree,
// no multi-minute first boot on opencode 1.x.
//
// Parity is enforced by plugin/shim-check.ts (runs in `make publish-npm` and
// the release workflow): after any `@opencode-ai/plugin` upgrade, run
// `bun plugin/shim-check.ts` and update the vendored version below.
import type { Rpc } from "@opencode-ai/plugin/rpc";
import type { Plugin as TuiPlugin } from "@opencode-ai/plugin/tui";

// SDK behaviour copied from @opencode-ai/plugin@0.0.0-beta-19242
// (Rpc re-exported from @opencode-ai/schema/dist/rpc.js).
export function defineRpc<const D extends Rpc.Definition>(definition: D): D {
  const reserved = Object.values(definition.methods)
    .flatMap((method) => Object.keys(method.errors ?? {}))
    .find((name) => name.startsWith("rpc."));
  if (reserved) {
    throw new Error(
      `RPC error names starting with "rpc." are reserved: ${reserved}`,
    );
  }
  return definition;
}

// SDK behaviour copied from @opencode-ai/plugin@0.0.0-beta-19242
// (dist/tui/plugin.js: `export function define(plugin) { return plugin; }`).
export function defineTui(plugin: TuiPlugin.Definition): TuiPlugin.Definition {
  return plugin;
}
