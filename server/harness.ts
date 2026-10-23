// Runs, tasks and the worker scheduler. Each task is one headless `claude -p` process on DeepSeek,
// working in its own git worktree on branch dsh/<run>/<task>.

import * as G from "./git.ts";
import {
  cleanEnv,
  clip,
  deepseekKey,
  DSH_HOME,
  ensureDir,
  eolOf,
  exec,
  exists,
  findClaude,
  fmtMs,
  fmtTokens,
  inScope,
  isBinary,
  IS_WIN,
  join,
  killTree,
  log,
  modelId,
  Mutex,
  shellArgs,
  tailText,
  toLF,
  withEol,
  workerEnv,
} from "./util.ts";

export type TaskState = "queued" | "preparing" | "running" | "finishing" | "done" | "failed" | "cancelled" | "timeout" | "interrupted";
const TERMINAL = new Set<TaskState>(["done", "failed", "cancelled", "timeout", "interrupted"]);
const ACTIVE = new Set<TaskState>(["preparing", "running", "finishing"]);

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
}

interface Attempt {
  n: number;
  startedAt: number;
  endedAt?: number;
  sessionId?: string;
  model?: string;
  exitCode?: number;
  resultText?: string;
  isError?: boolean;
  subtype?: string;
  turns?: number;
  usage?: Usage;
}

interface CheckResult {
  ok: boolean;
  code: number;
  ms: number;
  tail: string;
  file: string;
  command: string;
}

export interface Task {
  id: string;
  title: string;
  prompt: string;
  files: string[];
  verify?: string;
  context?: string;
  model: string;
  effort: string;
  maxTurns?: number;
  timeoutMin: number;
  branch: string;
  worktree: string;
  baseSha: string;
  state: TaskState;
  attempts: Attempt[];
  sessionId?: string;
  progress: { turns: number; tools: number; last?: string; lastText?: string; at?: number; msgId?: string };
  pendingInput?: string;
  resume?: boolean;
  headSha?: string;
  changed?: string[];
  outOfScope?: string[];
  diffStat?: string;
  patchFile?: string;
  verifyResult?: CheckResult;
  error?: string;
  seen?: boolean;
  merged?: boolean;
  landed?: boolean;
  pid?: number;
  cancelRequested?: boolean;
  timedOut?: boolean;
}

interface Integration {
  branch: string;
  worktree: string;
  merged: string[];
  headSha?: string;
  conflict?: { taskId: string; files: string[] };
  verifyResult?: CheckResult;
}

export interface Run {
  id: string;
  repo: string;
  createdAt: number;
  baseSha: string;
  baseLabel: string;
  context?: string;
  verify?: string;
  setup?: string;
  link: string[];
  allowedTools: string[];
  permissionMode: string;
  maxParallel: number;
  tasks: Task[];
  integration?: Integration;
  landedSha?: string;
  cleaned?: boolean;
}

const GLOBAL_MAX = Math.max(1, Number(Deno.env.get("DSH_MAX_PARALLEL") ?? 12));
const VERIFY_TIMEOUT_MS = Number(Deno.env.get("DSH_VERIFY_TIMEOUT_MIN") ?? 15) * 60_000;
const runs = new Map<string, Run>();
const procs = new Map<string, Deno.ChildProcess>();
const repoLocks = new Map<string, Mutex>();
const listeners = new Set<() => void>();
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

const runDir = (id: string) => join(DSH_HOME, "runs", id);
const wtDir = (id: string) => join(DSH_HOME, "wt", id);

function repoLock(repo: string): Mutex {
  const k = repo.toLowerCase();
  if (!repoLocks.has(k)) repoLocks.set(k, new Mutex());
  return repoLocks.get(k)!;
}

function notify() {
  for (const l of [...listeners]) l();
}

function save(run: Run, now = false) {
  const write = () => {
    saveTimers.delete(run.id);
    try {
      Deno.writeTextFileSync(join(runDir(run.id), "run.json"), JSON.stringify(run, null, 1));
    } catch (e) {
      log("save failed", run.id, String(e));
    }
  };
  if (now) {
    clearTimeout(saveTimers.get(run.id));
    write();
  } else if (!saveTimers.has(run.id)) saveTimers.set(run.id, setTimeout(write, 1000));
}

export function loadRuns() {
  ensureDir(join(DSH_HOME, "runs"));
  for (const e of Deno.readDirSync(join(DSH_HOME, "runs"))) {
    if (!e.isDirectory) continue;
    try {
      const run = JSON.parse(Deno.readTextFileSync(join(runDir(e.name), "run.json"))) as Run;
      let changed = false;
      for (const t of run.tasks) {
        if (!TERMINAL.has(t.state)) {
          t.state = "interrupted";
          t.error = "The harness restarted while this task was queued or running. Use retry to continue it.";
          t.pid = undefined;
          changed = true;
        }
      }
      runs.set(run.id, run);
      if (changed) save(run, true);
    } catch { /* not a run */ }
  }
}

export async function shutdown() {
  for (const run of runs.values()) {
    for (const t of run.tasks) {
      if (t.pid) {
        t.cancelRequested = true;
        await killTree(t.pid);
      }
    }
    save(run, true);
  }
}

function getRun(id: string): Run {
  const r = runs.get(id);
  if (!r) throw new Error(`Unknown run ${id}. Call status without runId to list runs.`);
  return r;
}

function getTask(run: Run, id: string): Task {
  const t = run.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`Run ${run.id} has no task ${id}. Tasks: ${run.tasks.map((x) => x.id).join(", ")}`);
  return t;
}

