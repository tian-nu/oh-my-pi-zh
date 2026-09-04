# MCP server 与工具编写

本文档说明 MCP server 定义如何变成 coding-agent 中可调用的 `mcp__*` 工具，以及当配置无效、重复、被禁用或需要认证时，运维者应当预期什么。

## 架构总览

```text
Config sources (.omp/.claude/.cursor/.vscode/mcp.json, mcp.json, etc.)
  -> discovery providers normalize to canonical MCPServer
  -> capability loader dedupes by server name (higher provider priority wins)
  -> loadAllMCPConfigs applies user enablement overrides and suppresses disabled servers
  -> MCPManager connects/listTools (with auth/header/env resolution)
  -> manager best-effort loads resources/prompts and subscribes to resource updates when enabled
  -> MCPTool/DeferredMCPTool bridge exposes tools as mcp__<server>_<tool>
  -> AgentSession.refreshMCPTools replaces live MCP tools immediately
```

## 1) Server 配置模型与校验

`src/mcp/types.ts` 定义了 MCP 配置写入器和运行时使用的编写形态：

- `stdio`（缺少 `type` 时的默认值）：要求 `command`，可选 `args`、`env`、`cwd`
- `http`：要求 `url`，可选 `headers`
- `sse`：要求 `url`，可选 `headers`（为兼容性保留）
- 共享字段：`enabled`、`timeout`、`requestIdFormat`（`"number"` 或 `"string"`）、`auth`、`oauth`

`validateServerConfig()`（`src/mcp/config.ts`）强制传输层基本规则：

- 拒绝同时设置 `command` 和 `url` 的配置
- stdio 要求 `command`
- http/sse 要求 `url`
- 拒绝未知的 `type`

`config-writer.ts` 在 add/update 操作中应用此校验，并额外校验 server 名称：

- 非空
- 最长 100 字符
- 仅允许 `[a-zA-Z0-9_.:-]`（冒号用于带命名空间的插件 server 名称，如 `cloudflare:cloudflare-api`）

### 传输层陷阱

- 省略 `type` 意味着 stdio。如果你本意是 HTTP/SSE 却省略了 `type`，`command` 就变成必填。
- `sse` 选择旧版 protocol-revision 2024-11-05 的 HTTP+SSE 传输：由一个持久的 GET 流提供 `endpoint` 事件，其 URL 接收 JSON-RPC POST。它与 `"http"` Streamable HTTP 传输不同。
- 出站 JSON-RPC 请求 ID 默认为递增数字以保证生态兼容性。仅当 server 要求旧的 snowflake 字符串行为时才设置 `requestIdFormat: "string"`；无效值会在发现阶段告警并被忽略。
- 校验是结构性的，不检查可达性：语法正确的 URL 仍可能在连接时失败。

## 2) 发现、规范化与优先级

### 基于能力的发现

`loadAllMCPConfigs()`（`src/mcp/config.ts`）通过 `loadCapability(mcpCapability.id)` 加载规范化的 `MCPServer` 条目。

能力层（`src/capability/index.ts`）随后：

1. 按优先级顺序加载 provider
2. 按 `server.name` 去重（先到先得 = 最高优先级）
3. 校验去重后的条目

结果：跨来源重复的 server 名称不会被合并。只有一个定义胜出；低优先级的重复项被遮蔽。

### `.mcp.json` 及相关文件

`src/discovery/mcp-json.ts` 中的专用回退 provider 读取项目根目录的 `mcp.json` 和 `.mcp.json`（低优先级）。

实践中 MCP server 还来自更高优先级的 provider（例如原生 `.omp/...` 和特定工具的配置目录）。编写建议：

- 需要显式控制时，优先使用 `.omp/mcp.json`（项目）或 `~/.omp/agent/mcp.json`（用户）。
- 需要回退兼容时，使用根目录 `mcp.json` / `.mcp.json`。
- 在多个来源复用同一 server 名称会导致优先级遮蔽，而非合并。

### 规范化行为

`convertToLegacyConfig()`（`src/mcp/config.ts`）将规范化的 `MCPServer` 映射为运行时 `MCPServerConfig`。

关键行为：

- 传输层推断为 `server.transport ?? (command ? "stdio" : url ? "http" : "stdio")`
- `requestIdFormat` 被保留；省略意味着数字 ID
- 处于当前 profile 用户 `disabledServers` 列表中的名称始终被抑制；`enabled === false` 的 server 会被抑制，除非同一用户配置在 `enabledServers` 中点名它
- 可选字段存在时被保留

### 发现阶段的环境变量展开

OMP 原生 MCP 配置（`.omp/mcp.json`、`~/.omp/agent/mcp.json`，以及对应的 `.mcp.json` 变体）在转换为运行时配置前，会递归展开 `${VAR}` 和 `${VAR:-default}` 占位符。它还接受布尔/字符串形式的 `enabled`（`true`、`false`、`1`、`0`）以及数字字符串形式的 `timeout`。`requestIdFormat` 只接受 `"number"` 或 `"string"`；其他值会告警并回退到数字 ID。

