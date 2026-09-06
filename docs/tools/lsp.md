# lsp

> 查询 language server，以获取诊断、导航、符号、重命名、代码操作、能力与原始请求。

## 源码
- 入口：`packages/coding-agent/src/lsp/index.ts`
- 面向模型的 prompt：`packages/coding-agent/src/prompts/tools/lsp.md`
- 关键协作者：
  - `packages/coding-agent/src/lsp/client.ts` — 客户端进程生命周期与 JSON-RPC
  - `packages/coding-agent/src/lsp/config.ts` — 配置加载、自动检测、服务端选择
  - `packages/coding-agent/src/lsp/lspmux.ts` — 可选的 `lspmux` 命令包装
  - `packages/coding-agent/src/lsp/mux/daemon.ts` — broker 共享的 LSP 传输，以及私有进程回退
  - `packages/coding-agent/src/lsp/edits.ts` — 应用 `WorkspaceEdit` 与文本编辑
  - `packages/coding-agent/src/lsp/utils.ts` — URI 转换、符号解析、格式化、glob 展开
  - `packages/coding-agent/src/lsp/types.ts` — 工具 schema 与协议类型
  - `packages/coding-agent/src/lsp/clients/index.ts` — 自定义 linter 客户端缓存/工厂
  - `packages/coding-agent/src/lsp/clients/lsp-linter-client.ts` — 基于 LSP 的 linter 适配器
  - `packages/coding-agent/src/lsp/clients/biome-client.ts` — Biome CLI 诊断/格式化适配器
  - `packages/coding-agent/src/lsp/clients/swiftlint-client.ts` — SwiftLint CLI 诊断适配器
  - `packages/coding-agent/src/tools/index.ts` — 工具注册与 `lsp.enabled` 门控
  - `packages/coding-agent/src/tools/tool-timeouts.ts` — 超时默认值与钳制
  - `packages/coding-agent/src/lsp/defaults.json` — 自动检测用的内置服务端定义

## 输入

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `action` | string enum | 是 | `diagnostics`、`definition`、`references`、`hover`、`symbols`、`rename`、`rename_file`、`code_actions`、`type_definition`、`implementation`、`status`、`reload`、`capabilities`、`request` 之一。 |
| `file` | string | 否 | 文件路径；对 `diagnostics` 也可以是 glob；workspace 形式请用 `"*"`；`rename_file` 中为源路径。 |
| `line` | number | 否 | 基于位置的操作所用的 1 起始行号。单文件操作路径上默认为 `1`。 |
| `symbol` | string | 否 | 用于在 `line` 上解析列位置的子串。支持 `name#N` 出现次数选择器；`N` 从 1 起始，默认为 `1`。对项目感知的服务器，在 `definition`/`references`/`rename` 中给出 `line` 时为必填。 |
| `query` | string | 否 | workspace 符号查询、代码操作选择器/过滤器，或 `action=request` 时的 LSP 方法名。 |
| `new_name` | string | 否 | `rename` 与 `rename_file` 必填。 |
| `apply` | boolean | 否 | 对 `rename`/`rename_file`，除非显式为 `false` 否则应用；对 `code_actions`，除非显式为 `true` 否则列出。 |
| `timeout` | number | 否 | 秒，默认 `20`；`clampTimeout("lsp", ...)` 先应用正值的 `tools.maxTimeout` 上限，再应用工具的 `5..300` 范围（因此 5 秒下限仍优先于更低的全局上限）。 |
| `payload` | string | 否 | `action=request` 的 JSON 字符串；覆盖自动构建的参数。 |

## 输出
- 一次性 `AgentToolResult`；`content` 始终是一个文本块：`[{ type: "text", text: string }]`。
- `details` 为 `LspToolDetails`：`action`、`success`、可选的 `serverName`、可选的原始 `request`。
- 空的导航/符号查询（例如 `No definition found`）会额外标记 `useless: true`，使压缩（compaction）可以剔除它们；干净的诊断结果则作为验证证据保留。
- 无流式更新、无工件 URI、无后台任务。内联 TUI 渲染器把调用与结果合并渲染，加入按 action 感知的格式化，并支持折叠/展开视图。
- 该工具可被发现（discoverable），而非急切加载。只读操作（`diagnostics`、导航、hover、符号、`status`、`capabilities`）请求只读批准；`rename`、`rename_file`、`code_actions`、`reload` 与 `request` 无论 `apply` 如何都请求写批准。
- 许多校验失败以普通文本结果返回并带 `details.success: false`；中止则抛出 `ToolAbortError`。

