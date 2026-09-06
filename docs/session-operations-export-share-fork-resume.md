# 会话操作：export、dump、share、fresh、clear、fork、resume/continue

本文档描述会话 export、share、对话重置、生命周期、fork 与 resume 操作当前实现中操作者可见的行为。

## 实现文件

- [`../src/modes/controllers/command-controller.ts`](../packages/coding-agent/src/modes/controllers/command-controller.ts)
- [`../src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`../src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts)
- [`../src/export/html/index.ts`](../packages/coding-agent/src/export/html/index.ts)
- [`../src/export/custom-share.ts`](../packages/coding-agent/src/export/custom-share.ts)
- [`../src/main.ts`](../packages/coding-agent/src/main.ts)

## 操作矩阵

| Operation                               | Entry path                   | Session mutation                              | Session file creation/switch                                                               | Output artifact                                                                     |
| --------------------------------------- | ---------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `/dump`                                 | 斜杠命令（TUI/headless）     | 否                                            | 否                                                                                         | 剪贴板/命令文本，外加 best-effort 的临时 JSON sidecar                              |
| `/export [--themes] [path]`             | 斜杠命令（TUI/headless）     | 否                                            | 否                                                                                         | HTML 文件                                                                           |
| `--export <session.jsonl> [outputPath]` | CLI 启动快速路径             | 无运行时会话变更                              | 无活动会话；读取目标文件                                                                   | HTML 文件                                                                           |
| `/share`                                | 斜杠命令（TUI/headless）     | 否                                            | 否                                                                                         | 加密分享链接（gist 或 share server）；临时 HTML 仅用于 TUI 自定义 handler           |
| `/new`                                  | 交互式斜杠命令               | 是（启动一个空对话）                          | 切换身份；持久模式下分配新的 transcript 路径                                              | 无                                                                                  |
| `/fresh`                                | 斜杠命令（TUI/headless）     | 是（仅 provider 侧内存中的 id/状态）         | 否；保留当前会话文件/header                                                               | 无                                                                                  |
| `/clear`                                | 交互式斜杠命令               | 是（清空实时/模型对话上下文）                 | 否；保留会话身份、元数据、transcript 文件与完整的磁盘历史                                  | 追加一条持久的 `reset_boundary`                                                      |
| `/drop`                                 | 交互式斜杠命令               | 是（启动一个空对话）                          | 尝试删除当前持久化会话与产物，然后切换到新会话                                            | 无                                                                                  |
| `/fork`                                 | 交互式斜杠命令               | 是（活动会话身份改变）                        | 创建新的会话文件并把当前会话切换到它（仅持久模式）                                        | 存在时把产物目录复制到新会话命名空间                                                   |
| `--fork <id\|path>`                     | CLI 启动                     | 会话创建后是                                      | 从所选来源创建一个新的会话 fork 到当前 cwd/session 目录                                 | 无                                                                                  |
| `/resume [id\|@claude\|@codex]`         | 交互式斜杠命令               | 是（活动内存状态被替换）                      | 切换到所选/匹配的会话，或导入所选的外部会话                                              | 无                                                                                  |
| `--resume`                              | CLI 启动选择器               | 会话创建后是                                    | 打开所选既有会话文件（选择器在当前文件夹作用域打开；全局列表仅为空态提前退出与即时 Tab 切换预加载） | 无                |
| `--resume <id\|path>`                   | CLI 启动                     | 会话创建后是                                    | 打开既有会话；记录中缺失的 cwd 可能被 re-root 到当前目录                                  | 无                                                                                  |
| `/restart`                              | 交互式斜杠命令               | 是（进程重启）                                 | 以原始启动 flags 重启 omp 并在原位置恢复当前会话                                          | 无                                                                                  |
| `--continue`                            | CLI 启动                     | 会话创建后是                                    | 打开终端面包屑或最近会话；若不存在则创建新会话                                            | 无                                                                                  |

## Export 与 dump

### `/export [--themes] [outputPath]`（斜杠命令）

流程：