`src/discovery/mcp-json.ts` 中的独立回退 provider 读取项目根目录的 `mcp.json` 和 `.mcp.json`，展开相同的 `${...}` 占位符，并对 `enabled`/`timeout` 做类型检查而不强制转换字符串值。它应用同样的 `requestIdFormat` 校验。

无效的 `enabled`/`timeout` 值会在告警后被忽略，而不是让整个文件失败。

## 3) 认证与运行时值解析

`MCPManager.prepareConfig()`/`#resolveAuthConfig()`（`src/mcp/manager.ts`）是连接前的最后一道处理。

### OAuth 凭据注入

对 `http`/`sse` server，`auth: { type: "oauth", credentialId: "..." }`
块是可选的。当显式的任意凭据 ID 或旧版凭据 ID 能解析时，OMP 会尊重它。托管
的、按 profile 划分的 `mcp_oauth:profile:<profile>:<url>` ID 只有在其 profile
处于活动状态且其 URL 与 server 展开后的或字面的 URL 匹配时才被接受；不匹配则
被忽略。如果被接受的显式 ID 无法解析——或者没有 `auth` 块——OMP 会在由展开后
和字面的 server URL 派生的确定性 ID 下查找凭据。这些以 URL 为键的凭据按当前活
动 profile 划分，因此一个仅提供定义的共享 server 条目可以使用每个 profile 独
立存储的 OAuth 凭据。

大小写不敏感、显式配置的 `Authorization` header 会抑制该 URL 键回退。`stdio` server 没有可绑定的 URL：其显式的任意凭据 ID 或旧版凭据 ID 必须能解析，而以 URL 为键、按 profile 划分的 ID 会被忽略。

查找成功时：

- `http`/`sse`：注入 `Authorization: Bearer <access_token>` header
- `stdio`：注入 `OAUTH_ACCESS_TOKEN` 环境变量

如果没有凭据能解析，OMP 会在不注入 OAuth 值的情况下连接。刷新或凭据解析失败会被记录；在可能的情况下，OMP 会继续使用现有的 access token。

### Header/env 值解析

连接前，manager 通过 `resolveConfigValue()`（`src/config/resolve-config-value.ts`）解析 stdio 的 `env` 值和 HTTP/SSE 的 `headers` 值：

- 以 `!` 开头的值 => 执行 shell 命令，使用去除首尾空白的 stdout（有缓存）
- 失败、超时或纯空白的命令产生 `undefined`，因此该条目被省略
- 否则，先把值当作环境变量名（`process.env[name]`），回退为字面值

运维注意：一个写错的 `!` 秘密命令会静默移除该 header/env 条目，导致下游 401/403 或 server 启动失败。写错的环境变量名会按字面发送，除非该字面值恰好对 server 有意义。

## 4) 工具桥接：MCP -> agent 可调用工具

`src/mcp/tool-bridge.ts` 将 MCP 工具定义转换为 `CustomTool`。

### 命名与冲突域

工具名生成为：

```text
mcp__<sanitized_server_name>_<sanitized_tool_name>
```

规则：

- 转为小写
- 非 `[a-z_]` 字符变为 `_`
- 连续下划线折叠
- 工具名中冗余的 `<server>_` 前缀被剥离一次
- 超过 64 字符的名称保留可读前缀，并追加 `_` 加上对完整未截断生成名做 `Bun.hash()` 后的前八个 base-36
  字符

不同的原始名称仍可能净化为同一标识符（例如
`my-server` 和 `my.server` 的净化结果相似）。在注册表插入之前，
`deduplicateMCPToolsByName()` 通过对原始 `<server-name>\0<tool-name>` 来源键
做字典序比较，选出一个确定性的胜者。落败的来源会被记录并忽略，因此重连或发现
顺序无法改变归属。

### Schema 映射

`tool-bridge.ts` 在将每个 MCP `inputSchema` 注册为 `CustomTool` schema 之前，先通过 `normalizeSchemaForMCP()` 处理。

### 出站参数规范化

无论 live 还是 deferred 工具，在发送 `tools/call` 之前，桥接层按以下顺序规范化调用的参数：

1. 顶层的非对象值、`null` 和数组变成空的
   参数对象。
2. harness 注入的意图字段 `i` 会被移除，除非 MCP 工具自身的
   `inputSchema.properties` 声明了 `i`。
3. 对于 MCP schema 声明但未列入 `required` 的属性，值为 `undefined`、空字符串或空的非数组对象时会被省略。必需属性、未声明属性、`0`、`false`、`null`、
   以及数组（包括空数组）会被保留。
4. 字符串值会在嵌套对象和数组中递归遍历。
   可解析的 `local://` 文件 URL 会变成外部 MCP server 可读取的真实文件系统路径。当不存在活动的本地文件解析器，或 URL 指向目录/根而非文件时，原始字符串保持不变；无效、缺失或越界的本地文件 URL 会在规范化阶段失败，而不会到达 `tools/call`。

