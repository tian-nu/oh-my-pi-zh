# 模型与 Provider 配置（`models.yml` / `models.yaml`）

本文档描述 coding-agent 目前如何加载模型、应用覆盖、解析凭据并在运行时选择模型。

## 什么控制模型行为

主要实现文件：

- `packages/coding-agent/src/config/model-registry.ts` — 加载内置 + 自定义模型、provider 覆盖、运行时发现、auth 集成
- `packages/coding-agent/src/config/model-resolver.ts` — 解析模型模式并选择 initial/smol/slow 模型
- `packages/coding-agent/src/config/settings-schema.ts` — 模型相关设置（`modelRoles`、provider 传输偏好）
- `packages/coding-agent/src/session/auth-storage.ts` — 从 `@oh-my-pi/pi-ai` 重新导出 `AuthStorage`；API key + OAuth 解析顺序
- `packages/catalog/src/models.ts` 与 `packages/catalog/src/types.ts` — 内置 providers/models 与公开模型类型

## 配置文件位置与遗留行为

默认配置路径（按优先级顺序）：

- `~/.omp/agent/models.yml`
- `~/.omp/agent/models.yaml`

仍保留的遗留行为：

- 若两个 YAML 文件都不存在，而同位置存在 `models.json`，它会被迁移为 `models.yml`。
- 以编程方式传给 `ModelRegistry` 的显式 `.json` / `.jsonc` 配置路径仍然受支持。

## `models.yml` / `models.yaml` 结构

```yaml
providers:
  <provider-id>:
    # provider-level config
```

`provider-id` 是跨选择与 auth 查找使用的规范 provider 键。

根对象当前只包含 `providers`；未知的根键会令 schema 校验失败。

## Provider 级字段

```yaml
providers:
  my-provider:
    baseUrl: https://api.example.com/v1
    apiKey: MY_PROVIDER_API_KEY
    api: openai-completions
    headers:
      X-Team: platform
    authHeader: true
    auth: apiKey
    disableStrictTools: false # set true for Anthropic-compatible endpoints that reject the strict field
    discovery:
      type: ollama
      timeoutMs: 10000 # optional per-provider HTTP probe timeout in milliseconds
    modelOverrides:
      some-model-id:
        name: Renamed model
    models:
      - id: some-model-id
        name: Some Model
        api: openai-completions
        reasoning: false
        input: [text]
        imageInputDecoder: stb # local STB decoder; OMP converts WebP before dispatch
        cost:
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
        contextWindow: 128000
        maxTokens: 16384
        headers:
          X-Model: value
        compat:
          supportsStore: true
          supportsDeveloperRole: true
          supportsReasoningEffort: true
          maxTokensField: max_completion_tokens
          openRouterRouting:
            only: [anthropic]
          vercelGatewayRouting:
            order: [anthropic, openai]
          extraBody:
            gateway: m1-01
            controller: mlx
```

### 压缩选项

- `compactionModel`（每个模型，包括 `modelOverrides`）— 当该模型的会话被压缩时，用于总结/压缩上下文的模型选择器，而非模型本身。
- `remoteCompaction`（provider 级或每个模型）— 让符合条件的模型加入 provider 原生压缩。支持的键：`enabled`、`api`、`endpoint`、`model`、`v2StreamingEnabled`、`v2Endpoint`、`streamingEndpoint`。Provider 级设置是基线；每个模型的键覆盖它们。

### 允许的 provider/model `api` 值

- `openai-completions`
- `openai-responses`
- `openai-codex-responses`
- `azure-openai-responses`
- `anthropic-messages`
- `bedrock-converse-stream`
- `google-generative-ai`
- `google-gemini-cli`
- `google-vertex`

### 允许的 auth/discovery 值

- `auth`：`apiKey`（默认）、`none` 或 `oauth`；对于 `models.yml` 自定义模型，schema 接受 `oauth`，但不豁免 `apiKey` 要求
- `discovery.type`：`ollama`、`llama.cpp`、`lm-studio`、`openai-models-list`、`proxy` 或 `litellm`
- `discovery.injectV1`：可选布尔值，默认 `true`，用于 `openai-models-list`。设为 `false` 时从 `{baseUrl}/models` 获取模型列表而不注入 `/v1` — 适用于把 OpenAI 兼容表面放在带版本路径的网关（如 `https://api.opper.ai/v3/compat`），其强制的 `/v1/models` 会返回不同且更小的模型列表。`baseUrl` 中的查询字符串会被忽略，与默认模式一致。
- `transport`：仅 `pi-native`。设置后，该 provider 下的每个模型都会通过 `POST /v1/pi/stream` 发送到兼容 `omp auth-gateway` 的 `baseUrl`；`apiKey` 即网关的 bearer。
- `imageInputDecoder`：仅 `stb`。当服务后端使用无法接受 WebP 的 STB 兼容图像解码器时，在自定义模型或 `modelOverrides` 条目上设置此项；OMP 会在 provider 分发前转换附加的与历史 WebP 图像。
- `tokenizer`：当 proxy 的模型 id 有歧义或非规范时，选用某个内嵌的本地 tokenizer。允许的值：`claude-v3`、`claude-v47`、`claude-v5`、`claude-v5-sonnet`、`qwen3`、`deepseek-v3`、`kimi-k2` 与 `glm5`。省略时使用 catalog 身份策略；未知模型保留快速本地估算。

