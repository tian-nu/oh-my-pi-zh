# 添加一个 provider

一个 provider 由两部分构成：

- **Catalog 部分**（`packages/catalog`）：`CATALOG_PROVIDERS` 表（`packages/catalog/src/provider-models/descriptors.ts`）中的一个条目，携带 `id`、`defaultModel`、运行时模型发现工厂以及 catalog 生成的接线。`KnownProvider`、`PROVIDER_DESCRIPTORS` 和 `DEFAULT_MODEL_PER_PROVIDER` 都从这张表派生。
- **Auth 部分**（`packages/ai`）：registry 中的一个声明式 `ProviderDefinition`，携带 env-key 回退和登录/刷新流程。`OAuthProvider` 联合类型、env-key 映射、`/login` provider 列表、`refreshOAuthToken` / `AuthStorage.login` 分发以及 coding-agent 回调映射都从该 registry 派生。

**范围。** 本文针对复用现有 wire API 的 provider（`openai-completions`、`anthropic-messages`、`google-generative-ai` 等）——这是网关和 API-key provider 的常见情况，因为流分发基于 `model.api` 而非 `model.provider`。添加一种_新的 wire 协议_（新的 `KnownApi`）是另一项任务，还涉及 `stream.ts` 分发、`api-registry.ts` 和 catalog 的 `types.ts`。

## 结构

对于常见情况，一个 provider 就是**一个 catalog 条目 + 一个 def 文件 + 一行 registry 注册**：

1. **在 `CATALOG_PROVIDERS` 中添加条目**：编辑 `packages/catalog/src/provider-models/descriptors.ts`，填入 `id`、`defaultModel`、作为 `envVars` 的普通 API-key 环境变量，以及（通常）一个 `createModelManagerOptions` 工厂。对于简单的 OpenAI 兼容网关，可以在 `packages/catalog/src/provider-models/openai-compat.ts` 中构建工厂，或使用导出的 `createSimpleOpenAICompletionsOptions(providerId, baseUrl, config)` 内联构建。
2. **创建 `packages/ai/src/registry/<id>.ts`**，导出一个
   `export const <camelId>Provider = { … } as const satisfies ProviderDefinition;`
   并包含 auth 字段（`login` 等）。普通环境变量名放在 catalog 条目的 `envVars` 中；只有计算型 resolver（Foundry/ADC/Bedrock 式探测）才设置 `envKeys`。
3. **将其加入 `packages/ai/src/registry/registry.ts` 的 `ALL` 数组**（一条 import + 一个数组条目）。对可登录 provider 而言，`ALL` 的顺序就是 `/login` 列表的顺序。

以下情况只需上述改动即可完成：

- 仅使用 env-key 的 provider，
- 带有简单内联 API-key 登录流程的 provider，
- 大多数 OpenAI 兼容网关。

对于**非平凡的 provider 本地 OAuth 流程**，把实现放在 `packages/ai/src/registry/oauth/<vendor>.ts` 中，并在 def 文件里懒加载它。它所依赖的共享 OAuth 流程基础设施位于同一个 `registry/oauth/` 目录。

descriptor、默认模型映射、env-key 映射、登录列表和刷新分发都会自动更新；`KnownProvider` 联合类型从 catalog 表获得新 id，`OAuthProvider` 从 registry 获得。

## 字段参考

**Catalog 表条目**（`ProviderCatalogEntry`，JSDoc 见
`packages/catalog/src/provider-models/descriptor-types.ts`）：

| 字段                         | 作用                                                                                                                                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                         | 必填。`KnownProvider` 的成员。                                                                                                                                                                                                |
| `defaultModel`               | 必填。未显式选择时使用的首选模型。                                                                                                                                                                                            |
| `envVars`                    | 运行时 API-key 回退（`getEnvApiKey`）使用的环境变量名（按顺序）。                                                                                                                                                             |
| `createModelManagerOptions`  | 运行时模型发现工厂。存在（且非 `specialModelManager`）⇒ 出现在 `PROVIDER_DESCRIPTORS` 中。                                                                                                                                    |
| `allowUnauthenticated`       | 即使没有 key 也会创建 model manager。                                                                                                                                                                                          |
| `dynamicModelsAuthoritative` | 发现成功后替换内置模型。                                                                                                                                                                                                       |
| `catalogDiscovery`           | 用于离线 catalog 生成（`generate-models.ts`）的 `{ label, envVars?, oauthProvider?, allowUnauthenticated? }`。当生成使用不同凭据时（如 `cursor`），此处的 `envVars` 会覆盖条目级列表。                                          |
| `specialModelManager`        | 定制运行时工厂（`google-antigravity` / `google-gemini-cli` / `openai-codex`）；排除在 `PROVIDER_DESCRIPTORS` 之外。                                                                                                            |

