// Git plumbing for worktrees, checkpoints, integration and landing.
// Commits made here live only on the harness's own dsh/* branches; nothing is committed to the user's branch.

import { ensureDir, exec, exists, IS_WIN, join, normPath } from "./util.ts";

export const IDENTITY = {
  GIT_AUTHOR_NAME: "DeepSeek Harness",
  GIT_AUTHOR_EMAIL: "harness@deepseek-harness.local",
  GIT_COMMITTER_NAME: "DeepSeek Harness",
  GIT_COMMITTER_EMAIL: "harness@deepseek-harness.local",
};

export async function git(cwd: string, args: string[], o: { env?: Record<string, string>; input?: string; check?: boolean } = {}) {
  const pre = ["-c", "core.quotepath=off", ...(IS_WIN ? ["-c", "core.longpaths=true"] : [])];
  const r = await exec("git", [...pre, ...args], { cwd, env: { GIT_TERMINAL_PROMPT: "0", ...o.env }, input: o.input });
  if (o.check !== false && r.code !== 0) {
    throw new Error(`git ${args.slice(0, 3).join(" ")} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 1500)}`);
  }
  return r;
}

export async function repoRoot(path: string): Promise<string> {
  if (!exists(path)) throw new Error(`Path not found: ${path}`);
  const r = await git(path, ["rev-parse", "--show-toplevel"], { check: false });
  if (r.code !== 0) throw new Error(`${path} is not inside a git repository. Run git init (and commit) first.`);
  return normPath(r.stdout);
}

export async function headSha(root: string): Promise<string | null> {
  const r = await git(root, ["rev-parse", "--verify", "-q", "HEAD"], { check: false });
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function resolveCommit(root: string, ref: string): Promise<string> {
  const r = await git(root, ["rev-parse", "--verify", "-q", `${ref}^{commit}`], { check: false });
  if (r.code !== 0) throw new Error(`Unknown git ref: ${ref}`);
  return r.stdout.trim();
}

export async function isDirty(root: string): Promise<boolean> {
  return (await git(root, ["status", "--porcelain"])).stdout.trim() !== "";
}

// Commit the whole working tree (tracked changes and non-ignored untracked files) without touching
// the user's index, branch or files: a temporary index, write-tree, commit-tree, no ref update.
export async function snapshot(root: string, tmpIndex: string): Promise<string> {
  const env = { GIT_INDEX_FILE: tmpIndex };
  const head = await headSha(root);
  try {
    await git(root, head ? ["read-tree", head] : ["read-tree", "--empty"], { env });
    await git(root, ["add", "-A", "--", "."], { env });
    const tree = (await git(root, ["write-tree"], { env })).stdout.trim();
    const args = ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", "deepseek-harness snapshot of the working tree"];
    return (await git(root, args, { env: IDENTITY })).stdout.trim();
  } finally {
    try {
      Deno.removeSync(tmpIndex);
    } catch { /* never written */ }
  }
}

export async function worktreeAdd(root: string, path: string, branch: string, sha: string) {
  ensureDir(join(path, ".."));
  await git(root, ["worktree", "add", "-b", branch, path, sha]);
}

// Stage the whole worktree except shared links. A link that .gitignore already covers needs no
// exclude, and naming an ignored path in a pathspec makes `git add` exit 1.
export async function addAll(wt: string, exclude: string[]) {
  const specs: string[] = [];
  for (const p of exclude) {
    const rel = p.replace(/\\/g, "/");
    if ((await git(wt, ["check-ignore", "-q", rel], { check: false })).code !== 0) specs.push(`:(exclude)${rel}`);
  }
  await git(wt, ["add", "-A", "--", ".", ...specs]);
}

// Record everything the worker left in its worktree as one commit on its branch. Returns null if nothing changed.
export async function checkpoint(wt: string, message: string, exclude: string[]): Promise<string | null> {
  await addAll(wt, exclude);
  if ((await git(wt, ["diff", "--cached", "--quiet"], { check: false })).code === 0) return null;
  const tree = (await git(wt, ["write-tree"])).stdout.trim();
  const parent = (await git(wt, ["rev-parse", "HEAD"])).stdout.trim();
  const sha = (await git(wt, ["commit-tree", tree, "-p", parent, "-m", message], { env: IDENTITY })).stdout.trim();
  await git(wt, ["update-ref", "HEAD", sha, parent]);
  return sha;
}

export interface Change {
  status: string; // A, M, D, T
  path: string;
  oldMode: string;
  newMode: string;
  oldBlob: string | null;
  newBlob: string | null;
}

export async function rawDiff(root: string, a: string, b: string): Promise<Change[]> {
  const out = (await git(root, ["diff", "--raw", "-z", "--no-renames", "--no-abbrev", a, b])).stdout;
  const parts = out.split("\0");
  const zero = /^0+$/;
  const changes: Change[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const h = parts[i];
    if (!h.startsWith(":")) break;
    const [oldMode, newMode, os, ns, st] = h.slice(1).split(" ");
    changes.push({
      status: st[0],
      path: parts[i + 1],
      oldMode,
      newMode,
      oldBlob: zero.test(os) ? null : os,
      newBlob: zero.test(ns) ? null : ns,
    });
  }
  return changes;
}

export async function diffStat(root: string, a: string, b: string): Promise<string> {
  return (await git(root, ["diff", "--stat=110", a, b])).stdout.trimEnd();
}

export async function patch(root: string, a: string, b: string): Promise<string> {
  return (await git(root, ["diff", "--binary", a, b])).stdout;
}

export async function unmergedFiles(wt: string): Promise<string[]> {
  return (await git(wt, ["diff", "--name-only", "--diff-filter=U"])).stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

// Hash files the way `git add` would (clean filters, autocrlf), so they compare with blob ids.
export async function hashWorkingFiles(root: string, paths: string[]): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  const present = paths.filter((p) => {
    try {
      return Deno.statSync(join(root, p)).isFile;
    } catch {
      return false;
    }
  });
  if (!present.length) return m;
  const out = (await git(root, ["hash-object", "--stdin-paths"], { input: present.join("\n") + "\n" })).stdout.trim().split("\n");
  present.forEach((p, i) => m.set(p, out[i]?.trim()));
  return m;
}

// Blob content as it would be checked out at `path` (smudge filters, line endings).
export async function catFiltered(root: string, rev: string, path: string): Promise<Uint8Array> {
  const r = await exec("git", ["cat-file", "--filters", `${rev}:${path}`], { cwd: root });
  if (r.code !== 0) throw new Error(`git cat-file ${rev}:${path} failed: ${r.stderr.trim()}`);
  return r.bytes;
}

export async function listBranches(root: string, prefix: string): Promise<string[]> {
  return (await git(root, ["for-each-ref", "--format=%(refname:short)", `refs/heads/${prefix}`])).stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}
