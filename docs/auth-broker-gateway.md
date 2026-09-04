# Auth Broker 与 Auth Gateway

auth broker 和 auth gateway 是两个协作的 HTTP 服务，用于将 OAuth refresh token 和 provider access token 从开发者笔记本迁移到单一的 broker 主机上。

- **`omp auth-broker serve`** 持有规范的 SQLite 凭据库，执行 OAuth 刷新，并在 `/v1` 下暴露 snapshot、credential、block、usage 和 health API。
- **`omp auth-gateway serve`** 是一个正向代理。它接受 OpenAI Chat Completions、Anthropic Messages、OpenAI Responses 以及 pi-native 流式请求，解析 broker 支持的凭据，并通过 `pi-ai` provider 逻辑分发。客户端（容器化的 omp、llm-git、macOS usage widget 等）永远看不到 access token。

操作者、broker 与 gateway 之间的传输安全由操作者负责（Tailscale / Wireguard / 反向代理 + TLS）。除 `/v1/healthz`（broker）和 `/healthz`（gateway）外，所有端点都要求 bearer token。

源码：`packages/ai/src/auth-broker/`、`packages/ai/src/auth-gateway/`、`packages/coding-agent/src/cli/auth-broker-cli.ts`、`packages/coding-agent/src/cli/auth-gateway-cli.ts`、`packages/coding-agent/src/session/auth-broker-config.ts`。

## 数据流

```
                ┌────────────────────────────────────────────────────────────┐
                │ broker host                                                │
                │                                                            │
  developer ──▶ │  ┌──────────────────────────┐    ┌────────────────────┐    │
  laptop /      │  │  omp auth-broker serve   │◀──▶│  SQLite agent.db    │    │
  CI / robomp   │  │  - holds refresh tokens  │    │  (canonical writer)│    │
                │  │  - background refresher  │    └────────────────────┘    │
                │  │  /v1/{snapshot,refresh,…}│                              │
                │  └─────────┬────────────────┘                              │
                │            │  bearer ($CONFIG_DIR/auth-broker.token)       │
                │            ▼                                               │
                │  ┌──────────────────────────┐                              │
                │  │  omp auth-gateway serve  │  RemoteAuthCredentialStore   │
                │  │  /v1/{chat,messages,…}   │  receives snapshot stream,   │
                │  │  /v1/usage,/v1/models    │  refreshes credentials by id │
                │  │  /v1/credentials/check   │  via the broker on expiry    │
                │  └─────────┬────────────────┘                              │
                └────────────┼───────────────────────────────────────────────┘
                             │  bearer ($CONFIG_DIR/auth-gateway.token)
                             ▼
                  gateway clients
                  (llm-git, macOS widget, robomp containers, IDE plugins, …)
                                │
                                ▼ provider request with broker-resolved credential
                  api.anthropic.com / api.openai.com / …
```

broker 是 OAuth refresh token 的唯一写入者。客户端（包括 gateway 自身）加载一个脱敏的 snapshot，其中每个 `refresh` 字段都被替换为 `REMOTE_REFRESH_SENTINEL`；当 access token 过期时，客户端调用 `POST /v1/credential/:id/refresh`，由 broker 在服务端执行刷新。`RemoteAuthCredentialStore` 拒绝本地的 replace/upsert/delete-by-provider 变更，错误信息会指向 `omp auth-broker login` / `omp auth-broker logout`。

## auth-broker

### CLI

```
omp auth-broker serve     [--bind=host:port]                    # boot the broker
omp auth-broker token     [--regenerate] [--json]               # print or rotate the bearer token
omp auth-broker login     [<provider>] [--via=user@host] [--dry-run]
omp auth-broker logout    [<provider>]
omp auth-broker list      [--json]
omp auth-broker import    <file|dir> [--provider=<id>] [--include-disabled] [--dry-run] [--json]
omp auth-broker migrate   --from-local [--include-oauth] [--include-env] [--dry-run] [--json]
omp auth-broker status    [--json]
```