## 校验规则（当前）

### 完整自定义 provider（`models` 非空）

必填：

- `baseUrl`
- 除非 `auth: none`，否则需要 `apiKey`
- `api`：在 provider 级或每个模型上

### 仅覆盖的 provider（`models` 缺失或为空）

必须至少定义以下之一：

- `baseUrl`
- `apiKey`
- `auth: none`
- `headers`
- `compat`
- `disableStrictTools`
- `modelOverrides`
- `discovery`
- `remoteCompaction`

### 发现

- `discovery.timeoutMs` 以毫秒覆盖该 provider 的运行时 HTTP 探测超时。它必须是正的有限数。
- `discovery` 需要 provider 级 `api`，但 `discovery.type: proxy` 除外（按模型的 wire 自动探测）。

### 远程压缩

`remoteCompaction` 对仅覆盖的 provider 而言可独立满足要求。
它支持 `enabled`、`api`、`endpoint`、`model`、`v2StreamingEnabled`、
`v2Endpoint` 与 `streamingEndpoint`。

### 模型值检查

- `id` 必填
- 若提供 `contextWindow` 与 `maxTokens`，它们必须为正

### 由命令解析的密钥

Provider 的 `apiKey` 值与 provider/model 的 `headers` 值可以 `!` 开头，表示从命令 stdout 读取机密。命令以 10 秒超时运行，stdout 会被裁剪，空输出或失败的命令会被省略：

```yaml
providers:
  openai:
    apiKey: "!op read op://dev/openai/api-key"
    headers:
      X-Team-Key: "!bw get password omp-team-key"
```

成功命令的输出会在进程生命周期内缓存，因此不会为每个模型重复运行命令。

## 合并与覆盖顺序

ModelRegistry 流水线（刷新时）：

1. 从 `@oh-my-pi/pi-catalog` 加载内置 providers/models（`getBundledProviders` / `getBundledModels`）。
2. 加载 `models.yml` / `models.yaml` 自定义配置。
3. 对内置模型应用 provider 覆盖（`baseUrl`、`headers`、`disableStrictTools`）。
4. 应用 `modelOverrides`（按 provider + model id）。
5. 合并自定义 `models`：
   - 相同 `provider + id` 替换现有项
   - 否则追加
6. 加载缓存与运行时发现的模型。这包括本地服务器、内置 provider 管理器，以及已知 provider 的共享 models.dev catalog。合并后重新应用模型覆盖。

### Provider-model 缓存与静态指纹

每个 provider 的缓存模型列表会持久化在 model-cache SQLite
数据库中（当前 schema 版本 12），并带有一个 `static_fingerprint` 列，
用于对合并进该行的静态 catalog 切片做哈希。当 `resolveProviderModels`
跳过网络抓取，且内存中静态 catalog 的指纹与缓存的指纹一致时，
缓存行会被原样返回——静态与动态的合并被完全绕过。
该指纹通过给 static-models 数组打上 symbol 属性标签的方式，
在每个进程内被记忆化（memoized），
因此重复的冷启动调用不会重新哈希。

### 共享 catalog 刷新

内置 catalog 仍是启动与离线基线。启动同步加载内置与缓存行后，现有的后台刷新生命周期会为已知 provider 抓取当前共享的 models.dev catalog。新模型 ID 以叠加方式合并进各 provider 的内置切片，经该 provider 的 catalog 描述符规范化，并持久化到 model-cache 数据库。这样新发布的模型无需等待新的 OMP 二进制即可出现。

远程行可以为新加入的 ID 提供当前限制、定价、模态与能力标志，但不能引入代码、任意 headers 或未注册的 provider。成功的 provider 端点发现对账号可用性仍具权威性。共享 catalog 不具权威性：远程行消失时它不会移除内置模型。

新鲜的缓存快照可避免网络请求。若刷新失败，OMP 保留最后一个可用的缓存快照并标记为 stale；没有缓存时回退到内置 catalog。Provider 发现状态记录 `source`（`bundled`、`models.dev`、`provider` 或 `cache`）与 `fetchedAt`，以便调用方区分当前远程数据与离线回退。

## Provider 与模型身份

注册表保留具体的 `provider` + `id` 身份。当同一模型 id 存在于多个 provider 下时，请使用精确的
`provider/modelId` 选择器。会话状态
与 transcript 会记录执行该轮的具体 provider/model。

Provider 默认值与每个模型的覆盖：