## 流程
1. `packages/coding-agent/src/tools/index.ts` 注册 `lsp: LspTool.createIf`。仅当 `session.enableLsp !== false` 与 `lsp.enabled`（默认 `true`）都允许时工具才存在。`lspReadOnly` 会话会拒绝 `LSP_READONLY_ACTIONS` 之外的每个操作；受限会话默认同时关闭 LSP 且设为只读（若被显式重新启用）。
2. `LspTool.execute()`（位于 `packages/coding-agent/src/lsp/index.ts`）用 `clampTimeout("lsp", ...)` 钳制 `timeout`，包括可选的全局 `tools.maxTimeout` 上限，构建 `AbortSignal.timeout(...)`，并与调用方信号组合。
3. `getConfig()` 按 cwd 加载并缓存 `LspConfig`，通过 `setIdleTimeout()` 应用空闲超时配置，后续调用复用缓存配置。workspace `reload` 是显式例外：它先清空并重建该 cwd 的配置缓存，再重载新选定的服务端。
4. `packages/coding-agent/src/lsp/config.ts` 中的配置加载把 `defaults.json` 与来自项目、项目配置目录、用户配置目录、插件根/marketplace 元数据以及 home 的 JSON/YAML 覆盖合并；若无覆盖，则按 root marker 加可执行文件发现自动检测服务端。文件名、优先级与服务端字段见 [LSP 配置](../lsp-config.md)。
5. 服务端路由使用 `config.ts` 中的 `getServersForFile()` / `getServerForFile()`：先做扩展名或 basename 匹配，再把主服务端排在 linter 之前。`index.ts` 进一步用 `getLspServersForFile()` / `getLspServerForFile()` 把自定义 linter 客户端排除在导航/重构路径之外。
6. `getOrCreateClient()` 按 `command:cwd` 缓存一个客户端。启用 `lsp.shared`（SDK 会话默认 `true`）时，它先向 broker 管理的项目 mux 请求共享传输；失败则回退到私有 `ptree.spawn()`。外部 `lspmux` 包装优先于 broker 共享。随后客户端启动消息读取器，发送 `initialize`，存储 capabilities，并发送 `initialized`。
7. `client.ts` 中的消息读取器解析 LSP 帧、解决挂起的请求、缓存 `publishDiagnostics`、跟踪用于项目加载完成的 `$/progress` token、应答 `workspace/configuration`，并通过 `applyWorkspaceEdit()` 应用 `workspace/applyEdit` 请求。
8. 文件级操作在请求前调用 `ensureFileOpen()`。列解析使用 `utils.ts` 的 `resolveSymbolColumn()`：读取目标文件，省略 `symbol` 时取首个非空白字符，否则在目标行上找精确或大小写不敏感的匹配，并遵循 `#N` 出现次数选择器。
9. `LspTool.execute()` 通过专用分支分发操作：仅 workspace 的分支（`status`、部分 `diagnostics`、workspace `symbols`、workspace `reload`、`capabilities`、`request`）在单文件 switch 之前运行；其余单文件操作共享一次客户端查找与 `switch(action)`。
10. 请求经 `client.ts` 的 `sendRequest()` 发送：分配递增的 JSON-RPC id，安装中止与超时处理，中止时发送 `$/cancelRequest`，超时或进程退出时拒绝。
11. 返回编辑的操作要么用 `edits.ts` 的 `formatWorkspaceEdit()` 预览，要么用 `applyWorkspaceEdit()` 应用；`rename_file` 还会执行文件系统重命名，随后发送 `workspace/didRenameFiles`。
12. 单文件操作块内的非中止失败转为 `LSP error: ...`；许多前置条件失败返回显式文本而不抛出。

