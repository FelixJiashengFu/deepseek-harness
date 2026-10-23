// DeepSeek Harness host plugin. It mounts DSH's own MCP client on the bundled harness server
// (server/main.ts, run with Deno; its tools appear as mcp__harness__*) and a filesystem skill
// provider for skills/deliver. The server and skill are the same files the Claude Code plugin uses;
// with DSH installed, the server runs its workers as `dsh --profile headless` processes.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import * as mcpClient from "@deepseek-ai/dsh-mcp-client";
import * as skillFilesystem from "@deepseek-ai/dsh-skill-filesystem";

export const name = "dsh-parallel-workers";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const Config = z.object({
  deno: z.string().default("deno").description("Deno executable that runs the harness server (a full path if deno is not on PATH)."),
  toolCallTimeoutMinutes: z.number().min(1).default(62).description("Longest a harness tool call may block; wait can block for up to 60 minutes."),
});

// DSH may start without the shell's PATH tweaks, so look in the usual install places too.
function resolveDeno(configured) {
  if (configured !== "deno") return configured;
  const exe = process.platform === "win32" ? "deno.exe" : "deno";
  const candidates = (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, exe));
  candidates.push(join(homedir(), ".deno", "bin", exe));
  if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", exe));
  return candidates.find((p) => existsSync(p)) ?? configured;
}

export function apply(ctx, config) {
  // dsh-mcp-client drops ambient *KEY*/*TOKEN* and DSH_* variables from the child environment;
  // pass the DeepSeek key on explicitly (the server also falls back to the Windows user registry).
  const env = { DENO_NO_UPDATE_CHECK: "1" };
  if (process.env.DEEPSEEK_API_KEY) env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
  ctx.plugin(mcpClient, {
    serverName: "harness",
    transport: "stdio",
    command: resolveDeno(config.deno),
    args: ["run", "-A", "--no-config", "--quiet", join(root, "server", "main.ts")],
    env,
    cwd: homedir(),
    toolCallTimeoutMs: config.toolCallTimeoutMinutes * 60_000,
  });
  ctx.plugin(skillFilesystem, {
    providerName: "parallel-workers",
    includeDefaultRoots: false,
    customSkillDirs: [join(root, "skills")],
    watch: false,
  });
}