- `serve` 在 `getAgentDbPath()` 打开本地 SQLite 存储，并绑定一个 HTTP 监听器（默认 `127.0.0.1:8765`）。启动时会在 `<config-dir>/auth-broker.token` 确保存在一个 token（权限 `0600`，父目录 `0700`）。后台刷新器每隔 `refreshIntervalMs`（默认 60 s）刷新所有满足 `expires - Date.now() < refreshSkewMs`（默认 5 分钟）的 OAuth 凭据。
- `token` 打印缓存的 bearer token 或生成新 token。`--regenerate` 用于轮换。
- `login [<provider>]` 在本地运行各 provider 的 OAuth 流程 —— 未提供 provider 时回退到交互式编号选择器。使用 `--via=user@host` 时会执行 `ssh -L <callback-port>:127.0.0.1:<callback-port> user@host omp auth-broker login <provider>`，使 OAuth 回调命中本地浏览器，但凭据写入 broker 主机（`--via` 要求提供 `<provider>`）。内置回调端口：`anthropic:54545`、`openai-codex:1455`、`google-gemini-cli:8085`、`google-antigravity:51121`、`gitlab-duo:8080`、`devin:59653`、`gitlab-duo-agent:8080`、`zai-coding-plan:9999`。OAuth 流程通过 `AuthStorage.login()` 在进程内驱动 —— 不再需要 spawn `pi-ai` 可执行文件。
- `logout [<provider>]` 删除 `<provider>` 的所有凭据行。无参数时显示当前已存储 provider 的交互式编号选择器。
- `list` 枚举所有已注册的 OAuth provider id/名称（内置 provider 与 `registerOAuthProvider` 自定义 provider 的并集）。`--json` 输出机器可读的数组。
- `import <file|dir>` 将 CLIProxyAPI 风格的 JSON 凭据导入本地 SQLite 存储。`type` 字段映射到 omp provider（`claude → anthropic`、`codex → openai-codex`、`gemini → google-gemini-cli`、`antigravity → google-antigravity`、`gemini-cli → google-gemini-cli`）。
- `migrate --from-local` 将本地 SQLite 凭据上传到所配置的 broker（`POST /v1/credential`）。本地 API key 默认包含；本地 OAuth 行除非设置 `--include-oauth` 否则跳过；来自环境变量的 API key 除非设置 `--include-env` 否则跳过。重复执行对 broker snapshot 是幂等的。
- `status` 对所配置的远程 broker 做健康探测。

### 端点

| 方法     | 路径                         | 认证   | 用途                                                               |
| -------- | ---------------------------- | ------ | ------------------------------------------------------------------ |
| `GET`    | `/v1/healthz`                | 无     | 存活检查 + 版本                                                    |
| `GET`    | `/v1/snapshot`               | bearer | 脱敏 snapshot（refresh token 被替换为 sentinel）                   |
| `GET`    | `/v1/snapshot/stream`        | bearer | 带 delta 事件和 keepalive 的 SSE snapshot 流                       |
| `POST`   | `/v1/credential`             | bearer | upsert 一条 OAuth 或 API key 凭据                                  |
| `POST`   | `/v1/credential/:id/refresh` | bearer | 强制刷新一条 OAuth 凭据                                            |
| `POST`   | `/v1/credential/:id/disable` | bearer | 禁用一条凭据并记录原因                                             |
| `GET`    | `/v1/credentials/disabled`   | bearer | 列出已禁用的凭据；可选 `provider` 查询过滤                         |
| `POST`   | `/v1/credential/:id/block`   | bearer | upsert 一条 provider/scope 限流 block                              |
| `DELETE` | `/v1/credential/:id/blocks`  | bearer | 删除一条凭据的所有限流 block                                       |
| `GET`    | `/v1/usage`                  | bearer | 汇总各凭据当前的 `UsageReport[]`                                   |
| `GET`    | `/v1/usage/history`          | bearer | 持久化的用量历史；可选 `sinceMs` 和 `provider` 过滤                |
| `POST`   | `/v1/usage/observed`         | bearer | 记录 broker 客户端观测到的用量                                     |
| `GET`    | `/v1/usage/clients`          | bearer | 汇总自可选 `sinceMs` 以来客户端观测的用量                          |
| `POST`   | `/v1/usage/stale`            | bearer | 使 broker 当前的用量缓存失效                                       |

请求使用 `Authorization: Bearer <token>`。服务端将其与内存中的 token 允许列表比对；gateway 的实现使用时间安全的比较。

#### 条件 snapshot 长轮询