## 模式 / 变体
### 路由与工作区作用域
- `file: "*"` 只对 `diagnostics`、`symbols` 与 `reload` 特殊。
- `status` 忽略 `file`。
- `capabilities` 省略 `file` 或使用 `"*"` 时检查所有非自定义 LSP 服务端；给出具体文件时限定到匹配的非自定义服务端。
- `request` 省略 `file` 或使用 `"*"` 时选择第一个可用的非自定义 LSP 服务端；给出具体文件时选择该文件的主非-linter 服务端。
- `rename_file` 向 `getLspServers(config)` 中 `fileTypes` 匹配源、目标或任一枚举重命名对的每个非自定义 LSP 服务端发送 `workspace/willRenameFiles` 与 `workspace/didRenameFiles`——不只是单个文件级服务端。
- 诊断是唯一既查询普通 LSP 服务端、又查询自定义 linter 客户端（`BiomeClient`、`SwiftLintClient` 或 `LspLinterClient`）的工具操作。

### `diagnostics`
**输入**
- 必填：`file`，除非用 `file: "*"` 的 workspace 模式。
- 可选：`timeout`。

**执行**
- `file: "*"`：`runWorkspaceDiagnostics()` 按 Rust → TypeScript → Go workspace/module → Python 顺序选择第一个匹配的项目类型。它运行 Rust `cargo check --message-format=short`、TypeScript `npx tsc --noEmit`、Python `pyright` 或 Go `go build`：`go.mod` 用 `./...`，而 `go.work` 先读取 `go work edit -json`，再构建每个 `Use[].DiskPath/...` 模式（回退到 `./...`）。未知项目返回 supported-marker 消息而不启动检查器。
- 具体文件或 glob：`resolveDiagnosticTargets()` 把非 glob 当作单个目标，否则把 `Bun.Glob` 展开到最多 `MAX_GLOB_DIAGNOSTIC_TARGETS`。
- 对每个文件，每个匹配的服务端都会运行：自定义客户端调用 `lint(file)`；真实 LSP 服务端可选地等待项目加载，捕获 `diagnosticsVersion`，调用 `refreshFile()`，然后用 `waitForDiagnostics()` 等待新的 `publishDiagnostics`（在最新一次发布上落定；版本完全匹配立即接受）。
- 结果按 range+message 去重，并按严重度排序。

**输出文本**
- 无问题的单个目标：`OK`。
- 有问题的单个目标：`<summary>:\n<grouped diagnostics>`。
- 批/glob 目标：每个文件一个区块，glob 超过文件上限时开头给出截断警告。
- workspace 模式：`Workspace diagnostics (<detected description>):\n<command output>`。

### `definition`
**输入**
- 必填：`file`。
- 可选：`line`、`symbol`、`timeout`。

**执行**
- 发送 `textDocument/definition`，参数为 `{ textDocument, position }`。
- 接受 `Location`、`Location[]`、`LocationLink` 或 `LocationLink[]`；`normalizeLocationResult()` 把 `LocationLink` 转为 `targetSelectionRange ?? targetRange`。
- 对项目感知的服务端，给出 `line` 时要求提供 `symbol`（该操作禁用首个非空白列回退）。
- 请求前等待项目加载完成。

**输出文本**
- `No definition found`，或 `Found N definition(s):` 后接 `file:line:col`，以及每个位置上下各一行的上下文。

### `type_definition`
与 `definition` 使用相同的位置归一化与输出形态，但发送 `textDocument/typeDefinition`，并报告 `type definition(s)`。与 `definition` 不同，该实现提供 `line` 时不要求显式 `symbol`；未提供时解析首个非空白列。

### `implementation`
与 `definition` 使用相同的位置归一化与输出形态，但发送 `textDocument/implementation`，并报告 `implementation(s)`。与 `definition` 不同，该实现提供 `line` 时不要求显式 `symbol`；未提供时解析首个非空白列。

### `references`
**输入**
- 必填：`file`。
- 可选：`line`、`symbol`、`timeout`。

**执行**
- 发送 `textDocument/references`，带 `includeDeclaration: true`。
- 对项目感知的服务端，给出 `line` 时要求提供 `symbol`（该操作禁用首个非空白列回退）。
- 对项目感知的服务端，当唯一命中就是所查询的声明时，最多重试 `REFERENCES_RETRY_COUNT` 次；重试之间等待项目加载并睡眠 `REFERENCES_RETRY_DELAY_MS`。
- 前 `REFERENCE_CONTEXT_LIMIT` 条引用带周围上下文；其余只给出位置。

