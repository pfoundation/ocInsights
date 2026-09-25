// Resolve Git repository identity and worktree-relative edit paths.
// Keyed by the canonical git common directory so linked worktrees share a
// repo while separate clones stay distinct. No terminal output.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { dirname, isAbsolute, posix, resolve } from "node:path";
import { DEV_ROOT } from "./config.ts";
import { relFile } from "./util.ts";

export type ResolvedEdit = {
  repo: string;
  worktree: string;
  rel: string;
  readFrom: string;
};

export type RepoEntry = {
  common: string;
  readFrom: string;
  worktrees: string[];
  eligible: boolean;
};

function devRoot(): string {
  return process.env.OC_DEV_ROOT ?? DEV_ROOT;
}

function gitOk(cwd: string, args: string[]): string | null {
  if (!cwd || !existsSync(cwd)) return null;
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const out = (r.stdout ?? "").trim();
  return out || null;
}

function absPath(p: string): string {
  return resolve(p).replace(/\\/g, "/");
}

function existingDir(start: string): string | null {
  let d = absPath(start);
  try {
    if (existsSync(d) && lstatSync(d).isFile()) d = dirname(d);
  } catch {
    /* missing */
  }
  while (!existsSync(d)) {
    const parent = dirname(d);
    if (parent === d) return null;
    d = parent;
  }
  try {
    if (lstatSync(d).isFile()) d = dirname(d);
  } catch {
    return null;
  }
  return d;
}

export function gitCommonDir(dir: string): string | null {
  const out = gitOk(dir, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  return out ? absPath(out) : null;
}

export function gitTopLevel(dir: string): string | null {
  const out = gitOk(dir, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
  ]);
  return out ? absPath(out) : null;
}

function listWorktrees(readFrom: string): string[] {
  const out = gitOk(readFrom, ["worktree", "list", "--porcelain"]);
  if (!out) return [];
  const roots: string[] = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) roots.push(absPath(line.slice(9)));
  }
  return roots;
}

function under(root: string, path: string): boolean {
  const r = root.endsWith("/") ? root : root + "/";
  return path === root || path.startsWith(r);
}

function longestPrefix(path: string, roots: Iterable<string>): string | null {
  let best: string | null = null;
  for (const root of roots) {
    if (!root) continue;
    if (under(root, path) && (!best || root.length > best.length)) best = root;
  }
  return best;
}

export class RepoCatalog {
  readonly byCommon = new Map<string, RepoEntry>();
  readonly historical = new Set<string>();
  unresolved = 0;
  private probed = new Map<string, string | null>();
  // git answers per directory; resolveEdit asks once per edit, so without
  // these an extract spawned ~50k `git rev-parse` processes.
  private tops = new Map<string, string | null>();
  private commons = new Map<string, string | null>();

  private topOf(dir: string): string | null {
    let v = this.tops.get(dir);
    if (v === undefined) {
      v = gitTopLevel(dir);
      this.tops.set(dir, v);
    }
    return v;
  }

  private commonOf(dir: string): string | null {
    let v = this.commons.get(dir);
    if (v === undefined) {
      v = gitCommonDir(dir);
      this.commons.set(dir, v);
    }
    return v;
  }

  addHistorical(dir: string): void {
    if (dir) this.historical.add(absPath(dir));
  }

  eligible(common: string, readFrom: string): boolean {
    const root = devRoot();
    const prefix = root.endsWith("/") ? root : root + "/";
    return (
      common === root ||
      common.startsWith(prefix) ||
      readFrom === root ||
      readFrom.startsWith(prefix)
    );
  }

  probe(dir: string): RepoEntry | null {
    const key = absPath(dir);
    if (this.probed.has(key)) {
      const common = this.probed.get(key);
      return common ? (this.byCommon.get(common) ?? null) : null;
    }
    const start = existingDir(key);
    if (!start) {
      this.probed.set(key, null);
      return null;
    }
    const top = this.topOf(start);
    const common = top ? this.commonOf(top) : this.commonOf(start);
    if (!top || !common) {
      this.probed.set(key, null);
      return null;
    }
    this.probed.set(key, common);
    this.probed.set(top, common);
    this.probed.set(common, common);
    let ent = this.byCommon.get(common);
    if (!ent) {
      ent = {
        common,
        readFrom: top,
        worktrees: [],
        eligible: this.eligible(common, top),
      };
      this.byCommon.set(common, ent);
      for (const wt of listWorktrees(top)) {
        this.registerWorktree(ent, wt);
      }
    }
    this.registerWorktree(ent, top);
    if (ent.eligible && top.length < ent.readFrom.length) ent.readFrom = top;
    return ent;
  }

  private registerWorktree(ent: RepoEntry, wt: string): void {
    const n = absPath(wt);
    if (!ent.worktrees.includes(n)) ent.worktrees.push(n);
    this.probed.set(n, ent.common);
    this.historical.add(n);
  }

