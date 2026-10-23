# DeepSeek Harness

把大任务拆给多个 **DeepSeek 驱动的编码智能体（工人）** 并行完成，每个工人在自己的 git worktree 里干活；由调度方负责拆分、审核、集成和落地。同一个仓库同时是两种插件：

- **DeepSeek Harness（DSH）插件**（`dsh-parallel-workers`）：调度方是 DSH 里的智能体；
- **Claude Code 插件**（`deepseek-harness`）：调度方是桌面 App 里的 Claude，或跑在 DeepSeek 上的 Claude Code CLI。

工人有两种引擎，两种插件都能用：

- **`dsh`**（装了 DSH 时默认用它）：DSH 自带的 headless 模式（`dsh --profile headless`），不依赖 Claude Code。
- **`claude`**：后备引擎，是指向 DeepSeek 接口的 Claude Code CLI（`claude -p`）。

```
调度方
  │ dispatch：给工作区拍快照 → 为每个任务建 worktree + 分支 dsh/<run>/<task>
  ├─ 工人 stats ─ dsh headless（DeepSeek）─ 改代码、自查 ─┐
  ├─ 工人 text  ─ dsh headless（DeepSeek）─ …            ├─ harness 把各自的改动提交到工人分支，跑 verify
  └─ 工人 dates ─ dsh headless（DeepSeek）─ …            ┘
  │ wait / result：看报告、diff、检查结果；不合格就 retry（续接同一个工人对话）
  │ integrate：在集成 worktree 里合并所有分支，再跑一遍整体检查
  │ land：把结果写进你的工作区，作为未提交的改动（不替你 commit）
  └ cleanup：删掉 worktree 和 dsh/* 分支
```

## 需要什么