function newRunId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}-${Math.random().toString(36).slice(2, 5)}`;
}

// ---------- worker configuration ----------

const DEFAULT_ALLOWED = [
  "Read", "Glob", "Grep", "Edit", "Write", "NotebookEdit", "TodoWrite", "Task", "Skill",
  "Bash(git status)", "Bash(git status *)", "Bash(git diff *)", "Bash(git diff)", "Bash(git log *)", "Bash(git show *)",
  "Bash(git ls-files *)", "Bash(git grep *)", "Bash(git rm *)", "Bash(git mv *)", "Bash(git add *)",
  "Bash(ls)", "Bash(ls *)", "Bash(pwd)", "Bash(cd *)", "Bash(cat *)", "Bash(head *)", "Bash(tail *)", "Bash(wc *)",
  "Bash(echo *)", "Bash(mkdir *)", "Bash(touch *)", "Bash(find *)", "Bash(grep *)", "Bash(rg *)", "Bash(sort *)",
  "Bash(diff *)", "Bash(which *)", "Bash(sed -n *)",
  "Bash(deno *)", "Bash(node *)", "Bash(npm *)", "Bash(npx *)", "Bash(pnpm *)", "Bash(yarn *)", "Bash(bun *)", "Bash(tsc *)",
  "Bash(python *)", "Bash(python3 *)", "Bash(py *)", "Bash(pytest *)", "Bash(uv *)",
  "Bash(cargo *)", "Bash(go *)", "Bash(dotnet *)", "Bash(make *)", "Bash(cmake *)", "Bash(mvn *)", "Bash(gradle *)",
  "Bash(./gradlew *)", "Bash(java *)", "Bash(javac *)", "Bash(rustc *)", "Bash(gcc *)", "Bash(g++ *)", "Bash(clang *)",
];

const DEFAULT_DENIED = [
  "Bash(git commit *)", "Bash(git push *)", "Bash(git merge *)", "Bash(git rebase *)", "Bash(git checkout *)",
  "Bash(git switch *)", "Bash(git reset *)", "Bash(git stash *)", "Bash(git worktree *)", "Bash(git clean *)",
  "Bash(git branch *)", "Bash(git restore *)", "Bash(git cherry-pick *)",
  "EnterWorktree", "ExitWorktree", "CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "SendMessage",
  "ListAgents", "Workflow", "WebSearch",
];

function systemPrompt(run: Run, t: Task): string {
  const scope = t.files.length ? t.files.join(", ") : "whatever the task needs";
  const links = run.link.length
    ? `\n- These paths are shared links into the main checkout: ${run.link.join(", ")}. Treat them as read-only: never delete, reinstall or modify them.`
    : "";
  return [
    `You are worker "${t.id}" on a parallel team coordinated by DeepSeek Harness. Other workers are changing other parts of the same project at the same time, each in its own git worktree. An orchestrator reviews and merges everyone's work afterwards.`,
    `Rules:`,
    `- Your working directory ${t.worktree} is your own git worktree (branch ${t.branch}). Read and edit files only inside it.`,
    `- Your scope: ${scope}. Change files outside it only when the task cannot be done otherwise, keep such changes minimal, and list them in your report.`,
    `- Do not commit, push, merge, rebase, switch branches, reset or stash. The harness commits your work when you finish.`,
    `- Nobody can answer questions while you work. When something is unclear, pick the most reasonable option, note the assumption, and keep going.`,
    `- Shell commands outside the allowed list are denied automatically. If one is denied, use another way instead of retrying it.${links}`,
    t.verify
      ? `- When you finish, the orchestrator runs \`${t.verify}\` in your worktree. Run it yourself first and fix what fails.`
      : `- Check your work before finishing (run the project's tests or build when there are any).`,
    `- End with a short report: files changed, how you verified, assumptions, anything left undone.`,
  ].join("\n");
}

function taskPrompt(t: Task): string {
  const parts = [`# Task ${t.id}: ${t.title}`, "", t.prompt.trim()];
  if (t.context?.trim()) parts.push("", "## Shared context (the same for every worker)", t.context.trim());
  if (t.files.length) parts.push("", "## Files you own", ...t.files.map((f) => `- ${f}`));
  if (t.verify) parts.push("", "## Check", `\`${t.verify}\` must pass in your worktree.`);
  return parts.join("\n");
}

function describeTool(t: Task, name: string, input: Record<string, unknown>): string {
  const rel = (p: unknown) => {
    const s = String(p ?? "");
    return s.toLowerCase().startsWith(t.worktree.toLowerCase()) ? s.slice(t.worktree.length + 1) : s;
  };
  if (input?.file_path) return `${name} ${rel(input.file_path)}`;
  if (name === "Bash" && input?.command) {
    // Show commands relative to the worktree: workers often cd into their absolute path first.
    let cmd = String(input.command);
    for (const p of [t.worktree, t.worktree.replace(/\\/g, "/")]) cmd = cmd.split(`"${p}"`).join(".").split(p).join(".");
    return `Bash: ${cmd.replace(/\s+/g, " ").slice(0, 70)}`;
  }
  if (input?.pattern) return `${name} ${String(input.pattern).slice(0, 60)}`;
  if (name === "Task" && input?.description) return `Task: ${String(input.description).slice(0, 60)}`;
  return name;
}

function onEvent(t: Task, a: Attempt, line: string) {
  let e: Record<string, any>;
  try {
    e = JSON.parse(line);
  } catch {
    return;
  }
  t.progress.at = Date.now();
  if (e.type === "system" && e.subtype === "init") {
    t.sessionId = a.sessionId = e.session_id;
    a.model = e.model;
  } else if (e.type === "assistant" && e.message) {
    if (e.message.id && e.message.id !== t.progress.msgId) {
      t.progress.msgId = e.message.id;
      t.progress.turns++;
    }
    for (const c of e.message.content ?? []) {
      if (c.type === "tool_use") {
        t.progress.tools++;
        t.progress.last = describeTool(t, c.name, c.input);
      } else if (c.type === "text" && c.text?.trim()) t.progress.lastText = c.text.trim().replace(/\s+/g, " ").slice(0, 160);
    }
  } else if (e.type === "result") {
    a.resultText = e.result ?? "";
    a.isError = !!e.is_error;
    a.subtype = e.subtype;
    a.turns = e.num_turns;
    a.usage = {
      input: (e.usage?.input_tokens ?? 0) + (e.usage?.cache_creation_input_tokens ?? 0) + (e.usage?.cache_read_input_tokens ?? 0),
      output: e.usage?.output_tokens ?? 0,
      cacheRead: e.usage?.cache_read_input_tokens ?? 0,
    };
    if (e.session_id) t.sessionId = a.sessionId = e.session_id;
  }
}

// ---------- links (shared dependency folders) ----------

async function makeLink(target: string, linkPath: string) {
  if (!exists(target)) throw new Error(`link: ${target} does not exist in the main checkout`);
  if (exists(linkPath)) throw new Error(`link: ${linkPath} already exists in the worktree (is it tracked by git?)`);
  ensureDir(join(linkPath, ".."));
  if (IS_WIN) {
    const dir = Deno.statSync(target).isDirectory;
    const r = await exec("cmd", ["/c", "mklink", dir ? "/J" : "/H", linkPath, target]);
    if (r.code !== 0) throw new Error(`mklink failed: ${(r.stderr || r.stdout).trim()}`);
  } else Deno.symlinkSync(target, linkPath);
}