`GET /v1/snapshot?wait=<ms>` 支持基于 generation 的条件轮询。
将之前响应中的 generation 放入 `If-None-Match` 发送。broker 接受
非负整数 generation 作为裸 tag、带引号的 tag（如 `"42"`），
或弱引号 tag（如 `W/"42"`）。

`wait` 被解析为数字、截断到整毫秒，并限制在 0–30,000 ms 范围内；
缺失或非数字值视为 `0`。响应状态机如下：

- 如果 tag 缺失/无效、与当前 generation 不同，或 `wait <= 0`，立即以 `200` 返回当前脱敏 snapshot。
- 如果 tag 匹配且 `wait > 0`，等待 generation 变化。变化时以 `200` 返回新 snapshot，等待超时未变时返回空的 `304`，调用方断开时返回空的 `499`。

每个 `200`、`304` 和 `499` snapshot 响应都携带以引号 `ETag` 形式表示的当前 generation，外加 `Cache-Control: no-store` 和 `Vary: OMP-Auth-Broker-Capabilities`。

### Codex block-scope 兼容性

理解 per-meter Codex block 的客户端发送 `OMP-Auth-Broker-Capabilities: codex-meter-block-scopes`。snapshot 响应随后携带规范的 `chat` 和 `spark` scope。没有该能力时，broker 会在传输时将这些行投影为旧版 `shared` scope。

本地 SQLite schema 7 将 `chat` 和 `spark` 保留为当前存储 API 暴露的规范 scope。它还为直接读取 `agent.db` 的旧版本二进制维护一个物理 `shared` 兼容镜像。SQLite 触发器独立于 meter 行推导该镜像的 deadline 和更新时间，并将旧进程对 `shared` 的写回复制到两个 meter。当前存储 API 不暴露物理镜像，因此 broker snapshot 和模型选择不会重复计数。

在此能力之前发布的客户端（包括 17.1.4）会收到保守的 `shared` 投影，直到它们升级。这些客户端在现有传输格式上无法区分，因此混合版本部署倾向于让被限流的凭据保持 block 状态，而不是放行重复的 provider 请求和 429 响应。

依赖能力的响应包含 `Vary: OMP-Auth-Broker-Capabilities`，以免中间件把一种表示复用给另一个客户端。加密的客户端 snapshot 缓存也使用新的格式版本：旧缓存文件会被忽略并重新获取，防止旧版表示与 meter-scoped 表示在客户端版本间混用。

### 后台刷新器

`AuthBrokerRefresher` 以 `refreshIntervalMs` 的节奏遍历活跃的 OAuth 凭据，并刷新所有距离过期不足 `refreshSkewMs` 的凭据。刷新按凭据 id 单飞（single-flight），因此慢刷新不会被重复触发。刷新器区分：

- **确定性失败**（`invalid_grant`、`invalid_token`、`revoked`、未授权的 refresh token、非网络抖动导致的 401/403）—— 凭据被传给 `AuthStorage.disableCredentialById(id, cause)`，使下一次 snapshot 拉取在客户端呈现为一次干净的删除；
- **瞬时失败**（超时 / ECONNREFUSED / fetch failed）—— 保留原状，等待下一轮处理。

## auth-gateway

### CLI

```
omp auth-gateway serve   [--bind=host:port] [--no-auth]
omp auth-gateway token   [--regenerate] [--json]
omp auth-gateway status  [--json]
omp auth-gateway check   [--strict] [--json]
```

- `serve` 要求设置 `OMP_AUTH_BROKER_URL`（或 `config.yml` 中的 `auth.broker.url`）—— gateway 本身就是一个 broker 客户端。它调用 `AuthBrokerClient.fetchSnapshot()`，包装在 `RemoteAuthCredentialStore` 中，并构造一个通过 broker 解析 access token 的 `AuthStorage`。默认绑定 `127.0.0.1:4000`。gateway token 存储在 `<config-dir>/auth-gateway.token`（`0600`）；`--no-auth` 完全禁用 bearer 检查（仅限回环使用）。
- `token` / `status` 管理和检查 gateway bearer token 以及上游 broker 的就绪状态。
- `check` 通过 gateway 存储探测 broker 支持的凭据。不带 `--strict` 时使用 provider 用量探测；`--strict` 还会将每条凭据对其 chat-completion 端点进行验证，可能消耗少量配额。

