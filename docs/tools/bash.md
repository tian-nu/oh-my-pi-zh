# bash

> 在会话工作区执行 shell 命令，可选 PTY 或后台任务处理。

## Source
- 入口：`packages/coding-agent/src/tools/bash.ts`
- 面向模型的 prompt：`packages/coding-agent/src/prompts/tools/bash.md`
- 主要协作者：
  - `packages/coding-agent/src/tools/bash-interactive.ts` —— PTY/TUI 执行路径。
  - `packages/coding-agent/src/tools/bash-interceptor.ts` —— 阻止更适合专用工具的 shell 命令模式。
  - `packages/coding-agent/src/tools/bash-skill-urls.ts` —— 把内部 URL 展开为路径。
  - `packages/coding-agent/src/tools/bash-pty-selection.ts` —— `canUseInteractiveBashPty()` 决定调用是否可使用本地 PTY overlay。
  - `packages/coding-agent/src/tools/gh-cache-invalidation.ts` —— 为变更性的 `gh issue`/`gh pr` 子命令丢弃 `github-cache` 行。
  - `packages/coding-agent/src/exec/bash-executor.ts` —— 非 PTY shell 执行。
  - `packages/coding-agent/src/session/streaming-output.ts` —— 尾部缓冲、截断、artifact 溢出。
  - `packages/coding-agent/src/tools/tool-timeouts.ts` —— 超时钳制边界。
  - `packages/coding-agent/src/config/settings-schema.ts` —— 默认拦截规则。
  - `docs/bash-tool-runtime.md` —— 更深入的执行器/运行时说明；作为 shell 会话内部机制的配套文档。

## Inputs

| 字段 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `command` | `string` | Yes | 要执行的 shell 命令文本。仅当省略了 `cwd` 时，开头的 `cd <path> && ...` 才会被改写进 `cwd`。 |
| `env` | `Record<string, string>` | No | 额外的环境变量。键必须匹配 `^[A-Za-z_][A-Za-z0-9_]*$`，否则工具会抛出错误。值会经过内部 URL 展开，并作为环境变量值传入，而非 shell 文本。 |
| `timeout` | `number` | No | 超时时间（秒）。默认 `300`。`0` 表示不设截止时间。当 `tools.maxTimeout` 为正时，正值先受其上限约束，再被钳制到 Bash 范围 `1..3600`。 |
| `cwd` | `string` | No | 工作目录，通过 `resolveToCwd` 相对 `session.cwd` 解析。必须存在且为目录。 |
| `pty` | `boolean` | No | 请求 PTY 模式。默认 `false`。仅当 `pty: true`、`PI_NO_PTY !== "1"` 且工具上下文带 UI 时才使用 PTY。 |
| `async` | `boolean` | No | 后台执行请求。仅当会话的 `async.enabled` 为 true 时存在。立即返回 job id 而非等待；它不改变生效的截止时间，包括 `timeout: 0` 停用截止时间的情况。 |

## Outputs
该工具返回单个 `text` 内容块加可选的 `details`。

- 成功，前台：
  - `content[0].text`：命令输出；命令未产生任何输出时为 `(no output)`。
  - `details.timeoutSeconds`：经过全局/按工具钳制后的有效正超时；`timeout: 0` 时为 `details.timeoutDisabled: true`。
  - `details.requestedTimeoutSeconds`：请求的正超时与有效超时不同时出现。
  - `details.wallTimeMs`：已完成的本地/client-terminal 运行所经过的挂钟毫秒数。
  - `details.terminalId`：执行经由 client terminal bridge 路由时出现。
  - `details.exitCode`：命令以非零退出码完成时出现。
  - `details.timedOut: true`：本地/PTY 超时结果上出现。
  - `details.meta.truncation`：输出在内存中被截断时出现；完整输出溢出到 artifact 时包含 `artifactId`。
  - 非零退出与本地/PTY 超时返回标记为 `isError` 的工具结果；确定性的非零输出以 `Command exited with code <n>` 结尾。