// Remove only the link itself, never what it points to.
async function removeLink(linkPath: string): Promise<boolean> {
  if (!exists(linkPath)) return true;
  const st = Deno.lstatSync(linkPath);
  if (IS_WIN && (st.isSymlink || st.isDirectory)) {
    await exec("cmd", ["/c", "rmdir", linkPath]);
  } else if (st.isSymlink || st.isFile) Deno.removeSync(linkPath);
  return !exists(linkPath);
}

async function runCheck(command: string, cwd: string, file: string, onPid?: (pid: number) => void): Promise<CheckResult> {
  const [exe, args] = shellArgs(command);
  const t0 = Date.now();
  const r = await exec(exe, args, { cwd, env: cleanEnv(), clearEnv: true, timeoutMs: VERIFY_TIMEOUT_MS, onPid });
  const out = r.stdout + (r.stderr ? "\n" + r.stderr : "") + (r.timedOut ? `\n[timed out after ${fmtMs(VERIFY_TIMEOUT_MS)}]` : "");
  Deno.writeTextFileSync(file, `$ ${command}\n${out}\n[exit ${r.code}]\n`);
  return { ok: r.code === 0 && !r.timedOut, code: r.code, ms: Date.now() - t0, tail: tailText(out, 40, 3000), file, command };
}

// ---------- scheduler ----------

function activeCount(run?: Run): number {
  let n = 0;
  for (const r of run ? [run] : runs.values()) for (const t of r.tasks) if (ACTIVE.has(t.state)) n++;
  return n;
}

function pump() {
  for (const run of runs.values()) {
    for (const t of run.tasks) {
      if (t.state !== "queued") continue;
      if (activeCount() >= GLOBAL_MAX) return;
      if (activeCount(run) >= run.maxParallel) break;
      t.state = "preparing";
      startTask(run, t);
    }
  }
}

async function startTask(run: Run, t: Task) {
  notify();
  try {
    if (!exists(t.worktree)) {
      await repoLock(run.repo).run(() => G.worktreeAdd(run.repo, t.worktree, t.branch, t.baseSha));
      for (const l of run.link) await makeLink(join(run.repo, l), join(t.worktree, l));
      if (run.setup) {
        const r = await runCheck(run.setup, t.worktree, join(runDir(run.id), `${t.id}.setup.txt`), (pid) => (t.pid = pid));
        t.pid = undefined;
        if (!r.ok && !t.cancelRequested) throw new Error(`setup command failed (exit ${r.code}):\n${r.tail}`);
      }
    }
    if (t.cancelRequested) t.state = "cancelled";
    else await runWorker(run, t);
  } catch (e) {
    t.state = t.cancelRequested ? "cancelled" : "failed";
    t.error = String((e as Error).message ?? e);
    log("task failed", run.id, t.id, t.error);
  } finally {
    t.pid = undefined;
    t.seen = false;
    save(run, true);
    notify();
    pump();
  }
}

async function runWorker(run: Run, t: Task) {
  const key = await deepseekKey();
  const a: Attempt = { n: t.attempts.length + 1, startedAt: Date.now() };
  t.attempts.push(a);
  const resume = !!(t.resume && t.sessionId);
  const input = t.pendingInput ?? taskPrompt(t);
  t.pendingInput = undefined;
  t.resume = false;
  t.timedOut = false;
  t.progress = { turns: 0, tools: 0, at: Date.now() };
  const allowed = [...DEFAULT_ALLOWED, ...run.allowedTools];
  const args = [
    "-p", "--output-format", "stream-json", "--verbose",
    "--permission-mode", run.permissionMode, "--permission-prompts", "none",
    "--strict-mcp-config", "--setting-sources", "project,local",
    "--effort", t.effort,
    ...(t.maxTurns ? ["--max-turns", String(t.maxTurns)] : []),
    ...(resume ? ["--resume", t.sessionId!] : []),
    "--append-system-prompt", systemPrompt(run, t),
    "--allowedTools", ...allowed,
    "--disallowedTools", ...DEFAULT_DENIED,
  ];
  const child = new Deno.Command(findClaude(), {
    args,
    cwd: t.worktree,
    env: workerEnv(modelId(t.model), key),
    clearEnv: true,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const pkey = `${run.id}/${t.id}`;
  procs.set(pkey, child);
  t.pid = child.pid;
  t.state = "running";
  if (t.cancelRequested) killTree(child.pid); // cancel arrived while the process was starting
  save(run);
  notify();
  (async () => {
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode(input));
    await w.close();
  })().catch(() => {});
  const timer = setTimeout(() => {
    t.timedOut = true;
    killTree(child.pid);
  }, t.timeoutMin * 60_000);
  const logFile = await Deno.open(join(runDir(run.id), `${t.id}.jsonl`), { create: true, append: true });
  const errFile = await Deno.open(join(runDir(run.id), `${t.id}.stderr.txt`), { create: true, append: true });
  const readOut = (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of child.stdout) {
      await logFile.write(chunk);
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        onEvent(t, a, buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    }
    if (buf.trim()) onEvent(t, a, buf);
  })();
  const readErr = (async () => {
    for await (const chunk of child.stderr) await errFile.write(chunk);
  })();
  const status = await child.status;
  await Promise.allSettled([readOut, readErr]);
  clearTimeout(timer);
  logFile.close();
  errFile.close();
  procs.delete(pkey);
  t.pid = undefined;
  a.endedAt = Date.now();
  a.exitCode = status.code;
  t.state = t.cancelRequested ? "cancelled" : t.timedOut ? "timeout" : "finishing";
  if (t.state === "timeout") t.error = `Timed out after ${t.timeoutMin} min; partial work is kept on the branch.`;
  notify();
  await finish(run, t, a);
}