1. 内置斜杠命令注册表（`src/slash-commands/builtin-registry.ts`）用 `parseExportArgs` 解析参数；TUI 把同一命令委托给 `CommandController.handleExportCommand`。
2. `--themes` 选择配置好的暗/亮 TUI 主题，而不是独立的 web 调色板。移除该 flag 后，最多接受一个以空白分隔的路径；多余 token 会产生 `Usage: /export [--themes] [path]`。
3. `AgentSession.exportToHtml()` 调用 `exportSessionToHtml(sessionManager, state, { outputPath, palette, themeNames })`。
4. TUI 显示路径并在浏览器中打开该文件。Headless 命令执行只打印路径而不打开它。

行为细节：

- `--copy`、`clipboard` 与 `copy` 参数会被显式拒绝，并警告改用 `/dump`。
- Export 会嵌入会话 header/entries/leaf，外加来自 agent 状态的当前 `systemPrompt` 与工具描述。
- 存储在会话文件旁边的 subagent transcript（`<session>/<AgentId>.jsonl`，嵌套 spawn 递归存放）会作为 `subSessions` 嵌入（`src/export/html/index.ts` 中的 `collectSubSessions`；可在 `ExportOptions` 中用 `includeSubSessions: false` 关闭）。在页面中，task 工具卡片里的 agent id 会打开带面包屑的 sub-session 浮层。
- 工具调用通过 `<omp-tool-view>` web component 渲染——即与 collab-web（`packages/collab-web/src/tool-render/`）共享的 React 按工具渲染器，由 `bun run gen:tool-views` 预构建到 `src/export/html/tool-views.generated.js`。
- Export 期间不追加任何会话条目。

注意事项：

- 解析基于空白，因此带空格的带引号路径不会被保留。请使用不含空格的路径。

### `--export <inputSessionFile> [outputPath]`（CLI）

`main.ts` 中的流程：

1. 在早期处理（交互式/会话启动之前）。
2. 调用 `exportFromFile(inputPath, outputPath?)`。
3. `SessionManager.open(inputPath)` 加载 entries，随后生成并写入 HTML。
4. 进程打印 `Exported to: ...` 并退出。

行为细节：

- 输入文件缺失会显示为 `File not found: <path>`。
- 该路径不创建 `AgentSession`，也不改变任何运行中的会话。

### `/dump`（剪贴板/headless 文本导出）

流程：

1. 命令调用 `session.formatSessionAsText()`。
2. 若返回空字符串，命令报告 `No messages to dump yet.`
3. 否则它还尝试 `session.dumpLlmRequestToTmpDir()`，并把结果路径追加到 transcript。TUI 把合并后的文本复制到剪贴板；headless/ACP 命令执行则把它作为命令输出返回。

Dump transcript 内容包含：

- 系统 prompt
- 活动模型/thinking 级别
- 工具定义 + 参数
- 用户/助手消息
- Thinking 块与工具调用
- 工具结果与执行块（`excludeFromContext` 的 bash/python 条目除外）
- 自定义/hook/文件提及/分支摘要/压缩摘要条目

Best-effort 的 JSON sidecar 命名为 `omp-llm-request-<id>.json`，位于操作系统临时目录下。它包含当前模型、thinking 级别、服务层级、系统 prompt、wire 工具 schema 与经 LLM 转换的消息。命令结束后它仍然存在，且可能包含原始上下文或机密；请相应保护或删除它。Sidecar 失败不会抑制 transcript（TUI 报告该失败；headless 执行静默省略该路径）。

Dump 不会追加任何会话持久化条目。

## 分享（Share）

`/share` 发布会话的端到端加密快照，并打印查看器链接。实现见 [`../packages/coding-agent/src/export/share.ts`](../packages/coding-agent/src/export/share.ts)。

### TUI 阶段 1：自定义 share handler（若存在）

交互式 TUI 的 `loadCustomShare()` 会在 `~/.omp/agent` 中查找第一个存在的候选：

- `share.ts`
- `share.js`
- `share.mjs`

要求：

- 模块必须默认导出一个函数 `(htmlPath) => Promise<CustomShareResult | string | undefined>`。

若存在且有效，旧契约得以保留：会话被导出到临时 HTML 文件（`${os.tmpdir()}/${Snowflake.next()}.html`），handler 收到其路径，随后临时文件被删除。Handler 结果的解释：

- string => 视为 URL，显示并打开
- object => 显示 `url` 与/或 `message`；打开 `url`
- `undefined`/falsy => 通用 `Session shared`

关键回退行为：