**Registry 定义**（`ProviderDefinition`，见
`packages/ai/src/registry/types.ts`）：

| 字段                    | 作用                                                                                                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `name`            | 必填。当定义有可见登录流程时，`name` 显示在 `/login` 列表中。                                                                                                                                              |
| `available`             | 可选的登录列表可用性标志。                                                                                                                                                                                 |
| `showInLoginList`       | 设为 `false` 可让带 `login` 流程的 provider 不出现在交互式列表中。                                                                                                                                        |
| `envKeys`               | `getEnvApiKey` 的计算型环境变量回退，覆盖 catalog 条目的 `envVars`：可以是变量名字符串，或 `() => string \| undefined` resolver。`envVars` 已覆盖时不需设置。                                               |
| `allowsMissingApiKey`   | provider 传输层可以在没有解析出 API-key 字符串的情况下完成认证。                                                                                                                                           |
| `prepareRequest`        | 在通用 API 分发前由 provider 自有的请求整形。返回要分发的模型和流选项。                                                                                                                                    |
| `mapSimpleOptions`      | 将通用简单流选项包投影为 provider 自有选项。                                                                                                                                                                |
| `prepareModelDiscovery` | 运行时模型发现的 provider 自有认证或端点设置。                                                                                                                                                              |
| `login`                 | 交互式登录。存在 ⇒ 成为 `OAuthProvider` 成员，可通过 `AuthStorage.login` 分发，并显示在 `/login` 中（除非 `showInLoginList` 为 false）。返回 API-key `string` 或 `OAuthCredentials`。                       |
| `refreshToken`          | OAuth 刷新器；静态 token provider 可省略（分发原样返回凭据）。                                                                                                                                             |
| `getApiKey`             | 将存储的 OAuth 凭据转换为传输层使用的 API-key/token 字符串。                                                                                                                                                |
| `storeCredentialsAs`    | 将凭据存储到另一个 provider id 下（如 `openai-codex-device` ⇒ `openai-codex`）。                                                                                                                            |
| `callbackPort`          | 存在 ⇒ 成为 auth-broker `CALLBACK_PORTS` 映射的条目。                                                                                                                                                      |
| `pasteCodeFlow`         | OAuth 流程需要粘贴 code/redirect URL ⇒ 成为 `PASTE_CODE_LOGIN_PROVIDERS` 成员。                                                                                                                            |

## 约定

- 使用 `... as const satisfies ProviderDefinition`，以便字面量 `id` 在联合类型派生时得以保留。
- 简单 API-key 或基于验证的流程，其 `login` / `refreshToken` 可直接放在 provider def 文件中（在那里导出命名的 login 函数，方便测试直接导入）。
- 重量级 provider 本地 OAuth 流程的 `login` / `refreshToken` 必须通过动态导入 thunk 访问相邻的 `registry/oauth/*` 模块（`const { loginX } = await import("./oauth/x"); return loginX(cb);`），使这些流程不进入急切启动图。
- 所有 OAuth 代码都位于 `registry/oauth/` 下：共享流程基础设施（`callback-server`、`pkce`、`google-oauth-shared`、`types`、运行时 API `index`）以及每个 provider 的流程，包括被流式和用量层复用的 `github-copilot` / `kimi` / `openai-codex` 辅助函数。非 OAuth 的 API-key 辅助函数（`api-key-login`、`api-key-validation`）与 def 文件一起放在 `registry/` 中，因为它们支撑简单的粘贴 API-key 登录。
- 对于简单的 OpenAI 兼容网关，用导出的 `createSimpleOpenAICompletionsOptions(providerId, baseUrl, config)` 内联构建 manager——无需修改 `openai-compat.ts`。
- `ProviderDefinition` 也可以在运行时由扩展通过 `registerOAuthProvider` 注册（`AuthStorage.login` 分发器通过同一路径处理内置和扩展 provider）。
