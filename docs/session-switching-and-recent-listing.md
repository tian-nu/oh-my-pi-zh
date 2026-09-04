# 会话切换与最近会话列表

本文档介绍 coding-agent 如何发现最近会话、解析 `--resume` 目标、呈现会话选择器，以及切换活动运行时会话。

重点描述当前实现行为，包括回退路径与注意事项。

## 实现文件

- [`../src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts)
- [`../src/session/session-listing.ts`](../packages/coding-agent/src/session/session-listing.ts)
- [`../src/session/session-paths.ts`](../packages/coding-agent/src/session/session-paths.ts)
- [`../src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`../src/cli/session-picker.ts`](../packages/coding-agent/src/cli/session-picker.ts)
- [`../src/modes/components/session-selector.ts`](../packages/coding-agent/src/modes/components/session-selector.ts)
- [`../src/modes/controllers/selector-controller.ts`](../packages/coding-agent/src/modes/controllers/selector-controller.ts)
- [`../src/main.ts`](../packages/coding-agent/src/main.ts)
- [`../src/sdk.ts`](../packages/coding-agent/src/sdk.ts)
- [`../src/modes/interactive-mode.ts`](../packages/coding-agent/src/modes/interactive-mode.ts)
- [`../src/modes/utils/ui-helpers.ts`](../packages/coding-agent/src/modes/utils/ui-helpers.ts)

## 最近会话发现

### 目录范围

`SessionManager` 默认按规范化的 cwd 分桶存储文件会话：

- `~/.omp/agent/sessions/<encoded-cwd>/*.jsonl`