- 若自定义 handler 存在但加载失败，命令报错并返回。
- 若自定义 handler 执行时抛出异常，命令报错并返回。
- 在这两种失败情况下，它**不会**回退到默认流程。
- 只有不存在自定义 share 脚本时才会运行默认流程。
- Headless/ACP 斜杠命令执行不加载自定义 share 脚本；它始终使用默认的加密流程。

### 默认加密分享

对于 headless 执行，或 TUI 中找不到自定义 share handler 时，`shareSession()`：

1. 构建会话快照（`header`、`entries`、`leafId`，外加来自 agent 状态的当前 `systemPrompt` 与工具描述）。
2. 若 `share.redactSecrets` 已启用（默认）且混淆器配置或正则发现了机密，一次带类型的逐字段脱敏会重写承载文本的 header、prompt、tool、entry、sub-session 与 message 字段。内联图像字节保留给随后的尺寸检查。不透明的 provider 回放字段与无类型扩展载荷（`details`、`data`、`outputSchema`、压缩保留数据）会被丢弃而不是遍历。
3. JSON 被 gzip 并用新的 AES-256-GCM 密钥密封（`[12B IV][ciphertext+tag]`）。
4. 上传目标由 `share.store` 选择：
   - **Share server**（默认，`store: "blob"`）——向 `POST <share.serverUrl>`（默认 `https://my.omp.sh/s`）发送原始 blob，上限 1 MB。超大的快照会被修剪到合适大小：先内联图像，然后长字符串（32 KB → 8 KB → 2 KB → 512 B 上限），最后最早的 entries。
   - **Secret gist**（`store: "gist"`）——当 `gh` 已安装并认证时，密封 blob 以 base64 编码推送到 `session.ompshare.txt`（密封预算 5 MB；gist raw 获取上限 10 MB），`gh` 不可用时回退到 share server。
5. 两种情况下链接都是 `<share.serverUrl>/<id>#<base64url key>`。该处托管的查看器页面获取 blob（hex id 走 GitHub gist API，其他一律走服务器的 blob store）并在客户端解密；密钥只存在于 URL fragment 中，永远不会出现在任何 HTTP 请求里。

UI 报告分享 URL（外加底层的 gist URL，以及适用时的截断说明）。Headless `/share` 打印同样的行。与 `/export` 不同，`/share` 对内存中（`--no-session`）会话也有效：快照由实时 entries 构建，不需要会话文件。

share 中的取消/中止语义：

- Loader 有 `onAbort` hook，会恢复编辑器 UI 并报告 `Share cancelled`。
- 上传本身不会在半途被中止；取消是 UI 级的，在上传返回后才检查。

## Fresh

交互式 `/fresh` 会重置当前会话的 provider 侧流状态，**而不触碰本地 transcript、会话文件或 header**。当 provider 流卡死或损坏（过期 prompt 缓存、turn 中途故障，或服务端会话 id 漂移）时用它来恢复，同时保留你能看到的对话。

`AgentSession.freshSession()`：

- 在 agent 流式期间会被拒绝——请先等响应结束或中止它。
- 关闭每个缓存的 provider-session 状态条目（服务端会话/prompt-cache 句柄），并报告清理了多少个。
- 铸造新的 provider 会话 id，并把 hindsight 与 mnemopi 记忆重新关联到它；同时使 append-only 上下文失效，以便下一 turn 把完整本地 transcript 重新发送给 provider。
- 本地 transcript、会话文件与会话身份保持不变，因此你说过或收到过的任何内容都不会丢失。

由于它同时保留可见对话与面向模型的对话，`/fresh` 不同于 `/clear`（就地清空实时/模型对话）、`/new`（启动全新空会话）与 `/drop`（尝试删除当前会话并启动新会话）。只有 `/fresh` 在保留现有对话的同时给 provider 流状态一个干净的开始。

## Clear

交互式 `/clear` 就地清空当前对话上下文。它只在 TUI 中可用，并且当响应正在流式或前台 bash/Python 执行正在运行时会被拒绝。若压缩处于活动状态，命令会中止它并等待其停止后再重置。

`AgentSession.resetSessionContext()`：

