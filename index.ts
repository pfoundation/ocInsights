// Directory entrypoint: opencode resolves a plugin directory to <dir>/index.ts
// (it ignores package.json exports). The real plugin lives in ./plugin/.
export { default } from "./plugin/index.ts";