- 成功，后台启动（`async: true` 或自动后台）：
  - `content[0].text`：可选的预览尾部与提示，后接 `Backgrounded as job <id>; result will be delivered automatically.`
  - `details.async`：`{ state: "running", jobId, type: "bash" }`。
- 后台进度 / 完成：
  - 通过 `onUpdate` / 异步任务管理器送达，而非初始返回。
  - 运行中的更新仅在任务被视为已后台化之后才包含尾部文本与 `details.async.state: "running"`。
  - 完成/失败更新携带最终文本与 `details.async.state: "completed" | "failed"`。非零退出或超时记为失败的后台任务。
- 失败：
  - 取消、缺失退出状态、校验失败、被拦截的命令与 client-terminal bridge 超时会抛出 `ToolError` / `ToolAbortError`。

模型看到输出前，stdout 与 stderr 已合并。确定性的非零退出码会以 `Command exited with code <n>` 追加到返回的错误结果文本。

## Command policy and dedicated-tool routing

有两个相互独立的设置可以阻止 Bash 子进程启动。它们的用途不同，作用于 tool call 生命周期的不同阶段。

| Setting | Purpose | Rule syntax | Result when matched |
| --- | --- | --- | --- |
| `bash.patterns` | 针对命令的执行策略 | 带 `*` 通配符的纯文本 | 允许该调用、请求人工批准或予以拒绝。 |
| `bashInterceptor.patterns` | 优先使用专用工具而非 Bash | JavaScript 正则表达式、可选标志、工具名与消息 | 返回 Bash 工具错误，告知模型改调用所指名的专用工具。 |

### `bash.patterns`: 权限策略

`bash.patterns` 用于那些必须被允许、需人工确认、或无论其他工具能否胜任都应拒绝的命令。规则按顺序排列，第一条匹配的规则生效。每条规则包含一个 `match` glob 与一个 `approval` 值（`allow`、`prompt` 或 `deny`）。

```yaml
bash:
  patterns:
    - match: "git *"
      approval: allow
    - match: "curl *"
      approval: prompt
    - match: "rm -rf *"
      approval: deny
```

- `deny` 会在 `BashTool.execute()` 运行前终止调用，包括 `yolo` 模式下。
- `prompt` 会显示批准请求。只有被接受的请求才会进入 `BashTool.execute()`。
- `allow` 可以降低简单命令的批准级别，但不能批准复合命令。例如 `match: "git *"` 不会批准 `git status && rm -rf build`。
- `deny` 与 `prompt` 会检查完整命令以及每一段 shell 命令。因此像 `match: "rm -rf *"` 这样的规则也能拦住 `cd /tmp && rm -rf build`。

使用该设置来保障安全与用户控制。对于没有合适替代工具的命令（如破坏性删除、网络访问、部署脚本或项目特定脚本），它依然有用。

### `bashInterceptor.patterns`: 专用工具路由

`bashInterceptor` 是一个可选加入的路由层（`bashInterceptor.enabled` 默认 `false`）。它面向那些技术上合法、但用某个可用专用工具表达更佳的 Bash 命令。每条 pattern 是一个正则表达式，并包含替换工具的名称以及展示给模型的解释。

```yaml
bashInterceptor:
  enabled: true
  patterns:
    - pattern: '^\s*(cat|head|tail)\s+'
      tool: read
      message: "Use the read tool instead; it handles binary files and provides better context."
    - pattern: '^\s*(grep|rg)\s+'
      tool: grep
      message: "Use the grep tool instead; it respects .gitignore and returns structured results."
```

拦截规则仅在当前会话中存在其 `tool` 时才生效。若 `read` 被禁用，指向 `read` 的 `cat` 规则不会拦下 Bash 调用。这使得拦截器成为尽力而为的能力偏好，而非执行安全边界。

内置默认规则把常见操作路由到专用工具，例如把 `cat` 指向 `read`、`rg` 指向 `grep`、原地 `sed` 指向 `edit`、shell 重定向指向 `write`、不受管的服务/后台进程指向 `hub`。完整列表见 `packages/coding-agent/src/config/settings-schema.ts` 中的 `DEFAULT_BASH_INTERCEPTOR_RULES`。