### 端点

| 方法   | 路径                    | 认证   | 用途                                                         |
| ------ | ----------------------- | ------ | ------------------------------------------------------------ |
| `GET`  | `/healthz`              | 无     | 存活检查 + 版本                                              |
| `GET`  | `/v1/usage`             | bearer | 汇总 `UsageReport[]`（通过 `AuthStorage` 代理）              |
| `GET`  | `/v1/models`            | bearer | 内置模型目录，过滤为有凭据的 provider                        |
| `GET`  | `/v1/credentials/check` | bearer | 每凭据的认证健康探测                                         |
| `POST` | `/v1/chat/completions`  | bearer | OpenAI Chat Completions 传输格式                             |
| `POST` | `/v1/messages`          | bearer | Anthropic Messages 传输格式                                  |
| `POST` | `/v1/responses`         | bearer | OpenAI Responses 传输格式                                    |
| `POST` | `/v1/pi/stream`         | bearer | 原生 `pi-ai` 流式传输格式                                    |

对于外部传输格式，model id 从顶层的 `model` 字段读取；`/v1/pi/stream` 则从 pi-native 请求体读取。gateway 选取与该 id 匹配的第一个内置 `Model<Api>`，将入站传输格式解析为 omp `Context`，从 broker 支持的 `AuthStorage` 解析 provider 凭据，通过 `streamSimple()` 分发，并将结果重新编码为入站格式（流式响应使用 SSE）。

不存在原始 provider 透传路径。所有支持的路由都经过 `pi-ai` provider 逻辑，使凭据相关的请求整形、认证错误时的 OAuth 刷新以及 provider 怪癖保持集中。

底层 `Bun.serve` 的 `idleTimeout` 设为 `255 s`，使长 thinking-budget 调用不会被 Bun 的默认空闲超时杀掉。

## 用量缓存：服务端 5 分钟抖动 + 客户端 15 秒单飞

聚合的 provider 用量报告由两层缓存。两层都是有意的且叠加生效。

### 服务端缓存（broker 的 `AuthStorage`）

`AuthStorage` 将每条凭据的 `UsageReport` 缓存在 broker 的 SQLite 存储中，采用**每凭据 5 分钟 TTL 并带 ±25 % 抖动**。Anthropic 和 OpenAI 会按源 IP 激进地限流 `/usage`，同步的 5 凭据扇出每个周期都会触发 429；抖动使刷新时间在几个周期内去相关。获取失败时，存储将**最后可用**的报告保留最多 24 h，并带一个较短的抖动重询窗口 —— 因此瞬时上游抖动不会让 widget 数据清空。

常量：`USAGE_REPORT_TTL_MS = 5 * 60_000`、`USAGE_LAST_GOOD_RETENTION_MS = 24 * 60 * 60_000`（`packages/ai/src/auth-storage.ts`）。

### 客户端单飞（`RemoteAuthCredentialStore`）

当 gateway（或任何其他 broker 客户端）调用 `fetchUsageReports()` / `getUsageReport(provider, credential)` 时，`RemoteAuthCredentialStore` 将并发调用合并为一次 `GET /v1/usage` 往返，并将结果在内存中缓存 **15 s**。

- `USAGE_CACHE_TTL_MS = 15_000`（`packages/ai/src/auth-broker/remote-store.ts`）。
- 单个 `#usageInflight` promise 由所有调用方共享；每个调用方的 `AbortSignal` 与共享 promise **竞速**（race），而不是注入其中，因此一个调用方的中止绝不会级联影响同行的在途请求。
- 获取失败时，被拒绝的 promise 会被记录日志，await 得到的值为 `null` —— 调用方（`AuthStorage.fetchUsageReports`、`#getUsageReport`）将 `null` 报告视为"本周期无用量信号"并继续执行。**这就是 15 s TTL 回退**：客户端通过抑制错误、向排序返回 `null`、并在 15 s 窗口后重试来吸收 broker 的瞬时故障。

15 s 客户端窗口刻意低于 broker 的 5 分钟服务端缓存，因此几乎每个客户端轮询都由 broker 已缓存的值提供服务；客户端缓存的存在是为了把 `AuthStorage.#rankOAuthSelections` 产生的并行扇出吸收为单次 broker 往返。

