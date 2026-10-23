// Shared helpers: paths, logging, processes, environment for DeepSeek workers.

export const IS_WIN = Deno.build.os === "windows";
export const SEP = IS_WIN ? "\\" : "/";
export const HOME = Deno.env.get("USERPROFILE") ?? Deno.env.get("HOME") ?? ".";
export const DSH_HOME = Deno.env.get("DSH_HOME") ?? join(HOME, ".deepseek-harness");

const enc = new TextEncoder();
const dec = new TextDecoder();

export function join(...parts: string[]): string {
  const s = parts.filter((p) => p !== "").join(SEP);
  return IS_WIN ? s.replace(/\//g, "\\").replace(/(?<!^)\\{2,}/g, "\\") : s.replace(/\/{2,}/g, "/");
}

export function normPath(p: string): string {
  let s = p.trim();
  if (IS_WIN) s = s.replace(/\//g, "\\");
  return s.length > 3 ? s.replace(/[\\/]+$/, "") : s;
}

export function exists(p: string): boolean {
  try {
    Deno.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export function ensureDir(p: string) {
  Deno.mkdirSync(p, { recursive: true });
}

export function log(...a: unknown[]) {
  const line = `[${new Date().toISOString()}] ${a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")}\n`;
  try {
    Deno.stderr.writeSync(enc.encode(line));
  } catch { /* stderr closed */ }
  try {
    Deno.writeTextFileSync(join(DSH_HOME, "server.log"), line, { append: true });
  } catch { /* log dir missing */ }
}

export class Mutex {
  #tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.#tail.then(fn);
    this.#tail = r.catch(() => {});
    return r;
  }
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  bytes: Uint8Array;
  timedOut: boolean;
}

async function readAll(s: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(s).arrayBuffer());
}

export async function exec(
  cmd: string,
  args: string[],
  o: {
    cwd?: string;
    env?: Record<string, string>;
    clearEnv?: boolean;
    input?: string | Uint8Array;
    timeoutMs?: number;
    onPid?: (pid: number) => void;
  } = {},
): Promise<ExecResult> {
  const child = new Deno.Command(cmd, {
    args,
    cwd: o.cwd,
    env: o.env,
    clearEnv: o.clearEnv,
    stdin: o.input !== undefined ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  o.onPid?.(child.pid);
  // Feed stdin while the output is drained, so a chatty child can't deadlock on a full pipe.
  const writing = o.input !== undefined
    ? (async () => {
      const w = child.stdin.getWriter();
      try {
        await w.write(typeof o.input === "string" ? enc.encode(o.input) : o.input!);
      } finally {
        await w.close().catch(() => {});
      }
    })().catch(() => {})
    : Promise.resolve();
  let timedOut = false;
  const timer = o.timeoutMs
    ? setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, o.timeoutMs)
    : undefined;
  const [out, err] = await Promise.all([readAll(child.stdout), readAll(child.stderr), writing]);
  const status = await child.status;
  clearTimeout(timer);
  return { code: status.code, stdout: dec.decode(out), stderr: dec.decode(err), bytes: out, timedOut };
}

export async function killTree(pid: number | undefined) {
  if (!pid) return;
  try {
    if (IS_WIN) {
      await new Deno.Command("taskkill", { args: ["/PID", String(pid), "/T", "/F"], stdout: "null", stderr: "null" }).output();
    } else {
      Deno.kill(pid, "SIGTERM");
    }
  } catch { /* already gone */ }
}

// Glob for task scopes: `**` crosses folders, `*` and `?` stay inside one; a bare folder covers everything under it.
export function globToRegExp(glob: string): RegExp {
  let g = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  if (g.endsWith("/")) g += "**";
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        i++;
        if (g[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$", IS_WIN ? "i" : "");
}

export function inScope(path: string, globs: string[]): boolean {
  const p = path.replace(/\\/g, "/");
  return globs.some((g) => {
    const plain = g.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (!/[*?]/.test(plain)) {
      const a = IS_WIN ? p.toLowerCase() : p, b = IS_WIN ? plain.toLowerCase() : plain;
      if (a === b || a.startsWith(b + "/")) return true;
    }
    return globToRegExp(g).test(p);
  });
}

export function findClaude(): string {
  const env = Deno.env.get("DSH_CLAUDE");
  if (env) return env;
  const name = IS_WIN ? "claude.exe" : "claude";
  const candidates = [join(HOME, ".local", "bin", name)];
  for (const dir of (Deno.env.get("PATH") ?? "").split(IS_WIN ? ";" : ":")) if (dir) candidates.push(join(dir, name));
  for (const c of candidates) if (exists(c)) return c;
  throw new Error("Claude Code CLI not found. Install it (irm https://claude.ai/install.ps1 | iex) or set DSH_CLAUDE to claude.exe.");
}

export function findBash(): string | null {
  const c = [
    Deno.env.get("CLAUDE_CODE_GIT_BASH_PATH"),
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ];
  if (!IS_WIN) return exists("/bin/bash") ? "/bin/bash" : "/bin/sh";
  for (const p of c) if (p && exists(p)) return p;
  return null;
}

// Setup and verify commands run in Git Bash when it exists (the same shell Claude Code's Bash tool uses).
export function shellArgs(cmd: string): [string, string[]] {
  const bash = findBash();
  if (bash) return [bash, ["-c", `exec 2>&1\n${cmd}`]];
  return ["powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `& { ${cmd} } 2>&1`]];
}

let cachedKey = "";
export async function deepseekKey(): Promise<string> {
  if (cachedKey) return cachedKey;
  let k = Deno.env.get("DEEPSEEK_API_KEY") ?? "";
  if (!k && IS_WIN) {
    for (const hive of ["HKCU\\Environment", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"]) {
      const r = await exec("reg", ["query", hive, "/v", "DEEPSEEK_API_KEY"]);
      const m = r.stdout.match(/DEEPSEEK_API_KEY\s+REG_(?:EXPAND_)?SZ\s+(\S+)/);
      if (m) {
        k = m[1];
        break;
      }
    }
  }
  if (!k) throw new Error('DEEPSEEK_API_KEY is not set. Set it in a terminal with: setx DEEPSEEK_API_KEY "sk-..." and restart the session.');
  cachedKey = k;
  return k;
}

const KEEP = new Set(["CLAUDE_CODE_GIT_BASH_PATH", "CLAUDE_CONFIG_DIR"]);

// The parent's environment minus everything that would tie a child to the calling Claude session.
export function cleanEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(Deno.env.toObject())) {
    const K = k.toUpperCase();
    if (KEEP.has(K)) out[k] = v;
    else if (K.startsWith("CLAUDE") || K.startsWith("ANTHROPIC") || K.startsWith("OTEL_") || K === "DEEPSEEK_API_KEY") continue;
    else out[k] = v;
  }
  return out;
}

export const MODELS: Record<string, string> = { flash: "deepseek-flash[1m]", pro: "deepseek-v4-pro[1m]" };

export function modelId(m?: string): string {
  return MODELS[m ?? "flash"] ?? m!;
}

// Same settings as claude-deepseek.cmd (DeepSeek's Claude Code guide), set only for the worker process.
export function workerEnv(model: string, key: string): Record<string, string> {
  return {
    ...cleanEnv(),
    ANTHROPIC_BASE_URL: Deno.env.get("DSH_BASE_URL") ?? "https://api.deepseek.com/anthropic",
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-flash",
    CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-flash",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "786432",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

export function fmtMs(ms: number | undefined): string {
  if (ms === undefined || ms < 0) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

export function tailText(s: string, maxLines = 60, maxChars = 4000): string {
  let t = s.replace(/\r\n/g, "\n").trimEnd().split("\n").slice(-maxLines).join("\n");
  if (t.length > maxChars) t = "…" + t.slice(-maxChars);
  return t;
}

// Byte-level line-ending helpers, so files in any encoding (UTF-8, GBK, ...) pass through untouched.
export function isBinary(b: Uint8Array): boolean {
  for (let i = 0, n = Math.min(b.length, 8000); i < n; i++) if (b[i] === 0) return true;
  return false;
}

export function eolOf(b: Uint8Array): "crlf" | "lf" | null {
  for (let i = 0; i < b.length; i++) if (b[i] === 10) return i > 0 && b[i - 1] === 13 ? "crlf" : "lf";
  return null;
}

export function toLF(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length);
  let j = 0;
  for (let i = 0; i < b.length; i++) if (!(b[i] === 13 && b[i + 1] === 10)) out[j++] = b[i];
  return out.subarray(0, j);
}

export function withEol(b: Uint8Array, style: "crlf" | "lf" | null): Uint8Array {
  if (!style || isBinary(b)) return b;
  const lf = toLF(b);
  if (style === "lf") return lf;
  let n = 0;
  for (const x of lf) if (x === 10) n++;
  const out = new Uint8Array(lf.length + n);
  let j = 0;
  for (const x of lf) {
    if (x === 10) out[j++] = 13;
    out[j++] = x;
  }
  return out;
}

export function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n… [${s.length - n} more characters]` : s;
}
