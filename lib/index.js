// DeepSeek Harness host plugin. It mounts DSH's own MCP client on the bundled harness server
// (server/main.ts, run with Deno; its tools appear as mcp__harness__*) and a filesystem skill
// provider for skills/deliver. The server and skill are the same files the Claude Code plugin uses;
// with DSH installed, the server runs its workers as `dsh --profile headless` processes.
//
// It also owns "parallel delivery mode", the composer toggle next to the input bar (lib/client.js):
// a per-session on/off state kept as a plugin record in the session log, read by clients through
// the `parallel-workers` projection, switched with `/parallel on|off`, and, while on, a system
// prompt section that tells the agent to fan large tasks out through the deliver skill.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import * as mcpClient from "@deepseek-ai/dsh-mcp-client";
import * as skillFilesystem from "@deepseek-ai/dsh-skill-filesystem";
import { appendPluginRecord, pluginRecordOf } from "@deepseek-ai/dsh-session";

export const name = "dsh-parallel-workers";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const Config = z.object({
  deno: z.string().default("deno").description("Deno executable that runs the harness server (a full path if deno is not on PATH)."),
  toolCallTimeoutMinutes: z.number().min(1).default(62).description("Longest a harness tool call may block; wait can block for up to 60 minutes."),
});

/** Session-log record holding the toggle state: `{ active: boolean }`. */
export const MODE_RECORD = "plugin:parallel-workers/mode";
/** Projection key the composer toggle reads. */
export const PROJECTION_KEY = "parallel-workers";

/** Model-facing guidance while the toggle is on. */
export const POLICY = [
  "Parallel delivery mode is ON for this session (the user switched it on with the composer toggle).",
  "For a coding task in a git repository that splits into three or more independent parts, load the `deliver` skill and follow it: write the shared contracts first, then use the mcp__harness__* tools (dispatch, wait, result, retry, integrate, land, cleanup) to run DeepSeek workers in parallel, review every result, and land the work as uncommitted changes.",
  "For small, tightly coupled or non-coding requests, work normally and say in one line why you did not fan out.",
].join("\n");

// Minimal schema objects for the projection registry: `parse` plus the Standard Schema interface.
function schema(label, check) {
  const fail = () => new Error(`dsh-parallel-workers: invalid ${label}`);
  return {
    parse(value) {
      if (!check(value)) throw fail();
      return value;
    },
    safeParse(value) {
      return check(value) ? { success: true, data: value } : { success: false, error: fail() };
    },
    "~standard": {
      version: 1,
      vendor: "dsh-parallel-workers",
      validate: (value) => (check(value) ? { value } : { issues: [{ message: `invalid ${label}` }] }),
    },
  };
}

const isMode = (value) => value !== null && typeof value === "object" && typeof value.active === "boolean";

export const projection = {
  key: PROJECTION_KEY,
  stateVersion: 1,
  stateSchema: schema("parallel-workers state", isMode),
  init: () => ({ active: false }),
  apply: (state, event) => {
    const record = pluginRecordOf(event);
    if (record?.type !== MODE_RECORD || !isMode(record.data) || record.data.active === state.active) return state;
    return { active: record.data.active };
  },
  wire: {
    viewSchema: schema("parallel-workers view", isMode),
    view: (state) => ({ active: state.active }),
  },
};

// DSH may start without the shell's PATH tweaks, so look in the usual install places too.
function resolveDeno(configured) {
  if (configured !== "deno") return configured;
  const exe = process.platform === "win32" ? "deno.exe" : "deno";
  const candidates = (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, exe));
  candidates.push(join(homedir(), ".deno", "bin", exe));
  if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", exe));
  return candidates.find((p) => existsSync(p)) ?? configured;
}

function applyParallelMode(ctx) {
  ctx.inject(["systemPrompt", "sessionProjections"], (modeCtx) => {
    const isActive = (session) => modeCtx.sessionProjections.stateOf(session, PROJECTION_KEY)?.active === true;
    modeCtx.sessionProjections.register(projection);
    modeCtx.systemPrompt.section({
      name: "parallel-workers:policy",
      // After first-party guidance (below 10200, where the deployment persona suffix sits).
      order: 10100,
      text: (context) => (context.agent !== undefined && isActive(context.agent.session) ? POLICY : ""),
    });
    modeCtx.inject(["commands"], (commandCtx) => {
      commandCtx.commands.register({
        definitionId: "dsh-parallel-workers",
        name: "parallel",
        description: "Turn parallel delivery mode (DeepSeek workers) on or off",
        input: { hint: "[on|off]" },
        handler: ({ agent, rawInput }) => {
          const arg = rawInput.trim().toLowerCase();
          if (arg !== "" && arg !== "on" && arg !== "off") return { kind: "error", text: "Use /parallel on or /parallel off." };
          const target = arg === "" ? !isActive(agent.session) : arg === "on";
          if (target === isActive(agent.session)) {
            return { kind: "success", text: target ? "Parallel delivery mode is already on." : "Parallel delivery mode is already off." };
          }
          appendPluginRecord(agent.session, MODE_RECORD, { active: target });
          return {
            kind: "success",
            text: target
              ? "Parallel delivery mode on: large splittable tasks go to DeepSeek workers. Use /parallel off to leave."
              : "Parallel delivery mode off.",
          };
        },
      });
    });
  });
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
  applyParallelMode(ctx);
}