  resolveEdit(
    file: string | null | undefined,
    sessionDir: string,
    extra?: {
      repo?: string;
      worktree?: string;
      rel?: string;
      /** git common dir of the session's project, used when sessionDir no longer exists */
      fallback?: string | null;
    },
  ): ResolvedEdit | null {
    if (extra?.rel && extra.repo) {
      const ent =
        this.byCommon.get(absPath(extra.repo)) ?? this.probe(extra.repo);
      if (ent?.eligible) {
        const wt = extra.worktree
          ? absPath(extra.worktree)
          : (ent.worktrees[0] ?? ent.readFrom);
        return {
          repo: ent.common,
          worktree: wt,
          rel: extra.rel.replace(/\\/g, "/"),
          readFrom: ent.readFrom,
        };
      }
    }
    if (!file) {
      this.unresolved += 1;
      return null;
    }
    const abs = isAbsolute(file)
      ? absPath(file)
      : absPath(resolve(sessionDir, file));
    if (extra?.worktree) {
      const wt = absPath(extra.worktree);
      const rel = relFile(abs, wt);
      const ent = this.probe(wt) ?? this.ownerOf(wt);
      if (rel && ent?.eligible) {
        this.registerWorktree(ent, wt);
        return { repo: ent.common, worktree: wt, rel, readFrom: ent.readFrom };
      }
    }
    const marked = this.fromWorktreeMarker(abs);
    if (marked) return marked;
    const hist = longestPrefix(abs, this.historical);
    const live = this.probe(abs);
    const liveTop = live
      ? (this.topOf(existingDir(abs) ?? abs) ?? live.readFrom)
      : null;
    const worktree =
      hist && (!liveTop || hist.length >= liveTop.length) ? hist : liveTop;
    if (worktree) {
      const rel = relFile(abs, worktree);
      const ent = this.probe(worktree) ?? live ?? this.ownerOf(worktree);
      if (rel && ent?.eligible) {
        return {
          repo: ent.common,
          worktree,
          rel,
          readFrom: ent.readFrom,
        };
      }
    }
    const sess = this.probe(sessionDir);
    if (sess?.eligible) {
      if (
        !isAbsolute(file) &&
        !file.includes("..") &&
        !file.startsWith(".worktrees/")
      ) {
        return {
          repo: sess.common,
          worktree: sess.readFrom,
          rel: file.replace(/\\/g, "/"),
          readFrom: sess.readFrom,
        };
      }
      const rel = relFile(abs, sess.readFrom) ?? relFile(file, sessionDir);
      if (rel && !rel.startsWith(".worktrees/")) {
        return {
          repo: sess.common,
          worktree: sess.readFrom,
          rel,
          readFrom: sess.readFrom,
        };
      }
    }
    // A renamed or removed checkout (v0-dashboard → datastudio, pruned
    // opencode worktrees): the session directory is gone but its project
    // still resolves. Paths stay relative to the session directory.
    if (extra?.fallback) {
      const dir = absPath(sessionDir);
      if (!existsSync(dir)) {
        const ent =
          this.byCommon.get(absPath(extra.fallback)) ??
          this.probe(extra.fallback);
        const rel = relFile(abs, dir);
        if (
          ent?.eligible &&
          rel &&
          rel !== "." &&
          !rel.startsWith(".worktrees/")
        ) {
          return {
            repo: ent.common,
            worktree: dir,
            rel,
            readFrom: ent.readFrom,
          };
        }
      }
    }
    if (abs.startsWith(devRoot())) this.unresolved += 1;
    return null;
  }

  /** Parent of `/.worktrees/<name>/` is a known repo → treat as a (possibly pruned) linked worktree. */
  private fromWorktreeMarker(abs: string): ResolvedEdit | null {
    const marker = "/.worktrees/";
    const idx = abs.indexOf(marker);
    if (idx <= 0) return null;
    const parent = abs.slice(0, idx);
    const rest = abs.slice(idx + marker.length);
    const slash = rest.indexOf("/");
    if (slash <= 0) return null;
    const wtRoot = parent + marker + rest.slice(0, slash);
    const rel = rest.slice(slash + 1);
    if (!rel) return null;
    const ent = this.probe(parent);
    if (!ent?.eligible) return null;
    this.historical.add(wtRoot);
    return {
      repo: ent.common,
      worktree: wtRoot,
      rel,
      readFrom: ent.readFrom,
    };
  }

  /** Innermost known repo whose worktree or path contains dir. */
  ownerOf(dir: string): RepoEntry | null {
    const p = absPath(dir);
    let best: RepoEntry | null = null;
    let bestLen = -1;
    for (const ent of this.byCommon.values()) {
      for (const wt of [ent.readFrom, ...ent.worktrees, dirname(ent.common)]) {
        if (under(wt, p) && wt.length > bestLen) {
          best = ent;
          bestLen = wt.length;
        }
      }
    }
    if (best) return best;
    let d = p;
    while (true) {
      const parent = dirname(d);
      if (parent === d) break;
      const ent = this.probe(parent);
      if (ent) return ent;
      d = parent;
    }
    return null;
  }

  eligibleRepos(): RepoEntry[] {
    return [...this.byCommon.values()]
      .filter((e) => e.eligible)
      .sort((a, b) => (a.readFrom < b.readFrom ? -1 : 1));
  }
}

export function posixRel(base: string, path: string): string | null {
  const rel = posix.relative(
    base.replace(/\\/g, "/"),
    path.replace(/\\/g, "/"),
  );
  if (!rel || rel.startsWith("..")) return null;
  return rel;
}