**输出文本**
- `No references found`，或 `Found N reference(s):`，带上下文的条目在前；截断时末尾附 `... M additional reference(s) shown without context`。

### `hover`
**输入**
- 必填：`file`。
- 可选：`line`、`symbol`、`timeout`。

**执行**
- 发送 `textDocument/hover`。
- `extractHoverText()` 把字符串、markup 内容、marked-string 对象或数组扁平化为纯文本。

**输出文本**
- `No hover information`，或提取到的 hover 文本。

### `symbols`
**输入**
- workspace 模式：必填 `file: "*"`，另必填 `query`。省略 `file` 目前会在 workspace 符号分发前返回 `Error: file parameter required...`。
- 文档模式：必填 `file`。
- 可选：`timeout`。

**执行**
- workspace 模式向每个非自定义 LSP 服务端发送 `workspace/symbol`，用 `filterWorkspaceSymbols()` 做后置过滤，用 `dedupeWorkspaceSymbols()` 去重，然后截断到 `WORKSPACE_SYMBOL_LIMIT`。
- 文档模式向主服务端发送 `textDocument/documentSymbol`。若首项带 `selectionRange`，则格式化层级式 `DocumentSymbol`；否则格式化扁平的 `SymbolInformation`。

**输出文本**
- workspace 模式：`Found N symbol(s) matching "query":` 后接格式化后的 `name @ file:line:col`，超过上限时给出省略行。
- 文档模式：`Symbols in <file>:` 后接层级式或扁平的符号行。

### `rename`
**输入**
- 必填：`file`、`new_name`。
- 可选：`line`、`symbol`、`apply`、`timeout`。

**执行**
- 对项目感知的服务端，给出 `line` 时要求提供 `symbol`，然后等待项目加载，发送 `textDocument/rename`，收到 `WorkspaceEdit`。
- `apply !== false` 时用 `applyWorkspaceEdit()` 立即应用编辑。
- `apply === false` 时用 `formatWorkspaceEdit()` 渲染预览。

**输出文本**
- `Rename returned no edits`、`Applied rename:` 加应用到的变更行，或 `Rename preview:` 加汇总后的编辑。

### `rename_file`
**输入**
- 必填：`file` 源路径、`new_name` 目标路径。
- 可选：`apply`、`timeout`。

**执行**
- 解析绝对源与目标，拒绝相同路径、源缺失、目标已存在、空重命名集，或包含超过 `MAX_RENAME_PAIRS` 个文件的目录。
- `enumerateRenamePairs()` 对单个文件返回一个 `{oldUri,newUri}` 对，或遍历目录树中的每个常规文件。
- 向 `fileTypes` 匹配受影响路径的每个非自定义 LSP 服务端发送带 `{ files: pairs }` 的 `workspace/willRenameFiles`；收集返回的 `WorkspaceEdit` 与服务端说明（notes）。
- 预览模式（`apply === false`）只格式化这些编辑。
- 应用模式按 URI 合并返回的文本编辑（重叠时项目感知服务端的编辑胜出；其他服务端重叠的编辑被丢弃并加说明），从单一快照对每个 URI 应用一次，创建目标父目录并在磁盘上重命名源路径，为每个已重命名的打开文件发送 `textDocument/didClose`，删除这些 `openFiles` 条目，然后发送 `workspace/didRenameFiles`。

**输出文本**
- 预览：`Rename preview: <file-count label> → <dest>` 加每个服务端的编辑摘要与可选的 server notes。
- 应用：`Renamed <file-count label> → <dest>` 加已应用的编辑摘要、文件系统重命名行与可选的 server notes。

### `code_actions`
**输入**
- 必填：`file`。
- 可选：`line`、`symbol`、`query`、`apply`、`timeout`。

**执行**
- 从 `client.diagnostics` 读取该打开 URI 的缓存诊断，并在解析出的位置上为长度为零的范围发送 `textDocument/codeAction`。
- `apply !== true` 时，`query` 作为 `context.only: [query]` 传入；这是服务端侧的类型过滤器。
- `apply === true` 且 `query` 非空时，它是客户端侧选择器：基于零的数字索引，或操作标题的大小写不敏感子串。
- `apply === true` 但省略 `query` 时，当前实现会落入列表模式，不应用任何操作。
- 应用 `CodeAction` 用 `applyCodeAction()`：可选地 `codeAction/resolve`，然后 `applyWorkspaceEdit(edit)`，再可选地 `workspace/executeCommand`。
- 应用裸 `Command` 只运行 `workspace/executeCommand`。

