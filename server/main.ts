// DeepSeek Harness MCP server (stdio, newline-delimited JSON-RPC, no dependencies).

import * as H from "./harness.ts";
import { STATE_HOME, ensureDir, log } from "./util.ts";

const VERSION = "0.2.0";

const INSTRUCTIONS = `DeepSeek Harness runs several DeepSeek-powered coding agents in parallel (DSH headless workers, or Claude Code CLI workers when DSH is not installed), each in its own git worktree, to deliver large tasks faster. Use it when a task splits into independent parts (3+ parts of several minutes each); for small or tightly coupled work, do it yourself. Flow: dispatch -> wait -> result -> retry where needed -> integrate -> land -> cleanup. Workers cannot ask questions, so every task prompt must be complete. Their output is unverified: review diffs and run checks before landing. Code and prompts go to DeepSeek's servers. The deliver skill has the full workflow.`;

const str = (description: string) => ({ type: "string", description });
const strArr = (description: string) => ({ type: "array", items: { type: "string" }, description });

const TOOLS = [
  {
    name: "dispatch",
    description:
      "Start DeepSeek workers on independent tasks in a git repo. Each task gets its own worktree and branch from one base commit and runs in the background (up to maxParallel at once). Returns at once with a run id; then use wait. By default the base is a snapshot of the current working tree, uncommitted edits included, so shared scaffolding you just wrote is visible to every worker without committing. Pass runId to add a second wave of tasks to an existing run.",
    inputSchema: {
      type: "object",
      properties: {
        repo: str("Absolute path inside the git repository to work on."),
        tasks: {
          type: "array",
          minItems: 1,
          description: "Independent tasks. Give each one disjoint files so merges stay clean.",
          items: {
            type: "object",
            properties: {
              id: str("Short id: letters, digits, - or _ (used in branch and folder names)."),
              title: str("One-line title."),
              prompt: str("Complete, self-contained instructions: goal, where in the code, interfaces to honour, acceptance criteria. The worker cannot ask questions."),
              files: strArr("Files or globs this task owns, e.g. [\"src/api/**\", \"tests/api_test.ts\"]. Changes outside are reported."),
              verify: str("Shell command (Git Bash) that must pass in the worktree, e.g. \"deno test tests/api_test.ts\". Overrides the run's verify."),
              model: str("\"flash\" (default, fast and cheap), \"pro\" (deepseek-v4-pro, stronger, about 3-4x the price) or a full model name."),
              effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"], description: "Reasoning effort; default max." },
              maxTurns: { type: "number", description: "Optional cap on agent turns for this task (claude engine only)." },
            },
            required: ["id", "prompt"],
          },
        },
        runId: str("Add these tasks to an existing run instead of starting a new one."),
        base: str("\"snapshot\" (default: working tree incl. uncommitted changes), \"head\", \"integration\" (this run's integration branch, for a second wave that builds on the first), or any git ref."),
        context: str("Shared context appended to every task: conventions, contracts, commands to use."),
        verify: str("Default check command for every task, also used by integrate."),
        setup: str("Shell command run once in each new worktree before the worker starts, e.g. \"npm ci\"."),
        link: strArr("Git-ignored folders to share read-only from the main checkout into each worktree, e.g. [\"node_modules\"]. Faster than setup; workers must not modify them."),
        model: str("Default model for the tasks: flash (default) or pro."),
        effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"], description: "Default effort; default max." },
        maxParallel: { type: "number", description: "Workers running at once for this run (default 6, capped by DS_WORKERS_MAX_PARALLEL, default 12)." },
        timeoutMin: { type: "number", description: "Per-attempt time limit in minutes (default 30)." },
        maxTurns: { type: "number", description: "Default turn cap per task (claude engine only)." },
        engine: { type: "string", enum: ["dsh", "claude"], description: "Worker engine. \"dsh\": DeepSeek Harness headless, the default when DSH is installed. \"claude\": Claude Code CLI pointed at DeepSeek. Fixed per run." },
        allowedTools: strArr("claude engine only: extra permission rules, e.g. [\"Bash(docker compose *)\"]. The defaults cover file edits, git read commands and common build/test tools; anything else is denied without prompting."),
        permissionMode: { type: "string", enum: ["acceptEdits", "bypassPermissions"], description: "acceptEdits (default): writes only inside the worktree (dsh: workspace-write sandbox; claude: edits in the worktree, shell limited to the allow list). bypassPermissions: no confinement (dsh: danger-full-access); only when the user asked for it." },
      },
      required: ["repo", "tasks"],
    },
  },
  {
    name: "wait",
    description:
      "Block until the run's tasks finish (mode \"all\") or until any not-yet-reported task finishes (mode \"any\", good for reviewing results while others still run), or until timeoutSec passes. Returns the status table, elapsed wall time vs total worker time, and token use.",
    inputSchema: {
      type: "object",
      properties: {
        runId: str("Run id from dispatch."),
        taskIds: strArr("Only wait for these tasks."),
        mode: { type: "string", enum: ["all", "any"], description: "Default all." },
        timeoutSec: { type: "number", description: "Max seconds to block (default 240, max 3600)." },
      },
      required: ["runId"],
    },
  },
  {
    name: "status",
    description: "Show a run's status table without waiting. Without runId, list recent runs.",
    inputSchema: { type: "object", properties: { runId: str("Run id; omit to list runs.") } },
  },
  {
    name: "result",
    description:
      "For finished tasks: the worker's final report, changed files, files outside the task's scope, the check result, and the diff (truncated; the full patch path is given). Review this before integrating.",
    inputSchema: {
      type: "object",
      properties: {
        runId: str("Run id."),
        taskIds: strArr("Tasks to show (default: all finished tasks)."),
        includeDiff: { type: "boolean", description: "Include the diff text (default true)." },
        maxDiffChars: { type: "number", description: "Max diff characters per task (default 12000)." },
      },
      required: ["runId"],
    },
  },
  {
    name: "retry",
    description:
      "Send a finished, failed or interrupted task back to its worker with feedback. By default it resumes the same worker conversation in the same worktree (cheap: it keeps its context); a failed check's output is attached automatically. fresh: true starts a new conversation on top of the existing changes.",
    inputSchema: {
      type: "object",
      properties: {
        runId: str("Run id."),
        taskId: str("Task id."),
        feedback: str("What is wrong and what to change. Be specific."),
        fresh: { type: "boolean", description: "Start a new worker conversation instead of resuming." },
        model: str("Switch model for this retry, e.g. \"pro\" for a task flash could not do."),
        effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"] },
        timeoutMin: { type: "number" },
      },
      required: ["runId", "taskId", "feedback"],
    },
  },
  {
    name: "cancel",
    description: "Stop queued or running tasks (all of the run's tasks by default). Partial work is kept on their branches and can be retried.",
    inputSchema: { type: "object", properties: { runId: str("Run id."), taskIds: strArr("Tasks to stop.") }, required: ["runId"] },
  },
  {
    name: "integrate",
    description:
      "Merge finished tasks' branches into the run's integration branch (its own worktree), then run the check on the combined result. Merges done tasks not yet merged by default. On a conflict it stops and names the files: edit them in the integration worktree and call again with continue: true, or abort: true. Pass taskIds: [] to only re-run the check after fixing something there.",
    inputSchema: {
      type: "object",
      properties: {
        runId: str("Run id."),
        taskIds: strArr("Tasks to merge, in order (default: every done task not yet merged)."),
        verify: str("Check command for the combined result (default: the run's verify)."),
        continue: { type: "boolean", description: "Finish a merge whose conflicts you resolved." },
        abort: { type: "boolean", description: "Abandon the conflicted merge." },
      },
      required: ["runId"],
    },
  },
  {
    name: "land",
    description:
      "Apply the integration branch (or one task with source: <taskId>) to the user's working tree as uncommitted changes. Nothing is committed. Files you edited after dispatch are three-way merged; conflicts get markers or a .harness-incoming copy and are listed. Use dryRun first if the working tree changed a lot.",
    inputSchema: {
      type: "object",
      properties: {
        runId: str("Run id."),
        source: str("\"integration\" (default) or a task id."),
        dryRun: { type: "boolean", description: "Report what would happen without writing." },
      },
      required: ["runId"],
    },
  },
  {
    name: "cleanup",
    description: "Remove a run's worktrees and dsh/<run>/* branches after landing. Refuses while work is not landed unless force: true. Logs are kept unless deleteLogs: true.",
    inputSchema: {
      type: "object",
      properties: {
        runId: str("Run id."),
        force: { type: "boolean", description: "Also delete unlanded work and stop active tasks." },
        deleteLogs: { type: "boolean", description: "Also delete the run's logs and state." },
      },
      required: ["runId"],
    },
  },
];