- 已安装 `git` 和 [Deno](https://deno.com)。harness 服务用 Deno 运行，没有任何外部依赖。
- 工人引擎：要么装 **DeepSeek Harness 桌面版**（`dsh` 引擎），要么装 Claude Code CLI（`claude` 引擎）。两个都装了时默认用 `dsh`。
- DeepSeek API key，放在环境变量 `DEEPSEEK_API_KEY` 里。Windows 上也会读 `HKCU\Environment`，所以用 `setx` 设置后不用重启 App。
- 目标项目得是一个 git 仓库，并且至少有一次提交。

## 安装

### DeepSeek Harness（DSH 0.2.x）

在 DSH 里打开 **插件 → 添加插件**，填 GitHub 仓库 `FelixJiashengFu/deepseek-harness`，或 clone 下来的本地目录路径，点"安装"，再点"立即启用"。插件列表里会出现"DeepSeek 并行工人 (dsh-parallel-workers)"。

也可以用命令行安装，但要先完全退出 DSH 桌面版：

```bash
dsh plugin --profile desktop add github:FelixJiashengFu/deepseek-harness
```

它在 DSH 里是这样接入的：
- `lib/index.js` 是一个很小的 cordis 宿主插件，用 DSH 自带的 `@deepseek-ai/dsh-mcp-client` 启动 harness 服务（`server/main.ts`）。工具名是 `mcp__harness__dispatch`、`mcp__harness__wait` 等。它还负责"并行"开关背后的 `/parallel` 命令、会话状态和系统提示段。
- `lib/client.js` 是浏览器端，把"并行"按钮放进输入栏右侧的 `conversation.input.right` 座位。
- 同时用 `@deepseek-ai/dsh-skill-filesystem` 加载 `skills/deliver`。
- DSH 的 MCP 工具默认 60 秒超时，插件把它调到 62 分钟，所以 `wait` 可以长时间阻塞。
- 插件配置里有 `deno`（deno 不在 PATH 上时填完整路径）和 `toolCallTimeoutMinutes` 两项。

### Claude Code

```bash
claude plugin marketplace add FelixJiashengFu/deepseek-harness
```

```bash
claude plugin install deepseek-harness@deepseek-harness
```

装好后**新开一个会话**才会加载。桌面 App 和 CLI 都能用。想改代码的话，可以先 clone 下来，再用 `claude plugin marketplace add <本地路径>` 从本地目录安装，改动在新会话里生效。

## 用法

### DSH：输入栏右侧的"并行"开关

DSH 的输入栏右侧、模型选择器左边有一个 **并行** 按钮。点亮后，这个会话进入"并行交付模式"：之后你提的任务里，凡是能拆成三个以上互不相关部分的编码任务，智能体都会按 `deliver` 流程把它分给 DeepSeek 工人并行完成；小任务或耦合紧的任务照常自己做，并用一句话说明为什么没有拆。再点一下就关掉。

- 也可以输入 `/parallel on`、`/parallel off` 或 `/parallel`（切换）。
- 开关按会话记录，刷新页面或恢复会话后状态不变。
- 实现方式：宿主端在会话日志里写一条 `plugin:parallel-workers/mode` 记录，并通过 `parallel-workers` 投影把状态送到界面；开关打开时，系统提示里会多一段 "Parallel delivery mode is ON…" 的说明。按钮代码在 `lib/client.js`，宿主端代码在 `lib/index.js`。

### 直接说

不开开关也行，直接说："用 DeepSeek 并行把 X 做了"。在 DSH 里也可以用 `deliver` 技能，在 Claude Code 里可以用 `/deepseek-harness:deliver 把 X 做了`。`deliver` 技能会让调度方：

1. 先写好共享的接口、桩代码和测试（不用提交：dispatch 默认给工作区拍快照，未提交的改动也会带上）；
2. 按**互不重叠的文件**拆成 3 到 8 个任务，每个任务带完整的提示词和 `verify` 命令；
3. 工人跑的时候，调度方自己做没分出去的部分；
4. 逐个审核结果，不合格就带具体反馈 `retry`；
5. `integrate` 后再 `land`，在真实工作区跑测试，然后交给你决定要不要提交。

## 工具

| 工具 | 作用 |
|---|---|
| `dispatch` | 启动一批任务，可用 `runId` 追加第二波。参数有 `engine`（dsh/claude）、`context`、`verify`、`setup`、`link`、`model`（flash/pro）、`effort`、`maxParallel`、`timeoutMin`、`permissionMode` |
| `wait` | 阻塞等待：`all` 等全部完成，`any` 等到有新任务完成就返回，方便边跑边审。返回状态表、墙钟时间、工人总耗时和 token 用量 |
| `status` | 查看某个 run 的状态；不带参数就列出所有 run |
| `result` | 工人报告、改动文件、越界文件、检查结果，以及 diff（截断显示，另给完整 patch 路径） |
| `retry` | 带反馈让工人返工。默认续接同一个对话（dsh 用 `--session-id`，claude 用 `--resume`），失败的检查输出会自动附上 |
| `cancel` | 停止任务，已做的部分保留在分支上 |
| `integrate` | 在集成 worktree 里合并各分支并跑整体检查。遇到冲突就停下，列出冲突文件，解决后用 `continue: true` 继续 |
| `land` | 把集成结果（或单个任务）写进你的工作区，作为未提交的改动。你在 dispatch 之后改过的文件会做三方合并 |
| `cleanup` | 落地后删除 worktree 和分支；日志保留在 `~/.deepseek-harness/runs/<run>` |

## 权限和安全

**`dsh` 引擎**
- 每个工人在 DSH 的 `workspace-write` 沙箱里运行（Windows 上是受限令牌加 ACL）。文件工具和 shell 命令都只能写自己的 worktree 和一个私有临时目录。
- 需要人工审批的操作，在无人值守时会自动拒绝。
- 每个工人有独立的 `DSH_HOME`（`runs/<run>/dsh/<task>`），不会碰你自己的 DSH 会话和设置。工人规则写在那里的 `AGENTS.md` 里，模型和推理强度通过一个 `--patch` 覆盖文件指定。
- 已知限制：沙箱禁止命名管道，所以 `deno test` 这类测试工具在工人里会直接崩溃。工人会改用类型检查、直接运行代码等方式自查；最终的 `verify` 由 harness 在沙箱外运行，不受影响。
- `link` 共享进来的依赖目录在沙箱里同样只能读、不能写。

**`claude` 引擎**
- 用 `--permission-mode acceptEdits --permission-prompts none` 运行：只能改自己 worktree 里的文件；shell 只允许白名单里的命令（git 只读命令，以及 deno、npm、python、pytest、cargo、go 等常见构建和测试工具），其他一律自动拒绝。
- 白名单只是防止误操作，**不是沙箱**：`node`、`python` 这类解释器本身什么都能执行。
- 工人不加载你的 MCP 服务和用户级设置（`--strict-mcp-config --setting-sources project,local`）。

**两种引擎都适用**
- `permissionMode: "bypassPermissions"` 会去掉所有限制（dsh 下就是 `danger-full-access`），只在你明确同意时使用。
- 内部提交只出现在 `dsh/*` 分支上，作者是 “DeepSeek Harness”，并且会跳过仓库的 hooks。**你的分支永远不会被提交**：`land` 只修改工作区文件。
- 代码和提示词会发到 DeepSeek 的服务器，按你的 DeepSeek 账户计费。只在你信任的仓库上用。
- 关闭会话、或在 DSH 里关掉插件时，harness 服务会退出，正在运行的工人会被结束，避免在后台继续扣费；之后可以用 `retry` 接着做。
- Claude Code 和 DSH 可以同时开着，它们共用 `~/.deepseek-harness`。每个 run 会记下驱动它的服务进程；那个进程还活着时，另一边只会提示"由另一个 harness 服务在跑"，不会接管或改动这个 run。

## 配置（环境变量）

| 变量 | 默认值 | 作用 |
|---|---|---|
| `DS_WORKERS_ENGINE` | 装了 DSH 时为 `dsh`，否则为 `claude` | 默认的工人引擎 |
| `DS_WORKERS_DSH` | `%LOCALAPPDATA%\Programs\DeepSeek Harness` | DSH 安装目录（非 Windows 系统填 `dsh` 启动器的路径） |
| `DS_WORKERS_HOME` | `~/.deepseek-harness` | 存放 worktree、日志和状态 |
| `DS_WORKERS_MAX_PARALLEL` | `12` | 全局同时运行的工人上限（每个 run 默认 6 个） |
| `DS_WORKERS_CLAUDE` | `~/.local/bin/claude(.exe)`，或 PATH 里找到的 | `claude` 引擎用的可执行文件 |
| `DS_WORKERS_BASE_URL` | `https://api.deepseek.com/anthropic` | `claude` 引擎用的 Anthropic 兼容接口地址 |
| `DS_WORKERS_VERIFY_TIMEOUT_MIN` | `15` | 单次 setup 或 verify 的时间上限（分钟） |

## 排查问题

- 每个任务的完整事件流在 `runs/<run>/<task>.jsonl`，stderr 在 `<task>.stderr.txt`，检查输出在 `<task>.verify.txt`，patch 在 `<task>.patch`。服务日志是 `~/.deepseek-harness/server.log`。
- `dsh` 工人的会话、规则（`AGENTS.md`）和模型覆盖文件（`worker.patch.yml`）在 `runs/<run>/dsh/<task>`。
- `link` 里的目录是指向主仓库的 junction（目录联接）。需要改依赖时改用 `setup`。

## 测试

```bash
deno run -A --no-config test/e2e.ts <一个空的临时目录> [dsh|claude]
```

这个测试会建一个小的 Deno 库，派出 5 个工人（其中两个故意改同一行，用来测试冲突处理），然后把集成、落地（主工作区同时有一处并发修改）和清理整个流程走一遍，最后逐项打印 PASS/FAIL。会花一点 DeepSeek 额度。2026-10-23 实测，10 项检查都全部通过：

- `dsh` 引擎：墙钟 44 秒，工人耗时合计 1 分 54 秒；
- `claude` 引擎：墙钟 29 秒。

```bash
deno run -A --no-config test/plugin-smoke.ts <一个空的临时目录>
```

这个测试会用 `--plugin-dir` 启动一个真实的 Claude Code 会话（跑在 DeepSeek 上），确认 harness 工具能加载，并确认 150 秒的 `wait` 不会被客户端的 MCP 超时打断。

## 许可证

[MIT](LICENSE)
