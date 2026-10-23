---
name: deliver
description: Deliver a large, splittable coding task faster by running several DeepSeek-powered coding agents in parallel, each in its own git worktree, then reviewing, integrating and landing their work with the DeepSeek Harness tools (dispatch, wait, result, retry, integrate, land, cleanup). Use when the user asks to parallelize, fan out, split work across agents or workers, use the DeepSeek harness or DeepSeek workers, or says 并行, 拆分任务, 多 agent, 子 agent, 加速交付, 用 DeepSeek 干活; also when a task in a git repo clearly breaks into three or more independent parts that each take more than a few minutes.
---

# Parallel delivery with DeepSeek Harness

You are the orchestrator. Workers are headless coding agents on DeepSeek (`deepseek-flash` by default), each in its own worktree on branch `dsh/<run>/<task>`. They run on DeepSeek Harness's headless mode when DSH is installed (engine `dsh`), otherwise on the Claude Code CLI (engine `claude`). They cannot ask you questions, their output is unverified, and their code and prompts go to DeepSeek's servers. You own the split, the review and the final result.

## 1. Decide whether to fan out

Fan out when the work splits into 3 or more parts that touch different files and each part takes a single agent more than a few minutes: modules behind agreed interfaces, many similar files (pages, endpoints, migrations, test suites, translations), independent bug fixes.

Do it yourself instead when the change is small, when each step depends on the previous one, when the parts all edit the same few files, or when the repo holds anything the user would not want sent to DeepSeek. Ask the user first if you are unsure about the last point.

The repo must be a git repository with at least one commit.

## 2. Prepare the split (this is where the speed comes from)

1. Read enough of the code to know where each part goes.
2. Write the shared contracts yourself before dispatching: types, interfaces, function signatures, file layout, stubs, shared fixtures, and the tests that define "done" when you can. You do not need to commit. The default base snapshots the working tree, uncommitted edits included.
3. Cut tasks so that **no two tasks edit the same file**. Shared files (an index, a router, a changelog) stay with you. Wire them up after landing, or give them to one task.
4. Aim for 3 to 8 tasks of similar size. A worker takes about 10 to 20 s to start, so tiny tasks waste the overhead. Keep the hardest, most coupled piece for yourself.
5. Write each prompt as if for a capable contractor who has never seen the project:
   - the goal and why,
   - the exact files and the interfaces to honour (paste signatures),
   - acceptance criteria and edge cases,
   - how to verify (the `verify` command),
   - what not to touch.

## 3. Dispatch

Call `dispatch` with:
- `repo`: absolute path,
- `tasks`: `[{id, title, prompt, files, verify}]`,
- `context`: conventions every worker needs (language and style rules, commands, how to run tests),
- `verify`: the default check, also used for the combined result,
- `link: ["node_modules"]` (or `.venv` and so on) so git-ignored dependency folders are shared read-only instead of reinstalled. Use `setup: "npm ci"` only when workers must change dependencies.
- `model: "pro"` for genuinely hard tasks only (about 3 to 4 times the price). `effort` defaults to max; use `low` for mechanical edits.

Workers may write only inside their worktree.
- **dsh engine**: DSH's workspace-write sandbox enforces this for every file tool and shell command. Writes elsewhere fail, and so do tool caches outside the worktree. If a build needs them, share them with `link` or point the cache into the worktree through `context` instructions.
- **claude engine**: workers can run the allowed shell commands: git read commands, common build and test tools, and file helpers. Anything else is denied without a prompt. Add rules with `allowedTools`, for example `["Bash(docker compose *)"]`.

Use `permissionMode: "bypassPermissions"` (no confinement) only when the user explicitly agrees.

## 4. While the workers run, keep working

Don't sit idle. Do your own part in files no worker owns: the integration glue, docs, the shared files you kept. Then call `wait` with `mode: "any"`, so you can review each task as it finishes while the others keep going. `wait` blocks for up to `timeoutSec` (default 240 s). Calling it again is fine; it is not polling.

## 5. Review every result

Call `result` for the finished tasks and check:
- the worker's report (assumptions, anything left undone),
- the check result: a failed `verify` marks the task failed,
- `Outside the task's scope` files: possible collisions with other tasks,
- the diff itself. Read it like a code review. Don't trust "all tests pass" claims you haven't seen.

If something is wrong, call `retry` with concrete feedback ("`median` mutates its input; sort a copy", not "fix bugs"). Retry resumes the same worker conversation in the same worktree, so it is cheap, and a failed check's output is attached automatically. Use `model: "pro"` on a retry that flash could not solve. If a task is hopeless, cancel it and do that part yourself.

## 6. Integrate, then land

1. Call `integrate` (default: every done task not yet merged). It merges the task branches in its own integration worktree and runs `verify` on the combined result.
   - On a CONFLICT, edit the listed files in the integration worktree path it gives you (remove the markers), then call `integrate` again with `continue: true`. Or use `abort: true`, then `dispatch` the task again under a new id with `runId` and `base: "integration"`, so it starts from the merged code.
   - If the combined check fails, fix it in the integration worktree and call `integrate` with `taskIds: []` to re-run the check, or retry the task at fault.
2. Call `land`. It applies the integration result to the user's working tree as **uncommitted** changes. Files you edited meanwhile are three-way merged, and any conflicts are listed. Use `dryRun: true` first if you changed a lot since dispatch.
3. Run the project's tests in the real working tree yourself, then show the user what changed. Commit only if the user wants it.
4. Call `cleanup` to remove the worktrees and `dsh/*` branches. Logs stay in `~/.deepseek-harness/runs/<run>`.

A second wave that builds on the first: call `dispatch` with `runId` and `base: "integration"`, then integrate and land again. Land only applies what is new since the last land.

## 7. Report honestly

Tell the user:
- which tasks ran,
- the wall time against total worker time (the `wait` table shows the ratio),
- what you fixed or redid yourself,
- what is landed but uncommitted,
- anything not verified.

If some tasks failed and you did them yourself, say so.