- 丢弃实时消息、排队的 steer/follow-up turns、待处理的工具调用、错误状态、checkpoint/rewind 与延迟工具状态，以及 session-stop 继续状态。它还会取消该 agent 排队的继续工作与异步 bash/task jobs。
- 轮换 provider 侧会话状态、重新初始化 advisors、使 append-only 模型上下文失效，并重置记忆提升，以便下一 turn 从基础系统 prompt 与当前项目指令重建。
- 保留会话 id、标题、cwd、模型、设置、活动 plan 路径与 transcript 文件。
- 追加一条持久的 `reset_boundary`。折叠后的实时 transcript 与重建的模型上下文从最新 boundary 之后开始，而 JSONL transcript 与全量 transcript 导出在磁盘上保留重置前的历史。

TUI 在成功清空后清空其渲染的 transcript。这与 `/fresh`（轮换 provider 流状态而不清空对话）、`/new`（创建新的会话身份与 transcript 文件）和 `/drop`（在启动新会话前尝试删除旧的持久化会话）不同。

## Fork

交互式 `/fork` 从当前会话创建新会话，并切换活动会话身份。

### 前置条件与即时防护

- 若 agent 正在流式，`/fork` 会带警告被拒绝。
- 操作前会清除 UI 状态/加载指示器。

### 会话级流程

`AgentSession.fork()`：

1. 发出 `session_before_switch`，`reason: "fork"`（可取消）。
2. 冲刷待处理的写入。
3. 调用 `SessionManager.fork()`。
4. 把产物目录从旧会话命名空间复制到新命名空间（best-effort；非 ENOENT 的复制失败会被记录，但不致命）。
5. 更新 `agent.sessionId`，并继承先前的 provider prompt-cache key，除非已显式钉住 prompt-cache key。
6. 发出 `session_switch`，`reason: "fork"`。

`SessionManager.fork()` 行为：

- 要求持久模式与既有会话文件。
- 创建新的会话 id 与新的 JSONL 文件路径。
- 重写 header：
  - 新 `id`
  - 新时间戳
  - `cwd` 不变
  - `parentSession` 设为之前的会话 id
  - `providerPromptCacheKey` 设为先前 header 的继承 key，未钉住时设为之前的会话 id
- 新文件中所有非 header entries 保持不变。

### 非持久行为

- 内存会话管理器从 `fork()` 返回 `undefined`。
- `AgentSession.fork()` 返回 `false`。
- UI 报告 `Fork failed (session not persisted or cancelled)`。

### CLI `--fork <id|path>`

启动时 `--fork` 在正常会话创建之前解析：