## 客户端 snapshot 缓存

`discoverAuthStorage()` 在首次 `/v1/snapshot` 获取之后以及后续来自 broker 的完整 snapshot 之后，将 broker snapshot 持久化到 `~/.omp/cache/auth-broker-snapshot.enc`。该文件使用 `SHA-256(OMP_AUTH_BROKER_TOKEN)` 进行 AES-256-GCM 加密，并以 broker URL 作为附加数据做认证，因此更改 token 或 URL 中的任何一个都会使缓存不可读。文件以 `0600` 权限原子写入。

新鲜度以 broker 盖章的 `snapshot.generatedAt` 为准，而非本地写入时间。默认 TTL 为 1 h（`OMP_AUTH_BROKER_SNAPSHOT_TTL_MS`）；`0` 禁用缓存读写。新鲜缓存会以 500 ms 的启动预算对可达的 broker 重新验证，因此导入、吊销或轮换的凭据对一次性命令立即可见。如果因 broker 不可用或缓慢导致重新验证失败，`omp` 从缓存启动，`RemoteAuthCredentialStore` 在后台继续正常的 SSE / 长轮询同步。过期的 OAuth access token 仍然通过 `POST /v1/credential/:id/refresh` 刷新。

如果启动时 broker 宕机且存在新鲜缓存，启动将从缓存的 snapshot 成功进行。认证失败（401/403）不会被缓存掩盖；瞬时的服务器错误则回退到缓存。如果缓存缺失、过期、损坏、面向不同 URL 或用不同 token 加密，启动会回退到实时获取，并在 broker 不可达时失败。

## 客户端账户池（路由，而非授权）

broker 客户端可以通过将 `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE` 设置为一个 JSON 文件来限制可见的 OAuth 账户。该文件将 provider ID 映射到 broker snapshot 协议中的精确 `identityKey` 值：

```json
{
  "anthropic": ["email:alice@example.com|org:org-team"],
  "openai-codex": []
}
```

`identityKey` 是每个已认证的 `/v1/snapshot` 凭据条目已携带的免 token 身份字段。操作者工具应只投影 `provider` 和 `identityKey`；不得保留或打印随附的凭据负载。专门的账户列出 CLI 刻意不在此路由功能的范围内。

SDK 宿主可以在 `discoverAuthStorage()` 或 `RemoteAuthCredentialStore` 中以 `accountPool` 提供相同的 provider 到身份映射。显式的编程式池优先于环境文件。

- 缺失的 provider 不受限制。
- 空数组隐藏该 provider 的所有 OAuth 凭据。
- 非空数组只暴露精确身份匹配，包括 organization/workspace 限定符。
- API key 凭据保持可见；池仅作用于 OAuth 账户。

文件在 broker 支持的认证存储启动时解析一次。不可读的文件、格式错误的 JSON 或无效的 provider 条目会中止初始化，而不是悄悄扩大池。完整 snapshot、SSE 更新、刷新响应和聚合用量都会被一致过滤。对于池中列名的 provider，只有当聚合报告能归属到可见的 OAuth 身份时才会返回；仅能归属到 API key 或缺少匹配身份元数据的报告会失败关闭（fail closed）。加密的 snapshot 缓存仍保留原始 broker snapshot，以便共享该缓存的可信进程应用不同的池。

这是一种**可信客户端路由策略，而非授权边界**。客户端仍持有 broker bearer token，在应用本地视图之前接收原始 broker 响应，并可以直接调用 broker 端点。当必须阻止客户端检索其他凭据时，请使用服务端授权——而非账户池。

## 操作者选择启用

除非设置了 `OMP_AUTH_BROKER_URL`（或 `config.yml` 中的 `auth.broker.url`），broker 处于**关闭**状态。设置后，`packages/coding-agent/src/sdk.ts` 中的 `discoverAuthStorage` 会将本地 SQLite 凭据存储替换为 `RemoteAuthCredentialStore`，所有 API 调用都通过 broker 解析凭据。

### 环境变量