因此，server 作者应针对规范化后的载荷做校验，而不要
假设模型生成的调用中每个存在的字段都会到达 server。

### 执行映射

`MCPTool.execute()` / `DeferredMCPTool.execute()`：

- 调用 MCP `tools/call`
- 将 MCP content 扁平化为可显示文本
- 返回结构化详情（`serverName`、`mcpToolName`、provider 元数据）
- 将 server 报告的 `isError` 映射为 `Error: ...` 文本结果
- 对可重试的连接错误尝试重连并重试一次
- 将剩余抛出的传输/运行时失败映射为 `MCP error: ...`
- 通过将 AbortError 转换为 `ToolAbortError` 来保留中止语义

## 5) 运维生命周期：add/edit/remove 与实时更新

交互模式在 `src/modes/controllers/mcp-command-controller.ts` 中暴露 `/mcp`。

支持的操作：

- `add`（向导或快速添加）
- `remove` / `rm`
- `enable` / `disable`
- `test`
- `reauth` / `unauth`
- `reconnect`
- `reload`
- `resources`、`prompts`、`notifications`
- Smithery search/login/logout 流程

配置写入是原子的（`writeMCPConfigFile`：临时文件 + 重命名）。

变更之后，controller 调用 `#reloadMCP()`：

1. `mcpManager.disconnectAll()`
2. `mcpManager.discoverAndConnect()`
3. `session.refreshMCPTools(mcpManager.getTools())`

`refreshMCPTools()` 替换注册表中所有 `mcp__` 条目并立即重新激活最新的 MCP 工具集，因此变更无需重启会话即生效。

### 模式差异

- **交互/TUI 模式**：`/mcp` 提供应用内 UX（向导、OAuth 流程、连接状态文本、立即运行时重绑定）。
- **SDK/headless 集成**：`discoverAndLoadMCPTools()`（`src/mcp/loader.ts`）返回已加载的工具和每个 server 的错误；没有 `/mcp` 命令 UX。

## 6) 用户可见的错误呈现

用户/运维者常见的错误字符串：

- add/update 校验失败：
  - `Invalid server config: ...`
  - `Server "<name>" already exists in <path>`
- 快速添加参数问题：
  - `Use either --url or -- <command...>, not both.`
  - `--token requires --url (HTTP/SSE transport).`
- 连接/测试失败：
  - `Failed to connect to "<name>": <message>`
  - 超时帮助文本建议增大 timeout
  - 针对 `401/403` 的认证帮助文本
- 认证/OAuth 流程：
  - `Authentication required ... OAuth endpoints could not be discovered`
  - `OAuth flow timed out. Please try again.`
  - `OAuth authentication failed: ...`
- 使用已禁用的 server：
  - `Server "<name>" is disabled. Run /mcp enable <name> first.`

发现阶段的坏源 JSON 通常作为警告/日志处理；config-writer 路径则抛出显式错误。

## 7) 实用编写建议

要在此代码库中稳健地编写 MCP 配置：

1. 让 server 名称在所有支持 MCP 的配置来源中全局唯一。
2. 优先选择在 MCP 工具名净化后仍保持 distinct 的名称，避免生成的 `mcp__` 冲突。
3. 使用显式 `type`，避免意外落到 stdio 默认值。
4. 当需要覆盖某个已发现 server 的 `enabled: false` 时，使用当前 profile 的用户 `enabledServers` 列表；若名称同时出现在两个列表中，`disabledServers` 始终胜出。
5. 对远程 OAuth server，有效的显式 `credentialId` 是可选的：仅提供定义的 `http`/`sse` 条目可以使用绑定到同一 URL 的当前 profile 凭据。当必须抑制该 URL 键回退时，使用显式的 `Authorization` header。
6. 如果使用基于命令的秘密解析（`!cmd`），请验证命令输出稳定且非空。

## 实现文件

- [`src/mcp/types.ts`](../packages/coding-agent/src/mcp/types.ts)
- [`src/mcp/config.ts`](../packages/coding-agent/src/mcp/config.ts)
- [`src/mcp/config-writer.ts`](../packages/coding-agent/src/mcp/config-writer.ts)
- [`src/mcp/tool-bridge.ts`](../packages/coding-agent/src/mcp/tool-bridge.ts)
- [`src/discovery/mcp-json.ts`](../packages/coding-agent/src/discovery/mcp-json.ts)
- [`src/modes/controllers/mcp-command-controller.ts`](../packages/coding-agent/src/modes/controllers/mcp-command-controller.ts)
- [`src/mcp/manager.ts`](../packages/coding-agent/src/mcp/manager.ts)
- [`src/capability/index.ts`](../packages/coding-agent/src/capability/index.ts)
- [`src/config/resolve-config-value.ts`](../packages/coding-agent/src/config/resolve-config-value.ts)
- [`src/mcp/loader.ts`](../packages/coding-agent/src/mcp/loader.ts)
