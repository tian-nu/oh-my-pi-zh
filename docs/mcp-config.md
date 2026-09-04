# OMP 中的 MCP 配置

本指南介绍如何为 OMP coding agent 添加、编辑和校验 MCP 服务器。

代码中的权威来源：

- 运行时配置类型：`packages/coding-agent/src/mcp/types.ts`
- 配置写入器：`packages/coding-agent/src/mcp/config-writer.ts`
- 加载器 + 校验：`packages/coding-agent/src/mcp/config.ts`
- 独立 `mcp.json` 发现：`packages/coding-agent/src/discovery/mcp-json.ts`
- Schema：`packages/coding-agent/src/config/mcp-schema.json`

## 首选配置位置

OMP 可以从多种工具（`.claude/`、`.cursor/`、`.vscode/`、`opencode.json` 等）中发现 MCP 服务器，但对于 OMP 原生配置，通常应使用以下主文件之一：

- 项目级：`.omp/mcp.json`
- 用户级：`~/.omp/agent/mcp.json`（或在激活命名 profile 时使用 `~/.omp/profiles/<name>/agent/mcp.json` — 见 [Profiles](#profiles)）

原生 provider 出于兼容性考虑也会读取 `.omp/.mcp.json` 和 `~/.omp/agent/.mcp.json`，但 OMP 只写入上述主 `mcp.json` 路径。

OMP 还接受项目根目录下的回退独立文件：

- `mcp.json`
- `.mcp.json`

如果希望 OMP 完全接管配置，请使用 `.omp/mcp.json` 或 `~/.omp/agent/mcp.json`。只有在你想要一个其他 MCP 客户端也可能读取的可移植回退文件时，才使用根目录的 `mcp.json` / `.mcp.json`。

### 导入的工具配置

OMP 还会转换以下当前的工具原生来源：

- Claude Code：`~/.claude.json`、`~/.claude/mcp.json`，以及项目级 `.claude/.mcp.json` / `.claude/mcp.json`
- Codex：`~/.codex/config.toml` 和 `.codex/config.toml`（`[mcp_servers.*]`）
- Gemini CLI：`~/.gemini/settings.json` 和 `.gemini/settings.json`
- OpenCode：`~/.config/opencode/opencode.json` 和项目根目录的 `opencode.json`
- Cursor：`~/.cursor/mcp.json` 和 `.cursor/mcp.json`
- Windsurf：`~/.codeium/windsurf/mcp_config.json` 和 `.windsurf/mcp_config.json`
- VS Code：仅项目级 `.vscode/mcp.json`，使用 `mcp.servers`
- 声明了 MCP 服务器的已安装 Claude marketplace 插件和 OMP 扩展包

对于 Claude Code、Codex、Gemini CLI、Cursor 和 Windsurf，项目条目会先于同名用户条目被发现 — 这与 OMP 原生配置一致（项目条目先于其激活 profile 的用户条目）— 因此项目中的 `enabled: false` 会抑制同名用户服务器。OpenCode 目前则先发现用户条目。跨 provider 的优先级见 [Discovery and precedence](#discovery-and-precedence)。

### Profiles

命名 profile（`omp --profile <name>`、`--alias` 快捷方式，或 `OMP_PROFILE`/`PI_PROFILE`）用于隔离用户级 MCP 配置。当某个 profile 处于激活状态时，**用户**作用域会解析到该 profile 的 agent 目录，而非默认目录：

- 默认 profile：`~/.omp/agent/mcp.json`
- Profile `<name>`：`~/.omp/profiles/<name>/agent/mcp.json`

发现逻辑、`/mcp` 命令和配置写入器都遵循激活的 profile，因此每个 profile 只能看到**自己的**用户级服务器 — 绝不会看到默认 profile 的 `~/.omp/agent/mcp.json`。向 profile 添加服务器的方式是：在该 profile 下启动（`omp --profile <name>`）并运行 `/mcp add` → User level，或者直接编辑 `~/.omp/profiles/<name>/agent/mcp.json`。

项目级 MCP 配置（`.omp/mcp.json`）以工作目录而非 profile 为键，因此在所有 profile 下都生效。外部工具配置（`.claude/`、`.cursor/` 等）同样与 profile 无关，因为它们属于那些工具而非某个 OMP profile。

MCP 遵循与 OMP 原生配置其余部分相同的 profile 规则；参见 [Configuration Discovery → Profiles](./config-usage.md#profiles)。

## 添加 schema 引用

在文件顶部添加这一行，即可获得编辑器自动补全和校验：

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {}
}
```

当 `/mcp add`、`/mcp enable`、`/mcp disable`、`/mcp reauth` 或其他写入配置的流程创建或更新 OMP 管理的 MCP 文件时，OMP 现在会自动写入这一行。

## 文件结构

OMP 支持以下顶层结构：

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "server-name": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "some-mcp-server"]
    }
  },
  "disabledServers": ["server-name"]
}
```

顶层键：

- `$schema` — 供工具使用的可选 JSON Schema URL
- `mcpServers` — 服务器名到服务器配置的映射
- `disabledServers` — 激活 profile 的用户级拒绝列表；它按名称隐藏被发现的服务器，无论来源条目的 `enabled` 值如何
- `enabledServers` — 激活 profile 的用户级允许列表；它可以强制启用来源为 `enabled: false` 的同名条目，但 `disabledServers` 仍然优先

配置写入器接受的名称最长 100 个字符，可包含字母、数字、`_`、`-`、`.` 和 `:`。内置 schema 的名称模式目前省略了 `:`，因此 OMP 管理的带命名空间插件条目（如 `cloudflare:cloudflare-api`）在运行时可能有效，而编辑器却报告 schema 错误。

## 支持的服务器字段

所有传输类型共用的字段：

- `enabled?: boolean` — 为 `false` 时跳过该服务器，除非激活 profile 的用户级 `enabledServers` 允许列表中包含它
- `timeout?: number` — MCP 请求超时时间（毫秒）；`0` 表示禁用客户端侧 MCP 超时
- `requestIdFormat?: "number" | "string"` — 发出的 JSON-RPC request-id 编码；默认为按传输类型区分的整数。`"string"` 使用抗冲突的 snowflake ID。这个 OMP 特有字段只从 OMP 原生文件、根目录 `mcp.json` / `.mcp.json` 以及 OMP 扩展包中读取；从其他工具转换而来的配置会忽略它。
- `auth?: { ... }` — 已存储凭据的元数据；托管凭据注入已针对 OAuth 实现
- `oauth?: { ... }` — 在 auth/reauth 期间使用的显式 OAuth 客户端和回调设置

`OMP_MCP_TIMEOUT_MS` 在进程范围内优先于每个服务器的 `timeout`。将其设为 `0` 可禁用客户端侧超时，或设为正的毫秒值如 `120000`。若未设置或值无效，OMP 会先使用服务器配置的值，再退回 30 秒默认值；无效值会被记录并忽略。

### `stdio` 传输

省略 `type` 时默认为 `stdio`。

必填：

- `command: string`

可选：

- `type?: "stdio"`
- `args?: string[]`
- `env?: Record<string, string>`
- `cwd?: string`

示例：

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/Users/alice/projects",
        "/Users/alice/Documents"
      ]
    }
  }
}
```

这对应官方的 Filesystem MCP 服务器包（`@modelcontextprotocol/server-filesystem`）。

### `http` 传输

必填：

- `type: "http"`
- `url: string`

可选：

- `headers?: Record<string, string>`

示例：

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/"
    }
  }
}
```