为兼容既有自定义正则，拦截器始终先检查完整的原始命令。随后检查以未加引号、未转义的 `&&`、`||`、`;`、`|`、`&` 或换行分隔的原始扁平命令片段。还会在去掉开头的环境变量赋值后检查片段：

```bash
git add file && git commit -m "message"
GIT_AUTHOR_NAME=Dev git commit -m "message"
```

因此，像 `^\s*git\s+commit\b` 这样的锚定规则能匹配两个示例中的 `git commit` 命令。通过未加引号的 `|` 或 `|&` 消费另一命令 stdout 的管道阶段（例如 `printf 'x\n' | grep x` 中的 `grep x`）**不**被视为拦截候选：它读取的是管道 stdin，基于路径的专用工具无法提供，因此只会匹配独立命令或首阶段命令。管道之后的空行与纯注释续行保留该上下文。加引号、转义与注释文本不视为命令。heredoc、参数展开、命令替换、反引号、分组与格式错误的引号只保留完整命令检查；拦截器刻意不打算成为完整的 shell 解析器。

### Interaction and selection guide

批准策略在执行前解析。命中的 `bash.patterns` `deny` 永远到不了拦截器。命中的 `prompt` 只在用户接受批准请求后才会进入拦截器。若被接受的调用随后又命中拦截规则，Bash 调用仍然不会执行；模型会收到路由错误，并应调用专用工具。

除非有意为之，否则避免在两边配置同一操作。例如，`cat *` 的 `prompt` 规则叠加启用的 `cat` 到 `read` 拦截器，会先请求用户批准 Bash，随后拒绝 Bash 并要求模型改用 `read`。

按期望的结果选择设置：

- 当问题是**命令是否可以执行**时，使用 `bash.patterns`。
- 当问题是**应由哪个工具执行该操作**时，使用 `bashInterceptor.patterns`。

1. `packages/coding-agent/src/tools/bash.ts` 中的 `BashTool.execute()` 读取 `command`、校验 `env`，并把 `timeout` 默认为 `300`。
2. 若缺少 `cwd`，它会将开头的 `cd <path> && ...` 改写为结构化的 `cwd` 字段，并从 `command` 中去掉该前缀。
3. 若在 `async.enabled` 关闭时请求 `async: true`，它会在任何执行之前抛出 `ToolError`。
4. 若 `bashInterceptor.enabled` 开启，`checkBashInterception()` 会同时针对原始命令与去掉 `cd` 前缀的命令运行。对每种形式，配置的正则仍先检查完整输入，再检查每个以未加引号/未转义的 `&&`、`||`、`;`、`|`、`|&`、`&` 或换行分隔的扁平命令（不含从 `|` 或 `|&` 消费管道 stdin 的阶段，跨空行/注释续行亦如此），随后检查去掉开头 `NAME=value` 赋值的片段版本。命中的启用规则会在 URL 展开或执行之前抛出。
5. `expandInternalUrls()` 改写 `command`、每个 `env` 值以及形如协议的 `cwd` 值中受支持的内部 URL。命令中的替换会做 shell 转义；`env` 与 `cwd` 的替换使用原始文件系统/字符串值，因为它们不会被插值进 shell 文本。
6. `resolveToCwd()` 相对 `session.cwd` 解析 `cwd`；`fs.stat()` 验证目标存在且是目录。
7. `timeout: 0` 停用截止时间。否则 `clampTimeout("bash", requestedTimeoutSec, tools.maxTimeout)` 先应用正的全局上限（若已配置），再应用 `TOOL_TIMEOUTS.bash`（`min: 1`、`max: 3600`）。发生钳制时，`#buildCompletedResult()` / `#buildBackgroundStartResult()` 会追加一行提示。
8. 执行路径分流：
   1. `async: true` -> `#startManagedBashJob()` 注册一个会话异步任务并立即返回。
   2. 非 PTY 且 `bash.autoBackground.enabled` 开启、异步任务管理器未达其运行任务上限、且没有可用的 client-terminal bridge（两者都适用时 bridge 优先）-> 启动受管任务，最多等待 `min(thresholdMs, timeoutMs - 1000)`，要么返回已完成的结果，要么把该次运行转为后台任务。
   3. 非 PTY client-terminal bridge：当会话声明具备终端能力且 `pty` 为 false -> 创建远程终端，流式/轮询当前输出，完成后释放终端。
   4. 否则以前台方式执行。