const enc = new TextEncoder();
let writeChain: Promise<void> = Promise.resolve();

function send(msg: unknown) {
  const data = enc.encode(JSON.stringify(msg) + "\n");
  writeChain = writeChain.then(async () => {
    let off = 0;
    while (off < data.length) off += await Deno.stdout.write(data.subarray(off));
  }).catch((e) => log("stdout write failed", String(e)));
}

const reply = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
const replyError = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });

// deno-lint-ignore no-explicit-any
async function callTool(name: string, args: any, progressToken: unknown): Promise<string> {
  const progress = progressToken !== undefined
    ? (done: number, total: number, message: string) =>
      send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress: done, total, message } })
    : undefined;
  switch (name) {
    case "dispatch":
      return await H.dispatch(args);
    case "wait":
      return await H.wait(args, progress);
    case "status":
      return await H.status(args ?? {});
    case "result":
      return await H.result(args);
    case "retry":
      return await H.retry(args);
    case "cancel":
      return await H.cancel(args);
    case "integrate":
      return await H.integrate(args);
    case "land":
      return await H.land(args);
    case "cleanup":
      return await H.cleanup(args);
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

// deno-lint-ignore no-explicit-any
async function handle(msg: any) {
  if (!msg || typeof msg !== "object" || typeof msg.method !== "string") return;
  const isRequest = msg.id !== undefined && msg.id !== null;
  try {
    switch (msg.method) {
      case "initialize":
        return reply(msg.id, {
          protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "deepseek-harness", version: VERSION },
          instructions: INSTRUCTIONS,
        });
      case "ping":
        return reply(msg.id, {});
      case "tools/list":
        return reply(msg.id, { tools: TOOLS });
      case "tools/call": {
        const { name, arguments: args, _meta } = msg.params ?? {};
        try {
          const text = await callTool(name, args ?? {}, _meta?.progressToken);
          return reply(msg.id, { content: [{ type: "text", text }] });
        } catch (e) {
          log("tool error", name, String((e as Error).stack ?? e));
          return reply(msg.id, { content: [{ type: "text", text: `Error: ${(e as Error).message ?? e}` }], isError: true });
        }
      }
      default:
        if (isRequest) replyError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  } catch (e) {
    if (isRequest) replyError(msg.id, -32603, String((e as Error).message ?? e));
  }
}

async function main() {
  ensureDir(STATE_HOME);
  await H.loadRuns();
  log(`deepseek-harness ${VERSION} started (pid ${Deno.pid}, home ${STATE_HOME})`);
  for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) {
    try {
      Deno.addSignalListener(sig, () => H.shutdown().finally(() => Deno.exit(0)));
    } catch { /* signal not supported on this OS */ }
  }
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of Deno.stdin.readable) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        continue;
      }
      for (const m of Array.isArray(msg) ? msg : [msg]) handle(m);
    }
  }
  // The client closed stdin: stop workers so nothing keeps billing in the background.
  log("stdin closed; shutting down");
  await H.shutdown();
  await writeChain;
  Deno.exit(0);
}

main();