这对应 GitHub 官方托管的 GitHub MCP 服务器端点。

### `sse` 传输

必填：

- `type: "sse"`
- `url: string`

可选：

- `headers?: Record<string, string>`

示例：

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "legacy-remote": {
      "type": "sse",
      "url": "https://example.com/mcp/sse"
    }
  }
}
```

`sse` 出于兼容性考虑仍受支持，但 MCP 规范现在更推荐新服务器使用 Streamable HTTP（`type: "http"`）。

## 认证字段

OMP 理解两个与认证相关的对象。

### `auth`

```json
{
  "type": "oauth",
  "credentialId": "optional-stored-credential-id",
  "tokenUrl": "optional-token-endpoint",
  "clientId": "optional-client-id",
  "clientSecret": "optional-client-secret",
  "resource": "optional-mcp-resource-uri"
}
```

对于托管 OAuth，`auth` 告诉 OMP 如何查找和刷新已存储的凭据。尽管 `"apikey"` 是一个可接受的 `type`，但它不会从认证存储中加载或注入 API key。请将 API key 直接放在 stdio 的 `env` 或远程的 `headers` 中（优先使用下文描述的环境变量或 `!command` 间接方式）。

通常你无需手写这个块：当 OMP 为 `http`/`sse` 服务器完成一次 OAuth 流程后，它会以从激活 profile 和服务器 URL 派生的确定性 id（`mcp_oauth:profile:<profile>:<url>`）存储凭据，并内嵌刷新材料。任何指向同一 URL 的
配置 — 包括共享项目 `mcp.json` 中完全不含 `auth` 块的
_仅定义_ 条目 — 都会自动解析激活 profile 自己的
凭据，包括认证存储由共享 auth broker 支撑的情况。这正是项目级服务器能安全地跨
profile 使用的原因：提交定义，然后每个 profile 都通过 `/mcp reauth <name>` 授权（并保持登录为）
自己的账户。显式的 `credentialId` 在能解析时
仍会被尊重；如果它指向另一个 profile 的记录，OMP 会
退回到按 profile 作用域、以 URL 为键的绑定。

对仅定义条目执行 `/mcp reauth` 不会改动文件 —
凭据（包括刷新材料）完全存放在激活 profile 的
认证存储（本地 `agent.db` 或 broker）中，因此提交的项目配置绝不会
拾取本地认证状态。显式配置的
`Authorization` 头始终优先于以 URL 为键的绑定。

这种绑定按 profile 而非按项目生效：一旦某个 profile 已授权
某个 URL，任何其 `mcp.json` 定义了该 URL 服务器的检出都会自动
使用该 profile 的凭据连接。已提交的 MCP 定义属于
受信任输入 — 同样的规则早已适用于会运行
任意命令的 `stdio` 条目 — 因此在用持有重要凭据的 profile 打开仓库之前，
请审查该仓库的 `mcp.json`，或者为不受信任的检出
使用专用 profile。

### `oauth`

```json
{
  "clientId": "...",
  "clientSecret": "...",
  "redirectUri": "...",
  "callbackPort": 3334,
  "callbackPath": "/oauth/callback",
  "prompt": "consent"
}
```

当 MCP 服务器要求显式的 OAuth 客户端或回调设置时使用 `oauth`。回调监听器默认使用端口 `3000` 和路径 `/callback`；HTTP 环回 `redirectUri` 会自带端口/路径，除非显式覆盖。HTTPS 环回重定向需要为 TLS 终结器之后的本地 HTTP 监听器指定一个独立的 `callbackPort`。

`prompt` 控制 OAuth 的 `prompt` 授权参数。默认情况下 OMP 会省略它，但例外是：请求 `offline_access` scope 时默认为 `"consent"`，以便 provider 能颁发刷新访问权限。可以显式设置为 provider 支持的值如 `"consent"` 或 `"select_account"`，或设为 `""` 强制省略。

示例：

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "slack": {
      "type": "http",
      "url": "https://mcp.slack.com/mcp",
      "oauth": {
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      },
      "auth": {
        "type": "oauth",
        "tokenUrl": "https://slack.com/api/oauth.v2.user.access",
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      }
    }
  }
}
```