**输出文本**
- 列表模式：`N code action(s):` 加 `index: [kind] title` 行。
- 应用模式成功：`Applied "title":` 加 `Workspace edit:` 与/或 `Executed command(s):` 区块。
- 应用模式未命中：`No code action matches "query". Available actions:`。
- 应用模式无编辑/命令：`Action "title" has no workspace edit or command to apply`。

### `status`
**输入**
- 无。

**执行**
- 从缓存的 `LspConfig` 读取已配置服务端，并与 `getActiveClients()` 交叉引用，使每个服务端标记为 `(configured, not started)` 或带上其活动客户端状态。
- 调用 `detectLspmux()`，在安装了 `lspmux` 时追加状态文本。

**输出文本**
- `Language servers: <name (configured, not started) | name (<status>)>` 加一行解释性说明，或 `No language servers configured for this project`，可选后接 `lspmux: active (multiplexing enabled)` 或 `lspmux: installed but server not running`。

### `reload`
**输入**
- workspace 模式：`file: "*"` 或省略 `file`。
- 单文件模式：必填 `file`。
- 可选：`timeout`。

**执行**
- workspace 模式先使 per-cwd 配置缓存失效，从磁盘重载配置，然后重载每个新配置的非自定义 LSP 服务端。
- 单文件模式保留缓存配置，只重载该文件的主服务端。
- 两种模式在启动服务端前都会清除匹配的近期初始化失败记录。对 rust-analyzer 服务端，`reloadServer()` 先尝试 `rust-analyzer/reloadWorkspace` 请求（只有 rust-analyzer 实现了它；发送给 Roslyn 等其他服务端可能使其崩溃，因此按服务端二进制/名称门控）。随后每个服务端回退为发送携带活动客户端配置设置的 `workspace/didChangeConfiguration` 通知。若该通知失败，reload 会拆除客户端，让下一次请求冷启动它。对共享 mux 客户端，拆除会先发送 mux 重启通知，使共享服务端——而不只是本会话的链路——被替换。

**输出文本**
- 每个服务端一行：`Reloaded <server>`、`Restarted <server>` 或 `Failed to reload <server>: ...`。

### `capabilities`
**输入**
- 可选：`file`、`timeout`。

**执行**
- 给定具体 `file` 时，检查该文件匹配的非自定义服务端。
- 省略 `file` 或使用 `"*"` 时，检查每个非自定义的已配置服务端。
- 按需启动服务端，并把 `client.serverCapabilities ?? {}` 以 pretty JSON 转储。

**输出文本**
- 每个服务端：`<server>:` 后接缩进的 `capabilities: { ... }`，或 `<server>: failed to start (...)`。

### `request`
**输入**
- 必填：`query` 方法名。
- 可选：`file`、`line`、`symbol`、`payload`、`timeout`。

**执行**
- 选择一个非自定义服务端：文件级主服务端，否则第一个已配置的非自定义服务端。
- 参数构建优先级：
  1. 若提供 `payload`，解析 JSON 并原样使用。
  2. 否则若 `file` 具体且给出 `line`，用 `resolveSymbolColumn()` 构建 `{ textDocument: { uri }, position: { line: line - 1, character } }`。
  3. 否则若 `file` 具体，构建 `{ textDocument: { uri } }`。
  4. 否则使用 `{}`。
- `file` 具体时先打开该文件。

**输出文本**
- 成功：`<server> ← <method>:\n<formatted result>`，其中非字符串结果为 `JSON.stringify(..., null, 2)`，nullish 值变为 `null`。
- 失败：`LSP error from <server> on <method>: ...` 后接回显请求参数的 `  params: <preview>`（截断到 400 字符）。

## 副作用
- 文件系统
  - 读取配置文件、目标文件与 root marker。
  - `rename` 与 `code_actions` 可能通过 `applyWorkspaceEdit()` 编辑/创建/删除/重命名文件。
  - `rename_file` 在应用模式下总是会在磁盘上重命名源路径。
  - 服务端发起的 `workspace/applyEdit` 请求也会通过 `applyWorkspaceEdit()` 变更文件。