1. `--fork` 与 `--no-session` 同时使用会被拒绝。
2. 类路径值（`/`、`\` 或 `.jsonl`）调用 `SessionManager.forkFrom(path, cwd, sessionDir)`。
3. 其他值经由 `resolveResumableSession(...)` 解析：先本地会话，在未强制 `sessionDir` 时再全局搜索。匹配接受小写会话 id 前缀、完整 JSONL 文件名前缀，以及去除时间戳的文件名 id 后缀。
4. fork 出的文件创建在当前 cwd/session-dir 作用域内，并成为启动时的活动会话管理器。
5. 全上下文 fork 会自动从源 header 的继承 key 播种 `providerPromptCacheKey`，回退到源会话 id。当 `--model`、`--thinking`、`--system-prompt`、`--append-system-prompt`、`--tools` 或 `--no-tools` 改变 provider 路由或 prompt/工具形态时，启动会放弃该自动继承。

用 `--prompt-cache-key <key>` 显式且独立于 OMP 会话 id 与 `--provider-session-id` 钉住 provider prompt-cache 身份。`--provider-session-id` 继续控制 provider 会话/路由 header 与粘性凭据选择；`--prompt-cache-key` 在支持处控制 OpenAI Responses 的 `prompt_cache_key` 载荷。

## Resume 与 continue

## 交互式 `/resume [value]`

不带参数时：

1. 打开由 `SessionManager.list(currentCwd, currentSessionDir)` 填充的会话选择器。选择器总是在当前文件夹作用域打开；空状态（`No sessions in current folder. Press Tab to view all.`）会邀请你按 Tab 进入全部项目，而不是自动切换（issue #3099）。
2. Tab 切换到全部项目作用域，惰性加载并缓存 `SessionManager.listAll()`。
3. 选中后，`SelectorController.handleResumeSession(sessionPath)` 调用 `session.switchSession(sessionPath)`。若切换被拒绝，它返回 `false`，选择器停止且不应用新会话 UI 状态。
4. 成功切换后，UI 清空/重建聊天与 todos，然后报告 `Resumed session`（当恢复的会话属于另一个项目时报告 `Resumed session in <dir>`，此时进程 cwd 与 cwd 派生的缓存会经由 `applyCwdChange` 重新指向）。

带参数时：

- `/resume <id>` 以本地优先解析 id/文件名前缀，然后全局回退并直接切换到匹配的文件；未知值报告 `Session "<value>" not found`。
- `/resume @claude` 与 `/resume @codex` 打开外部会话选择器。选中一个会把它转换并以新的 OMP 会话身份持久化，然后切换到那个新会话。

## CLI `--resume`

### `--resume`（无值）

- `main.ts` 列出当前 cwd/sessionDir 的会话并在当前文件夹作用域打开选择器。列表为空时它会预加载 `SessionManager.listAll()`，使用户发起的 Tab 切换到全部项目作用域立即生效；它不会自动切换作用域（issue #3099）。只有全局列表也为空时才打印 `No sessions found`。
- 在会话创建前用 `SessionManager.open(selectedPath)` 打开所选路径；随后进程/项目作用域切换到被恢复会话的 cwd（`switchToResumedProject`），重载 cwd 作用域的设置与插件缓存，并重新解析作用域模型。

### `--resume <value>`

`createSessionManager()` 的解析顺序：

1. 若值看起来像路径（`/`、`\` 或 `.jsonl`），直接打开。
2. 否则 `resolveResumableSession(...)` 搜索：
   - 当前作用域（`SessionManager.list(cwd, sessionDir)`）
   - 仅当未提供显式 `sessionDir` 时搜索全局会话（`SessionManager.listAll()`）
3. 匹配接受不区分大小写的会话 id 前缀、完整 JSONL 文件名前缀，以及 `<timestamp>_<sessionId>.jsonl` 中去掉时间戳后的 id 后缀。

跨项目 id 匹配行为：

- 若匹配会话记录中的目录已不存在，CLI 会询问 `Session's directory no longer exists (...). Move (re-root) it into the current directory? [Y/n]`。
  - 选择是（默认）时，`SessionManager.open(match.path)` 后接 `manager.moveTo(cwd)` 会把既有会话 re-root 到当前目录而不复制它。
  - 选择否时，启动被取消。在非 TTY 模式下，启动以错误失败，提示用户以交互方式运行。
- 若记录中的目录仍然存在，匹配会话被直接打开。启动随后把进程/项目作用域切换到被恢复会话的 cwd，并重载 cwd 作用域的设置与插件缓存。它不会被隐式 fork。

## CLI `--continue`

`SessionManager.continueRecent(cwd, sessionDir)`：

1. 解析当前 cwd 的会话目录。
2. 读取终端作用域的面包屑。若它指向嵌套的产物/subagent 会话，解析会上溯到顶层交互父会话（最多八层）。
3. 若面包屑指向记录在另一个 cwd 下、且其目录已不存在的会话，**且**当前目录没有任何自己的会话，则通过 `moveTo` 把该会话 re-root 到当前目录，而不是重新开始。
4. 否则，若面包屑的 cwd 与当前 cwd 匹配，使用面包屑会话；否则回退到最近修改的会话文件。
5. 打开找到的会话；若不存在则创建新会话。

为兼容起见，当 UUID 是唯一的位置消息时，`--continue <full-UUID>` 会被归一化为 `--resume <UUID>`。`autoResume` 设置在未提供显式会话 flag/会话目录时调用同样的 `continueRecent` 行为，并在找到先前 transcript 时恢复会话模型/thinking 状态。

这是仅启动行为；没有交互式的 `/continue` 斜杠命令。

## 会话切换实际上如何改变运行时状态

`AgentSession.switchSession(sessionPath)` 执行 resume 类操作所用的运行时迁移：