9. 无 client terminal 的前台非 PTY 调用 `packages/coding-agent/src/exec/bash-executor.ts` 中的 `executeBash()`；该路径自行执行 direnv/devenv 预检。
10. 前台 PTY 与 client-terminal 路径在分发前于 `BashTool` 内运行相同的 direnv 预检。在 `bash.direnv: "auto"`（默认值）下，获准的 `.envrc` 可把环境变更并入命令；`"off"` 则禁用此行为。`bash.direnvLoadTimeoutMs` 默认为 `30_000`，正的命令超时同样约束预检。
11. 当 `session.allocateOutputArtifact` 可用时，本地非 PTY 与 PTY 路径先分配输出 artifact。artifact 路径/id 传入 sink，使大输出能溢出到磁盘。
12. `executeBash()` 加载 shell 设置、可选的 shell 快照与 shell 最小化器设置，然后通过持久的原生 `Shell` 会话或一次性 `executeShell()` 运行。`docs/bash-tool-runtime.md` 详细介绍该路径。
13. `runInteractiveBashPty()` 创建 `PtySession`，叠加基于 xterm 的控制台 UI，把用户按键输入转发进 PTY，通过 `OutputSink` 捕获输出，并在关闭/释放时终止 PTY。
14. client-terminal bridge 模式调用 `session.getClientBridge().createTerminal(...)`，发出 `terminalId` 更新，轮询输出直到退出/超时/中止，把信号退出映射为 `137`，并在 `finally` 中释放句柄。
15. 完成时，`#buildCompletedResult()` 在必要时格式化 `(no output)`，从输出摘要附加截断元数据，追加耗时/超时/退出提示，并在返回前重新检查未完成状态。
16. 本地/PTY 超时结果成为带 `details.timedOut` 的 `isError` 结果；client-terminal 超时以及取消/缺失退出状态路径会抛出错误，并在可用时携带捕获的输出。

## Modes / Variants
1. 前台非 PTY 本地
   - 无 client terminal bridge 可用时的默认路径。
   - 使用 `executeBash()`。
   - 通过 `streamTailUpdates()` 与 `TailBuffer(DEFAULT_MAX_BYTES)` 流式发送仅尾部更新。
2. 前台非 PTY client terminal
   - 当 `session.getClientBridge()?.capabilities.terminal` 为 true、存在 `createTerminal` 且 `pty` 为 false 时使用。
   - 通过带 `details.terminalId` 的轮询更新流式发送当前终端输出。
   - 强制执行相同的超时与中止行为，然后释放终端句柄。
3. 前台 PTY
   - 需要 `pty: true`、UI 上下文以及 `PI_NO_PTY !== "1"`。
   - 使用 `runInteractiveBashPty()` 与 `PtySession` overlay。
   - 支持交互式输入；`Esc` 从 overlay 终止会话。
4. 显式后台任务
   - 需要 `async: true` 与 `async.enabled`。
   - 用 `session.asyncJobManager` 注册任务并立即返回 `{ state: "running", jobId }`。`timeout: 0` 使任务不带有工具强加的截止时间。
5. 自动转后台的非 PTY 任务
   - 需要 `bash.autoBackground.enabled`、无 PTY/client-terminal bridge，且异步任务管理器未达其运行任务上限。
   - 像前台受管任务一样启动，超过等待窗口后转入后台；达到容量上限时，Bash 回退为直接前台执行。
6. 被拦截的命令
   - 不创建子进程。
   - 返回 `ToolError`，指引模型使用 `read`、`grep`、`glob`、`edit` 或 `write`。

