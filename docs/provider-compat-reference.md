# Provider compat 参考：OpenAI compat 标志、推理级别与工具处理

`packages/ai` 四个子系统的参考（类型定义在 `packages/catalog`）：

1. [OpenAI compat 标志](#1-openai-compat-flags) — 每个 `compat` 字段及其线上效果
2. [推理级别](#2-reasoning-levels) — effort/thinking 预算如何流转到各 provider
3. [各 provider 的工具处理](#3-tool-handling-per-provider) — schema 转换、流式传输、结果编码
4. [强制工具选择](#4-forced-tool-choice) — `toolChoice` 语义、线上映射、模拟

相关参考：

- [Provider endpoint 约束](./provider-endpoint-constraints.md) — 新约束应放在哪里
- [Provider 流式内部机制](./provider-streaming-internals.md) — 流事件规范化
- [Provider 特殊行为](./provider-quirks.md) — 逐 provider 的特殊处理、流行为、认证/用量、catalog 处理
- [模型与 Provider 配置](./models.md) — `models.yml` 与用户侧 `compat` 覆盖

## 1. OpenAI compat 标志

### 架构

Compat 标志分两个阶段解析：

1. **Catalog 构建时**（`packages/catalog/src/compat/openai.ts`）：`buildOpenAICompat(spec)` / `buildOpenAIResponsesCompat(spec)` 在 `buildModel` 中对每个模型运行一次。默认值从 `provider`、`baseUrl`、模型 id/name 和 `spec.reasoning` 自动检测；显式的 `spec.compat` 覆盖经 `applyCompatOverrides`（`packages/catalog/src/compat/apply.ts`）合并。若存在适用的 `whenThinking` 变体（显式覆盖、直连 DeepSeek reasoning、OpenCode reasoning 网关），一个**完整的备用已解析 compat 对象**会被预构建并附加为 `compat.whenThinking`。
   OpenRouter 是一个伪 API：`buildOpenRouterCompat` 将完整的 chat-completions 视图与仅 Responses 的字段合并为 `ResolvedOpenRouterCompat`，使同一模型对象同时满足两个运行时处理器（`PI_OPENROUTER_RESPONSES` 决定分发方式）。
2. **请求时**（`packages/ai/src/providers/openai-shared.ts`）：`resolveOpenAICompatPolicy(model, options)` 将已解析的 compat 与逐请求选项（`reasoning`、`disableReasoning`、`toolChoice` 等）组合为带 `reasoning`、`tools`、`messages` 和 `stream` 子策略的 `OpenAICompatPolicy`。当 thinking 激活且 `whenThinking` 存在时，策略**指针切换**到预构建的变体——不做逐请求展开或分配：

   ```ts
   const compat = enabled && baseCompat.whenThinking ? baseCompat.whenThinking : baseCompat;
   ```

消费者：`openai-completions.ts` 中的 `applyChatCompletionsCompatPolicy` + `buildParams`、`openai-responses.ts` 中的 `buildResponsesInput`、`transform-messages.ts` 中的消息变换、`stream.ts` 中的流看门狗。

`packages/catalog/src/types.ts` 中声明的每个标志都在 `packages/ai` 的某处被消费；没有死标志。

### 共享标志（chat-completions + responses）

类型：`packages/catalog/src/types.ts` 中的 `OpenAICompat` / `ResolvedOpenAISharedCompat`。

"共享"指该字段在两个已解析视图上都存在且线上契约相同——**不代表**两个构建器检测出相同默认值。`buildOpenAICompat` 与 `buildOpenAIResponsesCompat` 各自计算自己的默认值；下表在两者有分歧处以 *Chat:* / *Responses:* 标注（单一检测 = 两个表面上相同）。

#### 消息整形

| 标志 | 默认检测 | 线上效果 |
| --- | --- | --- |
| `supportsDeveloperRole` | Chat：官方 OpenAI、Azure。Responses：另含 GitHub Copilot | 系统 prompt 以 `developer` 角色而非 `system` 发送 |
| `requiresToolResultName` | Chat：Mistral 为 `true`。Responses：始终 `false` | 在 `role: "tool"` 消息上添加 `name: <toolName>` |
| `requiresAssistantAfterToolResult` | Chat：Mistral 为 `true`。Responses：始终 `false` | 在工具结果与随后的用户消息之间插入一条合成的 assistant 消息（严格角色交替） |
| `requiresThinkingAsText` | Chat：Mistral 为 `true`。Responses：始终 `false` | 将 assistant thinking 以 `<thinking>...</thinking>` 文本重放，而非原生 reasoning 字段（`transform-messages.ts`） |
| `requiresMistralToolIds` | Chat：Mistral 为 `true`。Responses：始终 `false` | 工具调用 id 规范化为恰好 9 个字母数字字符（`normalizeMistralToolId`） |
| `requiresAssistantContentForToolCalls` | Chat：Kimi、直连 DeepSeek reasoning。Responses：仅 Kimi | 工具调用回合上空的 assistant 内容变为 `"."`，以避免 HTTP 400 |
| `usesOpenAIToolCallIdLimit` | 官方 OpenAI 为 `true` | 工具调用 id 截断到 40 字符 |

#### 推理线上格式

| 标志 | 默认检测 | 线上效果 |
| --- | --- | --- |
| `supportsReasoningEffort` | Chat：Grok、Xiaomi MiMo、部分 Z.AI/Zhipu 为 `false`。Responses：仅 `xai-oauth` 上不支持 effort 的 Grok 为 `false` | 控制 `reasoning_effort` 的发送 |
| `omitReasoningEffort` | 当 `supportsReasoningEffort` 为 `false` 时为 `true` | 即使 thinking 开启也抑制 `reasoning_effort`（thinking 开关字段仍会发出） |
| `reasoningEffortMap` | Chat：Kimi K3（`KIMI_K3_REASONING_EFFORT_MAP`）、MiMo；否则 `{}`。Responses：始终 `{}` | 将 `Effort` 值重映射为 provider 字符串（如 `minimal` → `low`） |
| `thinkingFormat` | Chat：`"zai"`（Kimi K2.x/Z.AI/Zhipu/MiMo）、`"qwen"`（DashScope）、`"qwen-chat-template"`（NVIDIA NIM 上的 Qwen）、`"openrouter"`、默认 `"openai"`（含 Venice/Fireworks Qwen）。Responses：仅 `"openrouter"` 或 `"openai"` | 选择 thinking 启用的编码方式：`thinking: { type: "enabled" }`（zai）、`enable_thinking: true`（qwen）、`chat_template_kwargs: { enable_thinking: true }`（qwen-chat-template）、`reasoning: { effort }`（openrouter）、普通 `reasoning_effort`（openai） |
| `reasoningDisableMode` | 由 `thinkingFormat` 派生，可被宿主覆盖 | 推理显式关闭时发送什么：`venice-disable-thinking` → `venice_parameters.disable_thinking: true`、`zai-thinking-disabled` → `thinking: { type: "disabled" }`、`qwen-enable-thinking-false` → `enable_thinking: false`、`qwen-template-false` → `chat_template_kwargs.enable_thinking: false`、`openrouter-enabled-false` → `reasoning: { enabled: false }`、`lowest-effort`，或 `omit`（`encodeChatCompletionsDisabledReasoning`） |
| `supportsReasoningParams` | Chat：GitHub Copilot 为 `false`。Responses：始终 `true` | 为 `false` 时抑制**所有**推理参数 |
| `reasoningContentField` | 默认 `"reasoning_content"`；备选 `"reasoning"`、`"reasoning_text"` | 在历史消息上重放 assistant thinking 时使用的键 |
| `requiresReasoningContentForToolCalls` | Chat：Kimi（OpenCode 别名除外）、DeepSeek reasoning、MiMo、OpenRouter reasoning 请求。Responses：Kimi/DeepSeek/OpenRouter，仅限支持推理时 | 历史中的 assistant 工具调用回合必须携带 reasoning 内容（真实的或合成的） |
| `requiresReasoningContentForAllAssistantTurns` | 直连 DeepSeek reasoning、MiMo | 将上述要求扩展到每个 assistant 回合 |
| `allowsSyntheticReasoningContentForToolCalls` | Chat：DeepSeek reasoning 系列和 MiMo 为 `false`。Responses：DeepSeek reasoning 为 `false` | 为 `true` 时，`"."` 占位可替代被剥离的 reasoning；为 `false` 时只重放真实内容 |
| `replayReasoningContent` | Chat：本地后端（llama.cpp、LM Studio、vLLM、Ollama、回环/私有 baseUrl）为 `true`。Responses：始终 `false`（reasoning 改为经加密条目重放） | 在每个 assistant 回合上把保留的 thinking 重放为 `reasoning_content`，让本地 chat 模板能重建 `<think>` 块并保持前缀 KV-cache 命中 |
| `qwenPreserveThinking` | Chat：带 `replayReasoningContent` 的本地后端上的 Qwen thinking 格式。Responses：始终 `false`（该模板开关仅属 chat-completions） | 发送 `preserve_thinking: true`（顶层和/或 `chat_template_kwargs` 内），让 Qwen 3.6+ 模板为更早的回合也渲染 `<think>`——一个历史开关，而非逐回合开关（`applyChatCompletionsCompatPolicy`） |
| `kimiApiFormat` | 逐模型的协议元数据 | Kimi Code 模型的 `"openai"` 与 `"anthropic"` 传输（`providers/kimi.ts`） |
| `includeEncryptedReasoning` | Chat：始终 `true`。Responses：`xai-oauth` 为 `false` | Responses 请求是否重放加密 reasoning 条目 |
| `filterReasoningHistory` | Chat：OpenRouter Anthropic 模型。Responses：另含 `xai-oauth` | 从重放的 Responses 历史中过滤原生 reasoning 条目 |

#### 工具选择 / strict 交互

| 标志 | 默认检测 | 线上效果 |
| --- | --- | --- |
| `supportsToolChoice` | Chat：直连 DeepSeek reasoning 为 `false`。Responses：始终 `true` | 为 `false` 时完全省略 `tool_choice` |
| `supportsForcedToolChoice` | Chat：强制 thinking 模型和 OpenCode DeepSeek reasoning 为 `false`。Responses：始终 `true` | 为 `false` 时 `required`/具名选择降级为 `auto` |
| `supportsNamedToolChoice` | 仅支持字符串的宿主（llama.cpp、LM Studio）为 `false` | 为 `false` 时，具名选择变为：把 `tools` 过滤到那一个函数 + `tool_choice: "required"` |
| `disableReasoningOnForcedToolChoice` | Chat：Kimi（原生 K3 除外）或 Anthropic 模型 id。Responses：所有 Kimi | 强制工具选择时丢弃 reasoning 字段 |
| `disableReasoningOnToolChoice` | DeepSeek reasoning（经 OpenRouter 除外） | 存在**任何** `tool_choice` 时丢弃 reasoning 字段 |
| `supportsStrictMode` | OpenAI、OpenRouter、Cerebras、Together、Copilot、Zenmux、Azure、DeepSeek 为 `true` | 为 `false` 时从不在工具定义上设置 `strict: true` |
| `toolSchemaFlavor` | Kimi/Moonshot 为 `"moonshot-mfjs"`，本地后端为 `"grammar"` | 额外的 schema 规范化：`normalizeSchemaForMoonshot` 或 `sanitizeSchemaForGrammar`（`utils/schema/normalize.ts`） |

#### 采样、token、缓存、路由

| 标志 | 默认检测 | 线上效果 |
| --- | --- | --- |
| `supportsSamplingParams` | o1/o3/gpt-5+ 级模型为 `false` | 为 `false` 时省略 `temperature`/`top_p`/惩罚项（它们会 400） |
| `alwaysSendMaxTokens` | Kimi 系列 | 始终发送最大输出 token 字段（默认模型最大值），保持 Kimi TPM 计量正确 |
| `openRouterRouting` | 未设置 | 在 OpenRouter 上添加 `provider: { only, order }` 请求体字段（`applyOpenAIGatewayRouting`） |
| `promptCacheSessionHeader` | Chat：Grok（`xai`）为 `"x-grok-conv-id"`。Responses：同一 header，用于 `xai-oauth` | 以 prompt-cache 会话键发出该 HTTP header |
| `supportsPromptCacheBreakpoints` / `promptCacheBreakpointTtl` | 官方 OpenAI GPT-5.6+ | 控制显式 prompt-cache 断点；请求不支持时抛 `ConfigurationError`。TTL 默认 `"30m"` |
| `isOpenRouterHost` | OpenRouter 宿主检测（两个构建器） | 省略默认 max-token 上限（可选字段在 OpenRouter 上是路由提示）并附加路由 |
| `wireModelIdMode` | Chat：`"firepass"` / `"fireworks"` / `"openrouter"` / `"raw"`。Responses：`"openrouter"` 或 `"raw"` | 用于网关分发的模型 id 重写 |

#### 流解析 / 看门狗

| 标志 | 默认检测 | 线上/流效果 |
| --- | --- | --- |
| `reasoningDeltasMayBeCumulative` | MiniMax 宿主 | 流解析器将 reasoning 增量视为累计快照而非增量 |
| `stripDeepseekSpecialTokens` | NVIDIA NIM 或直连 API 上的 DeepSeek | 从可见文本中剥离泄漏的 chat-template 令牌（`<｜User｜>` 等） |
| `streamMarkupHealingPattern` | `"kimi"`（Kimi/Moonshot）、`"dsml"`（DeepSeek DSML 宿主）、`"thinking"`（通用 compat 宿主）、官方 OpenAI 未设置 | 为泄漏的模板标记选择 `StreamMarkupHealing` 模式 |
| `emptyLengthFinishIsContextError` | Ollama | 带有 `finish_reason: "length"` 的空补全 → 上下文溢出错误 |
| `streamFirstEventTimeoutMs` | 本地后端为 `0` | 首事件看门狗提示（`0` = prefill/模型加载不限时） |
| `streamIdleTimeoutMs` | GLM/Alibaba coding plans 600 秒；MiMo、Kimi reasoning、DeepSeek reasoning、本地后端 300 秒 | 事件间空闲看门狗下限（`stream.ts`） |

### 仅 chat-completions 的标志（`ResolvedOpenAICompat`）

| 标志 | 默认检测 | 线上效果 |
| --- | --- | --- |
| `supportsStore` | 标准 OpenAI 形态的宿主为 `true`，非标准的为 `false`（Cerebras、Grok、Mistral、Fireworks、Z.AI 等） | 为 `true` 时发送 `store: false`（选择退出保留）；为 `false` 时省略该字段，因为宿主会拒绝 |
| `supportsMultipleSystemMessages` | 仅规范宿主白名单（OpenAI、Azure、OpenRouter、Cerebras、Together、Fireworks、Groq、DeepSeek、Mistral、Grok、Z.AI、Zhipu、Copilot、Zenmux）为 `true`，且对 MiniMax/Alibaba/Qwen 宿主从不为 true；其余全部为 `false`（openai.ts `supportsMultipleSystemMessagesDefault`） | 为 `false` 时，前导系统消息合并为一条（以 `\n\n` 连接）；为 `true` 时保持分离以复用 KV-cache |
| `supportsUsageInStreaming` | Cerebras 为 `false` | 添加 `stream_options: { include_usage: true }` |
| `maxTokensField` | Mistral、原生 Moonshot、Z.AI、Zhipu、Chutes、Fireworks、直连 DeepSeek 为 `"max_tokens"`；否则 `"max_completion_tokens"` | 输出 token 字段名（`resolveOpenAIOutputTokenParam`） |
| `thinkingKeep` | Kimi K2.6 为 `"all"` | 添加 `thinking.keep: "all"` |
| `cacheControlFormat` | OpenRouter `anthropic/*` 模型为 `"anthropic"` | 向消息部分添加 Anthropic `cache_control: { type: "ephemeral" }` 标记（`maybeAddAnthropicCacheControl`） |
| `toolStrictMode` | Cerebras 为 `"all_strict"`；默认 `"mixed"` | `all_strict` 对所有工具强制 `strict: true`，`none` 省略它，`mixed` 尊重逐工具 `strict` |
| `vercelGatewayRouting` / `isVercelGatewayHost` | Vercel AI Gateway 宿主（也存在于 Responses 视图上） | 在 `providerOptions.gateway` 下的路由 |
| `dropThinkingWhenReasoningEffort` | Fireworks | 当 `reasoning_effort` 存在时删除 `thinking` 块（Fireworks 拒绝两者同时出现） |
| `extraBody` | 未设置（由 DeepSeek reasoning 策略使用） | 合并进请求体的任意 JSON（`applyOpenAIExtraBody`） |
| `whenThinking` | OpenCode 网关、直连 DeepSeek reasoning、显式覆盖 | 预构建的完整备用 `ResolvedOpenAICompat`，thinking 激活时指针切换（仅 chat-completions 视图；OpenRouter 的合并 compat 继承它） |

### 仅 Responses 的标志（`ResolvedOpenAIResponsesCompat`）

| 标志 | 默认检测 | 线上效果 |
| --- | --- | --- |
| `supportsLongPromptCacheRetention` | 官方 OpenAI | 请求时发送 `prompt_cache_retention: "24h"` |
| `strictResponsesPairing` | Azure OpenAI、Copilot Responses | 构建 Responses 输入条目时强制严格的 1:1 工具调用/工具结果配对 |
| `supportsImageDetailOriginal` | Copilot、xai-oauth 为 `false` | 输入图像用 `detail: "original"` 还是 `detail: "auto"`（对 `original` 返回 400 的宿主使用 `auto`） |
| `supportsObfuscationOptOut` | 官方 OpenAI | 允许 `stream_options: { include_obfuscation: false }` |

## 2. 推理级别

### Effort 模型

规范的强度刻度是 `Effort` 枚举（`packages/catalog/src/effort.ts`）：`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。

逐模型能力存放在 `ThinkingConfig`（`packages/catalog/src/types.ts`），由 `resolveModelThinking`（`packages/catalog/src/model-thinking.ts`）在模型构建时解析一次：

- `mode` — 传输机制：`effort`（OpenAI 风格）、`budget`（token 预算）、`google-level`（枚举级别）、`anthropic-adaptive`、`anthropic-budget-effort`
- `efforts` — 规范顺序下支持的级别
- `effortMap` — 固化的到上游线字符串的重映射（如在没有 xhigh 的模型上 `xhigh` → `high`）
- `effortRouting` — effort（或 `"off"`）→ 动态模型 id 变体（`resolveWireModelId` 选择线上 id）
- `effortBudgets` — 为折叠的 effort 档位预计算的 token 预算
- `requiresEffort` — thinking 不可禁用
- `suppressWhenOff` — "off" 必须在线上显式发送（`includeThoughts: false` / `thinkingBudget: 0`），而非仅省略

运行时 helper：`clampThinkingLevelForModel`（把请求的 effort 钳制到模型支持的范围）、`mapEffortToGoogleThinkingLevel`、`mapEffortToAnthropicAdaptiveEffort`。

### 逐 provider 的线上映射

| Provider | 模式 | 线上编码 |
| --- | --- | --- |
| Anthropic（`providers/anthropic.ts`） | `anthropic-adaptive` 或 `budget` | Adaptive：`thinking: { type: "adaptive" }` + `output_config.effort: low…max`（需要 beta `effort-2025-11-24`）；Budget：`thinking: { type: "enabled", budget_tokens: N }`。交错 thinking 经 beta `interleaved-thinking-2025-05-14`。`ensureMaxTokensForThinking` 把 `max_tokens` 提升到至少 `budget_tokens + 1024` |
| OpenAI Responses（`providers/openai-responses.ts`） | `effort` | `reasoning: { effort }` 加上 `reasoning.summary: "auto" \| "detailed" \| "concise" \| null` |
| OpenAI Chat Completions（`providers/openai-completions.ts`） | `effort` | 默认 `reasoning_effort`；实际开关字段取决于 `thinkingFormat`（见[标志表](#reasoning-wire-format)） |
| Google Gemini / Vertex（`providers/google-shared.ts`） | `google-level` 或 `budget` | `thinkingConfig: { includeThoughts, thinkingLevel: MINIMAL…HIGH, thinkingBudget: N }` |

### OpenAI-compat 解析流水线

`resolveOpenAICompatPolicy`（`providers/openai-shared.ts`）逐请求决定：

1. **启用/禁用** — 请求的 effort 与模型推理支持的对比，再减去抑制规则（`disableReasoningOnForcedToolChoice`、`disableReasoningOnToolChoice`、`none`-effort 处理）。
2. **`whenThinking` 切换** — 启用且变体存在 → 活动 compat 变为预构建的变体。
3. **线上 effort** — 请求的 `Effort` 经 `compat.reasoningEffortMap` / `model.thinking.effortMap` 映射；`omitReasoningEffort` 抑制该字段但保留 thinking 开关。
4. **禁用编码** — 当推理关闭但线路需要显式关闭信号时，`encodeChatCompletionsDisabledReasoning` 按 `reasoningDisableMode` 发出格式。

若宿主对发出的 effort 返回 400/422，`resolveOpenAIReasoningEffortFallback`（`providers/openai-reasoning-fallback.ts`）解析错误文本以提取可接受的值或丢弃该参数，然后重试。

### 从流中取回 thinking

- **结构化增量**：provider 发出 `thinking_start` / `thinking_delta` / `thinking_end` 流事件。
- **历史重放**：先前的 thinking 经 assistant 消息上的 `reasoningContentField` 重放（DeepSeek/Z.AI/Qwen/本地后端上的 KV-cache 保全）；要求在工具调用回合携带 reasoning 内容的模型按 `allowsSyntheticReasoningContentForToolCalls` 获得真实内容或 `"."` 占位。
- **泄漏 thinking 修复**：`wrapLeakedThinkingStream`（`utils/leaked-thinking-stream.ts`）将行为异常宿主泄漏到带宽内的 ` ```thinking ` / `<think>` 围栏实时转换为结构化 thinking 块。
- **循环守卫**：`withThinkingLoopGuard`（`utils/thinking-loop.ts`）检测失控推理（逐字重复、近重复 trigram 簇、进度词汇停滞）并以可重试的 `AIError.Flag.ThinkingLoop` 终止流。

### 交互

- **采样钳制**：推理激活的模型（Opus 4.7+、Fable/Mythos 5、o 系列/GPT-5）拒绝显式 `temperature`/`top_p`；`anthropic.ts` 与 compat 策略（`supportsSamplingParams`）会抑制它们。
- **强制工具选择**：见 [§4](#edge-cases)；若干 provider 在工具调用被强制时必须丢弃 thinking。

## 3. 各 provider 的工具处理

所有 provider 都从同一个中立线上 schema 出发——`toolWireSchema(tool)`（`utils/schema/wire.ts`）——并在规范化、流式形态和结果编码上分化。

### Anthropic（`providers/anthropic.ts`）

- **Schema**：`buildAnthropicToolSchemaPlans` 逐工具决定严格性：白名单（`ANTHROPIC_STRICT_TOOL_ALLOWLIST`）、无不兼容关键字（`oneOf`/`allOf`/`$ref`/`patternProperties`/`propertyNames`）、预算上限（`MAX_ANTHROPIC_STRICT_TOOLS`、可选/union 参数限制）。严格 schema 经 `normalizeAnthropicStrictSchema` 处理（`additionalProperties: false`）；开放映射保持非严格以保留映射语义。线上：`{ name, description, input_schema, eager_input_streaming?, strict? }`。
- **流式**：`content_block_start`（`tool_use`，携带 `id`+`name`）→ `input_json_delta` 片段 → 在 `content_block_stop` 时经 `parseStreamingJson` 解析。信封异常被记录（`reportAnthropicEnvelopeAnomaly`）而非致命。
- **结果**：带 `tool_result` 块的 `user` 消息（`tool_use_id`）。图像嵌入在 `tool_result.content` 内；**错误**结果上 Anthropic 拒绝嵌入图像，因此文本留在块中而图像提升到 `tool_result` 运行之后。Z.AI 的 Anthropic 形态端点还需要块上的 `id`（`requiresToolResultId`）。
- **重放特性**：assistant 回合被稳定分区为 `[...non_tool_use, ...tool_use]`，使 `tool_use` 块位于尾部——否则 Anthropic 会 400 报 "tool_use ids were found without tool_result blocks immediately after"。
- **严格回退**：一次 400 严格拒绝会设置 `providerSessionState.strictToolsDisabled` 并以无 `strict` 方式重试。

### OpenAI Chat Completions（`providers/openai-completions.ts`）

- **Schema**：`convertTools` + `adaptSchemaForStrict`；严格性来自 `toolStrictMode`（`all_strict` / `mixed` / `none`），受 `supportsStrictMode` 与逐工具 `strict` 控制。Moonshot 宿主额外执行 MFJS 子集检查。线上：`{ type: "function", function: { name, description, parameters, strict? } }`。
- **流式**：`choice.delta.tool_calls`（`index`、`id`、`function.name`、`function.arguments` 片段）。MiniMax 以原始 JSON **对象**而非字符串流式传输参数——两种形态都会被合并（`mergeStreamingArgumentObjects`）。泄漏的 DeepSeek 模板令牌按 `stripDeepseekSpecialTokens` 剥离。当看到结构化调用时，`finish_reason: "stop"` 被提升为 `"tool_calls"`。
- **结果**：`{ role: "tool", tool_call_id, content }`；Mistral id 被规范化；assistant 重放设置 `tool_calls` 数组和内容 `""`（在 `requiresAssistantContentForToolCalls` 下为 `"."`）。非视觉模型经 `partitionVisionContent` 获得图像占位。

### OpenAI Responses（`providers/openai-responses.ts`）

- **Schema**：`sanitizeSchemaForOpenAIResponses` + `adaptSchemaForStrict`。支持函数工具、自由格式**custom 工具**与原生**computer 工具**（`model.supportsComputerUse`）。线上：扁平 `{ type: "function", name, description, parameters, strict? }`。
- **流式**：`response.output_item.added` → `response.function_call_arguments.delta` / `response.custom_tool_call_input.delta` → `response.output_item.done`。工具调用 id 是复合的 `callId|itemId`（`normalizeResponsesToolCallId`）。
- **结果**：`function_call_output` 与 `custom_tool_call_output` 条目按 `call_id`（复合值的 `callId` 半边）与调用配对。它们的 `output` 是字符串或规范 `input_text` 与 `input_image` 块的数组。具备视觉能力的模型把工具结果图像保留在该数组内而非创建合成用户消息；无图像输入的模型收到文本占位。认证网关解析也接受旧版 `output_text`、`text` 和 `refusal` 块，把内联 data-image URL 解码为图像内容，并保留远程图像 URL 或 OpenAI 图像文件 ID 作为引用。文件 ID 需要兼容 Responses 的上游，因为其他 provider 传输无法解析它们。`input_file` 对请求消息仍受支持，但在工具输出中被拒绝，直到规范工具结果能无损重放其字节与引用。有状态的 `previous_response_id` 链式调用可跨回合工作。

### Google Gemini / Vertex（`providers/google-shared.ts`、`google.ts`）

- **Schema**：函数包装在 `{ functionDeclarations }` 内。Gemini API/Vertex 使用 `parametersJsonSchema: normalizeSchemaForGoogle(...)`（剥离 `$schema`、`additionalProperties`，把类型数组转换为可空）；Cloud Code Assist / Antigravity / Gemini CLI 使用 `parameters: normalizeSchemaForCCA(...)`。
- **流式**：`part.functionCall` 携带 `name` 和完整的 `args` **对象**到达（无参数片段流式）。Google 省略调用 id → 经 `nextToolCallId(name)` 合成。
- **Vertex 特性**：Vertex `GenerateContent` **拒绝** `functionCall`/`functionResponse` 部分上的 `id`；当 `model.provider === "google-vertex"` 时它们被删除。
- **结果**：带 `functionResponse` 部分的 `user` 消息。所有并行响应必须合并为**单条连续**的 `user` 消息，否则 Google 报错 "number of function response parts is not equal to number of function call parts"。图像：Gemini 3+ 支持多模态 `functionResponse.parts`；更旧的 Gemini 会缓冲图像（`pendingToolImageParts`）并在响应后作为单独的 user 回合刷出。

### Amazon Bedrock（`providers/amazon-bedrock.ts`）

- **Schema**：`convertToolSpec` → `{ toolSpec: { name, description, inputSchema: { json } } }`。
- **流式**：`start.toolUse`（`toolUseId`、`name`）然后 `delta.toolUse.input` 片段。
- **结果**：所有连续工具结果分入一条带 `toolResult` 数组的 `user` 消息（Converse API 要求）；图像嵌入在 `content` 数组内。
- **哨兵特性**：Converse 校验任何历史含 `toolUse`/`toolResult` 的请求必须提供 `toolConfig`。当没有活动工具（或 `toolChoice: "none"`）时，`planToolConfig` 注入 `NO_TOOLS_SENTINEL`（`__no_tools__`，"do not call" 描述）配 `toolChoice: { auto: {} }`；对哨兵的调用会从流中丢弃（`sentinelInjected` 检查）。

### 差异总结

| | Anthropic | OpenAI Completions | OpenAI Responses | Google | Bedrock |
| --- | --- | --- | --- | --- | --- |
| Schema 规范化器 | 严格白名单 + 预算 | `adaptSchemaForStrict` | `sanitizeSchemaForOpenAIResponses` | `normalizeSchemaForGoogle` / CCA | 原始 JSON schema |
| 参数流式 | JSON 字符串片段 | JSON 字符串片段（MiniMax：对象） | JSON 字符串片段 | 完整对象，无片段 | JSON 字符串片段 |
| 调用 id | 原生 | 原生（+Mistral 9 字符、OpenAI 40 字符规则） | 复合 `callId\|itemId` | 合成；Vertex 剥离 | 原生 |
| 结果编码 | `user` + `tool_result` 块 | `role: "tool"` 消息 | function/custom 输出条目 | `user` + `functionResponse` 部分，单条消息 | `user` + 分组的 `toolResult` 数组 |
| 结果中的图像 | 嵌入；错误时提升 | 占位分区 | 在输出数组内；无图像输入时占位 | Gemini 3+ 嵌入，否则尾随 user 回合 | 嵌入 |
| 并行调用 | 原生 | 原生 | 原生 | 原生 | 原生 |

### 严格工具生命周期

`OpenAIStrictToolsState`（`providers/openai-shared.ts`）按 `${provider}:${baseUrl}:${modelId}` 作用域跟踪 strict 模式失败：一次 400 严格 schema 拒绝调用 `disableStrictToolsForScope`，而 `isStrictToolsDisabledForScope` 使该作用域的后续请求全部以非严格方式运行——一次重试，然后记住，不再逐回合支付 400 代价。Anthropic 有对应的逐会话 `strictToolsDisabled` 标志。

### 基于文本的工具调用方言（`src/dialect/`）

用于原生工具 API 不可用时，或历史必须为另一个模型家族重新编码时：

1. **带宽内工具调用**：`renderInbandToolPrompt(tools, dialect)` 把工具清单注入 prompt；`InbandScanner` / `wrapInbandToolStream` 把流式文本解析回结构化工具调用。方言：`harmony`、`gemini`、`qwen3`、`deepseek`、`kimi`、`glm`、`gemma`、`hermes`、`minimax`、`xml`、`anthropic`。
2. **跨模型历史重放**：会话中途切换模型会把先前的 thinking/工具回合按目标的 `preferredDialect(modelId)` 重新渲染（`renderDemotedThinking`、`encodeInbandToolHistory`）。
3. **Harmony**（`dialect/harmony.ts`）：GPT-5/Codex 控制令牌（`<|start|>`、`<|call|>`、`<|channel|>`、`<|return|>`）；经非 Harmony 端点重放时 `utils/harmony-leak.ts` 会转义它们。
4. **修复**：`StreamMarkupHealing`（`utils/stream-markup-healing.ts`）使用相同的扫描器从托管模型泄漏到可见文本中的标记重建工具调用和 thinking。

### 边界防护

- **`utils/tool-call-loop-guard.ts`**：`ToolCallLoopGuard` 规范化参数（键排序、剥离 `intent`）、哈希 `${name}:${canonicalArgs}`，在重复相同调用时返回 `RepeatedToolCallDetection` 用于引导模型跳出循环。
- **`utils/deterministic-id.ts`**：`deterministicUuid(seed)`（SHA-256 → UUID 形态）在 provider 省略或损坏线上 id 时支撑 `ensureToolCallId`（Google、Bedrock、退化补全）。
- **`providers/transform-messages.ts`**：共享的预检阶段——工具调用去重、清洗、id 规范化——在 provider 特定转换之前。

## 4. 强制工具选择

### 统一的 `ToolChoice`（`src/types.ts`）

```ts
type ToolChoice =
  | "auto" | "none" | "any" | "required"
  | { type: "function"; name: string }
  | { type: "function"; function: { name: string } }
  | { type: "tool"; name: string }
  | { type: "computer" };
```

- `auto` — 模型自行决定（有工具时的默认值）
- `none` — 本回合不调用工具
- `required` / `any` — 至少一次工具调用（OpenAI 与 Anthropic 的拼写；可互换）
- 具名固定 — 精确调用该工具
- `{ type: "computer" }` — 分发到原生 computer-use 工具

`toolChoice` 在 `packages/ai` 内**逐请求一次性生效**——无粘性；调用方每回合决定。

### 映射工具（`src/utils/tool-choice.ts`）

| 导出 | 语义 |
| --- | --- |
| `isForcedToolChoice(choice)` | 除 `undefined`/`"auto"`/`"none"` 外都为 `true`——即 `required`、`any` 与所有固定。任何 provider 需要对强制作出反应之处都会使用 |
| `mapToOpenAICompletionsToolChoice` | → `"auto" \| "none" \| "required" \| { type: "function", function: { name } }`（`any` → `required`，嵌套 name 形态） |
| `mapToOpenAIResponsesToolChoice` | → 相同字符串外加**扁平** `{ type: "function", name }`、`{ type: "custom", name }`、`{ type: "computer" }` 透传 |
| `mapToAnthropicToolChoice` | → `"auto" \| "none" \| "any" \| { type: "tool", name }`（`required` → `any`） |

### 逐 provider 的线上映射

| Provider | 线上字段 | 值 | 降级 / 防护 |
| --- | --- | --- | --- |
| OpenAI Completions | `tool_choice` | 字符串 + 嵌套 function 对象 | `!supportsNamedToolChoice` → 过滤工具 + `"required"`；`!supportsForcedToolChoice` → `"auto"`；强制工具不在 `tools` 中 → 删除 `tool_choice`；无工具时 `"none"` → 丢弃（LiteLLM/Bedrock 代理会 400） |
| OpenAI Responses | `tool_choice` | 字符串 + 扁平 function/custom/computer 对象 | 同样的具名/强制降级；选择会对照**在 schema 隔离后幸存**的工具校验——对被丢弃工具的固定会被删除；无原生 computer use 的模型上 `{ type: "computer" }` 重映射为 function 工具名（`azure-openai-responses.ts` 同） |
| Anthropic | `tool_choice` | `{ type: "auto" \| "none" \| "any" \| "tool", name? }` | 名字经 `encodeAnthropicToolName`；`!supportsForcedToolChoice`（Fable/Mythos）→ `auto` |
| Google Gemini/Vertex | `toolConfig.functionCallingConfig` | `mode: AUTO \| NONE \| ANY`（固定时加 `allowedFunctionNames`） | Antigravity/Gemini CLI 默认 `mode: VALIDATED`（`google-gemini-cli.ts`） |
| Bedrock | `toolConfig.toolChoice` | `{ auto: {} } \| { any: {} } \| { tool: { name } }` | `planToolConfig`；`"none"` + 工具历史 + 无工具 → `NO_TOOLS_SENTINEL` 配 `{ auto: {} }` |
| Ollama | `tool_choice` | 仅 `"none"` / `"required"` | 固定由 `selectToolsForToolChoice` 模拟：过滤工具到目标，发送 `"required"` |

### 模拟与回退路径

1. **仅字符串的宿主**（`supportsNamedToolChoice: false` — LM Studio、llama.cpp、Ollama）：对象固定被宿主拒绝，所以 provider 只**通告被固定的工具**并发送 `tool_choice: "required"`——只提供一个工具时，`required` 等价于固定。
2. **Bedrock 哨兵**：见 [§3](#amazon-bedrock-providersamazon-bedrockts)。
3. **Computer 固定回退**：无原生支持时 `{ type: "computer" }` 降级为具名 function 固定。
4. **过期固定修剪**：强制工具不在最终工具列表中（活动工具过滤、schema 隔离）时，静默丢弃 `tool_choice` 而非发出无效请求。

### 与推理的交互

若干后端拒绝 thinking 与强制工具选择同时出现：

- **Anthropic**：`disableThinkingIfToolChoiceForced` 删除 `params.thinking`；仅自适应模型固定 `output_config.effort = "low"` 以免默认自适应 thinking 重新生效。
- **Bedrock**：强制 `any`/`tool` 清空 `additionalModelRequestFields`（thinking 配置所在处）。
- **OpenAI compat**：`resolveOpenAICompatPolicy` 尊重 `disableReasoningOnForcedToolChoice` / `disableReasoningOnToolChoice`。例外：Kimi K3 在强制 `"required"` 时保留推理 effort（`openai-completions.ts` 中的 `hasActiveNativeKimiK3Reasoning`）。

### Agent 循环如何驱动它（`packages/agent`）

- **逐回合解析**：`agent-loop.ts` 在每个回合开始时解析 `config.getToolChoice()`：
  ```ts
  const effectiveToolChoice = ownedDialect ? undefined : (hostToolChoice ?? forcedToolChoice ?? config.toolChoice);
  ```
  当自有带宽内方言激活时，原生工具被剥离，因此 `tool_choice` 必须为 `undefined`（没有原生 `tools` 的原生 `tool_choice` 会 400）。
- **软需求**（`SoftToolRequirement`、`packages/agent/src/types.ts`）：每回合强制 `tool_choice` 会搅动 provider prompt cache。软需求（`{ soft: true, toolName, reminder }`）先注入提醒文本且 `toolChoice` 保持 auto；只有当模型未能调用 `toolName` 时，下一回合才升级为单回合的硬 `{ type: "tool", name }`。
- **活动工具刷新**：`refreshToolChoiceForActiveTools`（`packages/agent/src/agent.ts`）丢弃其工具已不在活动集合中的排队强制选择。
- **Compaction/handoff**：以 `toolChoice: "none"` 运行，在强制纯文本输出的同时保持 prompt-cache 前缀；auto-only 400 会以 `"auto"` 重试一次（`packages/agent/src/compaction/compaction.ts`）。