- Provider 的 `headers`、`compat` 与 `remoteCompaction` 是基线。
- 模型的 `headers` 覆盖 provider 的 header 键。
- `modelOverrides` 可覆盖模型元数据（`name`、`reasoning`、`thinking`、`input`、`imageInputDecoder`、
  `tokenizer`、`supportsTools`、`cost`、`premiumMultiplier`、`contextWindow`、`maxTokens`、
  `omitMaxOutputTokens`、`headers`、`compat`、`contextPromotionTarget`、`compactionModel` 与
  `remoteCompaction`）。
- 对嵌套路由块（`openRouterRouting`、`vercelGatewayRouting`、
  `extraBody` 与 `whenThinking`），`compat` 做深度合并。

## 运行时发现集成

### 隐式 Ollama 发现

若未显式配置 `ollama`，注册表会添加一个隐式可发现的 provider：

- provider：`ollama`
- api：`openai-responses`
- base URL：`OLLAMA_BASE_URL`、`OLLAMA_HOST` 或 `http://127.0.0.1:11434`
- context window：设置了 `OLLAMA_CONTEXT_LENGTH` 则用之，否则用 Ollama `/api/show` 元数据，否则为 `128000`
- auth 模式：无密钥（`auth: none` 行为）

运行时发现调用 Ollama 端点，并把发现的 OpenAI 兼容模型规范化为 `openai-responses`。

`OLLAMA_CONTEXT_LENGTH` 不配置 Ollama 运行时的 `num_ctx`；请在 Ollama/模型配置中单独设置。

### 隐式 llama.cpp 发现

若未显式配置 `llama.cpp`，注册表会添加一个隐式可发现的 provider：

- provider：`llama.cpp`
- api：`openai-responses`
- base URL：`LLAMA_CPP_BASE_URL` 或 `http://127.0.0.1:8080`
- auth 模式：无密钥（`auth: none` 行为）

运行时发现调用 llama.cpp 模型端点，并以本地默认值合成模型条目。

### 隐式 LM Studio 发现

若未显式配置 `lm-studio`，注册表会添加一个隐式可发现的 provider：

- provider：`lm-studio`
- api：`openai-completions`
- base URL：`LM_STUDIO_BASE_URL` 或 `http://127.0.0.1:1234/v1`
- auth 模式：无密钥（`auth: none` 行为）

运行时发现抓取模型（`GET /models`）并以本地默认值合成模型条目。

这条路径同样适用于并非 LM Studio 的本地 OpenAI 兼容服务器。例如，若 oMLX 绑定在 Ollama 常用的端口上，可设置 `LM_STUDIO_BASE_URL=http://127.0.0.1:11434/v1`，通过现有的 `/v1/models` 流程发现它。让 oMLX 与 Ollama 并存运行时，需要给其中一个分配不同端口。不要把 oMLX 配置成 `ollama`：Ollama 发现使用原生 `/api/tags` 与 `/api/show` 端点，而非 OpenAI 的 `/v1/models`。

### LiteLLM provider 发现

当 `litellm` 激活时（例如通过 `LITELLM_API_KEY` 或已存储的 auth），运行时发现使用 LiteLLM proxy：

- provider：`litellm`
- api：OpenAI 支撑的模型用 `openai-responses`；其他模型用 `openai-completions`
- base URL：显式的 provider `baseUrl` / `models.yml` 配置，否则 `LITELLM_BASE_URL`，否则 `http://localhost:4000/v1`
- auth 模式：proxy 需要 key 时用 `LITELLM_API_KEY` 或已存储的 LiteLLM auth

运行时发现按顺序探测 LiteLLM 管理元数据：`GET /model_group/info`、`GET /v2/model/info`、`GET /model/info` 与 `GET /v1/model/info`。配置的 key 必须被授权读取其中至少一条路由；在限制管理端点的部署上，通过 LiteLLM 的 `allowed_routes` 访问控制授予该路由，或使用 master/admin key 进行发现。

若所有元数据路由都不可用，发现会回退到 OpenAI 兼容的 `GET /models` 列表。被禁止或失败的元数据请求会连同端点与状态记录一次；`404` 视为路由不存在。富元数据会映射每个模型的上下文、能力与上游 provider 字段。OpenAI 支撑的模型使用 LiteLLM 的 Responses 路由，以便 reasoning 摘要保持可用；混合 provider 组仍走 Chat Completions。裸回退 id 在可用时使用已知的 OpenAI 模型族做路由与内置参考元数据。因此，不在内置 catalog 中的模型在回退后可能具有未知的上下文与定价。

### 显式 provider 发现

你也可以自行配置发现：

```yaml
providers:
  ollama:
    baseUrl: http://127.0.0.1:11434
    api: openai-responses
    auth: none
    discovery:
      type: ollama

  llama.cpp:
    baseUrl: http://127.0.0.1:8080
    api: openai-responses
    auth: none
    discovery:
      type: llama.cpp
```

自定义 LiteLLM 网关可使用相同的富发现路径：