## Side Effects
- 文件系统
  - 用 `fs.stat()` 校验 `cwd`。
  - 可能为完整本地输出（`bash`）与最小化器保留的原始输出（`bash-original`）分配并写入 artifact 文件。
  - `expandInternalUrls(..., { ensureLocalParentDirs: true })` 会在执行前为 `local://` 路径创建父目录。
- 子进程 / 原生绑定 / client terminal
  - 非 PTY 本地执行通过 `@oh-my-pi/pi-natives`（`Shell.run()` 或 `executeShell()`）使用原生 shell 执行。
  - PTY 使用原生 `PtySession.start()`。
  - client-terminal 模式把进程执行委托给所连接的 client terminal 能力。
- 会话状态
  - 读取会话设置中的 async、auto-background、拦截器、direnv、全局超时上限、工具可用性与 shell 配置。
  - 为显式/自动后台运行向 `session.asyncJobManager` 注册任务。
  - 使用 `session.getSessionId()` 隔离 shell 复用与异步会话键。
  - 使用 `session.allocateOutputArtifact()` 处理溢出文件。
  - 当命令包含变更性的 `gh issue`/`gh pr` 子命令时，在执行前使 `github-cache` 行失效，使之后的 `issue://`/`pr://` 读取能看到变更后的状态（`invalidateGithubCacheForBashCommand`）。
- 用户可见的提示 / 交互 UI
  - PTY 模式打开一个标题为 `Console` 的 TUI overlay 并把输入转发给 PTY。
  - 后台启动消息会说明：结果完成后会自动送达，在此之前可用 `hub` 工具等待该结果。
- 后台工作 / 取消
  - 异步与自动后台任务在工具首次返回后继续运行，直到完成、取消或到达截止时间（除非被 `timeout: 0` 停用）。
  - 取消会中止原生运行；关闭 PTY overlay 同样会终止 PTY。

## Limits & Caps
- 默认超时：`300s`（`packages/coding-agent/src/tools/tool-timeouts.ts` 中的 `TOOL_TIMEOUTS.bash.default`）。
- `timeout: 0` 停用命令截止时间。
- 正超时钳制：`tools.maxTimeout` 是可选全局上限（`0` 表示无全局上限），随后应用 Bash `1..3600s` 范围。
- 自动后台默认阈值：`60_000ms`（`packages/coding-agent/src/tools/bash.ts` 中的 `DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS`）；存在截止时间时进一步封顶为 `timeoutMs - 1000`；截止时间被停用时阈值不封顶。
- 带截止时间的非 PTY 执行器在 `max(1_000, timeoutMs)` 处启用宿主机侧定时器，并把相同的正超时传给原生运行；`timeout: 0` 则不传截止时间。超时的持久 shell 会话会被隔离（`packages/coding-agent/src/exec/bash-executor.ts`）。
- 内存输出尾部上限：`50 * 1024` 字节（`packages/coding-agent/src/session/streaming-output.ts` 中的 `DEFAULT_MAX_BYTES`）。超出后，sink 只在内存中保留尾部窗口。
- `executeBash()` 中的流式回调节流：启用流式时，两次 `onChunk` 调用间隔 `50ms`。
- TUI 折叠预览：在 agent UI 内联渲染时为 `10` 个可视行（`BASH_DEFAULT_PREVIEW_LINES`）；这是渲染器上限，不是工具输出上限。

## Errors
- 输入校验：
  - 无效 env 键 -> `ToolError("Invalid bash env name: <key>")`。
  - 禁用时请求 async -> `ToolError("Async bash execution is disabled...")`。
  - 缺少异步任务管理器 -> `ToolError("Background job manager unavailable for this session.")`。
  - `cwd` 缺失/无效 -> `ToolError("Working directory does not exist: ...")` 或 `ToolError("Working directory is not a directory: ...")`。
- 拦截器：
  - 命令命中规则 -> 带有 `Blocked: <rule.message>` 与原始命令的 `ToolError`。
  - 无效的拦截正则会被 `compileRules()` 静默跳过。