`<encoded-cwd>` 是路径编码后的规范化 cwd（home 下为 `-<relative>`，临时根目录下为 `-tmp-<relative>`，其余为 `--<encoded-absolute>--`；见 [session.md](session.md#on-disk-layout)）。来自已回退的 17.2.5-17.2.8 哈希方案的桶会尽力迁移。`SessionManager.list(cwd, sessionDir?)` 只读取解析后的桶，除非显式提供了 `sessionDir`。

### 两条载荷不同的列表路径

存在两条不同的列表管线：

1. `getRecentSessions(sessionDir, limit)`（欢迎页/摘要视图）
   - 每个文件只读取 4 KiB 前缀。
   - 同时理解当前的固定宽度 title-slot 文件和旧版的 header-first 文件。
   - 解析 header + 最早的用户文本预览。
   - 返回轻量的 `RecentSessionInfo`（`path`、`name`、`timeAgo`）。
   - 按文件 `mtime` 降序排序。

2. `SessionManager.list(...)` / `SessionManager.listAll()`（resume 选择器与 ID 匹配）
   - 每个文件读取 4 KiB 前缀加上有界的 32 KiB 尾部，不读取完整 JSONL 正文。
   - 构建 `SessionInfo`（`path`、`id`、`cwd`、标题/父级元数据、日期、大小、消息预览/计数，以及生命周期状态）。
   - 列表文本使用前缀解析加标记计数，最终消息的生命周期状态使用尾部解析；超出前缀的后续消息可能不在 `allMessagesText` 中。
   - 状态为 `complete`、`interrupted`、`aborted`、`error`、`pending` 或 `unknown`。
   - 按 `modified` 降序排序。按 stat 键缓存的扫描结果会被缓存；大型列表使用有界并行 worker。

正常的按目录扫描会修复 EPERM 原子重写回退在其主 JSONL 缺失时创建的最新孤儿 `.bak`。`listSessionsReadOnly` 是非变更变体。

### 元数据回退行为

对于最近会话摘要（`RecentSessionInfo`）：

- 显示名偏好（`sessionDisplayName`）：`title` -> 第一条用户消息 -> `Untitled · <time>` 标签（刻意从不使用原始 `id`）
- 欢迎页将渲染出的名称截断到可用列宽（无固定长度）
- 标题/消息派生的名称只保留第一行并剥离控制字符（`sanitizeSessionName`）

对于 `SessionInfo` 列表条目：

- `title` 优先取固定 title-slot 值，其次 `header.title`，再次前缀中最后一次压缩的 `shortSummary`
- `firstMessage` 是前缀中可发现的第一条用户消息文本，否则为 `"(no messages)"`
- 选择器还会显示修改时间、文件大小、生命周期状态（`unknown` 除外）、分叉标记，以及 all-projects 范围下的 cwd

## `--continue` 解析与终端面包屑偏好

`SessionManager.continueRecent(cwd, sessionDir?)` 按以下顺序解析目标：

1. 读取终端作用域的面包屑（`~/.omp/agent/terminal-sessions/<terminal-id>`）
2. 校验面包屑。已落盘的目标可用；缺失的目标仅在其可选第三行为 `fresh`（表示一个惰性未落盘的 `/new` 边界）时可用。
3. 缺失的 fresh 目标会启动新会话，而不是回退并复活此前的转录。
4. 将陈旧的修复前 subagent 面包屑解析到其交互式父会话。
5. 如果面包屑的 cwd 与当前 cwd 不同、已不存在，且当前位置没有自己的会话，则将面包屑会话重定根到当前 cwd（`open` + `moveTo`）。
6. 否则使用 cwd 与当前 cwd 一致的面包屑；cwd 不匹配时使用当前桶中最新的会话。
7. 没有可用面包屑时，按 mtime 选择最新文件；若不存在则创建新会话。

终端 ID 派生优先使用 TTY 路径，回退到基于环境变量的标识符（`ZELLIJ_PANE_ID`、`TMUX_PANE`、`CMUX_SURFACE_ID`、`KITTY_WINDOW_ID`、`WEZTERM_PANE`、`TERM_SESSION_ID`、`WT_SESSION`）。

面包屑写入是尽力而为的，不会致命失败。

当唯一的位置参数值符合 session-id 形状时，`-c <value>` 会被规范化为显式 resume 目标；其他位置参数文本仍是 `--continue` 的初始 prompt。

## 启动时 resume 目标解析（`main.ts`）

### `--resume <value>`

`createSessionManager(...)` 以两种模式处理带字符串值的 `--resume`：

1. 路径型值（包含 `/`、`\\`，或以 `.jsonl` 结尾）
   - 直接 `SessionManager.open(sessionArg, parsed.sessionDir)`

2. resume 键值
   - `resolveResumableSession(...)` 先搜索本地会话，再搜索全部会话，除非自定义 `sessionDir` 禁用了全局回退
   - 匹配不区分大小写，接受 `id` 前缀、完整 JSONL 文件名前缀，或时间戳后的 session-id 后缀
   - 按 modified 降序使用第一个匹配（无歧义提示）

如果匹配会话记录的 cwd 已不存在，CLI 会提示 `Move (re-root) it into the current directory? [Y/n]`。接受则打开它并用 `moveTo(cwd)` 迁移；拒绝则干净退出。非 TTY 无法回答，会抛出 `SessionResolutionError`。

否则会话在其记录的项目中打开，包括全局匹配；启动时会切换进程 cwd、重载项目级设置/插件，并在构造 agent 前重新解析已启用模型。仅仅因为匹配是跨项目的**并不**会分叉。

无匹配则抛出 `Session "..." not found.`。

### `--resume`（无值）

在初始 session-manager 构建之后处理：

1. 用 `SessionManager.list(cwd, parsed.sessionDir)` 列出当前文件夹的会话
2. 若为空，仅为了区分全局为空的状态而探测 `SessionManager.listAll()`，并预加载 Tab 范围；选择器本身从不自动切换到 all-projects 范围（issue #3099）
3. 若两个列表都为空，打印 `No sessions found` 并退出
4. 打开全屏 TUI 选择器（`selectSession`）
5. 若取消，打印 `No session selected` 并退出
6. 选中后 `SessionManager.open(selected.path)`，然后将进程/项目级状态切换到会话的 cwd（`switchToResumedProject`：`setProjectDir`、插件缓存重置、设置重载），并重新解析该范围的模型

### `--continue`

直接使用 `SessionManager.continueRecent(...)`（即上述面包屑优先行为）。

## 基于选择器的选择内部机制

## CLI 选择器（`src/cli/session-picker.ts`）

`selectSession(sessions, options)` 创建一个 `SessionSelectorComponent` 的全屏备用屏 TUI，并且恰好解析一次：

- 选中 -> 解析所选的 `SessionInfo`
- 取消（Esc）-> 解析 `null`
- 硬退出（Ctrl+C 路径）-> 停止 TUI 并退出
- Tab 切换 current-folder / all-projects 范围；all-projects 列表惰性加载或预加载提供
- 搜索在短暂去抖后将会话元数据/前缀文本与 `history.db` 的 prompt 历史匹配组合
- 鼠标滚轮更改选中项，左键在全屏选择器中选中
- Delete，或搜索为空时的 Backspace，打开确认后删除 JSONL 及会话附属文件

## 会话内交互式选择器（`SelectorController.showSessionSelector`）

流程：

1. 通过 `SessionManager.list(currentCwd, currentSessionDir)` 获取当前文件夹的会话；即使文件夹范围为空，all-projects 列表也保持惰性
2. 通过 `ctx.ui.showOverlay` 将 `SessionSelectorComponent` 呈现为全屏备用屏覆盖层（锚定左上角、全尺寸；底层 transcript 不受影响），接入惰性 all-project 加载（`loadAllSessions`）、`history.db` prompt 匹配器、删除功能以及固定会话标记
3. 回调：
   - 选中 -> 锁定选择器输入并调用 `handleResumeSession(sessionPath)`；成功后隐藏覆盖层并恢复编辑器焦点，可恢复的切换前失败会解锁选择器并保持其打开
   - 取消 -> 隐藏覆盖层、恢复编辑器焦点、重新渲染
   - 退出 -> 隐藏覆盖层，然后 `ctx.shutdown()`

`/resume <id-prefix>` 先解析本地匹配再解析全局匹配并直接切换。`/resume @claude` 和 `/resume @codex` 则打开只读来源的导入选择器：所选外部 transcript 会被持久化为一个 OMP 会话，然后切换过去；这些选择器不提供删除、历史增强和 all-project 范围。

## 会话选择器组件行为

`SessionList` 支持：

- Up/Down 和 Page Up/Page Down 导航（钳制，不循环）
- Enter 选中
- Delete，或搜索为空时的 Backspace，确认后删除
- Esc 取消；Ctrl+C 退出
- Tab 切换 current-folder / all-projects 范围
- 全屏选择器中的鼠标滚轮/点击
- 跨 id/标题/cwd/第一条消息/前缀消息文本/路径的多 token 搜索：字面匹配按时间新近度领先，之后是足够强的模糊匹配；输入停顿后可提升来自 `history.db` 的 prompt 历史匹配

空列表渲染行为：

- current-folder 范围渲染 `No sessions in current folder. Press Tab to view all.`；all-projects 范围渲染 `No sessions found`
- 空列表上的 Enter/Delete/Backspace 无操作
- Esc/Ctrl+C 仍然有效

## 运行时切换执行（`AgentSession.switchSession`）

`switchSession(sessionPath)` 是核心的进程内切换路径。

生命周期/状态转换：

1. 捕获先前的文件并发出可取消的 `session_before_switch`（`reason: "resume"`，目标文件）
2. 断开 agent 监听器、中止活动工作、运行切换前协调器，并冲刷待处理的 bash/会话写入
3. 快照回滚状态（manager、队列、消息、模型/思考/层级、工具/prompts、provider 缓存身份，以及检查点/回退状态），然后清空消息队列
4. 对于不同会话，排空/分离 advisor 记录器
5. `sessionManager.setSessionFile(sessionPath)`：更新面包屑、加载/迁移/blob 解析/索引条目，并在 cwd 策略允许时采纳已记录的 cwd
6. 同步会话 id、内存键、继承的 provider 缓存键、显示上下文，以及检查点/回退状态
7. 发出 `session_switch`、替换消息、重置 advisor 会话状态，并同步 todos
8. 对于不同会话，或重放发生变化的同会话重载，关闭 provider 会话
9. 按 role/default 回退顺序恢复第一个可用的已记录模型
10. 如果加载的分支以中断的工具流程结束，追加一条合成的中止消息并重建显示上下文
11. 恢复配置的思考设置（`auto` 仍保持为 auto）和按家族的服务层级，无对应条目时回退到当前设置
12. 按需重置内存/工具会话状态、重连监听器、运行模式协调，并刷新工作区感知的基础系统 prompt
13. 为不同会话恢复 advisor 开销、完成 bash 过渡、通知会话变更回调，成功时返回 `true`
当切换前 hook 取消或 cwd 策略拒绝该转换时，`switchSession()` 返回 `false`。没有 cwd 变更回调的跨项目切换会被拒绝，而不是静默采纳目标 cwd；回调拒绝同样视为取消。

快照之后的任何失败都会恢复先前的 manager 和运行时状态、重连/协调它、将 bash 过渡标记为失败，然后重新抛出。

## 交互式切换后的 UI 状态重建

`SelectorController.handleResumeSession` 先调用 `switchSession`。若它返回 `false`，选择器在应用任何新会话 UI 更新之前停止，保持现有会话/UI 不变。切换成功后，它会：

- 停止加载动画
- 清空状态容器
- 清空待处理消息 UI 和待处理工具映射
- 重置流式组件/消息引用
- 若恢复会话的 cwd 与先前不同，将进程及 cwd 派生的缓存重新指向它（`applyCwdChange`）
- 清空聊天容器并从会话上下文重新渲染（`renderInitialMessages`）
- 从新会话附属文件重载 todos
- 显示 `Resumed session`（跨项目恢复时显示 `Resumed session in <dir>`）

因此可见的会话/todo 状态是从新会话文件重建的。

## 启动恢复与会话内切换

### 启动恢复（`--continue`、`--resume`、直接打开）

- 会话文件在 `createAgentSession(...)` 之前选定。
- `sdk.ts` 在创建过程中构建已有会话上下文。
- Agent 消息与重放状态在构造期间一次性恢复。
- 模型/思考/服务层级使用持久化状态并以当前配置作为回退。
- 交互模式随后协调持久化的模式状态。

### 会话内切换（`/resume` 式选择器路径）

- 在已运行的会话上使用 `AgentSession.switchSession(...)`。
- 消息/模型/思考/层级以及会话作用域的运行时状态在原位重建。
- 会发出 `session_before_switch`/`session_switch` hook。
- UI 聊天/todos 会刷新。
- 交互模式协调通过已注册的会话切换协调器进行。

## 失败与边界情况行为

### 取消路径

- CLI 选择器取消 -> 返回 `null`，调用方打印 `No session selected`，进程退出。
- 交互式选择器取消 -> 关闭覆盖层，会话不变。
- 核心 hook 或 cwd 策略取消 -> `switchSession()` 返回 `false`；交互式选择器在其 UI 刷新/状态路径之前停止，保留旧会话和 UI。没有回调的跨项目切换会被拒绝，而不是静默采纳目标 cwd。

### 空列表路径

- CLI `--resume`（无值）：只有当前文件夹**和**全局列表都为空时才打印 `No sessions found` 并退出；否则空的文件夹范围选择器会提示按 Tab。
- 交互式选择器：空的文件夹范围渲染 Tab 提示并保持可取消。

### 目标会话文件缺失/无效

打开/切换到特定路径时（`setSessionFile`）：

- ENOENT -> 视为空 -> 在该精确路径初始化新会话并持久化。
- 头部格式错误/无效（或解析条目实际不可读）-> 视为空 -> 初始化新会话并持久化。

这是恢复行为，不是硬失败。

### 硬失败

真正的 I/O 失败（权限错误、重写失败等）仍会使切换/打开抛出异常，并传播给调用方。

### ID 前缀匹配注意事项

- 匹配对小写的会话 id、小写的 JSONL 文件名，以及文件名时间戳后的小写 id 后缀使用 `startsWith`。
- 按 modified 降序取第一个匹配；多个会话共享前缀时没有歧义 UI。
- 前缀列表元数据刻意保持轻量，因此搜索文本可能不包含会话文件前 4KB 之外的消息。
