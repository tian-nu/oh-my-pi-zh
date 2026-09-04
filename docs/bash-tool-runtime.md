# Bash 工具运行时

本文档描述 agent 工具调用使用的 **`bash` 工具**运行时路径，从命令规范化到执行、截断/工件（artifact）以及渲染。

它还指出在交互式 TUI、print 模式、RPC 模式以及用户发起的 bang（`!`）shell 执行中行为有差异之处。

## 范围与运行时表面

coding-agent 中有两种不同的 bash 执行表面：

1. **工具调用表面**（`toolName: "bash"`）：模型调用 bash 工具时使用。
   - 入口：`BashTool.execute()`。
   - 参数包括 `command`、可选的 `env`、`timeout`、`cwd`、`pty`，以及当 `async.enabled` 为 true 时的 `async`。
2. **用户 bang 命令表面**（交互输入的 `!cmd` 或 RPC `bash` 命令）：会话级辅助路径。
   - 入口：`AgentSession.executeBash()`。

两者最终都使用 `src/exec/bash-executor.ts` 中的 `executeBash()` 做非 PTY 执行，但只有工具调用路径运行规范化/拦截、可选的托管后台作业处理以及工具渲染器逻辑。

在设置中设 `bash.enabled: false` 可从活跃工具注册表中移除面向模型的 `bash` 工具。这不会禁用用户发起的 bang 命令或 RPC `bash` 请求。

## 端到端工具调用管线

## 1) 输入处理与参数合并

`BashTool.execute()` 当前按如下方式处理输入：

- 对可选的 `env` 名称按 shell 变量语法验证，
- 当未提供 `cwd` 且路径无需 shell 展开时，将前导的单行 `cd <path> && ...` 提取为 `cwd`，
- `async.enabled` 为 false 时拒绝 `async: true`，
- `timeout` 默认 300 秒；`0` 显式禁用命令截止时间。

没有结构化的 `head` 或 `tail` 参数。执行前，命令和环境值中的内部 URL 会展开为后备文件系统路径；用作 `cwd` 的内部 URL 也会被解析。展开可为可写的 `local://` 路径创建父目录。随后可配置的 direnv/devenv 预检可合并项目环境变更，显式的 `env` 值优先。

### 审批策略

bash 工具属于 `exec` 审批层级。`bash.patterns` 规则可显式 `allow`、`deny` 或 `prompt`：deny/prompt 规则匹配完整命令或分词后的复合命令片段，而 allow 规则必须匹配整条命令且绝不放行 shell 控制语法。一组固定的关键破坏性及远程取回并执行的模式始终强制 exec 审批，即使用户 allow 规则已匹配。拦截与审批是独立机制：拦截将误用路由到专用工具；审批决定执行是否可以继续。

这些规则只约束 **`bash` 工具**。它们不约束通过其他工具启动的 shell —— 尤其是 `eval`，它可通过子进程 spawn shell（`subprocess.run(["bash", "-c", ...])`、`Bun.$` 等）。因此当同一命令经 `eval` 发出时，`bash.patterns` 的 `deny` 规则不起作用。要在两个表面上都加固对破坏性命令的防御，请将 `bash.patterns` 与 `tools.approval.eval` 策略（`prompt` 或 `deny`）配对；见 [Tool approval mode](./approval-mode.md)。

## 2) 可选拦截（阻止命令路径）

若 `bashInterceptor.enabled` 为 true，`BashTool` 从设置加载规则（`getBashInterceptorRules()`）并对命令运行 `checkBashInterception()` —— 当原始形式与按 cwd 规范化后的形式（提取前导 `cd … &&` 之后）不同时，两者都检查。规则语法不变：每条规则先检查完整输入，再检查由未引用/未转义的 `&&`、`||`、`;`、`|`、`|&`、`&` 或换行分隔的原始扁平命令片段，然后检查去除了前导 `NAME=value` 赋值的那些片段。从 `|` 或 `|&` 接收管道 stdin 的片段被排除在片段候选之外（包括跨空行/注释续行），因为消耗 stdin 的阶段无法被基于路径的专用工具替换。

拦截行为：

- 命令仅在以下条件同时满足时被阻止：
  - regex 规则匹配，且
  - 建议的工具存在于 `ctx.toolNames` 中。
- 无效的 regex 规则被静默跳过。
- 阻止时，`BashTool` 抛出带消息的 `ToolError`：
  - `Blocked: ...`
  - 包含原始命令。