- 内部 URL 展开：
  - 不支持的 scheme、未知的 skill、路径穿越、缺少 router 支持或 router 解析失败都会由 `packages/coding-agent/src/tools/bash-skill-urls.ts` 抛出 `ToolError`。
- 执行：
  - 非零退出 -> 返回标记为 `isError` 的工具结果，带 `details.exitCode`，文本以 `Command exited with code <n>` 结尾。
  - 缺失退出码 -> 抛出带 `Command failed: missing exit status` 的 `ToolError`。
  - 超时 -> 本地/PTY 执行返回带 `details.timedOut: true` 与超时提示的 `isError` 结果；client-terminal bridge 在终止终端并尝试最后一次读取输出后抛出 `ToolError`。受管后台执行会把任一形式记为失败任务。
  - 用户中止 -> 调用方信号被中止时抛出 `ToolAbortError`。
- artifact 分配/保存失败会在 `saveBashOriginalArtifact()` 与 `OutputSink.#createFileSink()` 中被吞掉；执行在缺少该 artifact 的情况下继续。

## Notes
- `BashTool` 上设置了 `strict = true`；`concurrency` 按调用解析：`pty: true` 为 `"exclusive"`（它接管终端 UI），其余均为 `"shared"`，因此同一 assistant 消息中的多个非 pty bash 调用并行运行。当并行调用落在同一 shell 会话键上时，第一个拥有持久的 `Shell`，其余在隔离的一次性 shell 中运行（见 `bash-executor.ts` 中的 `shellSessionsInUse`）。
- `command` 的 URL 展开会对替换做 shell 转义；`env` 与 `cwd` 的展开使用 `noEscape: true`，因为它们会成为环境变量值/文件系统路径，而非 shell 文本。
- `checkBashInterception()` 仅在匹配规则的 `tool` 名称存在于 `ctx.toolNames` 时才拦截；缺失的工具会禁用其对应规则。
- 拦截器配置语法不变。它处理常见的扁平命令列表，而非完整的 shell 解析：heredoc、参数展开、命令替换、反引号、分组与格式错误的引号只会接受既有的整段输入检查。这是向专用工具的尽力而为路由，不是安全边界。
- `bash.direnv` 默认为 `"auto"`，遵循 direnv 的允许列表；未获准的 `.envrc` 不会被执行。设为 `"off"` 可绕过预检。`bash.direnvLoadTimeoutMs` 控制冷加载预算。
- 默认拦截规则来自 `packages/coding-agent/src/config/settings-schema.ts` 中的 `DEFAULT_BASH_INTERCEPTOR_RULES`：
  - `cat|head|tail|less|more` -> `read`
  - `grep|rg|ripgrep|ag|ack` -> `grep`
  - `find|fd|locate` with name/type/glob flags -> `glob`
  - `sed -i`, `perl -i`, `awk -i inplace` -> `edit`
  - `echo|printf|cat <<` with redirection -> `write`
- 在非 UI 上下文以及 `PI_NO_PTY=1` 时忽略 PTY 模式（由 `canUseInteractiveBashPty()` 把关）；工具回退为非 PTY 执行，并追加一条 `pty requested but unavailable in this environment; ran without a terminal` 提示。
- 非 PTY 运行通过 `buildNonInteractiveEnv()` 将 `NON_INTERACTIVE_ENV` 与 `env` 合并；PTY 运行则继承用户环境，并在自定义 `env` 值之前前置 `TERM=xterm-256color`。
- 当 shell 最小化器在 `executeBash()` 内改写输出时，可见输出被最小化文本替换；若 `onMinimizedSave` 持久化了原始文本，可能追加 `[raw output: artifact://<id>]` 页脚。
- TUI 渲染器解析部分 JSON，以便在流式预览早期恢复 `env` 赋值；该行为仅用于显示。
- 非工具专属的执行器内部机制——shell 会话复用键、快照、前缀处理与原生超时行为——参见 `docs/bash-tool-runtime.md`。