Slack 文档中的相关端点：

- MCP 端点：`https://mcp.slack.com/mcp`
- 授权端点：`https://slack.com/oauth/v2_user/authorize`
- Token 端点：`https://slack.com/api/oauth.v2.user.access`

## 常见复制粘贴示例

### 通过 stdio 使用 Filesystem 服务器

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/absolute/path/one",
        "/absolute/path/two"
      ]
    }
  }
}
```

### 通过 HTTP 使用 GitHub 托管服务器

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/"
    }
  }
}
```

### 通过 Docker 使用 GitHub 本地服务器

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "github": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "GITHUB_PERSONAL_ACCESS_TOKEN",
        "ghcr.io/github/github-mcp-server"
      ],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_PERSONAL_ACCESS_TOKEN"
      }
    }
  }
}
```

这对应 GitHub 官方的本地 Docker 镜像 `ghcr.io/github/github-mcp-server`。

### 通过 OAuth 使用 Slack 托管服务器

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "slack": {
      "type": "http",
      "url": "https://mcp.slack.com/mcp",
      "oauth": {
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      },
      "auth": {
        "type": "oauth",
        "tokenUrl": "https://slack.com/api/oauth.v2.user.access",
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      }
    }
  }
}
```

## 密钥与变量解析

这是最容易让人踩坑的部分。