async function finish(run: Run, t: Task, a: Attempt) {
  let recordError = "";
  try {
    const sha = await G.checkpoint(t.worktree, `${t.id}: ${t.title} (attempt ${a.n})`, run.link);
    if (sha) t.merged = false;
    t.headSha = (await G.git(t.worktree, ["rev-parse", "HEAD"])).stdout.trim();
    const changes = await G.rawDiff(run.repo, t.baseSha, t.headSha);
    t.changed = changes.map((c) => c.path);
    t.outOfScope = t.files.length ? t.changed.filter((p) => !inScope(p, t.files)) : [];
    t.diffStat = await G.diffStat(run.repo, t.baseSha, t.headSha);
    t.patchFile = join(runDir(run.id), `${t.id}.patch`);
    Deno.writeTextFileSync(t.patchFile, await G.patch(run.repo, t.baseSha, t.headSha));
  } catch (e) {
    recordError = `Could not record the worker's changes: ${(e as Error).message}`;
    log("record failed", run.id, t.id, recordError);
    t.error = `${t.error ? t.error + " " : ""}${recordError}`;
  }
  if (t.state !== "finishing") return;
  const workerOk = a.exitCode === 0 && a.isError === false;
  if (t.verify && t.changed?.length && !recordError) {
    t.verifyResult = await runCheck(t.verify, t.worktree, join(runDir(run.id), `${t.id}.verify.txt`));
  }
  if (recordError) {
    t.state = "failed";
    t.error = recordError;
  } else if (!workerOk) {
    t.state = "failed";
    t.error = a.isError
      ? `Worker stopped with ${a.subtype ?? "an error"}: ${clip(a.resultText ?? "", 400)}`
      : `Worker exited with code ${a.exitCode} and no result. See ${join(runDir(run.id), `${t.id}.stderr.txt`)}`;
  } else if (t.verifyResult && !t.verifyResult.ok) {
    t.state = "failed";
    t.error = `Check \`${t.verify}\` failed (exit ${t.verifyResult.code}).`;
  } else {
    t.state = "done";
    t.error = undefined;
  }
}

// ---------- reporting ----------

function taskTime(t: Task): number {
  return t.attempts.reduce((s, a) => s + ((a.endedAt ?? Date.now()) - a.startedAt), 0);
}

function usageOf(t: Task): Usage {
  const u = { input: 0, output: 0, cacheRead: 0 };
  for (const a of t.attempts) {
    u.input += a.usage?.input ?? 0;
    u.output += a.usage?.output ?? 0;
    u.cacheRead += a.usage?.cacheRead ?? 0;
  }
  return u;
}

function nowText(t: Task): string {
  if (t.state === "running") return t.progress.last ?? "starting";
  if (t.state === "preparing") return "creating worktree";
  if (t.state === "finishing") return t.verify ? `checking: ${t.verify}` : "recording changes";
  if (t.state === "queued") return t.attempts.length ? "queued for retry" : "waiting for a free slot";
  const n = t.changed?.length ?? 0;
  const v = t.verifyResult ? (t.verifyResult.ok ? "check passed" : "check FAILED") : t.verify ? "check skipped" : "";
  const s = [`${n} file${n === 1 ? "" : "s"}`, v, t.outOfScope?.length ? `${t.outOfScope.length} outside scope` : ""].filter(Boolean).join(" · ");
  return t.state === "done" ? s : `${t.error ? clip(t.error.split("\n")[0], 90) : t.state}${n ? " · " + s : ""}`;
}

export function statusText(run: Run, note = ""): string {
  const rows = run.tasks.map((t) => [
    t.id,
    t.state,
    String(t.attempts.length || "-"),
    fmtMs(t.attempts.length ? taskTime(t) : undefined),
    String(t.state === "running" ? t.progress.turns : t.attempts.at(-1)?.turns ?? t.progress.turns ?? "-"),
    nowText(t),
  ]);
  const head = ["TASK", "STATE", "TRY", "TIME", "TURNS", "NOW / RESULT"];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (r: string[]) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]))).join("  ");
  const count = (s: TaskState) => run.tasks.filter((t) => t.state === s).length;
  const starts = run.tasks.flatMap((t) => t.attempts.map((a) => a.startedAt));
  const ends = run.tasks.flatMap((t) => t.attempts.map((a) => a.endedAt ?? Date.now()));
  const wall = starts.length ? Math.max(...ends) - Math.min(...starts) : 0;
  const work = run.tasks.reduce((s, t) => s + taskTime(t), 0);
  const u = run.tasks.map(usageOf).reduce((x, y) => ({ input: x.input + y.input, output: x.output + y.output, cacheRead: x.cacheRead + y.cacheRead }), { input: 0, output: 0, cacheRead: 0 });
  const lines = [
    `Run ${run.id} · ${run.repo} · base ${run.baseSha.slice(0, 8)} (${run.baseLabel})${run.cleaned ? " · cleaned up" : ""}`,
    fmt(head),
    ...rows.map(fmt),
    `done ${count("done")} · running ${count("running") + count("preparing") + count("finishing")} · queued ${count("queued")} · failed ${count("failed") + count("timeout")} · cancelled ${count("cancelled")}` +
    (wall ? ` · wall ${fmtMs(wall)}, worker time ${fmtMs(work)} (${(work / wall).toFixed(1)}x)` : ""),
    `tokens: in ${fmtTokens(u.input)} (cache hits ${fmtTokens(u.cacheRead)}) · out ${fmtTokens(u.output)}`,
  ];
  if (run.integration) {
    const I = run.integration;
    lines.push(`integration: ${I.merged.length} merged into ${I.branch}${I.conflict ? ` · CONFLICT while merging ${I.conflict.taskId}` : ""}${I.verifyResult ? ` · check ${I.verifyResult.ok ? "passed" : "FAILED"}` : ""}${run.landedSha ? " · landed" : ""}`);
  }
  if (note) lines.push("", note);
  return lines.join("\n");
}

export function listRunsText(): string {
  const all = [...runs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 15);
  if (!all.length) return "No runs yet.";
  return all.map((r) => {
    const c = (s: TaskState) => r.tasks.filter((t) => t.state === s).length;
    const active = r.tasks.filter((t) => !TERMINAL.has(t.state)).length;
    return `${r.id}  ${new Date(r.createdAt).toLocaleString()}  ${r.repo}  tasks ${r.tasks.length} (done ${c("done")}, active ${active}, failed ${c("failed") + c("timeout")})${r.landedSha ? " · landed" : ""}${r.cleaned ? " · cleaned" : ""}`;
  }).join("\n");
}

// ---------- tool implementations ----------

export interface TaskSpecInput {
  id: string;
  title?: string;
  prompt: string;
  files?: string[];
  verify?: string;
  model?: string;
  effort?: string;
  maxTurns?: number;
}