```yaml
providers:
  litellm-gateway:
    baseUrl: http://gateway.example:4000/v1
    apiKey: LITELLM_API_KEY
    api: openai-completions
    discovery:
      type: litellm
```

LiteLLM 元数据端点在仅用于发现时，会去掉配置的 base URL 末尾的 `/v1`，保留其前的任何 proxy 路径。运行时模型调用仍保留配置的 OpenAI 兼容 `/v1` base URL。

### Proxy 发现（`discovery.type: proxy`）

适用于 Anthropic+OpenAI 兼容 proxy（new-api / one-api / 类似产品），
它们在同一主机背后同时暴露 `/v1/messages` 与 `/v1/chat/completions`。
发现请求 `GET /v1/models`（10 秒超时，OpenAI 风格载荷），并从条目的
`supported_endpoint_types` 推导每个模型的 `api`：

- 包含 `"anthropic"` -> `api: anthropic-messages`（经 `/v1/messages` 路由）
- 包含 `"openai"` -> `api: openai-completions`（经 `/v1/chat/completions` 路由）
- 否则 -> 若设置了 provider 级 `api` 则回退到它，否则丢弃

对 `discovery.type: proxy`，provider 级 `api` 是**可选的**，因为
按模型的 wire 会被自动探测。Anthropic SDK 在追加 `/v1/messages` 前会去掉
`baseUrl` 末尾的 `/v1`，因此单个发现 `baseUrl`（以 `/v1` 结尾）
能正确往返于两条 wire。

```yaml
providers:
  newapi-reseller:
    baseUrl: https://api.example.com/v1
    apiKey: xxxx
    authHeader: true # injects Authorization: Bearer for openai models
    disableStrictTools: true # most anthropic-fronted proxies reject `strict`
    discovery:
      type: proxy
```

### Extension provider 注册

Extension 可在运行时注册 provider（`pi.registerProvider(...)`），包括：

- 对某 provider 的模型替换/追加
- 为新 API ID 注册自定义流处理器
- 自定义 OAuth provider 注册

## Auth 与 API key 解析顺序

为 provider 请求 key 时，生效顺序为：

