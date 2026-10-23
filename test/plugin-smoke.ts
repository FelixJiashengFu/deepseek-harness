// Smoke test inside a real Claude Code session on DeepSeek: the plugin's skill loads (--plugin-dir), the
// harness server runs under Claude Code's MCP client (--mcp-config with the same command as .mcp.json;
// --strict-mcp-config keeps the user's own servers out and also skips plugin servers), and a long
// `wait` (150 s) is not cut off by the client's MCP tool timeout. The task's setup command sleeps, so
// no worker tokens are spent on it. The plugin's .mcp.json itself is checked with `claude mcp list`.
// Usage: deno run -A --no-config test/plugin-smoke.ts <empty scratch dir>

const base = Deno.args[0];
if (!base) throw new Error("usage: plugin-smoke.ts <scratch dir>");
const pluginDir = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1").replace(/[\\/]$/, "");
const repo = `${base}/repo`;
Deno.mkdirSync(repo, { recursive: true });
const git = (...args: string[]) => new Deno.Command("git", { args, cwd: repo }).outputSync();
git("init", "-q");
Deno.writeTextFileSync(`${repo}/a.txt`, "a\n");
git("add", "-A");
git("-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-qm", "init");

let key = Deno.env.get("DEEPSEEK_API_KEY") ?? "";
if (!key) {
  const out = new TextDecoder().decode(new Deno.Command("reg", { args: ["query", "HKCU\\Environment", "/v", "DEEPSEEK_API_KEY"] }).outputSync().stdout);
  key = out.match(/DEEPSEEK_API_KEY\s+REG_\w+\s+(\S+)/)?.[1] ?? "";
}
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(Deno.env.toObject())) if (!/^(CLAUDE|ANTHROPIC)/i.test(k)) env[k] = v;
Object.assign(env, {
  ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
  ANTHROPIC_AUTH_TOKEN: key,
  ANTHROPIC_MODEL: "deepseek-flash[1m]",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-flash",
  DISABLE_AUTOUPDATER: "1",
  DS_WORKERS_HOME: `${base}/home`,
});
const mcpConfig = `${base}/mcp.json`;
Deno.writeTextFileSync(mcpConfig, JSON.stringify({
  mcpServers: {
    harness: {
      command: "deno",
      args: ["run", "-A", "--no-config", "--quiet", `${pluginDir}/server/main.ts`],
      env: { DENO_NO_UPDATE_CHECK: "1" },
    },
  },
}));
const prompt = `Use the harness MCP tools (mcp__harness__dispatch, mcp__harness__wait, mcp__harness__cleanup) exactly as follows, nothing else:
1. Call dispatch with repo "${repo.replace(/\\/g, "/")}", setup "sleep 170", and one task {id: "noop", prompt: "Reply with the word ok. Do not change any files.", effort: "low"}.
2. Call wait with that runId, mode "all", timeoutSec 150.
3. Call cleanup with that runId and force true.
Then reply with: the first line of the wait result, and whether any tool call returned an error.`;
const t0 = Date.now();
const child = new Deno.Command(`${Deno.env.get("USERPROFILE")}\\.local\\bin\\claude.exe`, {
  args: [
    "-p", "--output-format", "stream-json", "--verbose", "--plugin-dir", pluginDir,
    "--mcp-config", mcpConfig, "--strict-mcp-config",
    "--permission-mode", "acceptEdits", "--permission-prompts", "none", "--effort", "low",
    "--allowedTools", "mcp__harness",
  ],
  cwd: base,
  env,
  clearEnv: true,
  stdin: "piped",
  stdout: "piped",
  stderr: "piped",
}).spawn();
const w = child.stdin.getWriter();
await w.write(new TextEncoder().encode(prompt));
await w.close();
const out = await child.output();
const text = new TextDecoder().decode(out.stdout);
Deno.writeTextFileSync(`${base}/events.jsonl`, text);
for (const line of text.split("\n")) {
  if (!line.trim()) continue;
  const e = JSON.parse(line);
  const t = ((Date.now() - t0) / 1000).toFixed(0);
  if (e.type === "system" && e.subtype === "init") {
    console.log("mcp servers:", JSON.stringify(e.mcp_servers));
    console.log("harness tools:", e.tools.filter((x: string) => x.includes("harness")).join(", "));
    console.log("skills:", JSON.stringify(e.skills ?? []).slice(0, 300));
  } else if (e.type === "assistant") {
    for (const c of e.message.content) if (c.type === "tool_use") console.log(`tool_use ${c.name} ${JSON.stringify(c.input).slice(0, 160)}`);
  } else if (e.type === "user" && Array.isArray(e.message?.content)) {
    for (const c of e.message.content) {
      if (c.type === "tool_result") {
        const body = Array.isArray(c.content) ? c.content.map((x: any) => x.text ?? "").join("") : String(c.content);
        console.log(`tool_result${c.is_error ? " [ERROR]" : ""}: ${body.slice(0, 300).replace(/\n/g, " | ")}`);
      }
    }
  } else if (e.type === "result") {
    console.log(`result after ${(e.duration_ms / 1000).toFixed(0)}s (${e.subtype}): ${String(e.result).slice(0, 600)}`);
  }
}
console.log("exit", out.code, "stderr:", new TextDecoder().decode(out.stderr).slice(0, 800));