1. 发出 `session_before_switch`，`reason: "resume"` 与 `targetSessionFile`（可取消）。
2. 断开 agent 事件订阅、中止进行中的工作，并运行可选的 pre-switch reconciler。
3. 冲刷待处理的 bash/会话写入并捕获回滚状态：会话管理器状态；agent 消息与所有队列；model/thinking/服务层级；工具与 prompts；provider/cache id；记忆提升；以及 checkpoint rewind 状态。
4. 清空 agent 与下一 turn 队列。若文件不同，排空/分离 advisor recorder。
5. `sessionManager.setSessionFile(sessionPath)`、更新 provider-cache/会话 id 与记忆键、构建显示上下文，并重新水合 checkpoint 状态。
6. 发出 `session_switch`，`reason: "resume"`。
7. 替换 agent 消息、重置 advisor 状态并同步 todos。对不同的文件关闭缓存的 provider 会话；对重放消息发生变化的同文件重载也关闭。
8. 恢复可用的持久化模型。若加载的分支以被中断的 turn 结束，追加其合成的中止消息并重建上下文。
9. 恢复配置/生效的 thinking 与按族的服务层级，目标分支无对应条目时回退到当前设置。
10. 若 transcript 不同，重置记忆上下文；若对话被重写，清空会话作用域的工具状态。
11. 重连 agent 事件，运行可选的会话切换 reconciler（交互模式用它重新进入 plan 等持久化模式），并 best-effort 刷新工作区根的系统 prompt 块。Reconciler/prompt 刷新错误会被记录，而不会回滚已提交的切换。
12. 恢复目标 advisor 成本状态、完成 bash 迁移、在会话 id 改变时通知会话变更回调，并返回 `true`。
`switchSession()` 在 before-switch hook 取消或 cwd 策略拒绝迁移时返回 `false`。没有 cwd 变更回调的跨项目切换会被拒绝，而不是静默采用目标 cwd；回调拒绝同样是取消。交互式选择器会检查该结果，并保持既有会话/UI 不变。

若受防护迁移中的某个抛出步骤失败，`switchSession()` 会恢复捕获的会话、agent 队列/消息、工具/prompts、model/thinking/服务层级、provider/cache、记忆与 checkpoint 状态；在重新抛出前重连先前的 agent 订阅并重新运行模式协调。

`switchSession()` 本身不会创建新的会话文件。

## 事件发出与取消点

### Switch/fork 生命周期 hooks

对于 `newSession`、`fork` 与 `switchSession`：

- Before 事件：`session_before_switch`
  - reasons：`new`、`fork`、`resume`
  - 可通过返回 `{ cancel: true }` 取消
- After 事件：`session_switch`
  - 同一组 reasons
  - 包含 `previousSessionFile`

`ExtensionRunner.emit()` 在第一个取消的 before 事件结果处提前返回。当 before-switch hook 取消时，`switchSession()` 返回 `false` 且不发出 after-switch 事件。

### 自定义工具 `onSession` 行为

SDK 把扩展会话事件桥接到自定义工具 `onSession` 回调：

- `session_switch` -> `onSession({ reason: "switch", previousSessionFile })`
- `session_branch` -> `reason: "branch"`
- `session_start` -> `reason: "start"`
- `session_tree` -> `reason: "tree"`
- `session_shutdown` -> `reason: "shutdown"`

这些回调是观察性的；它们不会取消 switch/fork。

### 与本文档相关的其他取消面

- `/fork` 在流式期间被阻止（用户必须先等待/中止当前响应）。
- `/resume` 选择器可被用户关闭选择器来取消。
- 跨项目 `--resume <id>` 可通过拒绝缺失目录的 move/re-root 提示来取消。
- `/share` 有 UI 中止路径（`Share cancelled`）；上传本身不会在半途被杀掉。

## 非持久化（内存中）会话行为

当会话管理器以 `SessionManager.inMemory()`（`--no-session`）创建时：

- 会话文件路径不存在。
- `/export` 以 `Cannot export in-memory session to HTML` 失败（传播到命令错误 UI）。`/share` 仍然有效：快照由实时 entries 构建。
- `/fork` 失败，因为 `SessionManager.fork()` 需要持久化。
- `/dump` 仍然有效，因为它序列化内存中的 agent 状态。
- 若设置了 `--no-session`，CLI resume/continue 语义会被绕过，因为管理器创建会立即返回内存模式。

## 已知实现注意事项（截至当前代码）

- `/share` 自定义 share 失败不会降级到默认的加密分享流程；它们以错误终止 TUI 命令。
- `/export` 参数 token 化不保留带空格带引号的路径。
- `/drop` 把删除视为 best-effort：它尝试删除当前会话 JSONL 与产物目录，记录任何删除失败，并且仍然创建并切换到新会话。失败或部分删除可能把旧会话或其产物留在磁盘上，因此 `/drop` 不是有保证的擦除边界。
