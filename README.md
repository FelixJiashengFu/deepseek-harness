# DeepSeek Harness

一个 Claude Code 插件：把大任务拆给多个 **DeepSeek 驱动的 Claude Code 工人** 并行完成，每个工人在自己的 git worktree 里干活；由调度方（桌面 App 里的 Claude，或跑在 DeepSeek 上的 CLI）负责拆分、审核、集成和落地。

```
调度方（你和 Claude）
  │ dispatch：给工作区拍快照 → 为每个任务建 worktree + 分支 dsh/<run>/<task>
  ├─ 工人 stats ─ claude -p（DeepSeek）─ 改代码、跑测试 ─┐
  ├─ 工人 text  ─ claude -p（DeepSeek）─ …              ├─ 各自提交到自己的分支，跑 verify
  └─ 工人 dates ─ claude -p（DeepSeek）─ …              ┘
  │ wait / result：看报告、diff、检查结果；不合格就 retry（续接同一个工人对话）
  │ integrate：在集成 worktree 里合并所有分支，再跑一遍整体检查
  │ land：把结果写进你的工作区，作为未提交的改动（不替你 commit）
  └ cleanup：删掉 worktree 和 dsh/* 分支
```

## 需要什么

- Windows、macOS 或 Linux 都可以，需要装好 `git`、[Deno](https://deno.com)（MCP 服务用它运行，没有任何外部依赖）和 Claude Code CLI（`claude`）。
- DeepSeek API key，放在环境变量 `DEEPSEEK_API_KEY` 里（Windows 上也会读 `HKCU\Environment`，所以 `setx` 设置后不用重启 App）。
- 目标项目得是一个 git 仓库，并且至少有一次提交。

## 安装

```bash
claude plugin marketplace add FelixJiashengFu/deepseek-harness
```

```bash
claude plugin install deepseek-harness@deepseek-harness
```

装好后**新开一个会话**才会加载。桌面 App 和 CLI 都能用。想改代码的话，可以先 clone 下来，再用 `claude plugin marketplace add <本地路径>` 从本地目录安装，改动在新会话里生效。

## 用法

直接说：“用 DeepSeek 并行把 X 做了”，或者 `/deepseek-harness:deliver 把 X 做了`。`deliver` 技能会让调度方：

1. 先写好共享的接口、桩代码和测试（不用提交：dispatch 默认给工作区拍快照，未提交的改动也会带上）；
2. 按**互不重叠的文件**拆成 3 到 8 个任务，每个任务带完整的提示词和 `verify` 命令；
3. 工人跑的时候，调度方自己做没分出去的部分；
4. 逐个审核结果，不合格就带具体反馈 `retry`；
5. `integrate` 后再 `land`，在真实工作区跑测试，然后交给你决定要不要提交。

## 工具

| 工具 | 作用 |
|---|---|
| `dispatch` | 启动一批任务（可用 `runId` 追加第二波）。参数有 `context`、`verify`、`setup`、`link`、`model`（flash/pro）、`effort`、`maxParallel`、`timeoutMin`、`allowedTools` |
| `wait` | 阻塞等待：`all` 等全部完成，`any` 等到有新任务完成就返回，方便边跑边审。返回状态表、墙钟时间、工人总耗时和 token 用量 |
| `status` | 查看某个 run 的状态；不带参数就列出所有 run |
| `result` | 工人报告、改动文件、越界文件、检查结果，以及 diff（截断显示，另给完整 patch 路径） |
| `retry` | 带反馈让工人返工。默认续接同一个对话，失败的检查输出会自动附上 |
| `cancel` | 停止任务，已做的部分保留在分支上 |
| `integrate` | 在集成 worktree 里合并各分支并跑整体检查。遇到冲突就停下，列出冲突文件，解决后用 `continue: true` 继续 |
| `land` | 把集成结果（或单个任务）写进你的工作区，作为未提交的改动。你在 dispatch 之后改过的文件会做三方合并 |
| `cleanup` | 落地后删除 worktree 和分支；日志保留在 `~/.deepseek-harness/runs/<run>` |

## 权限和安全

- 工人用 `--permission-mode acceptEdits --permission-prompts none` 运行：只能改自己 worktree 里的文件；shell 只允许白名单里的命令（git 只读命令，以及 deno、npm、python、pytest、cargo、go 等常见构建和测试工具）。其他操作一律自动拒绝，不会弹窗。`git commit`、`push`、`reset`、`checkout` 等命令被明确禁止。
- 白名单只是防止误操作，**不是沙箱**：`node`、`python` 这类解释器本身什么都能执行。只在你信任的仓库上用。
- 工人不加载你的 MCP 服务和用户级设置（`--strict-mcp-config --setting-sources project,local`），所以不会递归调用 harness，也不会触发你的个人 hooks。
- 内部提交只出现在 `dsh/*` 分支上，作者是 “DeepSeek Harness”，并且会跳过仓库的 hooks（比如集成时的合并提交）。**你的分支永远不会被提交**：`land` 只修改工作区文件。
- 代码和提示词会发到 DeepSeek 的服务器，按你的 DeepSeek 账户计费。
- 关闭会话时（MCP 服务退出），正在运行的工人会被结束，避免在后台继续扣费；之后可以用 `retry` 接着做。

## 配置（环境变量）

| 变量 | 默认值 | 作用 |
|---|---|---|
| `DSH_HOME` | `~/.deepseek-harness` | 存放 worktree、日志和状态 |
| `DSH_MAX_PARALLEL` | `12` | 全局同时运行的工人上限（每个 run 默认 6 个） |
| `DSH_CLAUDE` | `~/.local/bin/claude(.exe)`，或 PATH 里找到的 | 指定 claude 可执行文件 |
| `DSH_BASE_URL` | `https://api.deepseek.com/anthropic` | Anthropic 兼容接口地址 |
| `DSH_VERIFY_TIMEOUT_MIN` | `15` | 单次 setup 或 verify 的时间上限（分钟） |

## 排查问题

- 每个任务的完整事件流在 `runs/<run>/<task>.jsonl`，stderr 在 `<task>.stderr.txt`，检查输出在 `<task>.verify.txt`，patch 在 `<task>.patch`。服务日志是 `~/.deepseek-harness/server.log`。
- 想看某个工人的完整对话：`cleanup` 之前进入它的 worktree，用指向 DeepSeek 的 claude（环境变量和工人一样，见 `server/util.ts` 里的 `workerEnv`）执行 `claude --resume <session>`。session id 在 `result` 的输出里。
- `link` 里的目录是指向主仓库的 junction（目录联接）。工人不能删除或重装它们，否则会改到主仓库里的那份。需要改依赖时改用 `setup`。

## 测试

```bash
deno run -A --no-config test/e2e.ts <一个空的临时目录>
```

这个测试会建一个小的 Deno 库，派出 5 个工人（其中两个故意改同一行，用来测试冲突处理），然后把集成、落地（主工作区同时有一处并发修改）和清理整个流程走一遍，最后逐项打印 PASS/FAIL。会花一点 DeepSeek 额度。2026-10-23 实测：5 个任务墙钟 33 秒，工人耗时合计 1 分 36 秒（约 2.9 倍），10 项检查全部通过。

```bash
deno run -A --no-config test/plugin-smoke.ts <一个空的临时目录>
```

这个测试会用 `--plugin-dir` 启动一个真实的 Claude Code 会话（跑在 DeepSeek 上），确认 harness 工具能加载，并确认 150 秒的 `wait` 不会被客户端的 MCP 超时打断。

## 许可证

[MIT](LICENSE)