- 网络 / IPC
  - 启用 `lsp.shared=true`（默认）时，SDK 会话尝试通过本地 Unix socket 或 Windows named pipe 连接 broker 管理的按项目 LSP mux。若无法连到或启动该 mux，客户端静默回退到私有子进程。
  - 私有与外部多路复用的服务端通过本地 stdio JSON-RPC 通信；工具本身不发起远程网络请求。
- 子进程 / 原生绑定
  - 私有回退用 `ptree.spawn()` 启动 language server；共享模式请 broker 按项目维护一个服务端。
  - Workspace 诊断会启动 `cargo`、`npx`、`go` 或 `pyright`。
  - `BiomeClient` 与 `SwiftLintClient` 启动 CLI 工具。
  - 可选的外部 `lspmux` 检测会启动 `lspmux status`；受支持的服务端可经 `lspmux client` 包装。
- 会话状态（transcript、memory、jobs、checkpoints、registries）
  - 在 `configCache` 中按 cwd 缓存配置；workspace `reload` 使该条目失效。
  - 按 `command:cwd` 缓存 LSP 客户端，含 `pendingRequests`、`diagnostics`、`openFiles`、`serverCapabilities` 与项目加载状态。传输可能代表共享 mux 链路，而非自有进程。
  - 按 `serverName:cwd` 缓存自定义 linter 客户端。
  - 更新客户端 `lastActivity`；可选的空闲超时清理由 `setIdleTimeout()` 驱动。
- 后台工作 / 取消
  - 每个请求都有可中止的超时信号。
  - 中止进行中的 LSP 请求会发送 `$/cancelRequest`。
  - 每个活动客户端的后台消息读取器一直存活到进程退出/关闭。

## 限制与上限
- 工具超时钳制：默认 `20`、最小 `5`、最大 `300` 秒——`packages/coding-agent/src/tools/tool-timeouts.ts` 中的 `TOOL_TIMEOUTS.lsp`。
- `sendRequest()` 内的 LSP 请求默认超时：`30_000ms`——`packages/coding-agent/src/lsp/client.ts` 中的 `DEFAULT_REQUEST_TIMEOUT_MS`。
- 预热 initialize 超时默认值：`5_000ms`——`packages/coding-agent/src/lsp/client.ts` 中的 `WARMUP_TIMEOUT_MS`。
- 项目加载等待回退：`15_000ms`——`packages/coding-agent/src/lsp/client.ts` 中的 `PROJECT_LOAD_TIMEOUT_MS`。
- 启用时的空闲客户端清扫间隔：`60_000ms`——`packages/coding-agent/src/lsp/client.ts` 中的 `IDLE_CHECK_INTERVAL_MS`。
- 初始化失败退避：`3 * 60 * 1000ms`——`INIT_FAILURE_BACKOFF_MS`；匹配的单文件或 workspace `reload` 会清除这个负面缓存，使重试立即可行。
- 诊断消息输出上限：前 `50` 条消息——`packages/coding-agent/src/lsp/index.ts` 中的 `DIAGNOSTIC_MESSAGE_LIMIT`。
- 单文件诊断等待：`3_000ms`——`SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS`。
- 批/glob 诊断按文件的等待：`400ms`——`BATCH_DIAGNOSTICS_WAIT_TIMEOUT_MS`。
- glob 诊断目标上限：前 `20` 个匹配——`MAX_GLOB_DIAGNOSTIC_TARGETS`。
- Workspace 符号上限：前 `200` 个条目——`WORKSPACE_SYMBOL_LIMIT`。
- 引用上下文上限：前 `50` 条引用带源码上下文——`REFERENCE_CONTEXT_LIMIT`。
- 引用重试次数：`2` 次重试、`250ms` 退避——`REFERENCES_RETRY_COUNT`、`REFERENCES_RETRY_DELAY_MS`。
- 目录重命名上限：`1_000` 个文件对——`MAX_RENAME_PAIRS`。
- `detectLspmux()` 状态缓存 TTL：`5 * 60 * 1000ms`；存活检查超时：`1_000ms`——`packages/coding-agent/src/lsp/lspmux.ts` 中的 `STATE_CACHE_TTL_MS`、`LIVENESS_TIMEOUT_MS`。
- Workspace 诊断输出上限：子进程输出的前 `50` 行。