export interface DispatchInput {
  repo: string;
  tasks: TaskSpecInput[];
  runId?: string;
  base?: string;
  context?: string;
  verify?: string;
  setup?: string;
  link?: string[];
  model?: string;
  effort?: string;
  maxParallel?: number;
  timeoutMin?: number;
  maxTurns?: number;
  allowedTools?: string[];
  permissionMode?: string;
}

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export async function dispatch(a: DispatchInput): Promise<string> {
  if (!a.tasks?.length) throw new Error("tasks must list at least one task");
  findClaude();
  await deepseekKey();
  const repo = await G.repoRoot(a.repo);
  let run: Run;
  const warnings: string[] = [];
  if (a.runId) {
    run = getRun(a.runId);
    if (run.cleaned) throw new Error(`Run ${run.id} was cleaned up; start a new run.`);
    if (run.repo.toLowerCase() !== repo.toLowerCase()) throw new Error(`Run ${run.id} belongs to ${run.repo}, not ${repo}`);
  } else {
    const id = newRunId();
    ensureDir(runDir(id));
    run = {
      id, repo, createdAt: Date.now(), baseSha: "", baseLabel: "", link: [], allowedTools: [],
      permissionMode: "acceptEdits", maxParallel: 6, tasks: [],
    };
  }
  if (a.permissionMode) {
    if (!["acceptEdits", "bypassPermissions"].includes(a.permissionMode)) throw new Error("permissionMode must be acceptEdits or bypassPermissions");
    run.permissionMode = a.permissionMode;
  }
  if (a.context !== undefined) run.context = a.context;
  if (a.verify !== undefined) run.verify = a.verify;
  if (a.setup !== undefined) run.setup = a.setup;
  if (a.link) run.link = a.link.map((l) => l.replace(/[\\/]+$/, ""));
  if (a.allowedTools) run.allowedTools = a.allowedTools;
  if (a.maxParallel) run.maxParallel = Math.max(1, Math.min(GLOBAL_MAX, a.maxParallel));

  const ids = new Set(run.tasks.map((t) => t.id));
  for (const s of a.tasks) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(s.id ?? "")) throw new Error(`Bad task id "${s.id}": use letters, digits, - and _ (max 40).`);
    if (ids.has(s.id)) throw new Error(`Duplicate task id ${s.id}`);
    if (!s.prompt?.trim()) throw new Error(`Task ${s.id} has no prompt`);
    for (const e of [s.effort, a.effort]) if (e && !EFFORTS.has(e)) throw new Error(`effort must be one of ${[...EFFORTS].join(", ")}`);
    ids.add(s.id);
  }

  // Base commit for the new tasks.
  const base = a.base ?? "snapshot";
  let baseSha: string, baseLabel: string;
  const head = await G.headSha(repo);
  if (base === "snapshot") {
    const dirty = await G.isDirty(repo);
    if (dirty) {
      baseSha = await repoLock(repo).run(() => G.snapshot(repo, join(runDir(run.id), `snapshot-${Date.now()}.index`)));
      baseLabel = "snapshot of the working tree, uncommitted changes included";
    } else {
      if (!head) throw new Error("The repository has no commits and no files to snapshot.");
      baseSha = head;
      baseLabel = "HEAD";
    }
  } else if (base === "head") {
    if (!head) throw new Error("The repository has no commits yet.");
    baseSha = head;
    baseLabel = "HEAD";
    if (await G.isDirty(repo)) warnings.push("The working tree has uncommitted changes; base \"head\" leaves them out of the workers' copies.");
  } else if (base === "integration") {
    if (!run.integration?.headSha) throw new Error("This run has no integration branch yet; call integrate first.");
    if (run.integration.conflict) throw new Error("The integration branch has an unresolved merge; finish it first.");
    baseSha = run.integration.headSha;
    baseLabel = "integration branch";
  } else {
    baseSha = await G.resolveCommit(repo, base);
    baseLabel = base;
  }
  if (!run.baseSha) {
    run.baseSha = baseSha;
    run.baseLabel = baseLabel;
  }

  for (const d of ["node_modules", ".venv", "venv", "vendor"]) {
    if (exists(join(repo, d)) && !run.link.includes(d)) {
      const ignored = (await G.git(repo, ["check-ignore", "-q", d], { check: false })).code === 0;
      if (ignored && !run.setup) {
        warnings.push(`${d}/ is git-ignored, so worktrees start without it. Pass link: ["${d}"] to share it read-only, or setup to rebuild it.`);
      }
    }
  }

  for (const s of a.tasks) {
    run.tasks.push({
      id: s.id,
      title: s.title?.trim() || s.id,
      prompt: s.prompt,
      files: s.files ?? [],
      verify: s.verify ?? run.verify,
      context: run.context,
      model: s.model ?? a.model ?? "flash",
      effort: s.effort ?? a.effort ?? "max",
      maxTurns: s.maxTurns ?? a.maxTurns,
      timeoutMin: a.timeoutMin ?? 30,
      branch: `dsh/${run.id}/${s.id}`,
      worktree: join(wtDir(run.id), s.id),
      baseSha,
      state: "queued",
      attempts: [],
      progress: { turns: 0, tools: 0 },
    });
  }
  runs.set(run.id, run);
  save(run, true);
  pump();
  const lines = [
    `${a.runId ? "Added" : "Started"} ${a.tasks.length} task(s) in run ${run.id}; up to ${run.maxParallel} run at once.`,
    `Base: ${baseSha.slice(0, 8)} (${baseLabel}). Model: ${modelId(a.model)}. Worktrees: ${wtDir(run.id)}`,
    ...warnings.map((w) => `Warning: ${w}`),
    "",
    statusText(run),
    "",
    `Next: wait (mode "any" to review tasks as they finish), then result.`,
  ];
  return lines.join("\n");
}

export async function wait(
  a: { runId: string; taskIds?: string[]; mode?: string; timeoutSec?: number },
  progress?: (done: number, total: number, msg: string) => void,
): Promise<string> {
  const run = getRun(a.runId);
  const tasks = a.taskIds?.length ? a.taskIds.map((id) => getTask(run, id)) : run.tasks;
  const mode = a.mode === "any" ? "any" : "all";
  const deadline = Date.now() + Math.max(1, Math.min(3600, a.timeoutSec ?? 240)) * 1000;
  const allDone = () => tasks.every((t) => TERMINAL.has(t.state));
  const cond = () => allDone() || (mode === "any" && tasks.some((t) => TERMINAL.has(t.state) && !t.seen));
  while (!cond() && Date.now() < deadline) {
    await new Promise<void>((res) => {
      const tm = setTimeout(() => l(), Math.max(1, Math.min(15_000, deadline - Date.now())));
      const l = () => {
        listeners.delete(l);
        clearTimeout(tm);
        res();
      };
      listeners.add(l);
    });
    const done = tasks.filter((t) => TERMINAL.has(t.state)).length;
    progress?.(done, tasks.length, `${done}/${tasks.length} tasks finished`);
  }
  const fresh = tasks.filter((t) => TERMINAL.has(t.state) && !t.seen);
  const note = cond()
    ? (allDone()
      ? `All ${tasks.length} task(s) have finished.`
      : `Newly finished: ${fresh.map((t) => `${t.id} (${t.state})`).join(", ")}. Others are still running.`) +
      " Next: result for these tasks; retry with feedback where needed."
    : `Still running after ${a.timeoutSec ?? 240}s. Call wait again, or do other work meanwhile.`;
  for (const t of fresh) t.seen = true;
  return statusText(run, note);
}