- heredoc、参数展开、命令替换、反引号、分组和格式错误的引用不会产生额外片段；它们只保留完整输入检查。拦截是尽力而为的专用工具路由，而非 shell 安全策略。

默认规则模式（定义于代码中）针对常见误用：

- 文件读取器（`cat`、`head`、`tail` 等）
- 搜索工具（`grep`、`rg` 等）
- 文件查找器（`find`、`fd` 等）
- 原地编辑器（`sed -i`、`perl -i`、`awk -i inplace`）
- shell 重定向写入（`echo ... > file`、heredoc 重定向）

### 注意事项

`InterceptionResult` 包含 `suggestedTool`，但 `BashTool` 当前只呈现消息文本（`details` 中没有结构化的建议工具字段）。

## 3) CWD 验证与超时解析

`cwd` 相对会话 cwd 解析（`resolveToCwd`），然后经 `stat` 验证：

- 路径缺失 -> `ToolError("Working directory does not exist: ...")`
- 非目录 -> `ToolError("Working directory is not a directory: ...")`

默认超时 300 秒。`timeout: 0` 禁用截止时间。其他值被限制到 `[1, 3600]` 秒，并受正的 `tools.maxTimeout` 上限约束；当请求值与解析值不同时记录一条 clamp 通知及两个值。

## 4) 工件分配

执行前，工具（尽力而为地）为截断输出存储分配一个工件路径/id。

- 工件分配失败不是致命的（执行继续，无工件溢出文件），
- 工件 id/路径被传入执行路径，用于截断时持久化完整输出。

## 5) PTY 与非 PTY 执行选择

PTY 资格由 `canUseInteractiveBashPty(pty, ctx)` 决定（`src/tools/bash-pty-selection.ts`）；本地 PTY 覆盖层只在以下全部为真时运行：

- 工具输入 `pty === true`
- `PI_NO_PTY !== "1"`
- 工具上下文有 UI（`ctx.hasUI === true` 且 `ctx.ui` 已设置）

若请求了 `pty` 但不可用，调用回退到非 PTY 并追加一条 `pty requested but unavailable …` 通知。

在本地 PTY/非 PTY 选择之前，前台（`async: false`）调用可以路由到托管后台作业（自动后台化；见下文），或 —— 当会话客户端宣告终端能力（`clientBridge.capabilities.terminal` + `createTerminal`，且 `pty` 为 false）时 —— 路由到在远端运行命令的**客户端桥接编辑器终端**（流式 `terminalId` 更新、超时时杀死、将信号杀死映射为退出码 `137`）。否则它使用非交互式 `executeBash()`。

这意味着 print 模式和非 UI 的 RPC/工具上下文始终使用非 PTY。

## 非交互式执行引擎（`executeBash`）

## Shell 会话复用模型

`executeBash()` 在一个进程级全局 map 中缓存原生 `Shell` 实例，键为：

- shell 路径，
- 配置的命令前缀，
- snapshot 路径，
- 序列化的 shell 环境，
- 可选的 agent 会话键，
- minimizer 配置。

会话级 bang 命令执行传递 `sessionKey: this.sessionId`。

工具调用执行在可用时传递 `sessionKey: this.session.getSessionId?.()`。在两个表面上，会话键都将 shell 复用按会话隔离；没有会话键时，复用回退到 shell 配置/snapshot/环境。
并发调用从不共享一个 `Shell`：原生会话一次只运行一条命令，且 `Shell.abort()` 会杀死其上每个在途运行。`executeBash()` 在 `shellSessionsInUse` 中跟踪在途键；当某个键忙碌时，重叠的调用跳过缓存，改用一次性 `executeShell()`（与隔离会话相同的隔离级别）。只有持有调用的 `finally` 会释放在用标志或删除缓存的会话。

## 内置 `jq` 兼容性

