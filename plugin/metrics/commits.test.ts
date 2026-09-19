import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { attributeCommits } from "./commits.ts";
import type { Cycle, Sess } from "./scan.ts";
import type { SessionMeta } from "./sessions.ts";
import { Counter, pairKey, unitKey } from "./util.ts";

const YOU = { name: "you", email: "you@x" };
const BOT = { name: "bot", email: "bot@x" };
const STRANGER = { name: "stranger", email: "stranger@x" };
const SEED = { name: "seed", email: "seed@x" };
const SLOW = { name: "slow", email: "slow@x" };

function git(
  repo: string,
  args: string[],
  env: Record<string, string> = {},
): void {
  const r = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${r.stderr || r.stdout}`);
  }
}

function commitFile(
  repo: string,
  file: string,
  body: string,
  author: { name: string; email: string },
  dateIso: string,
): number {
  writeFileSync(join(repo, file), body);
  git(repo, ["add", file]);
  git(repo, ["-c", "commit.gpgsign=false", "commit", "-m", body], {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
    GIT_AUTHOR_DATE: dateIso,
    GIT_COMMITTER_DATE: dateIso,
  });
  const at = spawnSync("git", ["-C", repo, "log", "-1", "--format=%at"], {
    encoding: "utf8",
  });
  return Number(at.stdout.trim());
}

function stubSess(wt: string): {
  S: Map<string, Sess>;
  meta: Map<string, SessionMeta>;
} {
  const mp = new Counter<string>();
  mp.add(pairKey("claude-opus-4.6", "anthropic", "max"), 1);
  const ph = {
    mp,
    ms: 60_000,
    u: 1,
    q: 0,
    a: 1,
    err: 0,
    edits: 7,
    eerr: 0,
    files: new Set(["a.txt"]),
    reads: 0,
    bash: 0,
    tools: 7,
    terr: 0,
    abort: 0,
    ver: 0,
    commit: 0,
    lat: [] as number[],
  };
  const cy = {
    ...ph,
    first: 0,
    last: 0,
    ev: [] as [number, number][],
    edit_ev: [] as [number, string][],
    has_build: true,
    ph: new Map([[2, ph]]),
    last_edit: null,
    last_ver: null,
  } as Cycle;
  const s = {
    ...ph,
    last: null,
    ev: [] as [number, number][],
    edit_ev: [] as [number, string][],
    first: null,
    comp: 0,
    day0: null,
    cur: null,
    cyc: [cy],
    prev_typ: null,
    ph: new Map([[2, ph]]),
    last_edit: null,
    last_ver: null,
    seq: 0,
  } as Sess;
  const S = new Map<string, Sess>([["ses_test", s]]);
  const meta = new Map<string, SessionMeta>([
    [
      "ses_test",
      {
        wt,
        agent: "build",
        child: false,
        cost: 0,
        fresh: 0,
        cache_r: 0,
        cache_w: 0,
        add: 0,
        dele: 0,
        has_lines: false,
        model: null,
        ocv: "1.18.0",
        created: 0,
        dir: wt,
        parent: null,
      },
    ],
  ]);
  return { S, meta };
}

describe("attributeCommits author learning", () => {
  const prevDev = process.env.OC_DEV_ROOT;
  const prevAuth = process.env.OC_GIT_AUTHORS;
  let root = "";
  let repo = "";
  let youAt: number[] = [];
  let botAt: number[] = [];
  let strangerHit = 0;
  let strangerRest: number[] = [];
  let seedAt = 0;
  let S: Map<string, Sess>;
  let meta: Map<string, SessionMeta>;
  let editsCyc: Map<string, [number, string][]>;

  beforeAll(() => {
    delete process.env.OC_GIT_AUTHORS;
    mkdirSync("/tmp/opencode", { recursive: true });
    root = mkdtempSync("/tmp/opencode/commits-");
    process.env.OC_DEV_ROOT = root;
    repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, ["init", "--initial-branch=main"]);
    git(repo, ["config", "user.email", SEED.email]);
    git(repo, ["config", "user.name", SEED.name]);

    youAt = [1, 2, 3, 4].map((d) =>
      commitFile(repo, "a.txt", `you ${d}`, YOU, `2026-06-0${d}T12:00:00Z`),
    );
    botAt = [5, 6, 7].map((d) =>
      commitFile(repo, "a.txt", `bot ${d}`, BOT, `2026-06-0${d}T12:00:00Z`),
    );
    strangerHit = commitFile(
      repo,
      "a.txt",
      "stranger hit",
      STRANGER,
      "2026-06-08T12:00:00Z",
    );
    strangerRest = [9, 10, 11, 12].map((d) =>
      commitFile(
        repo,
        "b.txt",
        `stranger ${d}`,
        STRANGER,
        `2026-06-${String(d).padStart(2, "0")}T12:00:00Z`,
      ),
    );
    seedAt = commitFile(
      repo,
      "c.txt",
      "seed only",
      SEED,
      "2026-06-13T12:00:00Z",
    );
    const slowAt = [14, 15, 16].map((d) =>
      commitFile(repo, "d.txt", `slow ${d}`, SLOW, `2026-06-${d}T12:00:00Z`),
    );

    const stub = stubSess(repo);
    S = stub.S;
    meta = stub.meta;
    const edits: [number, string][] = [];
    for (const at of [...youAt, ...botAt, strangerHit]) {
      edits.push([at - 60, "a.txt"]);
    }
    // 10 min before each slow commit — inside the 72 h attribution
    // window, outside the 5 min learning window.
    for (const at of slowAt) edits.push([at - 600, "d.txt"]);
    editsCyc = new Map([[unitKey("ses_test", 0), edits]]);
  });

  afterAll(() => {
    if (prevDev === undefined) delete process.env.OC_DEV_ROOT;
    else process.env.OC_DEV_ROOT = prevDev;
    if (prevAuth === undefined) delete process.env.OC_GIT_AUTHORS;
    else process.env.OC_GIT_AUTHORS = prevAuth;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("learns overlapping identities and seeds, drops strangers", () => {
    const [CM, , repoInfo] = attributeCommits(S, meta, "2026-01-01", editsCyc);
    const ids = CM.authors.map((a) => a.id);
    expect(ids).toEqual(["you@x", "bot@x", "seed@x"]);
    expect(ids).not.toContain("slow@x");
    expect(CM.authors.find((a) => a.id === "you@x")).toMatchObject({
      hits: 4,
      commits: 4,
      seed: false,
      name: "you",
    });
    expect(CM.authors.find((a) => a.id === "bot@x")).toMatchObject({
      hits: 3,
      commits: 3,
      seed: false,
      name: "bot",
    });
    expect(CM.authors.find((a) => a.id === "seed@x")).toMatchObject({
      hits: 0,
      commits: 1,
      seed: true,
      name: "seed",
    });
    expect(CM.total).toBe(8);
    expect(CM.basis.files).toBe(7);
    expect(CM.basis.manual).toBe(1);
    const recAt = new Set(CM.recs.map((r) => (r as number[])[3]));
    expect(recAt.has(strangerHit)).toBe(false);
    for (const at of [...youAt, ...botAt]) expect(recAt.has(at)).toBe(true);
    const ts = repoInfo.commits.get(repo) ?? [];
    expect(ts).not.toContain(strangerHit);
    for (const at of strangerRest) expect(ts).not.toContain(at);
    expect(ts).toContain(seedAt);
  });

  test("OC_GIT_AUTHORS is additive", () => {
    process.env.OC_GIT_AUTHORS = "stranger@x";
    try {
      const [CM, , repoInfo] = attributeCommits(
        S,
        meta,
        "2026-01-01",
        editsCyc,
      );
      const ids = CM.authors.map((a) => a.id);
      expect(ids).toContain("stranger@x");
      expect(ids).toContain("you@x");
      expect(ids).toContain("bot@x");
      expect(ids).toContain("seed@x");
      expect(CM.total).toBe(13);
      const recAt = new Set(CM.recs.map((r) => (r as number[])[3]));
      expect(recAt.has(strangerHit)).toBe(true);
      const ts = repoInfo.commits.get(repo) ?? [];
      expect(ts).toContain(strangerHit);
      expect(CM.authors.find((a) => a.id === "stranger@x")?.seed).toBe(true);
    } finally {
      delete process.env.OC_GIT_AUTHORS;
    }
  });
});