export function status(a: { runId?: string }): string {
  return a.runId ? statusText(getRun(a.runId)) : listRunsText();
}

export function result(a: { runId: string; taskIds?: string[]; includeDiff?: boolean; maxDiffChars?: number }): string {
  const run = getRun(a.runId);
  const tasks = a.taskIds?.length ? a.taskIds.map((id) => getTask(run, id)) : run.tasks.filter((t) => TERMINAL.has(t.state));
  if (!tasks.length) return "No finished tasks yet.";
  const max = a.maxDiffChars ?? 12000;
  const out: string[] = [];
  for (const t of tasks) {
    const last = t.attempts.at(-1);
    const u = usageOf(t);
    out.push(
      `## ${t.id} — ${t.state}${t.attempts.length ? ` (attempt ${t.attempts.length}, ${fmtMs(taskTime(t))}, ${last?.turns ?? t.progress.turns} turns, ${fmtTokens(u.input)} in / ${fmtTokens(u.output)} out)` : ""}`,
      `Title: ${t.title}`,
      `Branch ${t.branch} · worktree ${t.worktree}${t.sessionId ? ` · session ${t.sessionId}` : ""}`,
    );
    if (t.error) out.push(`Problem: ${t.error}`);
    if (!TERMINAL.has(t.state)) {
      out.push(`Still ${t.state}: ${nowText(t)}`, "");
      continue;
    }
    out.push("", "Worker report:", last?.resultText?.trim() ? clip(last.resultText.trim(), 4000) : "(none)");
    out.push("", `Files changed (${t.changed?.length ?? 0}):`, t.diffStat || "(no changes)");
    if (t.outOfScope?.length) out.push(`Outside the task's scope: ${t.outOfScope.join(", ")}`);
    if (t.verifyResult) {
      out.push(`Check \`${t.verifyResult.command}\`: ${t.verifyResult.ok ? "passed" : `FAILED (exit ${t.verifyResult.code})`} in ${fmtMs(t.verifyResult.ms)} · log ${t.verifyResult.file}`);
      if (!t.verifyResult.ok) out.push("```", t.verifyResult.tail, "```");
    }
    if (t.patchFile && t.changed?.length) {
      out.push(`Full patch: ${t.patchFile}`);
      if (a.includeDiff !== false) {
        try {
          out.push("```diff", clip(Deno.readTextFileSync(t.patchFile), max), "```");
        } catch { /* patch missing */ }
      }
    }
    out.push("");
    t.seen = true;
  }
  out.push("Next: retry tasks that need fixes (with specific feedback), then integrate.");
  return out.join("\n");
}

export function retry(a: { runId: string; taskId: string; feedback: string; fresh?: boolean; model?: string; effort?: string; timeoutMin?: number }): string {
  const run = getRun(a.runId);
  const t = getTask(run, a.taskId);
  if (run.cleaned) throw new Error("This run was cleaned up.");
  if (!TERMINAL.has(t.state)) throw new Error(`Task ${t.id} is ${t.state}; cancel it first or wait.`);
  if (!a.feedback?.trim()) throw new Error("feedback is required: say what is wrong and what to change.");
  if (a.effort && !EFFORTS.has(a.effort)) throw new Error(`effort must be one of ${[...EFFORTS].join(", ")}`);
  const verifyNote = t.verifyResult && !t.verifyResult.ok
    ? `\n\nThe check \`${t.verifyResult.command}\` failed (exit ${t.verifyResult.code}). Last output:\n\`\`\`\n${t.verifyResult.tail}\n\`\`\``
    : "";
  const fresh = a.fresh || !t.sessionId;
  t.pendingInput = fresh
    ? `${taskPrompt(t)}\n\n## Feedback on the previous attempt\nThe previous attempt's changes are already in this worktree; continue from them.\n\n${a.feedback.trim()}${verifyNote}`
    : `Feedback from the orchestrator on your work:\n\n${a.feedback.trim()}${verifyNote}\n\nFix this in the same worktree, check again, and end with an updated report.`;
  t.resume = !fresh;
  if (a.model) t.model = a.model;
  if (a.effort) t.effort = a.effort;
  if (a.timeoutMin) t.timeoutMin = a.timeoutMin;
  t.state = "queued";
  t.error = undefined;
  t.verifyResult = undefined;
  t.seen = false;
  t.cancelRequested = false;
  save(run, true);
  pump();
  return `Task ${t.id} queued again (${fresh ? "fresh session" : `resuming session ${t.sessionId}`}).\n\n${statusText(run)}`;
}

export async function cancel(a: { runId: string; taskIds?: string[] }): Promise<string> {
  const run = getRun(a.runId);
  const tasks = a.taskIds?.length ? a.taskIds.map((id) => getTask(run, id)) : run.tasks;
  const hit: string[] = [];
  for (const t of tasks) {
    if (t.state === "queued") {
      t.state = "cancelled";
      hit.push(t.id);
    } else if (ACTIVE.has(t.state)) {
      t.cancelRequested = true;
      await killTree(t.pid);
      hit.push(t.id);
    }
  }
  save(run, true);
  notify();
  return `Cancelling: ${hit.join(", ") || "nothing was queued or running"}. Partial work is kept on each task's branch.`;
}