| 变量                                | 用途                                                                                                                                                                   | 何时必需                                                                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `OMP_AUTH_BROKER_URL`               | 远程 auth-broker 的基础 URL（如 `https://broker.tailnet:8765`）。设置后客户端进入 broker 模式 —— 本地 SQLite 被绕过。                                                  | 任何希望 omp 客户端通过 broker 解析凭据的时候（`omp auth-gateway serve` 也必需）。                                         |
| `OMP_AUTH_BROKER_TOKEN`             | 用于除 `/v1/healthz` 外所有 broker 端点的 bearer token。                                                                                                               | 设置了 `OMP_AUTH_BROKER_URL` 且无法从 `auth.broker.token` 或 `<config-dir>/auth-broker.token` 获得 token 时。              |
| `OMP_AUTH_BROKER_SNAPSHOT_TTL_MS`   | 加密本地 snapshot 缓存的新鲜度窗口。默认 `3600000`（1 h）；`0` 禁用缓存读写。                                                                                          | broker 模式下可选。                                                                                                       |
| `OMP_AUTH_BROKER_SNAPSHOT_CACHE`    | 加密本地 snapshot 缓存的路径覆盖。默认 `~/.omp/cache/auth-broker-snapshot.enc`（或等效的 XDG cache 路径）。                                                             | broker 模式下可选。                                                                                                       |
| `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE` | 将 provider ID 映射到此可信客户端可见的 OAuth `identityKey` 值的 JSON 文件。只解析一次；无效文件会中止初始化。不影响 API key。                                          | broker 模式下可选。                                                                                                       |

`resolveAuthBrokerConfig()` 中的解析顺序：

1. `OMP_AUTH_BROKER_URL` 环境变量（否则取 `config.yml` 中的 `auth.broker.url`，经 `resolveConfigValue` 解析）；
2. `OMP_AUTH_BROKER_TOKEN` 环境变量（否则取 `config.yml` 中的 `auth.broker.token`，再否则 `<config-dir>/auth-broker.token`）；
3. 设置了 URL 但无法解析出 token → 硬错误并指向 token 文件路径。

gateway 没有专用的环境变量 —— 它继承 `OMP_AUTH_BROKER_*`，因为它本身就是 broker 客户端。

### `config.yml` 键

| 键                  | 默认值  | 用途                                                                                                                                                                               |
| ------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.broker.url`   | 未设置  | 同 `OMP_AUTH_BROKER_URL`；环境变量优先。在设置 UI 中隐藏。值可解析为字面量、环境变量名或 `!<shell command>`（使用其修剪后的 stdout）。                                              |
| `auth.broker.token` | 未设置  | 同 `OMP_AUTH_BROKER_TOKEN`；环境变量优先。值的解析方式相同。                                                                                                                       |

### Token 文件

| 路径                              | 属主                                                 | 权限                          |
| --------------------------------- | ---------------------------------------------------- | ----------------------------- |
| `<config-dir>/auth-broker.token`  | `omp auth-broker serve`（首次启动时创建）            | `0600`，父目录 `0700`         |
| `<config-dir>/auth-gateway.token` | `omp auth-gateway serve`（`--no-auth` 时跳过）       | `0600`，父目录 `0700`         |

`<config-dir>` 解析为 `~/.omp/`（遵循 `PI_CONFIG_DIR`）。

## 与本地 API key 解析顺序的交互

broker 只拥有上传给它的 OAuth 凭据和 provider-API-key 凭据。`models.md` 中的标准凭据阶梯（`Auth and API key resolution order`）保持不变，仅随 gateway 一起提交了一项新增：

- `AuthStorage.setConfigApiKey / removeConfigApiKey / clearConfigApiKeys` 让 `models.yml` 的 `apiKey` 能压过已存储的 OAuth token，**且不会**覆盖显式的 `--api-key`。这使得当两者同时存在时，broker 解析出的 OAuth 凭据可以被每个环境的 `models.yml` config key 可靠地遮蔽。

## 另见

- [`secrets.md`](./secrets.md) — 针对**确实**泄漏出来的 token（如 shell 输出中的 `OMP_AUTH_BROKER_TOKEN`）的机密混淆。
- [`models.md`](./models.md) — provider 认证解析顺序；broker 提供已存储凭据的各层。
- [`environment-variables.md`](./environment-variables.md) — 完整环境变量参考，包括 `OMP_AUTH_BROKER_URL` / `OMP_AUTH_BROKER_TOKEN`。