1. 运行时覆盖（CLI `--api-key`）
2. 配置覆盖（`models.yml` 的 `providers.<name>.apiKey`）
3. 已存储的 OAuth 凭据（带刷新）
4. 登录来源的已存储 API key
5. 环境变量映射（`OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 等）
6. 其他已存储的 API key，如 broker 迁移的副本
7. ModelRegistry 回退解析器（`models.yml` 自定义 provider，使用 env 名或字面量语义）

`models.yml` 的 `apiKey` 行为：

- 值首先被视为环境变量名。
- 若该环境变量不存在，则把字面字符串用作 token。

若设置了 `authHeader: true` 与 provider `apiKey`，模型会得到：

- 注入 `Authorization: Bearer <resolved-key>` header。

无密钥 provider：

- 标记为 `auth: none` 的 provider 被视为无需凭据即可用。
- 对它们 `getApiKey*` 返回 `kNoAuth`。

### Broker 模式

当设置了 `OMP_AUTH_BROKER_URL`（或 `auth.broker.url`）时，本地 SQLite 凭据存储会被 `RemoteAuthCredentialStore` 取代。上述第 3、4、6 层（已存储的 OAuth 与 API-key 凭据）由 broker 提供的快照供给，其中 `refresh` token 会被脱敏；过期会在 broker 上触发 `POST /v1/credential/:id/refresh`，而不是本地刷新。

`AuthStorage.setConfigApiKey` 让 `models.yml` 的 `apiKey` 胜过 broker 解析出的 OAuth token，同时不覆盖运行时的 `--api-key`。完整的 broker / gateway 设计与 env 面（`OMP_AUTH_BROKER_URL`、`OMP_AUTH_BROKER_TOKEN`、`auth.broker.url`、`auth.broker.token`）见 [`auth-broker-gateway.md`](./auth-broker-gateway.md)。

## 模型可用性 vs 全部模型

- `getAll()` 返回已加载的模型注册表（内置 + 合并的自定义 + 已发现）。
- `getAvailable()` 过滤出无密钥或 auth 可解析的模型。

因此模型可以存在于注册表中，但在 auth 可用之前不可被选择。

## 运行时模型解析

### CLI 与模式解析

`model-resolver.ts` 支持：

- 精确的 `provider/modelId`
- 精确的模型 id（provider 推断）
- 模糊/子串匹配
- `--models` 中的 glob 作用域模式（如 `openai/*`、`*sonnet*`）
- 可选的 `:thinkingLevel` 后缀（`off|minimal|low|medium|high|xhigh|max`）

`--provider` 是遗留选项；优先使用 `--model`。精确的 `provider/modelId` 没有歧义；裸 id
与模糊模式会对照可用的具体模型解析。

精确选择器的解析优先级：

1. 精确的 `provider/modelId` 引用
2. 精确的裸 id（不区分大小写）；当多个 provider 携带相同 id 时，由偏好排序选出胜者（见下文）
3. 已退役的 effort 层级变体别名（折叠的 catalog 条目，如 `X`/`X-thinking` 孪生）
4. provider 作用域的模糊匹配，然后是在别名与带日期版本之间取舍的子串匹配

glob 作用域模式（由 `enabledModels` 与 CLI `--models` 使用）在精确匹配后对具体模型单独运行。

当裸 id 命中多个 provider 的模型时，偏好顺序为：

1. 最近使用过的模型变体
2. provider 优先级（`modelProviderOrder` 设置，然后是内置 catalog 的 provider 优先级）
3. 最近使用过的 provider
4. 注册表顺序

### 初始模型选择优先级

`findInitialModel(...)` 使用此顺序：

1. 显式的 CLI provider+model
2. 第一个作用域模型（若非恢复会话）
3. 已保存的默认 provider/model
4. 可用模型中的已知 provider 默认值（如 OpenAI/Anthropic 等）
5. 第一个可用模型

### 角色别名与设置

受支持的模型角色：

- `default`、`smol`、`slow`、`vision`、`plan`、`commit`、`tiny`、`task`、`advisor`

`tiny` 角色覆盖用于轻量后台任务的在线模型（会话标题、memory、`auto` 思考难度分类、意外停止检测）；未设置时这些任务回退到 `@smol`。可在 `/models` 中选择一个。

`@smol` 之类的角色别名通过 `settings.modelRoles` 展开；`*` 选择 `@default`。在 YAML 值中给 `@` 别名加引号（`fable: "@slow"`）。每个角色值还可以追加思考选择器，如 `:minimal`、`:low`、`:medium` 或 `:high`。

若某角色指向另一角色，目标模型仍正常继承，且引用角色上任何显式后缀在该角色的特定用途中胜出。

相关设置：

- `modelRoles`（record）
- `enabledModels`（作用域模式列表）
- `modelProviderOrder`（等价具体选择共享同一 id 时的 provider 优先级）
- `providers.kimiApiFormat`（`openai` 或 `anthropic` 请求格式）
- `providers.openaiWebsockets`（OpenAI Codex 传输的 `auto|off|on` websocket 偏好）

`modelRoles` 存储诸如 `provider/modelId` 的模型选择器；`enabledModels` 与 CLI `--models`
接受精确选择器、glob 与模糊匹配。

全局 `enabledModels` 与 `disabledProviders` 条目也可以限定到某个路径前缀：

```yaml
enabledModels:
  - claude-sonnet-4-5
  - path: ~/work
    models:
      - anthropic/claude-opus-4-5
disabledProviders:
  - ollama
  - path: ~/private
    providers:
      - anthropic
```

字符串条目处处生效。作用域条目在当前工作目录为配置的路径或其子目录之一时生效。使用 `path`、`paths`、`pathPrefix` 或 `pathPrefixes`；`enabledModels` 用 `models`，`disabledProviders` 用 `providers`，两者也可用 `values`。

## `/model` 与 `omp models`

两个界面都让带 provider 前缀的具体模型保持可见且可选。

- `/model` 显示全部模型视图，外加每个 provider 一个视图
- `omp models`（默认 `ls` 动作）以 provider 分组表格打印每个可用模型；`omp models find <substring>` 按 provider、id 或名称过滤；`omp models refresh` 忽略模型缓存 TTL，强制重新抓取在线 catalog；任意 provider 名都可兼作 `ls` 过滤器（如 `omp models openai-codex`）。Flags：`--json`、`-e <path>`（加载 extension，可重复）、`--no-extensions`、`--config <overlay>`（额外配置覆盖，可重复）

选择某 provider 行会存储其显式的 `provider/modelId`。

## 上下文提升（模型级回退链）

上下文提升是针对小上下文变体（如 `*-spark`）的溢出恢复机制：当 API 因上下文长度错误拒绝请求时，它会自动提升到上下文更大的兄弟模型。

### 触发与顺序

当某轮因上下文溢出错误失败（如 `context_length_exceeded`）时，`AgentSession` 会在回退到压缩**之前**先尝试提升：

1. 若 `contextPromotion.enabled` 为 true，解析提升目标（见下文）。
2. 若找到目标，切换到它并重试请求——无需压缩。
3. 若无可用目标，则落到当前模型的自动压缩。

### 目标选择

选择是显式且由模型驱动的：

1. `currentModel.contextPromotionTarget`（若已配置）

只会考虑已配置的目标；上下文提升不会自动选择同 provider/API 的更大兄弟。除非凭据可解析（`ModelRegistry.getApiKey(...)`），否则已配置的目标会被忽略。

### OpenAI Codex websocket 交接

若从/向 `openai-codex-responses` 切换，会话 provider 状态键 `openai-codex-responses` 会在模型切换前关闭。这会丢弃 websocket 传输状态，使下一轮在提升后的模型上干净开始。

### 持久化行为

提升使用临时切换（`setModelTemporary`）：

- 在会话历史中记录为临时 `model_change`
- 不重写已保存的角色映射

### 配置显式回退链

通过 `contextPromotionTarget` 直接在模型元数据中配置回退。

`contextPromotionTarget` 接受以下任一种：

- `provider/model-id`（显式）
- `model-id`（在当前 provider 内解析）

显式 OpenAI 回退的示例（`models.yml`）：

```yaml
providers:
  openai-codex:
    modelOverrides:
      gpt-5.5:
        contextPromotionTarget: openai-codex/gpt-5.4
```

当目标存在于同一 provider/API 时，内置模型策略目前把 OpenAI 的 `codex-spark` 变体链接到 `gpt-5.5`，把 `gpt-5.5` 链接到 `gpt-5.4`。

## 兼容性与路由字段

provider 或模型上的 `compat` 块覆盖 `packages/catalog/src/compat/openai.ts`（`buildOpenAICompat`）中基于 URL 的自动探测。它由 `packages/coding-agent/src/config/models-config-schema.ts` 中的 `OpenAICompatSchema` 校验，并被每个 `openai-completions` 传输（`packages/ai/src/providers/openai-completions.ts`）消费。规范类型是 `packages/catalog/src/types.ts` 中的 `OpenAICompat`。

与这些字段交互的端点特有例外收录在 [Provider endpoint constraints](./provider-endpoint-constraints.md)。

`models.yml` 接受以下键（全部可选；未设置时回退到 URL 探测）：

请求整形：

- `supportsStore` — 在请求中发出 `store: false`。默认：auto（对非标准端点关闭）。
- `supportsDeveloperRole` — 对推理模型使用 `developer` 系统角色而非 `system`。默认：auto。
- `supportsMultipleSystemMessages` — 保留彼此分离的前导 system/developer 消息，而不是合并它们。默认：auto（已知的 OpenAI 兼容托管 API 会保留；严格模板/本地主机合并）。
- `supportsUsageInStreaming` — 发送 `stream_options: { include_usage: true }`，在流式响应中接收 token 用量。默认：`true`。
- `maxTokensField` — `"max_completion_tokens"` 或 `"max_tokens"`。默认：auto。
- `supportsToolChoice` — 当调用方强制指定某工具时发出 `tool_choice` 参数。默认：`true`。对在 `tool_choice` 上返回 400 的端点设为 `false`（如开启 reasoning 时的 DeepSeek）。
- `supportsForcedToolChoice` — 接受要求特定工具的强制 `tool_choice`。默认：`true`。为 `false` 时，强制选择器会被降级为 `auto`，以便工具对拒绝强制工具调用的端点（如某些要求思考的 OpenAI 兼容模型）仍然可用。
- `disableReasoningOnForcedToolChoice` — 只要 `tool_choice` 强制一次调用，就丢弃 `reasoning_effort` / OpenRouter `reasoning`。默认：auto（Kimi/Anthropic 前置端点）。
- `disableReasoningOnToolChoice` — 只要发送了任何 `tool_choice`，就丢弃 reasoning 字段。默认：auto（DeepSeek 推理模型）。
- `alwaysSendMaxTokens` — 当调用方未提供 max-token 字段时始终发送一个。默认：auto（Kimi 家族模型从 `max_tokens` 推导 TPM 限制）。
- `strictResponsesPairing` — Responses-API 的 tool-call/result 历史必须严格配对。默认：auto（Azure OpenAI、GitHub Copilot）。
- `streamIdleTimeoutMs` — 面向慢速推理主机的流看门狗空闲超时下限（毫秒）。默认：auto（GLM coding-plan 主机、直连 DeepSeek 推理）。
- `cacheControlFormat` — 设为 `"anthropic"` 以在 chat-completions 载荷中加入 Anthropic 风格 prompt-cache 标记。默认：auto（OpenRouter `anthropic/*` 模型）。
- `supportsLongPromptCacheRetention` — 主机在 Responses API 上认可 `prompt_cache_retention: "24h"`。默认：auto（api.openai.com）。
- `supportsImageDetailOriginal` — 允许在端点支持的地方使用 Responses API 的非标准 `detail: "original"` 图像
  模式。
- `extraBody` — 合并进每个请求体的额外顶层字段（网关提示、controller 选择器等）。

推理 / 思考：

自定义模型条目可定义 `thinking: { mode, efforts, defaultLevel, requiresEffort }`。
`requiresEffort` 默认为自动探测；只有当已确认
所配置的后端接受显式关闭推理的请求时，才把它设为 `false`。
这可以防止 `:off` 选择器被钳制到最低 effort。

- `supportsReasoningEffort` — 接受 `reasoning_effort`。默认：auto（对 Grok、Z.ai/Zhipu 与 Xiaomi MiMo 关闭）。
- `supportsReasoningParams` — 请求整形是否可发送 reasoning 参数。默认：auto（对 GitHub Copilot chat-completions 关闭）。
- `reasoningEffortMap` — 从内部 effort 级别（`minimal|low|medium|high|xhigh|max`）到 provider 特有字符串的部分映射（如 Fireworks GLM 把 `minimal -> "none"`）。
- `thinkingFormat` — thinking 的请求形态：`"openai"`（`reasoning_effort`）、`"openrouter"`（`reasoning: { effort }`）、`"zai"`（`thinking: { type: "enabled" }`）、`"qwen"`（顶层 `enable_thinking`）或 `"qwen-chat-template"`（`chat_template_kwargs.enable_thinking`）。默认：`"openai"`。
- `qwenTemplateReasoningEffort` — 把选中的 effort 路由到 Qwen 3.8+ chat template 的 `reasoning_effort` kwarg（`chat_template_kwargs.reasoning_effort`，外加 `qwen` 方言上的顶层字段）。默认：auto（对本地非 Ollama 后端上的 Qwen 3.8+ id 开启）。对拒绝未知 `chat_template_kwargs` 的严格服务器设为 `false`；此后 Qwen 方言不会发送 effort 选择，template 按自身默认运行。
- `reasoningContentField` — 承载 chain-of-thought 的 assistant 字段：`"reasoning_content"`、`"reasoning"` 或 `"reasoning_text"`。默认：auto。
- `requiresReasoningContentForToolCalls` — assistant 的工具调用轮必须往返携带 reasoning 字段（DeepSeek-R1、Kimi、开启 reasoning 时的 OpenRouter）。默认：`false`。
- `allowsSyntheticReasoningContentForToolCalls` — 当先前的 assistant 工具调用轮缺少 provider reasoning 内容时，允许占位 reasoning 字段。默认：`true`；对校验精确 reasoning 值的 provider 设为 `false`。
- `requiresAssistantContentForToolCalls` — assistant 的工具调用轮必须包含非空文本内容（Kimi）。默认：`false`。
- `whenThinking` — 仅当请求真正进入 thinking 模式时应用的部分 compat 覆盖（在基线 compat 之上深度合并）。

工具 / 消息规范化：

- `requiresToolResultName` — tool-result 消息需要 `name` 字段（Mistral）。默认：auto。
- `requiresAssistantAfterToolResult` — tool result 之后的用户消息需要先有一轮 assistant。默认：auto。
- `requiresThinkingAsText` — 把 thinking 块转换为包在 `<thinking>` 分隔符中的文本（Mistral）。默认：auto。
- `requiresMistralToolIds` — 把 tool-call id 规范化为恰好 9 个字母数字字符。默认：auto。
- `supportsStrictMode` — 接受工具 schema 上逐工具的 `strict` 字段。默认：按 provider/baseUrl 保守自动探测。
- `toolStrictMode` — `"all_strict"` 对所有工具强制 strict，`"none"` 强制关闭；未设置时保留现有的逐工具混合行为。

网关路由（仅当 `baseUrl` 与网关匹配时应用）：

- `openRouterRouting.only` / `openRouterRouting.order` — 在 `openrouter.ai` 上的 provider 路由（见 <https://openrouter.ai/docs/provider-routing>）。
- `vercelGatewayRouting.only` / `vercelGatewayRouting.order` — 在 `ai-gateway.vercel.sh` 上的 provider 路由（见 <https://vercel.com/docs/ai-gateway/models-and-providers/provider-options>）。

Provider 级 `compat` 是基线；每个模型的 `compat` 在其上深度合并，
`openRouterRouting`、`vercelGatewayRouting`、`extraBody` 与 `whenThinking` 作为嵌套对象合并。

### Anthropic 兼容性（`anthropic-messages`）

对 `anthropic-messages` 模型，运行时使用单独的 `AnthropicCompat` 形态
（`packages/catalog/src/types.ts`）。`models.yml` schema 把 strict-tools 退出选项暴露为
顶层 provider 字段，外加 `compat` 中的 `requiresToolResultId`、`replayUnsignedThinking`、
`supportsEagerToolInputStreaming` 与 `allowAnthropicHeaderOverrides`。其他
Anthropic 侧的调节项由内置 catalog 元数据提供，此处不可配置。

### Bedrock 兼容性（`bedrock-converse-stream`）

同一个 `compat` 槽位为 Bedrock 模型接受 `promptCacheMode`（`none`、`automatic` 或 `explicit`）、
`supportsLongPromptCacheRetention`、`promptCacheMinimumTokens` 与
`promptCacheMaximumCheckpoints`。

### 严格工具 schema（`disableStrictTools`）

Anthropic 的 API 支持工具定义上的 `strict` 字段，强制模型始终严格遵守所提供的 schema。OMP 默认对一小撮高频内置 `anthropic-messages` 工具（`bash`、`python`、`edit` 与 `find`）启用它，这些工具的 schema 符合 Anthropic 的严格语法限制；其他工具仍发送规范化 schema，但省略 `strict`。

前置 Anthropic API 的第三方 provider（AWS Bedrock、Azure、自托管 proxy）并非都实现该字段，包含它的请求会被拒绝。在 provider 级设置 `disableStrictTools: true` 可为白名单工具退出 strict 模式：

```yaml
providers:
  bedrock-anthropic:
    baseUrl: https://bedrock-runtime.us-east-1.amazonaws.com/anthropic
    apiKey: AWS_BEARER_TOKEN
    api: anthropic-messages
    disableStrictTools: true
    models:
      - id: claude-sonnet-4-20250514
        name: Claude Sonnet 4 (Bedrock)
        input: [text, image]
        contextWindow: 200000
        maxTokens: 16384
        cost:
          input: 3.00
          output: 15.00
          cacheRead: 0.30
          cacheWrite: 3.75
```

`disableStrictTools` 是 provider 级标志，作用于该 provider 中的所有模型。它只对 OMP 否则会标记为 strict 的工具禁用 Anthropic `strict` 标记；不会改变运行时工具参数校验。当 Anthropic 在首个流式 token 之前报告 strict 语法过大错误时，OMP 可以在不带 strict 工具的情况下自动重试；但出于其他原因拒绝 `strict` 字段的 proxy 应显式设置此标志。

上线传输的工具 schema 由统一流程规范化，见
`packages/ai/src/utils/schema/normalize.ts`（Google/CCA/MCP 分发器
外加 OpenAI strict-mode 的 sanitize+enforce 流水线）。
strict-mode 的边界情况（本地 `$ref` 内联、单条目 `allOf` 折叠、
`anyOf` 包装的 description 提升、enum/const 基本类型推断）
以及逐 provider 的分发器映射，
参见 [`ai-schema-normalize.md`](./ai-schema-normalize.md)。

## 实用示例

### 本地 OpenAI 兼容端点（无 auth）

```yaml
providers:
  local-openai:
    baseUrl: http://127.0.0.1:8000/v1
    auth: none
    api: openai-completions
    models:
      - id: Qwen/Qwen2.5-Coder-32B-Instruct
        name: Qwen 2.5 Coder 32B (local)
```

对于 oMLX 或另一个带可发现 `/v1/models` 端点的本地 OpenAI 兼容服务器，优先用发现而非手工列出模型。把 `api` 设为服务器实际暴露的端点家族：`openai-completions` 使用 `/v1/chat/completions`；暴露 `/v1/responses` 的服务器需要改用 `openai-responses`。

```yaml
providers:
  omlx:
    baseUrl: http://127.0.0.1:11434/v1
    auth: none
    api: openai-completions
    discovery:
      type: openai-models-list
```

内置 vLLM provider 可指向非默认端点，而无需声明自定义发现类型。OMP 使用 vLLM 的 `/v1/models` 元数据，并把 vLLM 的 `max_model_len` 字段保留为发现的上下文窗口。

```yaml
providers:
  vllm:
    baseUrl: http://192.168.5.3:8085/v1
    auth: none
```

对多个 vLLM 端点，可用任意 provider ID 搭配通用 OpenAI 兼容发现路径。本地无 auth 服务器设 `auth: none`，有认证的设 `apiKey`。通用发现先读 `max_model_len`，然后把 `context_length` 作为通用 OpenAI 兼容回退。

```yaml
providers:
  vllm-fast:
    baseUrl: http://host-a:8000/v1
    auth: none
    api: openai-completions
    discovery:
      type: openai-models-list
  vllm-long:
    baseUrl: http://host-b:8000/v1
    auth: none
    api: openai-completions
    discovery:
      type: openai-models-list
```

### 基于 env key 的托管 proxy

```yaml
providers:
  anthropic-proxy:
    baseUrl: https://proxy.example.com/anthropic
    apiKey: ANTHROPIC_PROXY_API_KEY
    api: anthropic-messages
    authHeader: true
    disableStrictTools: true # if the proxy doesn't support strict tool schemas
    models:
      - id: claude-sonnet-4-20250514
        name: Claude Sonnet 4 (Proxy)
        reasoning: true
        input: [text, image]
```

### 覆盖内置 provider 路由 + 模型元数据

```yaml
providers:
  openrouter:
    baseUrl: https://my-proxy.example.com/v1
    headers:
      X-Team: platform
    modelOverrides:
      anthropic/claude-sonnet-4:
        name: Sonnet 4 (Corp)
        compat:
          openRouterRouting:
            only: [anthropic]
```

## 遗留消费者的注意事项

现在大多数模型配置都经由 `ModelRegistry` 走 `models.yml` / `models.yaml`。显式 `.json` / `.jsonc` 路径仅在以编程方式传给 `ModelRegistry` 时仍受支持；默认用户配置优先 `~/.omp/agent/models.yml`，然后回退到 `~/.omp/agent/models.yaml`。

## 失败模式

若 `models.yml` / `models.yaml` 未通过 schema 或校验检查：

- 注册表继续使用内置模型运行
- 错误通过 `ModelRegistry.getError()` 暴露，并在 UI/通知中呈现