async function ensureIntegration(run: Run): Promise<Integration> {
  if (run.integration) {
    if (!exists(run.integration.worktree)) throw new Error(`The integration worktree ${run.integration.worktree} is missing; land single tasks instead, or start a new run.`);
    return run.integration;
  }
  const I: Integration = { branch: `dsh/${run.id}/integration`, worktree: join(wtDir(run.id), "_integration"), merged: [], headSha: run.baseSha };
  await repoLock(run.repo).run(() => G.worktreeAdd(run.repo, I.worktree, I.branch, run.baseSha));
  for (const l of run.link) await makeLink(join(run.repo, l), join(I.worktree, l));
  for (const t of run.tasks) t.merged = false;
  run.integration = I;
  save(run, true);
  return I;
}

export async function integrate(a: { runId: string; taskIds?: string[]; verify?: string; continue?: boolean; abort?: boolean }): Promise<string> {
  const run = getRun(a.runId);
  if (run.cleaned) throw new Error("This run was cleaned up.");
  const I = await ensureIntegration(run);
  const notes: string[] = [];
  if (I.conflict) {
    if (a.abort) {
      await G.git(I.worktree, ["merge", "--abort"], { check: false });
      notes.push(`Aborted the merge of ${I.conflict.taskId}. Retry that task with base "integration" or merge it later.`);
      I.conflict = undefined;
      save(run, true);
      return notes.join("\n") + "\n\n" + statusText(run);
    }
    if (!a.continue) {
      return `The merge of ${I.conflict.taskId} is waiting for conflict resolution in ${I.worktree}:\n${I.conflict.files.map((f) => `- ${f}`).join("\n")}\nEdit those files there (remove the conflict markers), then call integrate with continue: true. Or call integrate with abort: true.`;
    }
    const left = await G.unmergedFiles(I.worktree);
    const marked: string[] = [];
    for (const f of I.conflict.files) {
      try {
        if (/^(<<<<<<<|>>>>>>>) /m.test(Deno.readTextFileSync(join(I.worktree, f)))) marked.push(f);
      } catch { /* deleted */ }
    }
    if (marked.length) throw new Error(`Conflict markers are still in: ${marked.join(", ")}`);
    await G.addAll(I.worktree, run.link);
    await G.git(I.worktree, ["commit", "--no-edit", "--no-verify"], { env: G.IDENTITY });
    const t = getTask(run, I.conflict.taskId);
    t.merged = true;
    I.merged.push(t.id);
    notes.push(`Finished the merge of ${t.id}${left.length ? ` (resolved ${left.length} file(s))` : ""}.`);
    I.conflict = undefined;
  }
  const ids = a.taskIds?.length ? a.taskIds : run.tasks.filter((t) => t.state === "done" && !t.merged).map((t) => t.id);
  for (const id of ids) {
    const t = getTask(run, id);
    if (!TERMINAL.has(t.state)) {
      notes.push(`Skipped ${id}: still ${t.state}.`);
      continue;
    }
    if (!t.headSha || !t.changed?.length) {
      t.merged = true;
      notes.push(`Skipped ${id}: no changes.`);
      continue;
    }
    if (t.merged) continue;
    const r = await G.git(I.worktree, ["merge", "--no-ff", "--no-verify", "-m", `harness: ${t.id} - ${t.title}`, t.branch], { env: G.IDENTITY, check: false });
    if (r.code !== 0) {
      const files = await G.unmergedFiles(I.worktree);
      if (!files.length) throw new Error(`Merging ${id} failed: ${(r.stderr || r.stdout).trim()}`);
      I.conflict = { taskId: id, files };
      save(run, true);
      return [
        ...notes,
        `CONFLICT merging ${id} into ${I.branch}. Files with conflict markers in ${I.worktree}:`,
        ...files.map((f) => `- ${f}`),
        `Resolve them there (Read/Edit the files), then call integrate with continue: true. Or call integrate with abort: true and dispatch ${id}'s work again under a new id with runId and base "integration".`,
      ].join("\n");
    }
    t.merged = true;
    I.merged.push(id);
    notes.push(`Merged ${id}.`);
  }
  I.headSha = (await G.git(I.worktree, ["rev-parse", "HEAD"])).stdout.trim();
  const from = run.landedSha ?? run.baseSha;
  const stat = await G.diffStat(run.repo, from, I.headSha);
  const check = a.verify ?? run.verify;
  if (check) I.verifyResult = await runCheck(check, I.worktree, join(runDir(run.id), "_integration.verify.txt"));
  save(run, true);
  const out = [...notes, "", `Integration branch ${I.branch} (${I.worktree}), changes not yet landed:`, stat || "(none)"];
  if (I.verifyResult && check) {
    out.push("", `Check \`${check}\` on the combined result: ${I.verifyResult.ok ? "passed" : `FAILED (exit ${I.verifyResult.code})`} in ${fmtMs(I.verifyResult.ms)}`);
    if (!I.verifyResult.ok) out.push("```", I.verifyResult.tail, "```", `Fix it in ${I.worktree} and integrate again (with taskIds: [] to only re-run the check), or retry the task at fault.`);
  }
  out.push("", `Next: land to apply these changes to ${run.repo} as uncommitted edits.`);
  return out.join("\n");
}