除非 `PI_DISABLE_UUTILS_BUILTINS` 为真，非 PTY 原生 shell 注册一个由 vendored [jaq](https://github.com/01mf02/jaq) 支持的内置 `jq` 命令，而非系统 `jq`。设置该标志会禁用进程内 uutils 命令集并回退到系统二进制。内置 jaq 在链式访问经过 null 或缺失的中间值时报错：对 `{}` 执行 `.a.b` 以退出码 5 结束，而 jq 返回 `null`。

当父级可能为 null 或缺失时，用 `[.a.b?][0]` 守护访问。`?` 抑制 jaq 的遍历错误（jq 从不抛出它），`[…][0]` 将被抑制的空输出映射为 `null`，同时保留合法的 `false` 或 `null` 值：

```jq
{"c": [.a.b?][0]}
```

避免朴素的 `.a.b? // null`：`//` 把合法的 `false`（和 `null`）当作缺失，因此会悄悄把布尔数据改写为回退值。解析上也有分歧 —— `{"c": .a.b? // null}` 被 jaq 接受但在 jq 中是语法错误（值需要括号：`{"c": (.a.b? // null)}`）。

## Shell 配置、direnv 与 snapshot 行为

每次调用时，执行器加载设置中的 shell 配置（`shell`、`env`、可选 `prefix`）并运行 `applyDirenvPreflight()`。

除非 `bash.direnv` 为 `"off"`，预检会在 `bash.direnvLoadTimeoutMs` 内（并额外受正的命令超时约束）尝试加载 cwd 的 direnv/devenv 变更。Direnv 提供的变量合并在显式调用方 `env` 之下；被 direnv 移除的安全变量以 `unset -v ...` 前置。ACP 终端和 PTY 路由在其后端之前运行同样的预检；非 PTY 执行器在内部运行它。

如果所选 shell 包含 `bash`，它尝试 `getOrCreateSnapshot()`：

- snapshot 从用户 rc 捕获别名/函数/选项，
- snapshot 创建是尽力而为，
- 失败则回退到无 snapshot。

若配置了 `prefix`，它会在任何 direnv unset 前缀之后包裹命令。

随后每命令的子进程环境由 `buildNonInteractiveEnv()`（`src/exec/non-interactive-env.ts`）构建，它把非交互加固默认值叠放在调用方与 direnv 覆盖**之下**：

- 禁用 pager（`PAGER=cat`、`GIT_PAGER=cat` 等以及 `LESS=FRX`），
- 禁用编辑器提示（`GIT_EDITOR=true`、`EDITOR=true`、`VISUAL=true`），
- 减少终端/凭据提示（`TERM=dumb`、`GIT_TERMINAL_PROMPT=0`、`SSH_ASKPASS=/usr/bin/false`、`NO_COLOR=1`、`CI=true`，除非设置了 `PI_BASH_NO_CI`/`CLAUDE_BASH_NO_CI`），
- 包管理器/工具的非交互自动化标志（npm/pnpm/yarn/pip/cargo/terraform/gh 等），
- 在 Windows 上，缺少时添加 UTF-8 locale/代码页默认值。

## 流式输出与取消

`Shell.run()` 将数据块流式传给 `OutputSink` 和可选的 `onChunk` 回调。

取消：

- 中止信号触发 `shellSession.abort(...)`，
- 原生结果中的超时映射为 `cancelled: true` + 注释文本，
- 显式取消同样返回 `cancelled: true` + 注释。

执行器内部不为超时/取消抛出异常；它返回结构化的 `BashResult`，让调用方映射错误语义。

## 交互式 PTY 路径（`runInteractiveBashPty`）

启用 PTY 时，工具运行 `runInteractiveBashPty()`，它打开一个覆盖控制台组件并驱动原生 `PtySession`。

行为要点：

- xterm-headless 虚拟终端在覆盖层中渲染视口，
- 键盘输入被规范化（包括 Kitty 序列和 application cursor mode 处理），
- 运行中按 `esc` 杀死 PTY 会话，
- 终端尺寸变化传播到 PTY（`session.resize(cols, rows)`）。

与非 PTY 引擎不同，交互式 PTY 路径**不**应用非交互加固。它继承用户环境并设置真实的 `TERM=xterm-256color`（在 Rust 侧作为覆盖应用），使编辑器、pager 和 TUI 像正常终端一样工作。

PTY 输出被规范化（`CRLF`/`CR` 转为 `LF`、`sanitizeText`）并写入 `OutputSink`，包括工件溢出支持。

PTY 启动/运行时错误时，sink 接收 `PTY error: ...` 行，命令以未定义退出码收尾。

## 输出处理：流式、截断、工件溢出

PTY 与非 PTY 路径都使用 `OutputSink`。

## OutputSink 语义

bash 执行器以设置中的 `headBytes` 和 `maxColumns` 构建 sink（`resolveOutputSinkHeadBytes` / `resolveOutputMaxColumns`）。

- 维护 UTF-8 安全的滚动**尾**窗口（`spillThreshold`、`DEFAULT_MAX_BYTES`，当前 50KB）；溢出时裁剪到尾部（UTF-8 边界安全）并标记 `truncated`，
- 当 `headBytes > 0`（`tools.artifactHeadBytes`，默认 20KB）时还保留一个**头**窗口并省略中间，在 `dump()` 中于头尾之间拼接一个省略标记，
- 每行列上限：当 `maxColumns > 0`（`tools.outputMaxColumns`，默认 768 字节）时，超宽行在写入时被省略号截断，行的其余部分被丢弃，
- 跟踪看到的总字节/行数，
- 当输出溢出、列上限丢弃字节、或文件已活跃时，将**原始、无上限**的流镜像到工件文件，
- 尾部溢出、中间省略、列上限丢弃或文件溢出时标记 `truncated`。

`dump()` 返回：

- `output`（可能带注释前缀），
- `truncated`，
- `totalLines/totalBytes`，
- `outputLines/outputBytes`，
- 中间被省略时的 `elidedBytes/elidedLines`，
- 每行上限触发时的 `columnDroppedBytes/columnTruncatedLines`，
- 工件文件活跃时的 `artifactId`。

### 长输出注意事项

运行时截断在 `OutputSink` 中基于字节阈值（默认 50KB 尾窗口，外加可选的用于中间省略的头窗口）。该代码路径不强制硬性行数上限。

### Shell 输出 minimizer

非 PTY 执行还会把 shell-minimizer 设置传入原生 `Shell` 会话。当 minimizer 改写冗长输出时，执行器用最小化文本替换 sink 的可见文本，并尽可能将原始捕获保存为单独的 `bash-original` 工件，由 `[raw output: artifact://<id>]` 页脚引用。

## 实时工具更新与异步作业

非 PTY 前台执行时，`BashTool` 使用单独的 `TailBuffer` 做部分更新，并在命令运行期间发出 `onUpdate` 快照。

PTY 执行时，实时渲染由自定义 UI 覆盖层处理，而非 `onUpdate` 文本块。

当 `async.enabled` 为 true 且调用传递 `async: true` 时，`BashTool` 立即启动一个托管的 bash 作业，返回带作业 id 的运行中结果，并通过会话作业管理器存储完成状态。自动后台化在超过 `bash.autoBackground.thresholdMs` 后也可走此路径；PTY 和客户端桥接终端路由会跳过它，作业管理器满载时回退到前台执行。排队中的引导消息可以让仍在运行的自动后台候选提前转入后台。

## 结果整形、元数据与错误映射

执行之后：

1. 取消或缺失退出状态会抛出工具错误。客户端桥接终端路由在结构化结果
   整形之前也会因超时抛出 `ToolError`。
2. 本地非 PTY 和交互式 PTY 超时返回带 `details.timedOut = true` 的错误结果，
   使渲染器能将其与普通失败区分。
3. 空输出变为 `(no output)`。
4. 末尾的内联字节上限保护绕过 `OutputSink` 的路由；它复用 sink 工件（如可用）或保存一个 `bash-original` 工件。
5. 截断元数据从 sink 摘要附加。
6. 非零退出返回带 `details.exitCode` 的错误结果；零返回成功。

结果详情还可包括解析/请求的超时、`timeoutDisabled`、客户端 `terminalId`、墙上时间、异步作业状态和截断元数据。截断包括方向/原因、总行/字节数与显示行/字节数、显示范围，以及持久化成功时的 `artifactId`。

内置工具包装自动追加面向模型的恢复通知，例如 `Read artifact://<id> for full output`。

## 渲染路径

## 工具调用渲染器（`bashToolRenderer`）

`bashToolRenderer` 用于工具调用消息（`toolCall` / `toolResult`）：

- 折叠模式显示按视觉行截断的预览，
- 展开模式显示当前可用的全部输出文本，
- 警告行包含截断原因，截断时还包含 `artifact://<id>`，
- 超时值（来自参数）显示在页脚元数据行。

### 注意事项：完整工件展开

`BashRenderContext` 有 `isFullOutput`，但当前渲染器上下文构建器不为 bash 工具结果设置它。展开视图仍使用结果内容中已有的文本（尾部/截断输出），除非其他调用方提供完整工件内容。

## 用户 bang 命令组件（`BashExecutionComponent`）

`BashExecutionComponent` 用于交互模式中用户的 `!` 命令（非模型工具调用）：

- 实时流式显示块，
- 折叠预览保留最后 20 个逻辑行，
- 每行钳制在 4000 字符，
- 元数据存在时显示截断 + 工件警告，
- 分别标记已取消/错误/退出状态。

该组件由 `CommandController.handleBashCommand()` 接线，并从 `AgentSession.executeBash()` 供数。

## 各模式行为差异

| 表面                           | 入口路径                                              | PTY 资格                                              | 实时输出体验                                                             | 错误呈现                                         |
| ------------------------------ | ----------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------ |
| 交互式工具调用                 | `BashTool.execute`                                    | 是，当 `pty=true` 且有 UI 且 `PI_NO_PTY!=1`           | PTY 覆盖层（交互式）或流式尾部更新                                       | 工具错误变为 `toolResult.isError`                |
| Print 模式工具调用             | `BashTool.execute`                                    | 否（无 UI 上下文）                                    | 无 TUI 覆盖层；输出出现在事件流/最终 assistant 文本流中                  | 相同的工具错误映射                               |
| RPC 工具调用（agent 工具）     | `BashTool.execute`                                    | 通常无 UI -> 非 PTY                                   | 结构化工具事件/结果                                                      | 相同的工具错误映射                               |
| 交互式 bang 命令（`!`）        | `AgentSession.executeBash` + `BashExecutionComponent` | 否（直接使用执行器）                                  | 专用的 bash 执行组件                                                     | 控制器捕获异常并显示 UI 错误                     |
| RPC `bash` 命令                | `rpc-mode` -> `session.executeBash`                   | 否                                                    | 直接返回 `BashResult`                                                    | 消费方处理返回字段                               |

## 运维注意事项

- 拦截器仅在建议的工具当前在上下文中可用时才阻止命令。
- 工件分配失败时截断仍会发生，但没有 `artifact://` 反向引用可用。
- 本模块中 shell 会话缓存没有显式淘汰；生命周期为进程级。
- 超时整形因后端而异：本地非 PTY 和交互式 PTY 超时返回带 `details.timedOut` 的错误结果；客户端桥接终端创建/执行超时路径抛出 `ToolError`。非超时取消在这些工具调用路由上抛出。

## 实现文件

- [`src/tools/bash.ts`](../packages/coding-agent/src/tools/bash.ts) — 工具入口、输入处理/拦截、异步与 PTY/非 PTY 选择、结果/错误映射、bash 工具渲染器。
- [`src/tools/bash-pty-selection.ts`](../packages/coding-agent/src/tools/bash-pty-selection.ts) — 选择本地 PTY 覆盖层的 `canUseInteractiveBashPty` 谓词。
- [`src/tools/bash-interceptor.ts`](../packages/coding-agent/src/tools/bash-interceptor.ts) — 拦截器规则匹配与阻止命令消息。
- [`src/tools/bash-skill-urls.ts`](../packages/coding-agent/src/tools/bash-skill-urls.ts) — 命令、环境值与 cwd 的内部 URL 展开。
- [`src/exec/bash-executor.ts`](../packages/coding-agent/src/exec/bash-executor.ts) — 非 PTY 执行器、shell 会话复用、取消接线、输出 sink 集成。
- [`src/exec/non-interactive-env.ts`](../packages/coding-agent/src/exec/non-interactive-env.ts) — 非 PTY 执行器使用的非交互子进程环境默认值（`buildNonInteractiveEnv`）。
- [`src/exec/direnv.ts`](../packages/coding-agent/src/exec/direnv.ts) — 执行器预检使用的 direnv/devenv 环境加载。
- [`src/tools/bash-interactive.ts`](../packages/coding-agent/src/tools/bash-interactive.ts) — PTY 运行时、覆盖层 UI、输入规范化与交互式 `TERM` 设置。
- [`src/session/streaming-output.ts`](../packages/coding-agent/src/session/streaming-output.ts) — `OutputSink`、`TailBuffer`、截断/工件溢出与摘要元数据。
- [`src/tools/output-meta.ts`](../packages/coding-agent/src/tools/output-meta.ts) — 截断元数据形状 + 通知注入包装器。
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts) — 会话级 `executeBash`、消息记录、中止生命周期。
- [`src/modes/components/bash-execution.ts`](../packages/coding-agent/src/modes/components/bash-execution.ts) — 交互式 `!` 命令执行组件。
- [`src/modes/controllers/command-controller.ts`](../packages/coding-agent/src/modes/controllers/command-controller.ts) — 交互式 `!` 命令 UI 流/更新完成的接线。
- [`src/modes/rpc/rpc-mode.ts`](../packages/coding-agent/src/modes/rpc/rpc-mode.ts) — RPC `bash` 和 `abort_bash` 命令表面。
- [`src/internal-urls/artifact-protocol.ts`](../packages/coding-agent/src/internal-urls/artifact-protocol.ts) — `artifact://<id>` 解析。