## 错误
- 缺失或无效的输入通常以文本形式返回（`details.success: false`），而非抛出：
  - 缺失 `file`/`query`/`new_name`
  - `payload` 中的 JSON 无效
  - 没有匹配的服务端
  - `rename_file` 的源/目标条件无效
- `resolveSymbolColumn()` 对缺失文件、缺失符号与越界的 `#N` 选择器抛出明确错误；这些错误表现为 `LSP error: ...` 或请求专属的错误文本。
- `sendRequest()` 超时时以 `LSP request <method> timed out after <ms>ms` 拒绝。
- 客户端进程退出会以在 `getOrCreateClient()` 中组装的退出码/stderr 错误拒绝所有挂起请求。
- 主 `try` 内的单文件操作失败变为 `LSP error: <message>`。
- `request` 有自己的错误封装：`LSP error from <server> on <method>: <message>`。
- 部分服务端失败会被有意弱化：
  - 一个服务端失败时诊断继续
  - `rename_file` 抑制 `workspace/willRenameFiles` 的 “method not found” 错误，并把其他服务端错误记为 notes
  - `code_actions` 忽略 `codeAction/resolve` 失败，并在可能时应用未解析的操作
- 调用方中止不会转为文本：`ToolAbortError` 被重新抛出。无调用方中止的墙钟工具超时则抛出 `ToolError`：`LSP <action> timed out after <N>s on <server>. ...`。

## 备注
- `status` 从 `LspConfig` 报告已配置服务端，并通过 `getActiveClients()` 标记每个服务端：`(configured, not started)` 表示二进制可在 PATH 上解析，但尚无请求启动它；活动客户端则报告其状态。
- `getLspServerForFile()` 排除 `createClient` 适配器与仅 linter 的服务端；导航/重构操作永远不会指向 Biome/SwiftLint 自定义客户端。
- `getServersForFile()` 匹配 `fileTypes` 中的文件扩展名与精确 basename；配置可针对 `Dockerfile` 之类的名称（若存在）。
- `symbol` 匹配先做精确匹配，再大小写不敏感匹配，并且只在指定行上回退到第 N 次出现；它从不扫描其他行。
- 对 `definition`、`references` 与 `rename` 使用项目感知的服务端时，给出 `line` 却省略 `symbol` 会被 `ToolError` 拒绝，而不会静默回退到首个非空白列。
- `code_actions` 以两种方式使用 `query`：列表模式下的服务端侧 `context.only` 过滤器，以及同时存在 `apply: true` 与非空 `query` 时的客户端侧标题/索引选择器。尽管模型 prompt 要求提供选择器，但当前实现中当 `apply: true` 省略 `query` 时是列出操作而非应用其一。
- `rename` 与 `rename_file` 默认应用编辑；预览需要 `apply: false`。
- `request` 带 `file: "*"` 与省略 `file` 处理相同：它不会构建 workspace 专属参数。
- `reload` 杀掉客户端后不会立即重建它；下一次请求会触发重新初始化。
- `workspace/applyEdit` 可以应用服务端在直接工具操作结果路径之外发起的编辑。
- `detectLspmux()` 可用 `PI_DISABLE_LSPMUX=1` 禁用；`DEFAULT_SUPPORTED_SERVERS` 中只有 `rust-analyzer`。
- 启动时 LSP 发现（`sdk.ts` 中的 `discoverStartupLspServers(cwd)`）在 `enableLsp && options.hasUI` 时运行；后台预热还要求 `!settings.get("lsp.lazy")`。`lsp.lazy` 默认为 `true`，因此默认情况下被发现的服务端以状态 `"available"`（欢迎屏中的灰点）呈现，并在首次使用时通过 `getOrCreateClient()` 冷启动（lsp 工具调用，或对匹配文件类型的编辑/写入）。Print/RPC/ACP/script 会话完全跳过发现与预热。见 `docs/sdk.md` § Startup performance。
- `configCache` 是进程级的，不会自动失效。请用 workspace `reload`（省略 `file` 或 `file: "*"`）重新读取配置、root marker 与插件配置；具体文件的 reload 只重载那个服务端并保留缓存配置。