export async function land(a: { runId: string; source?: string; dryRun?: boolean }): Promise<string> {
  const run = getRun(a.runId);
  const root = run.repo;
  let from: string, to: string, label: string;
  let task: Task | undefined;
  if (!a.source || a.source === "integration") {
    const I = run.integration;
    if (!I?.headSha) throw new Error("Nothing integrated yet; call integrate first (or land a single task with source: <taskId>).");
    if (I.conflict) throw new Error(`The integration merge of ${I.conflict.taskId} is unresolved.`);
    from = run.landedSha ?? run.baseSha;
    to = I.headSha;
    label = "the integration branch";
  } else {
    task = getTask(run, a.source);
    if (!task.headSha) throw new Error(`Task ${task.id} has no recorded changes.`);
    from = task.baseSha;
    to = task.headSha;
    label = `task ${task.id}`;
  }
  if (from === to) return `Nothing new to land from ${label}.`;
  return await repoLock(root).run(async () => {
    const changes = await G.rawDiff(root, from, to);
    const current = await G.hashWorkingFiles(root, changes.map((c) => c.path));
    const tmp = join(runDir(run.id), "tmp");
    ensureDir(tmp);
    const applied: string[] = [], merged: string[] = [], same: string[] = [], conflicts: string[] = [], skipped: string[] = [];
    let k = 0;
    for (const c of changes) {
      const abs = join(root, c.path);
      if (c.oldMode === "160000" || c.newMode === "160000" || c.oldMode === "120000" || c.newMode === "120000") {
        skipped.push(`${c.path} (submodule or symlink: apply by hand)`);
        continue;
      }
      const cur = current.get(c.path) ?? null;
      const curBytes = cur ? Deno.readFileSync(abs) : null;
      if (cur === c.oldBlob) {
        if (!a.dryRun) {
          if (c.newBlob) {
            ensureDir(join(abs, ".."));
            // Keep the line endings the file already has; new files get git's checkout form.
            const body = await G.catFiltered(root, to, c.path);
            Deno.writeFileSync(abs, curBytes ? withEol(body, eolOf(curBytes)) : body);
            if (!IS_WIN && c.newMode === "100755") Deno.chmodSync(abs, 0o755);
          } else Deno.removeSync(abs);
        }
        applied.push(`${c.status} ${c.path}`);
      } else if (cur === c.newBlob) {
        same.push(c.path);
      } else if (curBytes && c.oldBlob && c.newBlob) {
        // The file changed in the working tree after the workers started: three-way merge it,
        // with all three sides in LF so a line-ending difference alone is not a conflict.
        const sides = [curBytes, await G.catFiltered(root, from, c.path), await G.catFiltered(root, to, c.path)];
        if (sides.some(isBinary)) {
          conflicts.push(`${c.path}: binary file changed on both sides; the harness version is at ${c.path}.harness-incoming`);
          if (!a.dryRun) Deno.writeFileSync(`${abs}.harness-incoming`, sides[2]);
          continue;
        }
        const files = ["ours", "base", "theirs"].map((n) => join(tmp, `${n}-${k}`));
        k++;
        sides.forEach((b, i) => Deno.writeFileSync(files[i], toLF(b)));
        const r = await exec("git", ["merge-file", "-p", "-L", "working tree", "-L", "harness base", "-L", "harness", ...files], { cwd: root });
        if (r.code < 0 || r.code >= 128) {
          conflicts.push(`${c.path}: git merge-file failed (${r.stderr.trim()}); the harness version is at ${c.path}.harness-incoming`);
          if (!a.dryRun) Deno.writeFileSync(`${abs}.harness-incoming`, sides[2]);
          continue;
        }
        if (!a.dryRun) Deno.writeFileSync(abs, withEol(r.bytes, eolOf(curBytes)));
        if (r.code === 0) merged.push(c.path);
        else conflicts.push(`${c.path}: ${r.code} conflict(s)${a.dryRun ? "" : ", markers written into the file"}`);
      } else {
        const why = !cur ? "deleted in the working tree" : !c.oldBlob ? "also created in the working tree" : "deleted by the harness but edited in the working tree";
        conflicts.push(`${c.path}: ${why}${c.newBlob ? `; the harness version is at ${c.path}.harness-incoming` : ""}`);
        if (!a.dryRun && c.newBlob) Deno.writeFileSync(`${abs}.harness-incoming`, await G.catFiltered(root, to, c.path));
      }
    }
    try {
      Deno.removeSync(tmp, { recursive: true });
    } catch { /* gone */ }
    if (!a.dryRun) {
      if (task) task.landed = true;
      else run.landedSha = to;
      save(run, true);
    }
    const sec = (title: string, xs: string[]) => (xs.length ? [`${title} (${xs.length}):`, ...xs.map((x) => `  ${x}`)] : []);
    return [
      `${a.dryRun ? "Dry run: would land" : "Landed"} ${label} into ${root} as uncommitted changes (nothing was committed).`,
      ...sec("Applied", applied),
      ...sec("Merged with your newer edits", merged),
      ...sec("Already identical", same),
      ...sec("CONFLICTS to resolve", conflicts),
      ...sec("Skipped", skipped),
      "",
      a.dryRun ? "Call land without dryRun to apply." : "Review with git status / git diff, run the tests, then commit if the user wants it. cleanup removes the worktrees and branches.",
    ].join("\n");
  });
}

export async function cleanup(a: { runId: string; force?: boolean; deleteLogs?: boolean }): Promise<string> {
  const run = getRun(a.runId);
  const busy = run.tasks.filter((t) => !TERMINAL.has(t.state));
  if (busy.length && !a.force) throw new Error(`Tasks still active: ${busy.map((t) => t.id).join(", ")}. Cancel them or pass force: true.`);
  const integrationLanded = !!run.landedSha && run.landedSha === run.integration?.headSha;
  const unlanded = run.tasks.filter((t) => t.changed?.length && !t.landed && !(integrationLanded && run.integration!.merged.includes(t.id)));
  if (unlanded.length && !a.force) {
    throw new Error(`Work not landed yet: ${unlanded.map((t) => t.id).join(", ")}. Land it first, or pass force: true to delete those branches anyway.`);
  }
  if (busy.length) {
    await cancel({ runId: run.id });
    for (let i = 0; i < 40 && run.tasks.some((t) => ACTIVE.has(t.state)); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const notes: string[] = [];
  const trees = [...run.tasks.map((t) => t.worktree), ...(run.integration ? [run.integration.worktree] : [])];
  await repoLock(run.repo).run(async () => {
    for (const wt of trees) {
      if (!exists(wt)) continue;
      let linksGone = true;
      for (const l of run.link) linksGone = (await removeLink(join(wt, l))) && linksGone;
      if (!linksGone) {
        notes.push(`Kept ${wt}: a shared link inside it could not be removed safely.`);
        continue;
      }
      const r = await G.git(run.repo, ["worktree", "remove", "--force", wt], { check: false });
      if (r.code !== 0) notes.push(`git worktree remove ${wt}: ${r.stderr.trim()}`);
    }
    await G.git(run.repo, ["worktree", "prune"], { check: false });
    for (const b of await G.listBranches(run.repo, `dsh/${run.id}`)) await G.git(run.repo, ["branch", "-D", b], { check: false });
  });
  try {
    const leftover = [...Deno.readDirSync(wtDir(run.id))];
    if (!leftover.length) Deno.removeSync(wtDir(run.id));
    else notes.push(`Left ${wtDir(run.id)} in place (${leftover.length} item(s) remain).`);
  } catch { /* already gone */ }
  run.cleaned = true;
  if (a.deleteLogs) {
    runs.delete(run.id);
    try {
      Deno.removeSync(runDir(run.id), { recursive: true });
    } catch { /* gone */ }
  } else save(run, true);
  return [`Cleaned up run ${run.id}: worktrees and dsh/${run.id}/* branches removed${a.deleteLogs ? ", logs deleted" : `; logs kept in ${runDir(run.id)}`}.`, ...notes].join("\n");
}