### 发现阶段的 `${...}` 展开

OMP 在从 OMP 原生文件和独立回退文件发现 MCP 配置时，会展开 `${VAR}` 和 `${VAR:-default}` 占位符。展开会递归应用于 `command`、`args`、`env`、`cwd`、`url`、`headers`、`auth` 和 `oauth` 中的字符串值；未解析的占位符保持原样。

示例：

```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": {
        "Authorization": "Bearer ${GITHUB_TOKEN}"
      }
    }
  }
}
```

### 连接前的 env/header 解析

在启动 stdio 服务器或发起 HTTP/SSE 请求之前，OMP 会按以下方式解析 stdio 的 `env` 值和 HTTP/SSE 的 `headers` 值：

1. 如果值以 `!` 开头，OMP 会在 10 秒超时内将其余部分作为 shell 命令运行，并使用去除首尾空白后的 stdout。成功的结果会在进程生命周期内缓存。
2. 如果命令失败、超时或只输出空白，该 `env`/`headers` 条目将被省略。
3. 否则，OMP 检查整个值是否是一个环境变量的名称。
4. 如果该环境变量被设置为非空值，OMP 使用环境变量的值；否则按字面字符串使用。

示例：

```json
{
  "env": {
    "GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_PERSONAL_ACCESS_TOKEN"
  },
  "headers": {
    "X-MCP-Insiders": "true"
  }
}
```

这意味着以下写法是有效的，且适合本地密钥：

- `"GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_PERSONAL_ACCESS_TOKEN"` → 从当前 shell 环境复制
- `"Authorization": "Bearer hardcoded-token"` → 使用字面值
- `"Authorization": "!printf 'Bearer %s' \"$GITHUB_TOKEN\""` → 由命令构建该头部

## 用户级的启用/禁用覆盖

激活 profile 的用户文件提供两个跨来源覆盖：

