import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RepoCatalog } from "./repositories.ts";

function git(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
): void {
  const r = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")}: ${r.stderr || r.stdout}`);
}

describe("RepoCatalog", () => {
  const prevDev = process.env.OC_DEV_ROOT;
  let root = "";
  let main = "";
  let clone = "";
  let wt = "";

  beforeAll(() => {
    mkdirSync("/tmp/opencode", { recursive: true });
    root = mkdtempSync("/tmp/opencode/repos-");
    process.env.OC_DEV_ROOT = root;
    main = join(root, "app");
    mkdirSync(main);
    git(main, ["init", "--initial-branch=main"]);
    git(main, ["config", "user.email", "you@x"]);
    git(main, ["config", "user.name", "you"]);
    writeFileSync(join(main, "src.ts"), "a\n");
    git(main, ["-c", "commit.gpgsign=false", "add", "src.ts"]);
    git(main, ["-c", "commit.gpgsign=false", "commit", "-m", "init"], {
      GIT_AUTHOR_NAME: "you",
      GIT_AUTHOR_EMAIL: "you@x",
      GIT_COMMITTER_NAME: "you",
      GIT_COMMITTER_EMAIL: "you@x",
    });
    wt = join(root, "wt-feature");
    git(main, ["worktree", "add", "-b", "feat", wt]);
    clone = join(root, "app-old");
    const r = spawnSync("git", ["clone", main, clone], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
  });

  afterAll(() => {
    if (prevDev === undefined) delete process.env.OC_DEV_ROOT;
    else process.env.OC_DEV_ROOT = prevDev;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("linked worktrees share a common directory", () => {
    const cat = new RepoCatalog();
    const a = cat.probe(main);
    const b = cat.probe(wt);
    expect(a?.common).toBe(b?.common);
    expect(a?.eligible).toBe(true);
    const got = cat.resolveEdit(join(wt, "src.ts"), main);
    expect(got?.rel).toBe("src.ts");
    expect(got?.worktree).toBe(wt.replace(/\\/g, "/"));
    expect(got?.repo).toBe(a?.common);
  });

  test("separate clones stay distinct even with the same origin", () => {
    const cat = new RepoCatalog();
    const a = cat.probe(main);
    const b = cat.probe(clone);
    expect(a?.common).not.toBe(b?.common);
  });

  test("pruned worktree path still normalizes via historical root", () => {
    const gone = join(main, ".worktrees", "issue-32-t1");
    const cat = new RepoCatalog();
    cat.probe(main);
    cat.addHistorical(gone);
    const file = join(gone, "src", "shared", "castMatch.ts");
    const got = cat.resolveEdit(file, main);
    expect(got?.rel).toBe("src/shared/castMatch.ts");
    expect(got?.worktree.replace(/\\/g, "/")).toBe(gone.replace(/\\/g, "/"));
    expect(got?.repo).toBe(cat.probe(main)?.common);
  });

  test("nested .worktrees path under a known repo normalizes without a live worktree", () => {
    const cat = new RepoCatalog();
    cat.probe(main);
    const file = join(main, ".worktrees", "issue-99", "src", "foo.ts");
    const got = cat.resolveEdit(file, main);
    expect(got?.rel).toBe("src/foo.ts");
    expect(got?.repo).toBe(cat.probe(main)?.common);
  });

  test("a renamed session directory resolves through its project repo", () => {
    const gone = join(root, "app-before-rename");
    const cat = new RepoCatalog();
    const fallback = cat.probe(main)?.common;
    cat.addHistorical(gone);
    const file = join(gone, "src", "page.tsx");
    expect(cat.resolveEdit(file, gone)).toBeNull();
    const got = cat.resolveEdit(file, gone, { fallback });
    expect(got?.repo).toBe(fallback);
    expect(got?.rel).toBe("src/page.tsx");
    expect(cat.resolveEdit("src/page.tsx", gone, { fallback })?.rel).toBe(
      "src/page.tsx",
    );
    // the fallback never reaches outside the vanished directory
    expect(
      cat.resolveEdit(join(root, "elsewhere.ts"), gone, { fallback }),
    ).toBeNull();
  });

  test("the fallback is ignored while the session directory exists", () => {
    const cat = new RepoCatalog();
    const other = join(root, "plain-dir");
    mkdirSync(other, { recursive: true });
    const fallback = cat.probe(main)?.common;
    expect(
      cat.resolveEdit(join(other, "notes.md"), other, { fallback }),
    ).toBeNull();
  });

  test("outside DEV_ROOT is not eligible", () => {
    const cat = new RepoCatalog();
    process.env.OC_DEV_ROOT = join(root, "empty");
    mkdirSync(process.env.OC_DEV_ROOT, { recursive: true });
    expect(cat.probe(main)?.eligible).toBe(false);
    expect(cat.resolveEdit(join(main, "src.ts"), main)).toBeNull();
    process.env.OC_DEV_ROOT = root;
  });
});