- `disabledServers` 是优先级最高的拒绝列表。它会从任何来源隐藏同名服务器。
- `enabledServers` 可强制启用来源为 `enabled: false` 的同名条目；但不能覆盖 `disabledServers`。

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "disabledServers": ["github"],
  "enabledServers": ["tool-owned-server"]
}
```

当定义位于 OMP 自有的可写文件中时，`/mcp enable` 和 `/mcp disable` 会直接更新 `enabled`。OMP 不会修改其他工具的配置：对于这类来源，这些命令改为维护用户级的允许列表或拒绝列表，并移除冲突的过期覆盖。

## `/mcp add` 与直接编辑 JSON

如果想要引导式设置，请使用 `/mcp add`。

在以下情况下使用直接 JSON 编辑：

- 你需要向导尚未提示的传输或认证选项
- 你想从另一个 MCP 客户端粘贴服务器定义
- 你想在编辑器中获得基于 schema 的校验

编辑之后，可以使用：

- `/mcp reload` 在当前会话中重新发现并重连服务器
- `/mcp list` 查看服务器来自哪个配置文件
- `/mcp test <name>` 测试单个服务器
- `/mcp reconnect <name>` 重连一个服务器而不重新发现所有配置
- `/mcp reauth <name>` 替换托管的 OAuth 凭据，或用 `/mcp unauth <name>` 移除它们
- `/mcp resources`、`/mcp prompts` 和 `/mcp notifications` 检查非工具类 MCP 能力

## OMP 强制执行的校验规则

来自 `packages/coding-agent/src/mcp/config.ts` 中的 `validateServerConfig()`：

- `stdio` 需要 `command`
- `http` 和 `sse` 需要 `url`
- 服务器不能同时设置 `command` 和 `url`
- 未知的 `type` 值会被拒绝

实际影响：

- 省略 `type` 意味着 `stdio`
- 如果粘贴远程服务器配置时忘记 `"type": "http"`，OMP 会将其视为 `stdio` 并报错缺少 `command`
- `sse` 出于兼容性考虑仍然有效，但新的托管服务器通常应配置为 `http`

## 发现与优先级

OMP 按优先级从高到低加载 provider。支持 MCP 的顺序为：

1. OMP 原生配置
2. OMP 扩展包
3. Claude Code
4. Claude marketplace 插件和 Codex
5. Gemini CLI
6. OpenCode
7. Cursor 和 Windsurf
8. VS Code
9. 根目录 `mcp.json` / `.mcp.json` 回退文件

第一个定义获胜。重名不会被合并。即使名称不同，只要其传输类型、端点/命令输入、认证和 request-id 模式与更高优先级的定义等价，也会被遮蔽。

在 OMP 原生配置内部，项目级 `.omp/mcp.json` 先于 `.omp/.mcp.json`，然后是激活 profile 的用户级 `mcp.json` 和 `.mcp.json`。根目录回退 `mcp.json` 先于根目录 `.mcp.json`。实践中：

- OMP 专属的覆盖优先使用 `.omp/mcp.json` 或激活 profile 的用户级 `mcp.json`
- 尽可能让各工具间的名称和端点定义保持唯一
- 当第三方配置不断重新引入某个不想要的服务器时，使用用户级 `disabledServers` 列表
- 设置 `mcp.enableProjectConfig: false` 可在去重之前排除所有项目级来源，让同名用户条目得以保留

## 故障排查

### `Server "name": stdio server requires "command" field`

你很可能在远程服务器上遗漏了 `type: "http"`。

### `Server "name": both "command" and "url" are set`

二选一。OMP 将 `command` 视为 stdio，将 `url` 视为 http/sse。

### `/mcp add` 成功但服务器仍无法连接

JSON 是有效的，但服务器可能仍不可达。使用 `/mcp test <name>` 并检查：

- 二进制文件或 Docker 镜像是否存在
- 所需的环境变量是否已设置
- 远程 URL 是否可达
- OAuth 或 API token 是否有效

### 服务器存在于其他工具的配置中，但 OMP 中没有

运行 `/mcp list`。OMP 会发现许多第三方 MCP 文件，但项目级加载也可能通过 `mcp.enableProjectConfig` 设置被禁用，而且用户级 `disabledServers` 条目也能按名称抑制某个服务器。

### 带命名空间的服务器可用，但编辑器拒绝其名称

运行时/配置写入器接受 marketplace 插件所用的名称中的 `:`。内置 JSON schema 的 `propertyNames` 模式目前不接受；这是 schema 与运行时之间的不一致，而非连接失败。

### 某个配置文件在列表中悄然缺失

JSON 格式错误或服务器映射缺失/无效会使该 provider 不从该文件贡献任何条目；视 provider 而定，OMP 会记录发现警告或记录解析失败日志，而不是让会话失败。修正 JSON 结构后，运行 `/mcp reload` 和 `/mcp list`。

## 参考资料

- MCP 传输规范：https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
- Filesystem 服务器包：https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem
- GitHub MCP 服务器：https://github.com/github/github-mcp-server
- Slack MCP 服务器文档：https://docs.slack.dev/ai/slack-mcp-server/
