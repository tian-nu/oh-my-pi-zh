# Provider 特殊行为：特殊处理、流、认证与 catalog 处理

针对 `packages/ai` 各传输层的逐 provider 深度解析：每个 provider 在共享流水线之外做了哪些特殊处理、
其流与普通 SSE/delta 模型有何差异、如何认证并跟踪用量/配额，以及 `packages/catalog` 对其
模型做了哪些特殊处理（描述符、发现、身份、thinking 元数据、定价）。

相关参考：

- [Provider compat 参考](./provider-compat-reference.md) — compat 标志、推理级别、工具处理、强制工具选择
- [Provider endpoint 约束](./provider-endpoint-constraints.md) — 新约束应放在哪里
- [Provider 流式内部机制](./provider-streaming-internals.md) — 流事件规范化
- [Providers](./providers.md) — 可用性、凭据、登录流程


## OpenAI Chat Completions
OpenAI Chat Completions provider 基于 Server-Sent Events（SSE）实现标准 OpenAI `/chat/completions` 线上契约（`ChatCompletionCreateParamsStreaming` 请求 schema 与 `ChatCompletionChunk` 事件载荷）之上的 HTTP POST JSON 流式传输。它是 OpenAI 模型以及数十个 OpenAI 兼容网关和第三方 provider（包括 Groq、Cerebras、Mistral、DeepSeek、Fireworks、Zhipu (Z.AI)、Qwen (DashScope)、Kimi (Moonshot)、Synthetic、GitLab Duo、OpenRouter、Vercel AI Gateway、CoreWeave、HuggingFace、Nvidia NIM、Novita、GMI Cloud、Baseten、NanoGPT 以及 Sakana/Fugu）的主力传输层。该传输层实现分布在 `packages/ai/src/providers/openai-completions.ts`（主流式运行器 `streamOpenAICompletions`）、`packages/ai/src/providers/openai-chat-wire.ts`（内置的线上类型）、`packages/ai/src/providers/openai-shared.ts`（共享请求/策略/用量 helper）、`packages/ai/src/providers/openai-reasoning-fallback.ts`（400 reasoning-effort 恢复）、`packages/ai/src/utils/openai-http.ts`（HTTP SSE 客户端 `postOpenAIStream`）和 `packages/ai/src/utils/empty-completion-retry.ts`（`withReplaySafeStreamRetry` 包装器）。

### 特殊处理
- **Azure 部署名映射**：`packages/ai/src/providers/openai-shared.ts` 中的 `parseAzureDeploymentNameMap` 解析 `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` 环境变量（逗号分隔的 `modelId:deploymentName` 对），在 `createRequestSetup`（`packages/ai/src/providers/openai-completions.ts`）中把模型 ID 翻译为 Azure 部署名，未映射时回退到 `model.id`。
- **网关路由与变体变换**：`packages/ai/src/providers/openai-shared.ts` 中的 `applyOpenAIGatewayRouting` 注入 OpenRouter provider 路由偏好（`params.provider`）。`applyOpenRouterRoutingVariant` 和 `applyWireModelIdTransform` 追加 OpenRouter 模型变体后缀（`:nitro`、`:floor`、`:online`、`:extended`）。`resolveSakanaRequestBaseUrl` 处理 Sakana/Fugu 基础 URL 覆盖（`SAKANA_BASE_URL` / `FUGU_BASE_URL`），`applyCoreWeaveProjectHeader` 注入 CoreWeave 项目 header。
- **空补全重试**：`streamOpenAICompletions` 被 `withReplaySafeStreamRetry`（`packages/ai/src/utils/empty-completion-retry.ts`）包装，当一次尝试以 `finish_reason: "stop"` 干净结束但没有发出可见 assistant 内容（`hasVisibleAssistantContent` 检查文本、thinking、图像或工具调用）且输出 token ≤ 1 时，最多重试 `MAX_EMPTY_COMPLETION_RETRIES` 次（2 次重试，指数退避 `EMPTY_COMPLETION_BASE_DELAY_MS` = 500ms）。该包装器会缓冲输出前事件，确保被丢弃的尝试不会被重放，并在（`retryProviderErrors: true`、`maxProviderErrorRetries: 1` 时）在任何输出提交之前也重试瞬态 provider 错误。
- **Reasoning-Effort 400 回退**：`packages/ai/src/providers/openai-reasoning-fallback.ts` 中的 `resolveOpenAIReasoningEffortFallback` 与 `applyOpenAIReasoningEffortFallback` 拦截由不支持的 `reasoning_effort` 值引起的 400/422 HTTP 错误响应。它从错误消息中解析允许的级别（或解析最近的受支持级别/null），按端点/模型键（`createOpenAIReasoningEffortFallbackKey`、`rememberOpenAIReasoningEffortFallback`）把回退记录在 provider 会话状态（`getOpenAICompletionsProviderSessionState`）中，并透明地重试请求而不使回合失败。
- **Finish Reason 提升**：在 `streamOpenAICompletionsOnce`（`packages/ai/src/providers/openai-completions.ts`）中，如果后端报告 `finish_reason: "stop"` 但该回合产生了结构化 `toolCall` 块或经 `StreamMarkupHealing` 修复的工具调用，`output.stopReason` 会从 `"stop"` 提升为 `"toolUse"`，让 agent 执行循环正确调用工具处理器。
- **Mistral 工具 ID 规范化**：`packages/ai/src/providers/openai-completions.ts` 中的 `normalizeMistralToolId` 将 Mistral 模型的工具调用 ID 限制为恰好 9 个字母数字字符（用确定性字符 `"ABCDEFGHI"` 填充或截断）。
- **MiniMax 对象参数深度合并**：`packages/ai/src/providers/openai-completions.ts` 中的 `mergeStreamingArgumentObjects` 处理以 JSON 对象而非字符串流式传输 `function.arguments` 的 MiniMax 兼容后端，跨流块递归合并部分对象增量。
- **DeepSeek Chat 模板与特殊令牌剥离**：`packages/ai/src/providers/openai-completions.ts` 中的 `stripDeepseekSpecialTokens` 与 `getTrailingPartialDeepseekToken` 缓冲并剥离 DeepSeek 端点（如 NVIDIA NIM、DeepSeek 原生 API）上泄漏到 `delta.content` 的原始 `<｜...｜>` / `<|...|>` chat 模板标记。
- **方言与 provider 特定行为**：`packages/ai/src/providers/openai-shared.ts` 中的 `isZaiReasoningEffortDialect` 处理 GLM-5.2 `zai` thinking 格式。`dropOpenRouterKimiForcedToolReasoning`、`hasActiveNativeKimiK3Reasoning` 和 `normalizeSchemaForMoonshot` 管理 Kimi (Moonshot) K3 工具 schema 与推理模式。`applyOpenAIChatCompletionsPromptCachePolicy` 注入 prompt 缓存断点（`cache_control: { type: "ephemeral" }` 或 `normalizeOpenAIPromptCacheKey` 的 64 字符 `pc_` 前缀）。

### 流行为
- **SSE 增量解码与规范化**：`postOpenAIStream`（`packages/ai/src/utils/openai-http.ts`）使用 `readSseJson` 将原始 SSE `data:` 载荷解码为 `ChatCompletionChunk` 对象。`normalizeStreamingContentText`（`packages/ai/src/providers/openai-completions.ts`）规范化 `delta.content`，无论其以字符串还是内容部分数组（`[{ type: "text", text: "..." }]`，如 Mistral Medium 3.5）形式到达，防止 `[object Object]` 字符串强制转换。
- **推理字段与加密签名**：`streamOpenAICompletionsOnce` 检查 `delta.reasoning_content`（llama.cpp/vLLM）、`delta.reasoning` 和 `delta.reasoning_text`，每个 chunk 使用第一个非空字段以避免重复的推理文本。`delta.reasoning_details`（`reasoning.encrypted`）中的加密推理签名会附加到对应的 `toolCall.thoughtSignature`。
- **部分 JSON 节流**：来自 `@oh-my-pi/pi-utils` 的 `parseStreamingJsonThrottled` 在 `streamOpenAICompletionsOnce` 中对工具参数流式传输期间的增量 JSON 解析进行节流，以降低 CPU 开销。
- **流标记修复**：当 `policy.stream.markupHealingPattern` 配置后，`StreamMarkupHealing`（`packages/ai/src/utils/stream-markup-healing.ts`）被激活。它检查流式文本中 XML/markdown 包装的工具调用（如 DSML 泄漏），解析完成的工具调用，发出 `toolcall_start`/`toolcall_delta`/`toolcall_end` 事件，并将 `stop` finish reason 提升为 `toolUse`。
- **降级 thinking 与累计推理**：`renderDemotedThinking`（`packages/ai/src/dialect/demotion.ts`）处理降级的 thinking 块（`isDemotedThinking`）。`lastCumulativeReasoningBySignature` 跟踪跨文本块转换的累计推理流（如 MiniMax-M3），防止可见文本开始后 thinking 文本被重复发出为重复块。
- **看门狗与终止宽限窗口**：`iterateWithIdleTimeout`（`packages/ai/src/utils/idle-iterator.ts`）使用 `getOpenAIStreamFirstEventTimeoutMs` 和 `getOpenAIStreamIdleTimeoutMs` 监控流活动，并向下游注入 `X-Stainless-Timeout` header。流结束时，`iterateWithTerminalGrace` 强制一个 2,500ms 的完成后宽限窗口（`OPENAI_COMPLETIONS_POST_FINISH_GRACE_MS`），允许带缓存读取 token 详情的仅用量尾部块（`stream_options.include_usage`，经 `awaitTrailingUsageDetails`）在关闭流之前到达。
- **用量块解析**：`packages/ai/src/providers/openai-completions.ts` 中的 `parseChunkUsage` 与 `applyUsagePayload` 处理来自 `chunk.usage` 或 `choice.usage` 的 token 用量。提取的字段包括 `prompt_tokens_details.cached_tokens`、`prompt_cache_hit_tokens`、`prompt_cache_miss_tokens`、`completion_tokens_details.reasoning_tokens`、`cache_write_tokens`，以及经 `applyProviderReportedCost`（`packages/ai/src/providers/openai-shared.ts`）获取的 provider 报告成本。

### 认证与用量
- **API-Key 校验**：`packages/ai/src/registry/api-key-validation.ts` 中的 `validateOpenAICompatibleApiKey` 通过发出一个轻量 `POST /chat/completions` 请求（`messages: [{ role: "user", content: "ping" }]`、`max_tokens: 1`、`temperature: 0`、`Authorization: Bearer ${apiKey}`）来校验 API 凭据。
- **凭据解析与环境变量**：`packages/ai/src/stream.ts` 中的 `getEnvApiKey` 为 OpenAI 兼容 provider 解析 provider 专属的环境变量：`OPENAI_API_KEY`、`GROQ_API_KEY`、`CEREBRAS_API_KEY`、`MISTRAL_API_KEY`、`DEEPSEEK_API_KEY`、`FIREWORKS_API_KEY`、`OPENROUTER_API_KEY`、`TOGETHER_API_KEY`、`SAMBANOVA_API_KEY`、`NEBIUS_API_KEY`、`NOVITA_API_KEY`、`AVALAI_API_KEY`、`CHUTES_API_KEY`、`NANOGPT_API_KEY`、`HYPERBOLIC_API_KEY`、`PERPLEXITY_API_KEY`、`XAI_API_KEY` 和 `AZURE_OPENAI_API_KEY`。
- **用量核算与配额呈现**：`calculateOpenAIUsageAccounting`（`packages/ai/src/providers/openai-shared.ts`）将输入、输出、缓存读取和缓存写入 token 调和为标准 `Usage` 记录。OpenRouter 与 ClinePass 的权威网关计费经 `applyProviderReportedCost` 填入 `output.usage.cost`。Copilot 请求计数存储在 `output.usage.premiumRequests`。传输 HTTP 错误（如 429 Rate Limit、408 Timeout、5xx Server Error）以 `OpenAIHttpError`（`packages/ai/src/utils/openai-http.ts`）抛出，捕获状态码、header 与错误信封详情，供 `AIError.finalize` 中的上游错误映射使用。

### Catalog 模型处理
- **Provider 描述符**：`packages/catalog/src/provider-models/descriptors.ts` 中的 `CATALOG_PROVIDERS` 注册所有使用该传输的 catalog 条目（如 `openai`、`groq`、`cerebras`、`mistral`、`deepseek`、`fireworks`、`openrouter`），指定 `api: "openai-completions"`、`defaultModel`、环境变量键和文档 URL。
- **模型解析器与管理器**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `createOpenAICompatibleModelManagerOptions` 为 `openai-completions` provider 构建模型管理器。它组合静态/精选模型定义、内置参考规格（`getBundledModels`）以及从远程 catalog 端点获取的实时模型。
- **Catalog 发现**：`packages/catalog/src/discovery/openai-compatible.ts` 中的 `fetchOpenAICompatibleModels` 查询 provider 的 `/models` 端点。它安全地解析信封（`data`、`models`、`result`、`items`），使用 `withOpenAICompatibleDiscoveryTimeout` 强制请求超时，校验模型记录 schema（`openAICompatibleModelRecordSchema`），应用自定义映射/过滤，并按 ID 去重模型。
- **身份与分类**：`packages/catalog/src/identity/classify.ts` 中的 `parseKnownModel` 与 `parseOpenAIModel` 为匹配 `gpt-(\d+(?:\.\d+){0,2})(?:-(...))?` 的 OpenAI 模型提取模型家族、变体（`base`、`codex`、`mini`、`max`、`nano`）和 SemVer 版本（`parseSemVer`）。版本比较工具（`semverGte`、`semverEqual`）驱动跨 GPT-4、GPT-4o 和 GPT-5 家族的能力检测。
- **Thinking 元数据与 effort 阶梯**：`packages/catalog/src/model-thinking.ts` 中的 `resolveModelThinking` 与 `deriveThinking` 构建 thinking 元数据（`ThinkingConfig`）并将模型身份/compat 设置映射到 effort 阶梯：
  - `DEFAULT_REASONING_EFFORTS`：`[minimal, low, medium, high]`
  - `DEFAULT_REASONING_EFFORTS_WITH_XHIGH`：`[minimal, low, medium, high, xhigh]`（如 OpenRouter GLM-5.2）
  - `GPT_5_2_PLUS_EFFORTS`：`[low, medium, high, xhigh]`
  - `FIVE_TIER_EFFORTS_LOW_TO_MAX`：`[low, medium, high, xhigh, max]`（GPT-5.6+ 线上 effort 模型、Fire Pass Kimi 路由器）
  - `LOW_HIGH_MAX_REASONING_EFFORTS`：`[low, high, max]`（Kimi K3、DeepSeek V4 Flash）
  - `HIGH_MAX_REASONING_EFFORTS`：`[high, max]`（Z.ai/Umans/Baseten 上的 GLM-5.2、DeepSeek V4 Pro）
  - `HIGH_ONLY_REASONING_EFFORTS`：`[high]`（OpenRouter DeepSeek）
  - `OLLAMA_REASONING_EFFORTS`：`[low, medium, high, max]`（Ollama 端点）

## OpenAI Responses
OpenAI Responses provider（`packages/ai/src/providers/openai-responses.ts`）处理 OpenAI 的有状态 `/v1/responses` HTTP Server-Sent Events（SSE）流式线上协议（类型定义于 `openai-responses-wire.ts`，共享编码与解码逻辑在 `openai-shared.ts`）。与 chat completions 不同，Responses API 在包含类型化输入/输出条目（`input_text`、`input_image`、`input_file`、`message`、`function_call`、`custom_tool_call`、`computer_call`、`reasoning`）的结构化条目序列（`ResponseInput`）上操作，支持经 `previous_response_id` 的服务端上下文链式调用、显式 prompt-cache 断点以及原生推理摘要与加密内容块。

### 特殊处理
- **Responses 输入条目模型 vs chat 消息**：`openai-shared.ts` 中的 `buildResponsesInput` 把标准对话上下文转换为 `ResponseInput` 数组（`ResponseInputItem[]`）。系统指令默认使用顶层 `instructions`，或在 `policy.messages.systemRole === "developer"`（推理模型必需）时使用 developer 角色条目（`{ role: "developer" }`）。重放的历史根据 `filterReasoningHistory` 剥离或保留推理条目，而 Harmony 方言模型（GPT-5+）经 `escapeReplayedControlTokens` 转义重放传输数据中的保留控制令牌拼写。
- **`previous_response_id` 链式调用与过期链重置**：`openai-responses.ts` 中的 `buildOpenAIResponsesChainedParams` 管理有状态回合。当 `statefulResponses` 激活时（官方 OpenAI 端点经 `PI_OPENAI_STATEFUL` 标志与 `hostMatchesUrl` 默认开启），请求强制 `store: true` 并计算锚定到 `previous_response_id` 的增量载荷（`buildResponsesDeltaInput`）。若历史变动、选项改变或 prompt-cache 断点策略变化，链会重置为完整重放（`resetOpenAIResponsesChainState`）。若端点返回过期 ID 错误（`isOpenAIResponsesStalePreviousResponseError`），provider 递增 `staleFailures` 并回退到完整转录重放；在 `OPENAI_RESPONSES_CHAIN_STALE_FAILURE_LIMIT`（3）次连续失败后，该会话禁用链式调用。零数据保留（ZDR）组织错误（`markOpenAIResponsesChainZeroDataRetention`）立即禁用该会话的链式调用并强制 `store: false`。
- **加密推理条目与摘要**：经 `policy.reasoning.includeEncryptedReasoning` 支持 `include: ["reasoning.encrypted_content"]`。`ResponseReasoningItem` 对象包含加密内容载荷、推理文本增量（`response.reasoning_text.delta`）与摘要文本增量（`response.reasoning_summary_text.delta`）。携带序列化 JSON 的 thinking 签名经 `parseResponseReasoningReplayItem` 解析，并在 `filterReasoningHistory` 为 false 时作为原生 `reasoning` 条目重放。
- **复合 `callId|itemId` 工具 ID**：`packages/ai/src/utils.ts` 中的 `normalizeResponsesToolCallId` 处理工具调用 ID 规范化。Responses 中的工具调用标识符是格式为 `${callId}|${itemId}` 的复合字符串。该函数把传入 ID 按 `|` 拆分为 `callId`（截断到 64 字符并带 `call_` 前缀）与 `itemId`（前缀 `fc_` 或 `ctc_`）。传入未合成的 ID 时，它生成基于哈希的配对（`call_<hash>` 与 `fc_<hash>` / `ctc_<hash>`）。变换后的消息使用 `normalizeResponsesToolCallIdForTransform` 保持工具调用与工具结果消息之间的对齐。
- **Custom（自由格式）工具与 computer 工具**：`convertTools` 中的工具转换处理 function、custom 与 computer 工具。当 `model.applyPatchToolType === "freeform"`（经 `supportsFreeformApplyPatch` 检查）时，custom 格式工具（如 `apply_patch`）编码为带语法定义（`compactGrammarDefinition`）的 `type: "custom"`。当 `model.supportsComputerUse === true` 时，原生 computer 工具（`type: "computer"`）使用结构化 `ComputerAction` 列表发出 `computer_call` 与 `computer_call_output` 条目；无原生 computer 支持的模型回退到普通 function 工具。工具 schema 经 `sanitizeSchemaForOpenAIResponses` 与 `adaptSchemaForStrict` 清洗，违反严格约束的 schema 被隔离（`findStrictToolSchemaViolation`），以防无效的 MCP schema 使整个请求失败。
- **服务层级与混淆退出**：`serviceTier` 选项向下传递到采样参数，并经 `processResponsesStream` 在输出用量中报告。当 `model.compat.supportsObfuscationOptOut` 为 true 时，采样参数包含 `stream_options: { include_obfuscation: false }`。
- **图像 detail 处理**：`convertResponsesInputContent` 与 `appendResponsesToolResultMessages` 中的图像内容转换尊重 `model.compat.supportsImageDetailOriginal`。为 false 时，`"original"` 图像 detail 值映射为 `"auto"` 以防止上游拒绝。多模态工具结果编码契约由 [provider 兼容性参考](./provider-compat-reference.md) 拥有。

### 流行为
- **流事件协议（`response.*` 生命周期）**：`openai-shared.ts` 中的 `processResponsesStream` 处理 `/v1/responses` 发出的 SSE 事件。处理的生命周期事件包括 `response.created`、`response.output_item.added`、`response.output_text.delta`、`response.reasoning_text.delta`、`response.reasoning_summary_text.delta`、`response.function_call_arguments.delta`、`response.custom_tool_call_input.delta`、`response.output_item.done`、`response.completed` 与 `response.done`。交错的并行工具调用通过 `output_index`、`item_id` 与带前缀的调用 ID 查找映射（`openItemsByOutputIndex`、`openItemsByItemId`、`openItemsByPrefixedCallId`）并发跟踪。
- **看门狗与瞬态重试**：`streamOpenAIResponsesOnce` 使用带两个超时阈值的 `iterateWithIdleTimeout`：`streamFirstEventTimeoutMs`（带 `X-Stainless-Timeout` 请求 header）用于初始响应 header/事件，`streamIdleTimeoutMs` 用于事件间停顿。如果流在发出重放不安全输出之前过早终止（`isOpenAIResponsesReplayUnsafeEvent`），单次尝试流式器在延迟（`OPENAI_RESPONSES_TRANSIENT_STREAM_RETRY_DELAY_MS` = 500ms）后执行瞬态重试（`OPENAI_RESPONSES_MAX_TRANSIENT_STREAM_RETRIES` = 1）。公开的 `streamOpenAIResponses` 用 `withReplaySafeStreamRetry` 包装执行以重试空补全。

### 认证与用量
- 标准 OpenAI 认证依赖经 `openai-shared.ts` 中的 `getEnvApiKey` 与 `resolveOpenAIRequestSetup` 解析的 `OPENAI_API_KEY`（或 provider 专属环境变量）。请求传递标准 Bearer 令牌授权 header（`Authorization: Bearer <key>`）以及可选的 Stainless/Copilot header。*（注：`openai-codex` / ChatGPT 订阅计划的 OAuth 认证单独处理。）*

### Catalog 模型处理
- **`gpt-5+` 身份分类**：`gpt-5` 家族模型经 `packages/catalog/src/identity/family.ts` 中的 `isOpenAIWireGen5Plus` 与 `isOpenAIWireGen54Plus` 识别。`gpt-5+` 模型在所有服务宿主上拒绝旧版采样参数（如 `temperature`、`top_p`、`frequency_penalty`）并返回 HTTP 400，`buildOpenAICompat` / `buildOpenAIResponsesCompat` 通过 `supportsReasoningParams` 对此做了处理。
- **Prompt-cache 断点（`supportsOfficialOpenAIPromptCacheBreakpoints`）**：在 `packages/catalog/src/compat/openai.ts` 中评估。`supportsOfficialOpenAIPromptCacheBreakpoints` 对服务版本 >= 5.6 模型的官方 OpenAI 端点返回 true。启用且 `promptCache.mode === "explicit"` 时，`openai-responses.ts` 中的 `markLatestStableResponsesCacheBreakpoint` 向最新的稳定 developer/user 消息块注入 `{ mode: "explicit" }` 的 `prompt_cache_breakpoint` 注解，同时保留有状态基线断点。
- **推理摘要配置与 effort 阶梯**：`buildParams` 经 `applyResponsesCompatPolicy` 应用推理参数。Effort 参数经模型特定映射（`reasoningEffortMap` 或 `thinking.effortMap`）映射。对 `gpt-5.6+` 模型和 5 档 effort 刻度（含 `xhigh` 与 `max`），`model-thinking.ts` 配置 effort 阶梯（`minimal`、`low`、`medium`、`high`、`xhigh`、`max`），将 `xhigh` 与 `max` 1:1 映射或按宿主方言偏移（如 `KIMI_K3_REASONING_EFFORT_MAP`、`MIMO_REASONING_EFFORT_MAP`）。生成的 pro 别名（`gpt-5.6-*-pro`）自动附加 `reasoningMode: "pro"`。

## OpenAI Codex
OpenAI Codex provider 基于 SSE 或 WebSocket 传输的 OpenAI Responses API 面集成 ChatGPT Plus/Pro 订阅模型。请求指向 ChatGPT 后端（`https://chatgpt.com/backend-api/codex/responses` 或自定义基础 URL），使用带账户级隔离的 ChatGPT OAuth 令牌。入口模块包括 `packages/ai/src/providers/openai-codex-responses.ts` 中的流式处理、`packages/ai/src/providers/openai-codex/request-transformer.ts` 中的请求变换、`packages/ai/src/providers/openai-codex/response-handler.ts` 中的错误与限流解析、`packages/ai/src/usage/openai-codex.ts` 中的配额与用量跟踪、`packages/ai/src/usage/openai-codex-reset.ts` 中的重置管理、`packages/ai/src/usage/openai-codex-base-url.ts` 中的基础 URL 规范化、`packages/catalog/src/compat/rules/auth/openai-codex.kdl` 中的认证策略，以及 `packages/ai/src/registry/oauth/openai-codex.ts` 中的 OAuth 处理。

### 特殊处理
- **WebSocket 与 SSE 双传输**：经 `packages/ai/src/providers/openai-codex-responses.ts` 中的 `CodexWebSocketConnection` 支持 WebSocket 流式（`v2StreamingEnabled: true`、header `OpenAI-Beta: responses_websockets=2026-02-06`、`preferWebsockets` 选项）。复用 socket 并设最大空闲复用上限（`CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS` = 30s）、ping/pong 心跳（10s 间隔、60s 超时）和队列容量（4096）。连接/握手失败时立即回退到 SSE（`CODEX_WEBSOCKET_FATAL_PATTERNS`、`CodexWebSocketTransportError`）。
- **采样参数剥离**：采样参数（`temperature`、`top_p`、`top_k`、`min_p`、`presence_penalty`、`repetition_penalty`、`frequency_penalty`、`stop`）在 `packages/ai/src/providers/openai-codex/request-transformer.ts` 的 `transformRequestBody` 中被剥离；Codex 后端在任何采样参数被发送时返回 HTTP 400 `Unsupported parameter`（#3117）。
- **Responses Lite 传输**：正常推理默认使用完整 Responses；调用方通过 `responsesLite` 请求选项或 `PI_CODEX_RESPONSES_LITE=1` 选择 Lite，而 provider 原生 compaction 显式遵循 catalog 的 `useResponsesLite` 标志。函数 `applyCodexResponsesLiteShape` 把声明的工具嵌入前导 `additional_tools` developer 条目、系统指令嵌入 developer 消息、剥离图像 `detail`、关闭并行工具调用、强制 `reasoning.context: "all_turns"`，并追加 `x-openai-internal-codex-responses-lite: true` header（或 WS `client_metadata` 中的 `ws_request_header_x_openai_internal_codex_responses_lite`）。当没有匹配的声明工具时，托管工具选择（`tool_choice`）回退为 `"auto"`（#5771）。
- **工具调用/输出对修复**：`request-transformer.ts` 中的 `repairToolCallPairs` 把缺少先前调用的孤立 `function_call_output`/`custom_tool_call_output` 重写为 assistant 消息（`[Previous tool result; call_id=...]`），并为缺少输出的孤立调用注入合成输出（`[No tool output recorded...]`），防止后端 HTTP 400 校验失败。
- **会话亲和与 header**：发出会话 header，包括 `session_id`、`session-id`、`x-codex-installation-id`、`x-codex-window-id`、`x-codex-turn-metadata`（包含 `turn_id`、`installation_id`、`parent_turn_id`、`request_kind` 的 JSON）、`x-codex-parent-thread-id` 与 `x-openai-subagent`，定义在 `packages/catalog/src/wire/codex.ts` 与 `openai-codex-responses.ts` 中。
- **证明与压缩**：为 `x-oai-attestation` header 咨询进程级 DeviceCheck 证明钩子 `setCodexAttestationProvider`（`getCodexAttestationHeader`）。当 `PI_CODEX_ZSTD` 激活时，对官方来源用 zstd 压缩请求体载荷（`compressCodexRequestBody`）。
- **区域固定的工作区驻留**：企业 ChatGPT 工作区可固定到数据驻留区域，并拒绝任何出口区域不同的 Codex 请求——HTTP 401 `Workspace is not authorized in this region.`——除非客户端自行声明工作区驻留。Codex 请求构建器从 OAuth 访问令牌读取它（`packages/catalog/src/wire/codex.ts` 中的 `getCodexResidency`，claim `chatgpt_data_residency`，以 `chatgpt_compute_residency` 为回退），并在 chat SSE 与 WebSocket 传输、web 搜索、远程 compaction 和 `generate_image` 上发送 `x-openai-internal-codex-residency`。没有该 claim 的账户（个人 ChatGPT、非 JWT 的不透明代理密钥）不发送 header，调用方提供的同名 header 永不被覆盖。
- **Harmony 控制令牌转义**：对运行在 Harmony 方言上的模型（`isHarmonyDialectModel`），用 `escapeHarmonyControlTokens` 清洗重放的输入文本。

### 流行为
- **事件协议**：解析 SSE JSON 载荷或 WebSocket 帧（`response`、`sequence_number`、`type`）。触发进度事件（`isOpenAIResponsesProgressEvent`、`CODEX_ADDITIONAL_PROGRESS_EVENT_TYPES` 如 `response.done` 与 `response.incomplete`）。
- **超时看门狗**：强制 `CODEX_WEBSOCKET_FIRST_EVENT_TIMEOUT_MS`（300s）用于首事件，`CODEX_WEBSOCKET_IDLE_TIMEOUT_MS`（300s）用于稳态流空闲上限，SSE 流使用 `iterateWithIdleTimeout`。
- **过期历史恢复**：在过期 `previous_response_id` 错误（`CODEX_STALE_PREVIOUS_RESPONSE_CODES`）时重新流式/重放，清除无效链式响应指针并重试。
- **重试预算与限流**：对瞬态错误（`model_error`、`server_error`、`internal_error` 或 `CODEX_RETRYABLE_EVENT_MESSAGE`）最多重试 `CODEX_MAX_RETRIES`（5）次。在 5 分钟预算（`CODEX_RATE_LIMIT_BUDGET_MS`）内处理带服务器重试延迟的 HTTP 429 退避。
- **空白循环防御**：检测无限的空白工具调用参数增量（`CODEX_WHITESPACE_TOOL_CALL_ARGUMENT_DELTA_EVENT_LIMIT` = 256，16KB 上限），以 `CodexWhitespaceToolCallLoopError` 中断执行并最多尝试 2 次重试（`CODEX_WHITESPACE_LOOP_RETRY_LIMIT`）。
- **并发推理摘要**：当请求推理摘要时（`supportsCodexReasoningSummary`），请求体包含 `stream_options: { reasoning_summary_delivery: "sequential_cutoff" }`，使输出文本能在摘要完成前流式输出。

### 认证与用量
- **OAuth 登录流程**：实现 `packages/catalog/src/compat/rules/auth/openai-codex.kdl`（`login "oauth-code"`，引擎 `packages/ai/src/registry/engine/oauth-code.ts`）与 `openai-codex-device.kdl` 声明的 ChatGPT OAuth，钩子在 `packages/ai/src/registry/oauth/openai-codex.ts`。浏览器流程使用 PKCE S256（`createOpenAICodexAuthorizationUrl`）、固定本地端口 1455（`http://localhost:1455/auth/callback`）、client ID `app_EMoamEEZ73f0CkXaXp7hrann` 以及简化 CLI 流程标志。无头设备码流程（`loginOpenAICodexDevice`）使用 `https://auth.openai.com/api/accounts/deviceauth/usercode` 并轮询 `deviceauth/token`。
- **令牌刷新与 claims**：`refreshOpenAICodexToken` 向 `https://auth.openai.com/oauth/token` 发送 `grant_type: refresh_token`。从 JWT claims 提取 `chatgpt_account_id` 与用户 `email`（`getTokenProfile` 中的 `https://api.openai.com/auth` 与 `https://api.openai.com/profile`）。
- **账户轮换与限流排名**：账户身份经 `ChatGPT-Account-Id` header 设置（`getCodexAccountId`）。`packages/ai/src/usage/openai-codex.ts` 中的 `codexRankingStrategy` 将标准 chat 限额（5h 主限、7d 次限）与 Spark 计量限额隔离（`-spark` 模型后缀消耗 `spark` 作用域），防止 Spark 耗尽阻塞正常 chat 请求。
- **用量跟踪**：`openaiCodexUsageProvider` 在规范 ChatGPT 来源上查询 `/wham/usage`。解析 `primary_window`（5h）与 `secondary_window`（7d），以及 `additional_rate_limits`（Spark/额外计量）。在 `parseCodexRateLimitHeaders`（`response-handler.ts` 的 `parseCodexError`）中摄取响应 header（`x-codex-primary-used-percent`、`x-codex-primary-window-minutes`、`x-codex-primary-reset-at`、`x-codex-secondary-*`）。
- **保存的限流重置额度**：从 `/wham/usage` 读取 `rate_limit_reset_credits`。用 `listCodexResetCredits`（`GET /wham/rate-limit-reset-credits`）列出可用额度，用 `pickSoonestExpiringCredit` 选择最快过期的额度，并用 `consumeCodexResetCredit`（`POST /wham/rate-limit-reset-credits/consume`，带 client UUID `redeem_request_id`）兑换。
- **基础 URL 规范化**：`packages/ai/src/usage/openai-codex-base-url.ts` 中的 `normalizeCodexBaseUrl` 强制账户 API 请求（`wham/usage`、重置额度）使用规范 `chatgpt.com` 或 `chat.openai.com` 来源（`/backend-api`），忽略会 404 的自定义代理覆盖（`providers.openai-codex.baseUrl`）。流 URL 经 `openai-codex-responses.ts` 中的 `resolveCodexResponsesUrl` 解析。

### Catalog 模型处理
- **描述符与管理**：在 `packages/catalog/src/provider-models/descriptors.ts` 中定义为 `openai-codex` provider 描述符（默认模型 `"gpt-5.5"`）。在 `packages/catalog/src/provider-models/special.ts` 的 `createOpenAICodexModelManagerOptions` 中配置为带动态模型发现的特殊托管 provider。
- **动态发现**：`packages/catalog/src/discovery/codex.ts` 中的 `fetchCodexModels` 以 `v2StreamingEnabled: true` 查询 `/codex/models` 或 `/models`，把 `reasoning_presets`（`effort`、`summary`）解析为 `ModelSpec<"openai-codex-responses">`。
- **身份与分类**：`packages/catalog/src/identity/classify.ts` 中的 `OpenAIVariant` 支持 `"codex"`、`"codex-max"`、`"codex-mini"`、`"codex-spark"`。`parseOpenAIModel` 匹配 `gpt-X.Y-(codex-spark|codex-mini|codex-max|codex|mini|max|nano)`。`packages/catalog/src/identity/priority.ts` 中的优先级列表将 `openai-codex` 排在通用 provider 回退之前。
- **Thinking 与 effort 限制**：`packages/catalog/src/model-thinking.ts` 映射支持的 effort（`minimal`、`low`、`medium`、`high`、`xhigh`、`max`），确定模型专属档位（如 `GPT_5_1_CODEX_MINI_EFFORTS`），并在 `identity/family.ts` 中检查 `supportsAllTurnsReasoningContext` 与 `supportsCodexReasoningSummary`。
- **定价回退**：`packages/catalog/scripts/generate-models.ts` 中的 `applyCodexPricingFallback` 在 Codex 发现模型缺少显式成本元数据时，从匹配模型 ID 的 `openai` provider 条目复制计费成本。

## Azure OpenAI
Azure OpenAI Responses provider（`azure-openai-responses`）处理经 Azure OpenAI Responses API 服务的 OpenAI 家族模型（GPT-4/4.1/4o、GPT-5 系列、o 系列、Codex）的传输、端点解析与兼容性包装。它使用内部 `postOpenAIStream` 传输（`packages/ai/src/utils/openai-http.ts`）发起 JSON-POST / SSE 请求。流生成初始化于 `streamAzureOpenAIResponses`（`packages/ai/src/providers/azure-openai-responses.ts`），共享的 Responses 输入/输出处理逻辑位于 `packages/ai/src/providers/openai-shared.ts`。

### 特殊处理
- **部署名映射**：Azure OpenAI 要求请求载荷中有部署名。`resolveDeploymentName`（`packages/ai/src/providers/azure-openai-responses.ts`）检查 `options.azureDeploymentName`，然后检查 `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` 环境变量（由 `openai-shared.ts` 中的 `parseAzureDeploymentNameMap` 解析为 `modelId=deploymentName` 对映射，如 `gpt-5-mini=my-mini-dep,o3=my-o3-dep`），默认为 `model.id`。
- **基础 URL / 资源解析**：`resolveAzureConfig`（`packages/ai/src/providers/azure-openai-responses.ts`）检查 `options.azureBaseUrl` 或 `$env.AZURE_OPENAI_BASE_URL`。若缺失，从 `options.azureResourceName` 或 `$env.AZURE_OPENAI_RESOURCE_NAME` 构造 `https://${resourceName}.openai.azure.com/openai/v1`。若仍缺失，回退到 `model.baseUrl`，找不到端点则抛 `AIError.ConfigurationError`。尾随斜杠被剥离。
- **API 版本处理**：`resolveAzureConfig` 从 `options.azureApiVersion`、`$env.AZURE_OPENAI_API_VERSION` 解析 API 版本，默认 `"v1"`。它作为 `api-version` URL 查询参数（`${baseUrl}/responses?api-version=${apiVersion}`）而非 HTTP header 传递。
- **严格 responses 工具配对**：经 `buildOpenAIResponsesCompat`（`packages/catalog/src/compat/openai.ts`，`isAzure = true`）对 Azure OpenAI 模型默认启用。在 `buildResponsesInput` / `appendResponsesToolResultMessages`（`packages/ai/src/providers/openai-shared.ts`）中，未配对的工具输出（其 `callId` 未由先前 assistant `function_call` 条目发出的结果）会被 Azure 严格后端拒绝。Omp 将孤立工具结果折叠进合成 assistant 备注消息（`[Orphan <tool> result; call_id=<id>]: <text>`，至多 16,000 字符，或 `[Orphan computer result; call_id=<id>]`），而非发送未配对的输出条目。
- **图像 detail 钳制**：在 `appendResponsesToolResultMessages` / `convertResponsesInputContent` 中，当 `supportsImageDetailOriginal` 为 `false` 时，`clampResponsesImageDetail` 将 `detail: "original"` 钳制为 `"auto"`。对 Azure OpenAI，`supportsImageDetailOriginal` 为 `true`（不同于 GitHub Copilot 与 xAI OAuth），保留原始图像分辨率。
- **Computer 工具回退映射**：`modelForAzureEndpoint`（`packages/ai/src/providers/azure-openai-responses.ts`）验证解析到的端点主机以 `.openai.azure.com` 或 `models.inference.ai.azure.com` 结尾。若经未识别的代理路由，`supportsComputerUse` 被禁用。在 `buildParams` 中，若工具的 `native.type === "computer"` 且 `model.supportsComputerUse` 为 `true`，它序列化为 `{ type: "computer" }`。若 `supportsComputerUse` 为 `false`，回退为把 computer 工具序列化为标准 `{ type: "function", name: tool.name, ... }` 工具。`tool_choice` 在 `computer` 与 `function` 目标之间自动转换。
- **与普通 Responses（`openai-responses`）的差异**：使用 `api-key` header（从不用 `Authorization: Bearer`）、使用固定端点路径 `${baseUrl}/responses?api-version=...`（`/responses` 路径不按部署限定作用域，不同于 Chat Completions 的 `/deployments/{dep}/chat/completions`）、把部署名放在请求体内的 `model`、从环境/选项动态运行时构造端点，并且 `strictResponsesPairing` 默认 `true`。

### 流行为
- **事件处理**：使用 `packages/ai/src/providers/openai-shared.ts` 中的 `processResponsesStream` 消费 SSE 流事件（`response.created`、`response.output_item.added`、`response.content_part.added`、`response.output_text.delta`、`response.completed`、`response.incomplete`）。终止性的 `response.incomplete` 事件（输出 token 截断）更新用量计数器并设置 `stopReason: "length"`。
- **空闲与首事件看门狗**：用 `iterateWithIdleTimeout` 包装。若第一个 SSE 事件未在 `streamFirstEventTimeoutMs` 内到达，以 `"Azure OpenAI responses stream timed out while waiting for the first event"` 中止。
- **无类型 SSE 载荷解析**：`onSseEvent` 检查无类型 JSON 事件数据（`type` 或 `object` 属性），在标准 SSE header 行缺失时附加事件类型标签。
- **推理 effort 回退**：在流启动期间捕获 `OpenAIHttpError`。若端点拒绝请求的推理 effort（如 `xhigh`），`resolveOpenAIReasoningEffortFallback` 确定更低的 effort 级别，下调 `params.reasoning`，并使用 `createOpenAIReasoningEffortFallbackKey("azure-responses", url, model)` 重试请求。

### 认证与用量
- **凭据来源**：来自 `options.apiKey` 或 `$env.AZURE_OPENAI_API_KEY`（经 `packages/ai/src/stream.ts` 中的 `getEnvApiKey(model.provider)` 或 `buildAzureResponsesRequest` 获取）。以 `api-key` header 发送。
- **用量跟踪**：由 `processResponsesStream` 直接从终止性的 `response.completed` / `response.incomplete` 流事件提取（`input_tokens`、`output_tokens`、`reasoning_tokens`、`cached_tokens`）。`packages/ai/src/usage/` 下不存在单独的用量跟踪器。
- **Prompt 缓存控制**：`prompt_cache_key` 经 `getOpenAIPromptCacheKey(options)` 生成。显式 prompt 缓存模式被拒绝（`AIError.ConfigurationError`），因为 Azure Responses 不支持显式缓存控制 header 或保留指令。

### Catalog 模型处理
- **描述符**：catalog provider 定义于 `packages/catalog/src/provider-models/descriptors.ts`（`id: "azure"`、`defaultModel: "gpt-5.5"`、`envVars: ["AZURE_OPENAI_API_KEY"]`）。在 `packages/catalog/src/provider-models/openai-compat.ts` 中经 `simpleModelsDevDescriptor("azure", "azure", "azure-openai-responses", "", ...)` 映射，它把 stencil catalog 模型过滤为具备工具能力的 OpenAI 家族 ID（`gpt-`、`o1`、`o3`、`o4`、`codex`、`chatgpt`），丢弃第三方 Foundry 模型（Claude、DeepSeek、Llama、Mistral、Phi）。
- **为何内置模型不带 `baseUrl`**：Azure OpenAI 端点是资源特定的，在 catalog 生成期间未知（`models.json` 存 `baseUrl: ""`）。运行时解析从 `AZURE_OPENAI_BASE_URL` 或 `AZURE_OPENAI_RESOURCE_NAME` 解析端点。Compat 检测（`packages/catalog/src/compat/openai.ts` 中的 `isAzure`）匹配 `provider === "azure"`，确保 `baseUrl` 为空的内置模型仍获得 Azure compat 标志（`strictResponsesPairing`、`supportsDeveloperRole`、`supportsStrictMode`）。
- **身份与分类**：`hosts.ts` 定义了 `azureOpenAI`，匹配 `provider: "azure"` 或以 `.openai.azure.com`、`azure.com/openai`、`models.inference.ai.azure.com` 结尾的主机名。
- **Thinking 元数据**：在 `packages/catalog/src/model-thinking.ts` 中，Azure 推理模型（o 系列、GPT-5、Codex）经 `DEFAULT_REASONING_EFFORTS_WITH_XHIGH` 解析离散的 OpenAI 推理 effort 档位（`minimal`、`low`、`medium`、`high`、`xhigh`、`max`）。

## Anthropic Messages
Anthropic provider（`packages/ai/src/providers/anthropic.ts`）以 HTTPS POST 到 `/v1/messages`（或 `/v1/messages?beta=true`）实现 Anthropic Messages API 协议，流式使用 Server-Sent Events（SSE）。自定义 HTTP 客户端传输由 `AnthropicMessagesClient`（`packages/ai/src/providers/anthropic-client.ts`）提供，以内置重试与超时逻辑取代 `@anthropic-ai/sdk`。线上结构与 SSE 载荷类型定义于 `packages/ai/src/providers/anthropic-wire.ts`。客户端指纹常量（版本、用户代理、工具前缀）位于 `packages/ai/src/providers/claude-code-fingerprint.ts`，而底层 Node HTTPS socket 复用与 header 排序由 `coworkFetch`（`packages/ai/src/providers/cowork-fetch.ts`）处理。

### 特殊处理
- **OAuth 与 API Key 路径**：`buildAnthropicHeaders`（`packages/ai/src/providers/anthropic.ts`）检查 `options.isOAuth ?? isAnthropicOAuthToken(apiKey)`。OAuth 请求发送 `Authorization: Bearer <token>` 且不带 `X-Api-Key`，默认 `Accept: application/json`（或 `text/event-stream`），并注入 Cowork 桌面 beta 标志（`buildCoworkBetas`）。API key 请求发送 `X-Api-Key: <key>` 不带 `Authorization`，且仅包含调用方的额外 beta。非官方端点在 `allowAnthropicHeaderOverrides` 启用时允许 header 覆盖。
- **Claude Code 指纹 Header 与 Beta**：默认 header 包括 `anthropic-version: 2023-06-01`、`anthropic-dangerous-direct-browser-access: true`、`x-app: cli` 和 `User-Agent: claude-cli/2.1.220 (external, claude-desktop)`（`coworkUserAgent`）。活动 beta 标志（`buildCoworkBetas`）包括 `claude-code-20250219`、`interleaved-thinking-2025-05-14`、`thinking-token-count-2026-05-13`、`context-management-2025-06-27`、`prompt-caching-scope-2026-01-05`、`mid-conversation-system-2026-04-07`、`advanced-tool-use-2025-11-20`、`effort-2025-11-24` 和 `fallback-credit-2026-06-01`（省略 `context-1m-2025-08-07` 以避免订阅令牌上的 429 credit 错误，#7238）。指纹元数据（`generateClaudeCloakingUserId`、`deriveClaudeDeviceId`、`generateClaudeJsonUserId`）生成设备/会话 ID。计费证明 header（`createClaudeBillingHeader`、`wrapFetchForCch`、`patchCch`）将 `cch=00000` XXHash64 哈希嵌入 `system[0]`。
- **系统 Prompt 注入**：`buildAnthropicSystemBlocks`（`packages/ai/src/providers/anthropic.ts`）在 OAuth 凭据下自动把 `claudeCodeSystemInstruction`（"You are a Claude agent, built on Anthropic's Claude Agent SDK."）前置为 `system[0]`。回合历史中的对话中途系统消息经 `mid-conversation-system-2026-04-07` 为 Opus 4.8+ / Sonnet 5+ 启用。
- **Thinking 签名与已编辑 thinking**：重放被修改或未签名的 thinking 块会导致 Anthropic API 错误（`invalid signature in thinking block`）。`convertAnthropicMessages` 转换 `ThinkingContent` 与 `RedactedThinkingContent`（`type: "redacted_thinking"`、`data`）。`maybeAddReplayUnsignedThinkingHint` 在签名错误时附加恢复提示，而 `unwrapAnthropicThinkingEnvelope` 剥离旧版 `<thinking>` XML 包装。
- **工具使用重放与前缀**：`encodeAnthropicToolName` / `decodeAnthropicToolName`（`packages/ai/src/providers/anthropic.ts`）在 OAuth 下给自定义工具名加 `_` 前缀（`claudeToolPrefix`），以避免与内置工具（`web_search`、`code_execution`、`text_editor`、`computer`）冲突。服务器执行的网页搜索与工具搜索（`anthropic-wire.ts` 中的 `AnthropicServerToolHistoryBlockParam`）经 `isAnthropicServerToolHistoryBlock` 检测以进行回合重放。空工具错误由 `ensureErrorToolResultWireContent` 填充。
- **严格工具 Schema 规范化与回退**：`normalizeAnthropicToolSchema` 与 `normalizeAnthropicStrictSchema` 为 `structured-outputs-2025-12-15` beta 剥离不支持的 JSON schema 关键字（如对象上的 `minItems`/`maxItems`）。若严格工具 schema 导致 HTTP 400，`streamAnthropicOnce` 调用 `dropAnthropicStrictTools` 并自动以非严格模式重试。
- **自适应与预算 thinking**：`ThinkingConfigParam`（`anthropic-wire.ts`）支持预算 thinking（`{ type: "enabled", budget_tokens: N }`，由 `ensureMaxTokensForThinking` 强制）与自适应 thinking（`{ type: "adaptive" }` 配 `output_config: { effort: level }`，经 `effort-2025-11-24` beta）。强制工具选择（`disableThinkingIfToolChoiceForced`）自动禁用 thinking。
- **Prompt 缓存断点**：`applyPromptCaching`（`packages/ai/src/providers/anthropic.ts:3195`，在 `:3506` 调用）在对话尾部标记一个双消息滚动窗口：它向两个尾随回合中每个的最后一个普通内容块附加 `cache_control: { type: "ephemeral" }`（对支持长保留的模型仅额外带 `ttl: "1h"`，由 `getCacheControl` 于 `:497` 构建），跳过 `thinking`、`redacted_thinking` 和 `fallback` 块（`applyCacheControlToLastBlock` 于 `:3179`）。当尾随用户消息是 assistant prefill 后追加的中性 `"Continue."` 填充时，窗口锚定到前面的真实 assistant。缓存从不应用于系统 prompt 或工具定义，且没有总断点上限。

### 流行为
- **事件协议**：`streamAnthropicOnce`（`packages/ai/src/providers/anthropic.ts`）中的 SSE 流发出标准框架事件：`message_start`（交付初始输入与缓存用量）、`content_block_start`（初始化块类型：text、thinking、tool_use、redacted_thinking、fallback）、`content_block_delta`（流式 `text_delta`、`thinking_delta`、`signature_delta`、`input_json_delta`）、`message_delta`（交付 `stop_reason` 与最终 `output_tokens`）、`content_block_stop`、`message_stop` 和 `ping`。
- **细粒度工具流式**：经 `fine-grained-tool-streaming-2025-05-14` beta 启用。传入的 `input_json_delta` 块累积在 `kStreamingPartialJson` 中，由 `parseStreamingJsonThrottled` 持续解析以呈现流式工具参数。
- **流看门狗与修复**：流在 `iterateWithIdleTimeout` 内使用 `getStreamFirstEventTimeoutMs` 与 `getStreamIdleTimeoutMs` 监控停顿超时。`ping` 事件（`ANTHROPIC_PING_EVENT`）重置空闲超时倍数。空补全响应（0 token）触发经 `withReplaySafeStreamRetry` 的自动重试。Fast 模式（`speed: "fast"`）失败清除会话 fast 模式状态（`clearAnthropicFastModeFallback`、`dropAnthropicFastMode`）以回退到标准执行。

### 认证与用量
- **OAuth 认证与 PKCE**：在 `packages/catalog/src/compat/rules/auth/anthropic.kdl` 中声明为 `login "oauth-code"` 规则（`packages/ai/src/registry/engine/oauth-code.ts`），身份钩子在 `packages/ai/src/registry/oauth/anthropic.ts`，使用解码的 Client ID（`OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl`）对 `https://claude.ai/oauth/authorize` 与 `https://api.anthropic.com/v1/oauth/token` 执行 PKCE `S256` 认证。OAuth 令牌携带 30 天的绝对授权 TTL（`anthropic-constants.ts` 中的 `ANTHROPIC_OAUTH_GRANT_TTL_MS`），无论刷新令牌轮换如何都要求每月交互式重新登录。账户身份经 `extractAccountFromTokenResponse` 或 `fetchBootstrapIdentity`（`/api/claude_cli/bootstrap`）解析。
- **配额跟踪与账户轮换**：`packages/ai/src/usage/claude.ts` 轮询 `https://api.anthropic.com/api/oauth/usage` 以跟踪滚动的 `five_hour`、`seven_day`、`limits[]`（`weekly_scoped`）和 `anthropic-ratelimit-unified-*` header。匹配 `isUsageLimitOutcome`（`packages/ai/src/error/rate-limit.ts`）与 `parseRateLimitReason`（`QUOTA_EXHAUSTED`）的错误触发自动凭据轮换。
- **错误分类**：HTTP 错误由 `parseRateLimitReason`（`packages/ai/src/error/rate-limit.ts`）分类为 `QUOTA_EXHAUSTED`（30 分钟退避 / 轮换）、`RATE_LIMIT_EXCEEDED`（30 秒退避）、`CONCURRENT_LIMIT`（5 秒退避）和 `MODEL_CAPACITY_EXHAUSTED`（45 秒 ± 15 秒退避）。瞬态 HTTP 408/409/429/5xx 错误由 `AnthropicMessagesClient`（`packages/ai/src/providers/anthropic-client.ts`）重试，尊重 `retry-after-ms` / `retry-after` header。

### Catalog 模型处理
- **模型身份与分类**：`isClaudeModelId`（`packages/catalog/src/identity/family.ts`）使用正则 `/(^|[/.])claude[-.]/i` 识别裸的、命名空间的（`anthropic/claude-*`）和 Bedrock（`us.anthropic.claude-*`）Claude 模型。`parseAnthropicModel`（`packages/catalog/src/identity/classify.ts`）解析模型种类（Opus、Sonnet、Fable、Mythos）、版本与变体。功能检查包括 `anthropicModelSupportsThinking`（v>=3.7）、`supportsAdaptiveThinkingDisplay`（v>=4.7）、`supportsMidConversationSystemMessages`（v>=4.8）和 `isAnthropicFableOrMythosModel`。
- **Provider 描述符**：`CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）定义 Anthropic provider 条目，`defaultModel: "claude-opus-4-8"`、`envVars: ["ANTHROPIC_API_KEY"]`，模型管理器选项为 `anthropicModelManagerOptions`。
- **Thinking 配置**：`resolveModelThinking`（`packages/catalog/src/model-thinking.ts`）派生 thinking 能力。现代自适应模型（Opus 4.7+、Sonnet 5+）使用 `FIVE_TIER_EFFORTS_LOW_TO_MAX`（`[low, medium, high, xhigh, max]`），较旧的自适应模型使用 `FOUR_TIER_EFFORTS_LOW_TO_MAX`。Effort 级别经 `mapEffortToAnthropicAdaptiveEffort` 映射到 Anthropic 线上值。
- **定价与倍率**：`packages/catalog/scripts/generate-models.ts` 中的 `COPILOT_PREMIUM_MULTIPLIERS` 在模型 catalog 生成期间为 GitHub Copilot Anthropic 模型分配 premium 倍率（如 `claude-opus-4.6`: 3x、`claude-haiku-4.5`: 0.33x）。

## Google Gemini
Google Gemini 集成使用基于 HTTP 的 REST/SSE（`POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse`）。核心 provider 入口是 `packages/ai/src/providers/google.ts`（`streamGoogle`）、`packages/ai/src/providers/google-shared.ts`（`streamGoogleGenAI`、`buildGoogleGenerateContentParams`、`convertMessages`、`consumeGoogleStream`）和 `packages/ai/src/providers/google-types.ts`。

### 特殊处理
- **`generateContent` 协议**：系统 prompt 在 `buildGoogleGenerateContentParams` 中提升为 `{ systemInstruction: { parts: [{ text }] } }`。工具格式化为 `tools[].functionDeclarations`，使用 `parametersJsonSchema`（经 `packages/ai/src/utils/schema/normalize.ts` 中的 `normalizeSchemaForGoogle` 清洗）。
- **`thinkingConfig` 映射**：`buildGoogleGenerateContentParams` 设置 `includeThoughts: !options.hideThinkingSummary`。Gemini 3 模型把 `options.thinking.level` 映射为 `thinkingLevel`（`THINKING_LEVEL_UNSPECIFIED`、`MINIMAL`、`LOW`、`MEDIUM`、`HIGH`）。Gemini 2.x 模型把 `options.thinking.budgetTokens` 映射为 `thinkingBudget`。Cloud Code Assist provider（`google-gemini-cli.ts`）在禁用时把 `thinking.suppress` 映射为显式 `includeThoughts: false` 加级别/预算（`suppressWhenOff`）。
- **函数调用 ID 合成与 Vertex AI 剥离**：`google-shared.ts` 中的 `nextToolCallId` 在 ID 缺失或重复时生成唯一 ID（`${name}_${Date.now()}_${++toolCallCounter}`）。`supportsFunctionPartId` 为 `claude-` 模型或 Gemini 3 模型（`isGemini3Model`）启用 `functionCall.id` / `functionResponse.id` 传播。`google-vertex` API 拒绝函数部分中的 `id` 字段，因此 `google-shared.ts` 为 Vertex 请求剥离 `part.functionCall.id` 与 `part.functionResponse.id`。
- **连续 `functionResponse` 规则**：Gemini 要求并行工具调用结果位于单条连续的 `user` 角色消息中。`google-shared.ts` 中的 `convertMessages` 检查 `lastContent` 并把 `functionResponse` 部分合并进已存在的 `user` 回合（`lastContent.parts.push(functionResponsePart)`）。
- **按版本的多模态函数响应**：Gemini 3+ 模型（经 `getGeminiMajorVersion >= 3` 检查 `supportsMultimodalFunctionResponse`）支持直接嵌套在 `functionResponse.parts` 内的内联工具输出图像。Gemini < 3 模型把工具图像缓冲到 `pendingToolImageParts`，并在随后单独的 `user` 文本/图像回合中刷出。
- **安全设置与 Prompt 反馈**：`PromptFeedback` 中的安全拦截（`blockReason`、`blockReasonMessage`）抛出带 `kind: "content-blocked"` 的 `AIError.ProviderResponseError`。`FinishReason` 值（`SAFETY`、`BLOCKLIST`、`PROHIBITED_CONTENT`、`SPII`、`IMAGE_SAFETY`、`RECITATION`、`MALFORMED_FUNCTION_CALL`、`UNEXPECTED_TOOL_CALL`、`NO_IMAGE`、`OTHER`）在 `mapStopReason` 中映射为 `stopReason: "error"`。

### 流行为
- **`streamGenerateContent` SSE 协议**：流在 `streamGoogleGenAI` 中经 `readSseJson<GenerateContentResponse>` 消费。
- **Thought 部分与签名保留**：`isThinkingPart` 在 `part.thought === true` 时识别推理文本。加密的 `part.thoughtSignature` 字段使用 `retainThoughtSignature` 跨增量保留。在 `convertMessages` 中，thought 签名仅在消息 provider/模型匹配目标（`msg.provider === model.provider && msg.model === model.id`）并通过 `isValidThoughtSignature`（base64 检查）时保留。对于缺少有效签名的 Gemini 3 工具调用，公共 Gemini API 在每个未签名调用上发出 `skip_thought_signature_validator` 旁路哨兵。Cloud Code Assist / Antigravity 仅在回合的第一次调用未签名时发出它；签名优先的并行回合会在未签名的次要调用上省略它。Vertex AI 始终省略该哨兵（#9638, #10602）。
- **空响应重试循环**：`streamGoogleGenAI` 防范 Gemini 在不调用工具的情况下返回 `finishReason: STOP` 且内容为空。`hasMeaningfulGoogleContent` 校验输出；若为空，`streamGoogleGenAI` 在经 `resetGoogleStreamOutputForRetry` 重置流输出后最多重试 `MAX_EMPTY_STREAM_RETRIES`（2 次重试，共 3 次尝试），带指数退避（`EMPTY_STREAM_BASE_DELAY_MS * 2^attempt`）。
- **Thinking 循环守卫**：实现于 `packages/ai/src/utils/thinking-loop.ts`（`ThinkingLoopDetector`）。Gemini、DeepSeek 和 Grok 模型 id 家族在工具调用前被监控三种失控形态：
  1. *逐字尾部重复*（`EXACT_TAIL_WINDOW = 4096`，>= 180 个重复字符）。
  2. *近重复片段*（跨最后 16 个片段的 trigram Jaccard 相似度 >= 0.8）。
  3. *进度词汇停滞*（8 个连续片段上新颖度 <= 0.2 且无新的具体引用锚点）。
  4. Gemini 的 `GEMINI_HEADER_RUNAWAY_THRESHOLD = 24` 会终止发出过多带标题推理摘要但不行动的流。触发时发出标记为 `AIError.Flag.ThinkingLoop` 的合成可重试 `error`。
- **Finish reason 映射与不完整流**：`candidate.finishReason` 经 `mapStopReason` 映射；若输出包含工具调用，`stop`/`length` 原因升级为 `toolUse`。没有 `finishReason` 的丢弃抛出带 `kind: "incomplete-stream"` 的 `ProviderResponseError`。
- **UsageMetadata 计量**：附加到尾随 chunk，在 `consumeGoogleStream` 中处理。`input` 计算为 `promptTokenCount - (cachedContentTokenCount || 0)`；`output` 为 `candidatesTokenCount + (thoughtsTokenCount || 0)`；`cacheRead` 为 `cachedContentTokenCount || 0`；`reasoningTokens` 为 `thoughtsTokenCount`。Token 成本经 `calculateCost(model, output.usage)` 计算。

### 认证与用量
- **凭据来源**：直接经 `x-goog-api-key: apiKey` header 认证（或经 `packages/ai/src/providers/google.ts` 中的 `getEnvApiKey(model.provider)` 获取的 `GEMINI_API_KEY` 环境变量）。
- **用量跟踪器**：`packages/ai/src/usage/gemini.ts` 中的 `googleGeminiCliUsageProvider` 通过调用 `POST /v1internal:loadCodeAssist`（用于项目解析）和 `POST /v1internal:retrieveUserQuota` 监控 OAuth 支持的 Cloud Code Assist 用量。配额桶映射到层级（`Flash`、`Pro`、`3-Flash`），带剩余比例使用百分比和重置窗口（`parseWindow`）。

### Catalog 模型处理
- **身份与分类**：`packages/catalog/src/identity/classify.ts` 中的 `parseGeminiModel` 解析匹配 `gemini-{version}-{kind}`（可选 `-preview` 后缀）的模型 ID，返回 `GeminiModel`（`family: "gemini"`、`kind: "pro" | "flash"`、`version: SemVer`）。
- **Thinking 元数据与级别**：`packages/catalog/src/model-thinking.ts` 使用 `ThinkingLevel` 枚举字符串（`THINKING_LEVEL_UNSPECIFIED`、`MINIMAL`、`LOW`、`MEDIUM`、`HIGH`）配置 thinking 选项。Gemini 3 模型定义了 effort 阶梯：`GEMINI_3_PRO_EFFORTS`（`[low, high]`）和 `GEMINI_3_FLASH_EFFORTS`（`[minimal, low, medium, high]`）。
- **描述符与发现**：配置于 `packages/catalog/src/provider-models/descriptors.ts`（`google` 的 `CATALOG_PROVIDERS` 条目，默认模型 `gemini-3.1-pro-preview`、`GEMINI_API_KEY`）。`packages/catalog/src/discovery/gemini.ts`（`fetchGeminiModels`）中的动态发现获取 `GET /v1beta/models?key=...`，过滤 `generateContent` 方法并解析 `inputTokenLimit` 与 `outputTokenLimit`。
- **定价与 Antigravity 回填**：基础价格经 `calculateCost` 计算。在 `scripts/generated-policies.ts` 与 `scripts/generate-models.ts` 中，`google-antigravity` 模型上游报告 $0 定价，用 `ANTIGRAVITY_PRICING_PEERS`（`["google", "google-vertex", "anthropic"]`）回填，并经 `ANTIGRAVITY_PRICING_ID_ALIASES` 解析 Gemini 别名（如 `gemini-3-flash` -> `gemini-3-flash-preview`）。

## Google Vertex AI

Google Vertex AI provider 为托管在 Google Cloud Vertex AI 上的 Gemini 模型以及经 Vertex 端点服务的第三方模型（如 Anthropic Claude）启用流式生成。入口包括 `packages/ai/src/providers/google-vertex.ts` 中的 `streamGoogleVertex`（Gemini 模型，API 类型 `"google-vertex"`）、`packages/ai/src/stream.ts` 中经 `createVertexAuthenticatedFetch` 的 `streamAnthropic`（Claude 模型，API 类型 `"anthropic-messages"`），以及 `packages/ai/src/providers/google-auth.ts` 中的 ADC 认证。传输使用 HTTPS REST / SSE，凭据为 Application Default Credentials（ADC OAuth Bearer 令牌）或 Vertex Express Mode API key（`x-goog-api-key`）。

### 特殊处理
* **端点与项目/位置解析**：在 ADC 模式（`packages/ai/src/providers/google-vertex.ts`）下，请求 URL 遵循 `https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${model.id}:streamGenerateContent?alt=sse`。`project` 从 `options.project`、`$env.GOOGLE_CLOUD_PROJECT`、`$env.GCP_PROJECT` 或 `$env.GCLOUD_PROJECT` 解析（缺失时抛 `ConfigurationError`）。`location` 从 `options.location`、`$env.GOOGLE_VERTEX_LOCATION`、`$env.GOOGLE_CLOUD_LOCATION` 或 `$env.VERTEX_LOCATION` 解析（缺失时抛 `ConfigurationError`）。在 Express Mode（API Key 模式，经 `options.apiKey` 或 `$env.GOOGLE_CLOUD_API_KEY`）下，URL 遵循 `https://${host}/v1/publishers/google/models/${model.id}:streamGenerateContent?alt=sse`，带 `x-goog-api-key` header，`location` 默认 `"global"`，并在环境区域主机失败时回退到全局端点。
* **端点主机解析**：`packages/catalog/src/hosts.ts` 中的 `resolveVertexEndpointHost(location)` 将位置映射到主机名：`"global"` → `aiplatform.googleapis.com`；多区域 `"eu"` / `"us"` → `aiplatform.{location}.rep.googleapis.com`（防止标准插值导致的 404）；区域（如 `"us-central1"`、`"europe-west4"`）→ `${location}-aiplatform.googleapis.com`。
* **函数调用与响应 ID 剥离**：`packages/ai/src/providers/google-shared.ts` 中的 `supportsFunctionPartId(model)` 对 `google-vertex` 返回 `false`。`convertMessages` 在线上序列化前显式删除 `part.functionCall.id` 与 `functionResponsePart.functionResponse.id`，因为当函数部分包含 `id` 字段时 Vertex AI 返回 `400 INVALID_ARGUMENT`。
* **安全设置默认值**：`packages/ai/src/providers/google-vertex.ts` 中的 `streamGoogleVertex` 在未配置时自动向 `params.config.safetySettings` 注入禁用所有危害类别的安全设置（`HARM_CATEGORY_HATE_SPEECH`、`HARM_CATEGORY_DANGEROUS_CONTENT`、`HARM_CATEGORY_SEXUALLY_EXPLICIT`、`HARM_CATEGORY_HARASSMENT` 设为 `threshold: "OFF"`）。
* **服务层级优先级 header**：直接的 `serviceTier` 请求体字段被 Vertex 忽略；`options.serviceTier === "priority"` 作为请求 header `X-Vertex-AI-LLM-Shared-Request-Type: priority` 传输（`google-vertex.ts`）。`flex` 没有受文档支持的控制方式，是无操作。
* **缓存内容透传**：把调用方提供的 `cachedContent` 资源名不透明地传入 `params.config.cachedContent`（`google-shared.ts`），绕过创建/刷新生命周期。

### 流行为
* **Gemini 流式执行**：委托给 `packages/ai/src/providers/google-shared.ts` 中的 `streamGoogleGenAI` 与 `consumeGoogleStream`，带 `retainTextSignature: true`。处理 SSE chunk 解析、文本/thinking 块聚合（`thoughtSignature`）、工具调用 ID 合成（Vertex 省略时生成 ID）与 finish reason。
* **Vertex 上的 Anthropic RawPredict 处理**：`packages/ai/src/stream.ts` 中的 `isGoogleVertexAuthenticatedModel` 匹配 `model.provider === "google-vertex"`、`anthropic-messages` API 与 `:streamRawPredict` baseUrl。请求经 `streamAnthropic` 路由，使用 `apiKey: "vertex-adc"` 与 `createVertexAuthenticatedFetch`。
* **Anthropic 请求重写**：`packages/ai/src/stream.ts` 中的 `createVertexAuthenticatedFetch` 调用 `resolveVertexRequest` 替换 URL 中的 `{project}` 与 `{location}` 占位符，规范化 `:streamRawPredict/v1/messages` 路径为 `:streamRawPredict`，并应用 `transformVertexAnthropicBody` 剥离 `payload.model`（编码在 URL 路径中）并向 JSON 体注入 `payload.anthropic_version = "vertex-2023-10-16"`。
* **Anthropic effort beta 门控**：Vertex `rawPredict` 以 400 错误拒绝 `anthropic-beta` HTTP header。在 `packages/ai/src/providers/anthropic.ts` 中，`effortBeta`（`effort-2025-11-24`）、`contextManagementBeta` 与 `output_config.effort` 字段在 `model.provider === "google-vertex"` 时被门控关闭。`anthropic.ts` 中的回退载荷也在 Vertex 请求上清除 `output_config.effort`（#5614）。

### 认证与用量
* **ADC 解析阶梯**：`packages/ai/src/providers/google-auth.ts` 按优先级解析凭据：
  1. `GOOGLE_APPLICATION_CREDENTIALS` 环境变量指向 JSON 凭据文件。支持 `type: "service_account"`（经 WebCrypto `crypto.subtle` 签名的 RS256 JWT 断言，在 `https://oauth2.googleapis.com/token` 交换）、`type: "authorized_user"`（刷新令牌交换）或 `type: "impersonated_service_account"`（先交换源凭据再调用 GCP IAM `generateAccessToken`）。
  2. 用户 ADC 文件 `~/.config/gcloud/application_default_credentials.json`（`authorized_user` 流程）。
  3. GCE / Cloud Run 元数据服务器（`http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token`）。
* **显式访问令牌覆盖**：`GOOGLE_CLOUD_ACCESS_TOKEN` 或 `CLOUDSDK_AUTH_ACCESS_TOKEN` 环境变量完全绕过文件/元数据查找与缓存。
* **令牌缓存与在途去重**：访问令牌存储在 `tokenCache`（Map）中，按解析来源为键，并在过期前 `GOOGLE_VERTEX_REFRESH_SKEW_MS` 刷新（默认 60s）。并发解析请求共享 `inflight` Map 中的单个在途 promise，以 `SHARED_TOKEN_RESOLVE_TIMEOUT_MS`（30s）为界。各调用方经 `raceWithSignal` 将自己的中止信号与共享 promise 竞争，因此一个调用方的中止不会取消批量解析。请求的 OAuth 作用域：`https://www.googleapis.com/auth/cloud-platform`。
* **用量与 token 规范化**：`packages/ai/src/providers/google-shared.ts` 中的 `consumeGoogleStream` 从响应提取 `usageMetadata`：`input` 计算为 `promptTokenCount - cachedContentTokenCount`，`output` 为 `candidatesTokenCount + thoughtsTokenCount`，`cacheRead` 为 `cachedContentTokenCount`，`reasoningTokens` 为 `thoughtsTokenCount`。把规范化后的用量传给 `calculateCost(model, output.usage)`。

### Catalog 模型处理
* **Catalog API 解析**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `resolveGoogleVertexApi` 把 `@ai-sdk/google-vertex/anthropic` npm 包模型路由到 `api: "anthropic-messages"` 与 `GOOGLE_VERTEX_ANTHROPIC_BASE_URL`（`https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/anthropic/models/{model}:streamRawPredict`）。带斜杠 ID 或 `@ai-sdk/openai-compatible` 的模型路由到 `api: "openai-completions"`。其余模型路由到 `api: "google-vertex"` 与 `GOOGLE_VERTEX_BASE_URL`（`https://{location}-aiplatform.googleapis.com`）。
* **Provider 描述符**：`packages/catalog/src/provider-models/descriptors.ts` 注册 `id: "google-vertex"`，`defaultModel: "gemini-3.1-pro-preview"`。
* **注册表凭据守卫**：在 `packages/catalog/src/compat/rules/auth/google-vertex.kdl` 中经 `env hook="google-vertex-adc"`（`packages/ai/src/registry/hooks/env.ts`）声明。若设置了 `$env.GOOGLE_CLOUD_API_KEY` 则返回它；若 ADC 凭据存在（`hasVertexAdcCredentials()`）且项目环境（`GOOGLE_CLOUD_PROJECT`/`GCP_PROJECT`/`GCLOUD_PROJECT`）与位置环境（`GOOGLE_VERTEX_LOCATION`/`GOOGLE_CLOUD_LOCATION`/`VERTEX_LOCATION`）都存在，则返回 `AUTHENTICATED_SENTINEL`（`"<authenticated>"`）。否则返回 `undefined`，防止模型在缺少正确认证时出现在 catalog 列表中。

## Google Gemini CLI / Antigravity
Google Cloud Code Assist（CCA）传输包装，经 `/v1internal:streamGenerateContent` SSE 端点访问 Gemini 与 Claude 模型。实现横跨 `packages/ai/src/providers/google-gemini-cli.ts`（共享执行引擎、请求构建、流解析与规划泄漏过滤器）、`packages/catalog/src/compat/rules/auth/google-gemini-cli.kdl` 与 `packages/catalog/src/compat/rules/auth/google-antigravity.kdl`（认证策略声明）、`packages/ai/src/registry/oauth/google-gemini-cli.ts` 与 `google-antigravity.ts`（OAuth 钩子、项目发现与入门）、`packages/ai/src/usage/google-antigravity.ts` 与 `packages/ai/src/usage/gemini.ts`（配额跟踪与凭据排名），以及 `packages/catalog/src/discovery/antigravity.ts`（模型 catalog 发现）。

### 特殊处理
- **CCA JSON Schema 规范化**：`normalizeSchemaForCCA`（`packages/ai/src/utils/schema/normalize.ts`）递归剥离不支持的 JSON Schema 关键字（`propertyNames`、`additionalProperties`、`patternProperties`、`$schema`、`title`、`description` 等），以防止 CCA 的 HTTP 400 错误。它准确跟踪名为 `properties` 的属性内部的上下文，避免过早重新断言属性剥离。工具在 `buildRequest`（`packages/ai/src/providers/google-gemini-cli.ts`）中经 `normalizeSchemaForCCA` 规范化。
- **函数调用配置模式**：在 `buildRequest` 中为 Antigravity 默认 `functionCallingConfig: { mode: "VALIDATED" }`。Antigravity 上的 Claude 模型即使上下文中没有声明工具也强制 `VALIDATED` 模式（`isClaudeModel`）。单一具名工具选择（`options.toolChoice`）设置 `mode: "ANY"` 与 `allowedFunctionNames: [...]`。
- **Provider 协议与请求信封**：
  - **端点**：`google-gemini-cli` 默认 `https://cloudcode-pa.googleapis.com`。`google-antigravity` 在 `https://daily-cloudcode-pa.googleapis.com`（主）与 `https://daily-cloudcode-pa.sandbox.googleapis.com`（沙箱）之间自动故障转移，在 `AntigravityProviderSessionState` 中持久化 `lastGoodEndpoint`。
  - **Header 与 User-Agent**：`google-gemini-cli` 发送 `getGeminiCliHeaders()`（`GeminiCLI/0.46.0/<modelId> (platform; arch; terminal)`）。`google-antigravity` 发送 `getAntigravityUserAgent()`（`antigravity/hub/<version> (aidev_client; os_type=<os>; arch=<arch>; cl=<cl>)`）；后端按客户端版本门控较新模型（如 gemini-3.7-flash）。Antigravity 上的推理 Claude 模型发送 `anthropic-beta: interleaved-thinking-2025-05-14`（`needsClaudeThinkingBetaHeader`）。
  - **系统指令**：Antigravity 用 `role: "user"` 标记系统指令。不注入身份 prompt——后端在所有路由上接受任意系统指令（已对照 gemini-3.x 与 Claude 线上 id 验证）。
  - **请求信封与会话状态**：Antigravity 用 `buildAntigravityRequestEnvelope` 包装请求：`project`（projectId）、`requestId`（`agent/<agentId>/<ts>/<trajectoryId>/<step>`）、`userAgent`（`antigravity`）、`requestType`（`agent`）和 `labels`（`last_step_index`、`model_enum`、`trajectory_id`、`used_claude`、`used_claude_conservative`、`last_execution_id`）。状态维护单调递增的 `stepIndex`、持久 `agentId`、`trajectoryId` 与带符号十进制的 `sessionId`（`deriveAntigravitySessionId`）。
  - **线上配置档**：`getAntigravityModelWireProfile`（`packages/catalog/src/wire/gemini-headers.ts`）将线上 ID 映射到 `maxOutputTokens` 与 `model_enum`。Claude 线上 ID 将 `maxOutputTokens` 上限设为 `64000`（后端拒绝 >64000 并返回 400）。
- **Thinking 配置与线上抑制**：Gemini 2.x 模型发送 `thinkingConfig.thinkingBudget`，而 Gemini 3 模型发送 `thinkingConfig.thinkingLevel`。当带 `thinking.suppressWhenOff` 的模型推理被禁用时，`buildRequest` 发出显式线上抑制（`includeThoughts: false` 加级别/预算）。省略 `thinkingConfig` 会导致 CCA 重新应用服务器默认值并静默计费 thinking token。

### 流行为
- **传输与 SSE 协议**：经 `readSseJson<CloudCodeAssistResponseChunk>` 消费 `POST /v1internal:streamGenerateContent?alt=sse`。chunk 交付 `candidates[0].content.parts`、`usageMetadata`、`modelVersion`、`responseId`、`promptFeedback` 或顶层 `error`。
- **带宽内错误与拦截原因**：`chunk.error` status/code >= 400 抛出 `AIError.GeminiCliApiError` 或 `AIError.ProviderResponseError`。`promptFeedback.blockReason` 抛出带 `kind: "content-blocked"` 的 `AIError.ProviderResponseError`。
- **规划泄漏检测与过滤**：Flash 模型（`isFlashLeakModel`）可能将原始 JSON 内部规划块流入可见文本部分。`consumePlanningBuffer` 使用 `isPlanningLeakPrefix` 与 `splitLeadingJsonObject` 检查以 `{` 或 `"thought":` 开头的前缀。若解析出的 JSON 包含 `thought`、`call`（匹配活动工具名）、`_i`、`paths`、`command` 或 `path`/`content`，该对象被分类为 `kind: "leak"` 并从可见输出中剥离。
- **Thinking 部分与签名保留**：带 `thought: true` 或 `isThinkingPart()` 的部分路由到 thinking 块。text、thinking 或 toolCall 部分上的 `thoughtSignature` 经 `retainThoughtSignature` 保留。内联 `<thinking>` 标签使用 `StreamMarkupHealing` 处理。
- **空流重试**：Google 模型可能返回 `finishReason: "STOP"` 且文本部分为空、无工具调用。`hasMeaningfulGoogleContent` 检查非空文本、thinking 或工具调用。带 `stopReason === "stop"` 的空响应在失败前最多触发 `MAX_EMPTY_STREAM_RETRIES`（3 次重试），带指数退避（`EMPTY_STREAM_BASE_DELAY_MS` = 1000ms）（`packages/ai/src/providers/google-gemini-cli.ts`）。
- **响应前看门狗**：以 `getStreamFirstEventTimeoutMs`（5 分钟上限）启动 `armPreResponseTimeout`，防止 HTTP 代理连接在第一个 SSE chunk 到达前挂起。原生 Bun fetch 的响应前超时被禁用（`timeout: false`）。

### 认证与用量
- **凭据模型与令牌过期**：凭据以 JSON 存储（`parseGeminiCliCredentials`）：`{ token, projectId, refreshToken, expiresAt, email }`。AuthStorage 是唯一的刷新权威。`shouldRefreshGeminiCliCredentials` 以 60s 偏移检查令牌过期（`ANTIGRAVITY_REFRESH_SKEW_MS` / `GOOGLE_GEMINI_REFRESH_SKEW_MS`）。过期令牌在发起 HTTP 请求前快速失败。
- **OAuth 已安装应用流程**：回调端口为 `8085`（`google-gemini-cli`，`/oauth2callback`）和 `51121`（`google-antigravity`，`/oauth-callback`）。支持粘贴码流程（`pasteCodeFlow: true`）。经 Google PKCE OAuth 2.0（`accounts.google.com/o/oauth2/v2/auth`）授权。Antigravity 作用域包括 `cloud-platform`、`userinfo.email`、`userinfo.profile`、`cclog` 和 `experimentsandconfigs`。
- **项目发现与入门**：
  - `google-gemini-cli`（`packages/catalog/src/compat/rules/auth/google-gemini-cli.kdl`，钩子在 `packages/ai/src/registry/oauth/google-gemini-cli.ts`）：以 `$GOOGLE_CLOUD_PROJECT` 回退调用 `POST /v1internal:loadCodeAssist`。若项目缺失，调用 `POST /v1internal:onboardUser` 带 `tierId`（`free-tier`、`legacy-tier`、`standard-tier`）并经 `pollOperation` 轮询 `LongRunningOperationResponse`（最多 `POLL_MAX_ATTEMPTS` = 24，5 秒间隔）。检测 VPC-SC 限制（`SECURITY_POLICY_VIOLATED`）。
  - `google-antigravity`（`packages/catalog/src/compat/rules/auth/google-antigravity.kdl`，钩子在 `packages/ai/src/registry/oauth/google-antigravity.ts`）：对 `https://daily-cloudcode-pa.googleapis.com` 镜像原生 `antigravity/hub` 流程：`loadCodeAssist` 请求携带 `{ metadata: { ideType: "ANTIGRAVITY" } }`，当响应缺少 `paidTier` 时带 `cloudaicompanionProject` 重复，解析账户状态后刷新。没有 `currentTier` 的账户以 `onboardUser` 与 `tierId: "free-tier"` 配置一次；其长运行操作在 30 秒截止时间内每秒轮询一次 `GET /v1internal/{operation.name}`。
- **用量与配额跟踪（`google-antigravity`）**：`antigravityUsageProvider`（`packages/ai/src/usage/google-antigravity.ts`）查询 `POST /v1internal:fetchAvailableModels`。将配额桶规范化为日（24h）与周（7d）窗口。按后端计数器键（`Anthropic`、`Google`、`OpenAI`）对配额去重。`antigravityRankingStrategy` 按请求的模型家族限定排名作用域（`getAntigravityCounterKeyForModel`：`claude-` → Anthropic、`gemini-`/`gemma-` → Google、`gpt-`/`openai/` → OpenAI），选择有可用配额余量的已存 OAuth 凭据。
- **用量与配额跟踪（`google-gemini-cli`）**：`googleGeminiCliUsageProvider`（`packages/ai/src/usage/gemini.ts`）查询 `loadCodeAssist` 与 `retrieveUserQuota`，按模型层级（`3-Flash`、`Flash`、`Pro`）呈现配额百分比。

### Catalog 模型处理
- **Provider 描述符**：`google-antigravity`（默认模型 `gemini-3.1-pro`）与 `google-gemini-cli`（默认模型 `gemini-3.1-pro-preview`）定义于 `CATALOG_PROVIDERS`，`specialModelManager: true`（`packages/catalog/src/provider-models/descriptors.ts`），绕过标准工厂。
- **模型解析与发现**：`googleAntigravityModelManagerOptions` 与 `googleGeminiCliModelManagerOptions`（`packages/catalog/src/provider-models/google.ts`）调用 `fetchAntigravityDiscoveryModels`（`packages/catalog/src/discovery/antigravity.ts`）。
- **身份与 thinking 元数据**：解析为 `family: "gemini"`，种类为 `pro` / `flash`（`packages/catalog/src/identity/classify.ts`）。Gemini 3.0+ 模型强制推理（`model-thinking.ts` 中的 `impliesMandatoryReasoning`）。Effort：`GEMINI_3_PRO_EFFORTS`（`[Low, High]`）与 `GEMINI_3_FLASH_EFFORTS`（`[Minimal, Low, Medium, High]`）。
- **变体折叠**：effort 档位变体在发现时折叠为逻辑规格（`packages/catalog/src/variant-collapse.ts`）：
  - `gemini-3.5-flash`：折叠 `gemini-3.5-flash-extra-low`、`gemini-3.5-flash-low`、`gemini-3-flash-agent`。Antigravity 预算模式映射 Minimal/Low → `extra-low`（1000 token）、Medium → `low`（4000 token）、High → `agent`（10000 token）。Gemini CLI 映射到级别传输。别名：`gemini-3-flash`。
  - `gemini-3.6-flash`：把 `gemini-3.6-flash-low`、`-medium`、`-high`、`-tiered` 折叠为带 `google-level` 模式的 `gemini-3.6-flash`。
  - `gemini-3.1-pro`：折叠 `gemini-3.1-pro-low`、`gemini-pro-agent`、`gemini-3.1-pro-high`。High effort 路由到 `gemini-pro-agent`，因为上游 `gemini-3.1-pro-high` 部署在 streamGenerateContent 上返回 INVALID_ARGUMENT。
  - `claude-*`：裸的与 `-thinking` 对使用 `thinkingPair` 折叠为 `claude-*`（`preserveAbsentEffortRoutes: true`）。
- **Catalog 生成器集成**：`fetchAntigravityModels`（`packages/catalog/scripts/generate-models.ts`）经发现令牌获取模型（从 `google-antigravity` 回退到 `google-gemini-cli` OAuth 凭据）并把 `baseUrl` 固定为 `https://daily-cloudcode-pa.googleapis.com`。

## Amazon Bedrock
Amazon Bedrock（`amazon-bedrock` provider，`bedrock-converse-stream` API）使用 AWS SigV4 签名或显式 bearer 令牌，经 HTTPS POST 请求直接与 `bedrock-runtime.{region}.amazonaws.com/model/{modelId}/converse-stream` 通信，解码二进制 `application/vnd.amazon.eventstream` 响应。该实现绕过沉重的 AWS SDK 依赖（`@aws-sdk/*`、`@smithy/*`），执行用 WebCrypto 签名的原生 fetch，并经轻量 eventstream 解析器解码。入口模块包括 `packages/ai/src/providers/amazon-bedrock.ts`（`streamBedrock`）、`packages/ai/src/registry/amazon-bedrock.ts`（`amazonBedrockTransport`）、`packages/catalog/src/compat/rules/auth/amazon-bedrock.kdl` 中的认证策略、`packages/ai/src/registry/aws.ts`、`packages/ai/src/providers/aws-credentials.ts`（`resolveAwsCredentials`）、`packages/ai/src/providers/aws-eventstream.ts`（`decodeEventStream`）和 `packages/ai/src/providers/aws-sigv4.ts`（`signRequest`）。

### 特殊处理
- **Converse API 载荷与消息映射**：请求构建 `ConverseStreamRequest`，包含 `messages`、`system`、`inferenceConfig`（`maxTokens`、`temperature`、`topP`）、`toolConfig` 和 `additionalModelRequestFields`。系统 prompt 规范化为带文本块和 `CachePoint` 标记（`{ cachePoint: { type: "default", ttl?: "1h" } }`）的 `SystemContent[]`。用户内容映射为 `text`、`image`（`jpeg`/`png`/`gif`/`webp` base64，经 `createImageBlock`）、`toolResult` 或 `cachePoint`。Bedrock 要求连续的工具结果块合并为单条 `user` 角色 `WireMessage`（`convertMessages` 循环合并相邻的 `toolResult` 回合）。空文本块与空内容数组被过滤以避免 HTTP 400 校验失败。
- **NO_TOOLS_SENTINEL（`__no_tools__`）**：Bedrock 校验任何包含先前 `toolUse` 或 `toolResult` 块的请求必须提供 `toolConfig`。当工具被禁用（`toolChoice: "none"`）或在有工具历史的回合上为空时，`planToolConfig` 注入占位工具 `NO_TOOLS_SENTINEL`（`name: "__no_tools__"`，哑 schema）。逐请求标志 `sentinelInjected` 跟踪注入（因此调用方名为 `__no_tools__` 的工具正常工作）。当 `sentinelInjected` 为 true 时，`handleContentBlockStart` 忽略合成工具使用开始事件，`messageStop` 把 `stopReason: "tool_use"` 降级为 `"stop"`。
- **Thinking 与推理（`additionalModelRequestFields`）**：
  - `anthropic-adaptive` 模型（Claude Opus 4.7+、Sonnet/Opus 5、Fable/Mythos 5）：经 `mapEffortToAnthropicAdaptiveEffort` 映射为 `{ thinking: { type: "adaptive", display? }, output_config: { effort } }`。`thinkingDisplay` 在支持 display 的模型上默认 `"summarized"`，以避免 Anthropic `"omitted"` 默认值下的静默推理流（issue #1373）。
  - 预算模式模型（如 Claude 3.7 / 4.6）：映射为 `{ thinking: { type: "enabled", budget_tokens, display }, anthropic_beta? }`。当 `interleavedThinking` 为 true 时设置 `anthropic_beta: ["interleaved-thinking-2025-05-14"]`。
  - 强制工具选择冲突：当 `toolChoice` 强制工具执行（`any` 或具名 `{ tool: { name } }`）时，Bedrock 拒绝 thinking。`streamBedrock` 在强制工具选择激活时清除 `additionalModelRequestFields`。
  - Thinking 签名与降级：Claude 模型（`supportsThinkingSignature`）上缺少 `thinkingSignature` 的 assistant thinking 块经 `renderDemotedThinking` 降级为文本。非 Claude 模型（Nova、Titan、Llama、Mistral）拒绝 thinking 签名，接收未签名的 `reasoningContent`。
- **区域与推理配置档解析**：`resolveBedrockRegion` 按顺序解析运行时区域：显式 `options.region` -> ARN 内嵌区域（`inferRegionFromBedrockArn`）-> 环境环境变量/配置档区域（`resolveAwsAmbientRegion`）。对地理前缀的跨区域推理配置档（`us.`、`us-gov.`、`eu.`、`apac.`、`au.`、`jp.`），`regionServesGeo` 验证环境区域兼容性；不匹配或缺失的环境区域回退到地理默认端点（`INFERENCE_PROFILE_GEO_DEFAULT_REGION`：`us` -> `us-east-1`、`us-gov` -> `us-gov-west-1`、`eu` -> `eu-west-1`、`apac` -> `ap-southeast-1`、`au` -> `ap-southeast-2`、`jp` -> `ap-northeast-1`）。`global.` 配置档使用环境区域或 `us-east-1`。

### 流行为
- **AWS Eventstream 二进制解码**：以大端整数框架（`[total len u32][headers len u32][prelude CRC u32][headers][payload][message CRC u32]`）。`packages/ai/src/providers/aws-eventstream.ts` 中的 `decodeMessage` 检查总长度（最小 16 字节），经 `Bun.hash.crc32(bytes) >>> 0`（`crc32`）计算 IEEE 802.3 CRC32，并验证 prelude（前 8 字节）与消息 CRC（除最后 4 字节外的整个帧）。Header 解析器（`parseHeaders`）读取类型化 header（bool、byte、short、int、long、byte-array、string、timestamp、uuid）。`decodeEventStream` 使用可增长的 Uint8Array 缓冲从 `ReadableStream<Uint8Array>` 产出消息，并在中止时取消读取器锁。
- **事件分发与错误处理**：携带 `:message-type = "event"` 的流消息分发：
  - `messageStart`：验证 `role === "assistant"` 并推送流 `start`。
  - `contentBlockStart`：推送 `toolcall_start`（跳过哨兵）。
  - `contentBlockDelta`：推送 `text_delta`（缺失时创建文本块）、`toolcall_delta`（在 `kStreamingPartialJson` 中累积 JSON 输入增量，经 `parseStreamingJsonThrottled` 节流）或 `thinking_delta`（累积推理文本与签名）。
  - `contentBlockStop`：经 `parseStreamingJson` 解析工具 JSON 并推送 `text_end`/`thinking_end`/`toolcall_end`。
  - `messageStop`：映射 `stopReason`（`end_turn`/`stop_sequence` -> `stop`、`max_tokens`/`model_context_window_exceeded` -> `length`、`tool_use` -> `toolUse`）。
  - `metadata`：提取用量（`inputTokens`、`outputTokens`、`cacheReadInputTokens`、`cacheWriteInputTokens`）并调用 `calculateCost`。
  - `:message-type = "exception"` 提取 `:exception-type` 与错误载荷抛出 `BedrockApiError`（400）。`:message-type = "error"` 提取 `:error-code` 与 `:error-message`。
- **空闲看门狗与响应前超时**：Bun 原生 `fetch` 超时被禁用（`timeout: false`）以支持长 prefill prompt。响应前超时经 `armPreResponseTimeout` 以 `streamFirstEventTimeoutMs` 启动。Bedrock 流在推理期间不发送 ping/keepalive 事件；catalog compat（`packages/catalog/src/compat/bedrock.ts` 的 `buildBedrockCompat`）为标准推理模型把 `streamIdleTimeoutMs` 下限设为 600s，自适应 thinking 模型（Claude Opus 4.7+、Sonnet/Opus 5、Fable 5）为 900s。

### 认证与用量
- **双认证模式**：
  - Bearer 令牌：若存在 `options.bearerToken`、`options.apiKey` 或 `$env.AWS_BEARER_TOKEN_BEDROCK`（`resolveAwsBearerToken`），设置 `Authorization: Bearer <token>` 并绕过 SigV4 签名。
  - AWS SigV4 签名：`signRequest`（`packages/ai/src/providers/aws-sigv4.ts`）使用 WebCrypto（`crypto.subtle`）签名 header。计算 SHA-256 载荷摘要（`x-amz-content-sha256`）、日期（`x-amz-date`）、host 和安全令牌（`x-amz-security-token`）。派生 HMAC-SHA256 签名密钥链（`AWS4` + `secretAccessKey` -> `kDate` -> `kRegion` -> `kService`（"bedrock"）-> `kSigning`）。
- **5 层凭据解析链**：`resolveAwsCredentials`（`packages/ai/src/providers/aws-credentials.ts`）按 `profile\0region\0config` 键缓存已解析凭据，带 60s 刷新偏移（`REFRESH_SKEW_MS`）与以 30s 超时为界的单飞在途去重（`SHARED_RESOLVE_TIMEOUT_MS`）。链优先级：
  1. 环境变量：`AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`、可选 `AWS_SESSION_TOKEN`。
  2. Web Identity / OIDC：`AWS_WEB_IDENTITY_TOKEN_FILE`、`AWS_ROLE_ARN`、`AWS_ROLE_SESSION_NAME`。在 `sts.{region}.amazonaws.com` 上调用 STS `AssumeRoleWithWebIdentity`。
  3. 共享配置 / 配置档（`~/.aws/credentials`、`~/.aws/config`，经 `parseAwsIni` 解析）：静态密钥（文件会话令牌经 `FILE_SESSION_CREDS_TTL_MS` 上限 5 分钟 TTL）、AWS SSO（`sso_account_id`、`sso_role_name`、旧版 `sso_start_url`/`sso_region` 或 `sso-session` 块；从 `~/.aws/sso/cache/*.json` 读取缓存令牌并调用 `portal.sso.{ssoRegion}.amazonaws.com/federation/credentials`），或 `credential_process`（使用 POSIX 分词 `tokenizeCredentialProcessCommand` 派生外部进程；Windows `.cmd`/`.bat` 经 `cmd.exe /c` 路由；期望 Version 1 JSON 信封）。
  4. ECS / 容器：`AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`（在 `http://169.254.170.2/` 上）或带可选认证令牌/文件的 `AWS_CONTAINER_CREDENTIALS_FULL_URI`。
  5. EC2 IMDSv2：`169.254.169.254`（或 IPv6 `[fd00:ec2::254]`），以 1s 超时（`IMDS_TIMEOUT_MS`）向 `latest/api/token` 请求 PUT 令牌。
- **缓存失效与注册表状态**：收到 401/403 HTTP 响应时，`streamBedrock` 调用 `invalidateAwsCredentialCache({ profile, region })` 丢弃缓存凭据，使后续回合重新解析新凭据。`packages/catalog/src/compat/rules/auth/amazon-bedrock.kdl` 中的认证解析（`env hook="aws-bedrock"`）评估 `hasAwsCredentialSource()`（`packages/ai/src/registry/aws.ts`），在存在有效凭据或环境令牌时返回 `AUTHENTICATED_SENTINEL`。

### Catalog 模型处理
- **描述符注册**：注册于 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`），默认模型 `us.anthropic.claude-opus-4-8`。
- **models.dev 映射与跨区域配置档**：`MODELS_DEV_PROVIDER_DESCRIPTORS`（`packages/catalog/src/provider-models/openai-compat.ts`）将 `modelsDevKey: "amazon-bedrock"` 映射到 API `bedrock-converse-stream`。`bedrockCrossRegionId` 为匹配模型加 `global.` 或 `us.` 前缀。对 `anthropic.claude-*` 模型，`transformModel` 自动产出 EU（`eu.`）与 AWS GovCloud（`us-gov.`）跨区域推理配置档规格变体。非工具与旧版模型（`ai21.jamba`、`titan-text-express`、`mistral-7b`）被过滤掉。
- **Mantle 与未文档化模型排除**：Bedrock Mantle 是独立的 provider（`bedrock-mantle`、`openai-responses` API、`https://bedrock-mantle.{region}.api.aws/openai/v1`），由单独小节覆盖。Catalog 构建策略（`packages/catalog/scripts/generated-policies.ts`）运行 `dropBedrockMantleOpenAIModels` 把 Mantle OpenAI 模型行（`openai.gpt-5.4`、`5.5`、`5.6-luna`、`sol`、`terra`）从 `amazon-bedrock` 中排除。`dropUnsupportedBedrockGeoIds` 修剪 `jp.anthropic.claude-opus-5`（上游 models.dev 有列出但 AWS Bedrock 不支持且拒绝）。
- **Prompt 缓存与 thinking 兼容**：`buildBedrockCompat`（`packages/catalog/src/compat/bedrock.ts`）把模型 ID 映射到显式 prompt 缓存契约（`promptCacheMode`：`explicit` 或 `none`，最小 token 阈值 512、1024、2048、4096；`supportsLongPromptCacheRetention` 1h 对 5m；最多 4 个检查点）。`inferThinkingControlMode`（`packages/catalog/src/model-thinking.ts`）把 Claude 4.6+ 自适应模型分类为 `anthropic-adaptive`（设置 `supportsDisplay: true`）、Opus 4.5 为 `anthropic-budget-effort`，非自适应模型为 `budget`。定价被生成并物化到 `packages/catalog/src/models.json`。

## Amazon Bedrock Mantle

Amazon Bedrock Mantle 是 AWS 的网关端点，经 OpenAI Responses API（`openai-responses`）协议而非 Bedrock 原生 Converse JSON 传输（`amazon-bedrock`）服务 OpenAI 兼容模型（如 `openai.gpt-5.4`、`openai.gpt-5.5` 和 `openai.gpt-5.6` Luna/Sol/Terra 变体）。请求指向区域插值端点（`https://bedrock-mantle.{region}.api.aws/openai/v1`），使用 OpenAI Responses API 载荷（`/responses`）。入口模块为 `packages/ai/src/providers/bedrock-mantle.ts`、`packages/ai/src/registry/bedrock-mantle.ts`，以及 `packages/catalog/src/provider-models/openai-compat.ts` 中的 catalog 配置。

### 特殊处理
- **端点结构**：不同于标准 Bedrock Converse 端点（`bedrock-runtime.{region}.amazonaws.com`），Mantle 请求指向 `https://bedrock-mantle.{region}.api.aws/openai/v1`。`model.baseUrl` 中的 `{region}` 模板占位符在 `prepareBedrockMantleRequest`（`packages/ai/src/providers/bedrock-mantle.ts`）的请求准备时动态替换。
- **区域解析层级**：`resolveAwsRegion`（`packages/ai/src/utils/aws-profile.ts`）中的区域替换按顺序评估：显式 `providerOptions.region` -> `AWS_REGION` -> `AWS_DEFAULT_REGION` -> 来自 `~/.aws/config` 中活动 AWS 共享配置档的区域（`resolveAwsProfileRegion`）-> 回退默认 `"us-east-1"`。
- **401/403 凭据失效**：在 `createSignedFetch`（`packages/ai/src/providers/bedrock-mantle.ts`）中使用 SigV4 签名请求时，HTTP 401 或 403 响应触发 `invalidateAwsCredentialCache({ profile, region })`（`packages/ai/src/providers/aws-credentials.ts`），使后续尝试从配置档、环境或 STS 角色重新解析新凭据。
- **注册表哨兵与认证标志**：`packages/catalog/src/compat/rules/auth/bedrock-mantle.kdl` 设置 `allows-missing-api-key #true` 与 `env hook="aws-bedrock-mantle"`（传输在 `packages/ai/src/registry/bedrock-mantle.ts`）。当存在环境 AWS 凭据时（`packages/ai/src/registry/aws.ts` 中的 `hasAwsCredentialSource`），`resolveAwsRegistryApiKey` 返回 `AUTHENTICATED_SENTINEL`。`resolveAwsBearerToken` 剥离此哨兵值，除非存在真实 bearer 令牌，否则选择 SigV4 认证。
- **生成器模型丢弃策略**：在 `packages/catalog/scripts/generated-policies.ts` 中，`dropBedrockMantleOpenAIModels` 从 `amazon-bedrock` provider 过滤掉 `openai.gpt-5.*` 行（上游 `models.dev` 错误地把它们归到 Bedrock Converse 下），只暴露可用的 `bedrock-mantle` Responses API 模型。

### 流行为
- **传输**：委托给 `openai-responses` provider 流水线（`packages/ai/src/providers/openai-responses.ts`），消费 `response.created`、`response.text.delta`、`response.output_item.added` 和 `response.completed` 等 SSE 流事件。
- **推理与 thinking effort**：经 `BEDROCK_MANTLE_GPT_5_X_THINKING` 与 `BEDROCK_MANTLE_GPT_5_6_THINKING`（`packages/catalog/src/provider-models/openai-compat.ts`）配置，支持 effort 级别（`low`、`medium`、`high`、`xhigh`、`max`）。推理内容在 `openai-responses` 推理增量帧中流式输出。
- **错误处理**：非 2xx SSE 流把错误状态码传回流结果处理器；401/403 状态码在 `createSignedFetch` 中使缓存的 AWS 凭据状态失效。

### 认证与用量
- **双认证模式**：
  - **Bearer 令牌**：由 `resolveBearerToken`（`packages/ai/src/providers/bedrock-mantle.ts`）评估。当提供 `AWS_BEARER_TOKEN_BEDROCK`、`providerOptions.bearerToken` 或显式非哨兵 `apiKey` 时激活。`createBedrockMantleAuthenticatedFetch` 注入 `Authorization: Bearer <token>`。
  - **AWS SigV4 签名**：当无 bearer 令牌但环境凭据通过 `hasAwsCredentialSource` 时激活。请求 header 由 `signRequest`（`packages/ai/src/providers/aws-sigv4.ts`）以服务名 `"bedrock-mantle"` 签名，设置 `Authorization: AWS4-HMAC-SHA256 ...` 与 `x-amz-security-token`（使用会话凭据时）。
- **认证优先级**：两者都可用时，bearer 令牌优先于 SigV4 签名。
- **用量跟踪**：输入、输出、缓存与推理 token 用量由 `openai-responses` 直接从标准 OpenAI Responses 线上载荷解析（`usage.input_tokens`、`usage.output_tokens`、`usage.input_token_details.cached_tokens`、`usage.output_token_details.reasoning_tokens`）。

### Catalog 模型处理
- **Provider 描述符**：`packages/catalog/src/provider-models/descriptors.ts` 中的 `bedrock-mantle` 描述符设置 `defaultModel: "openai.gpt-5.6-terra"`、`envVars: ["AWS_BEARER_TOKEN_BEDROCK"]` 与 `dynamicModelsAuthoritative: true`。
- **静态种子**：预打包于 `BEDROCK_MANTLE_STATIC_MODELS`（`packages/catalog/src/provider-models/openai-compat.ts`），含 5 个 OpenAI 模型（`openai.gpt-5.4`、`openai.gpt-5.5`、`openai.gpt-5.6-luna`、`openai.gpt-5.6-sol`、`openai.gpt-5.6-terra`），定义上下文窗口（272,000）、最大 token（128,000）、定价结构与 thinking effort 规格。
- **认证后的模型发现**：
  - `packages/ai/src/registry/bedrock-mantle.ts` 中的 `prepareModelDiscovery` 需要有效的 bearer 令牌（`resolveAwsBearerToken`）。若未认证或仅 SigV4，返回 `authenticated: false` 并绕过发现。
  - 认证后，发现剥离 `/openai/v1` 以经 `fetchOpenAICompatibleModels` 调用 `https://bedrock-mantle.{region}.api.aws/v1/models`。
- **权威动态模型替换**：`bedrockMantleModelManagerOptions` 中的 `dynamicModelsAuthoritative: true` 使成功的动态发现响应**完全替换**静态种子，修剪未为该 AWS 账户/令牌启用的模型。
- **参考属性合并**：`mapWithBundledReference` 把静态定义的成本、thinking 配置和上下文窗口合并到匹配 `BEDROCK_MANTLE_MODEL_BY_ID` 的动态发现的模型定义上。

## Kimi Code
Kimi Code（`kimi-code`）与 Moonshot（`moonshot`）经双传输执行提供 Moonshot AI 模型家族的访问——包装 OpenAI 兼容 chat completions（`/coding/v1/chat/completions`）与 Anthropic 兼容 messages（`/coding/v1/messages`）。入口是 `packages/ai/src/providers/kimi.ts`（`streamKimi`）和 `packages/ai/src/providers/openai-anthropic-shim.ts`（`streamOpenAIAnthropicShim`），模型发现与 catalog 描述符配置在 `packages/catalog/src/provider-models/descriptors.ts` 和 `packages/catalog/src/provider-models/openai-compat.ts`。

### 特殊处理
- **双传输路由**：`streamKimi` 委托给 `packages/ai/src/providers/openai-anthropic-shim.ts` 中的 `streamOpenAIAnthropicShim`，从 `model.compat.kimiApiFormat` 或 `KimiOptions` 中显式 `options.format` 选择格式。
  - `anthropic`：以 `api: "anthropic-messages"` 重构模型规格，经 `model.baseUrl.replace(/\/v1\/?$/, "")` 调整基础 URL（`https://api.kimi.com/coding`），注入 `getKimiCommonHeaders()`，把 thinking 格式映射为 `anthropic-adaptive`，经 `ANTHROPIC_THINKING` 计算 token 预算，并经 `streamAnthropic` 流式传输。
  - `openai`：保留 `model.baseUrl`（`https://api.kimi.com/coding/v1`），注入 `getKimiCommonHeaders()`，传递 `reasoning` effort，并经 `streamOpenAICompletions` 流式传输。
- **MFJS 工具 Schema 校验**：`toolSchemaFlavor: "moonshot-mfjs"` 在 `packages/catalog/src/compat/openai.ts`（`buildOpenAICompat`）中对原生 Moonshot 宿主（`isMoonshotNative`）及第三方代理上的 Kimi 模型 ID 强制。Moonshot Flavored JSON Schema 把单值 `const` 构造折叠为单元素 `enum` 数组，在裸 `enum` 声明上推断显式 `type`，并剥离不支持的非标准关键字以防止 400 schema 校验错误。
- **强制工具选择守卫**：原生 K2.7 Code 模型（`kimi-k2.7-code`、`kimi-for-coding`）与 K3 模型要求服务器端 thinking（`packages/catalog/src/compat/anthropic.ts` 中的 `requiresThinkingEnabled = true`）。在 Anthropic 表面上，强制工具选择降级为 `auto`。在 OpenAI 表面上（`packages/catalog/src/compat/openai.ts`），强制 thinking 的 K2.7 模型（`requiresEnabledThinking`）`supportsForcedToolChoice` 为 `false`，但 K3 保持 `true`（`!isMoonshotKimiK3`）。
- **回合与 token 不变量**：
  - `alwaysSendMaxTokens: isKimiModel`（`packages/catalog/src/compat/openai.ts`）：Kimi 基于 `max_tokens` 而非发出的 token 计算 TPM 限流，要求每个请求显式 max tokens。
  - `requiresReasoningContentForToolCalls`：非 OpenCode provider 上的 Kimi 模型为 true（`packages/catalog/src/compat/openai.ts`）。先前的 assistant 工具调用回合在 thinking 后续中必须携带 `reasoning_content`，当原始推理缺失时允许合成占位 `"."`（`allowsSyntheticReasoningContentForToolCalls`）。
  - `requiresAssistantContentForToolCalls`：强制 assistant 工具调用回合中的非空文本内容。

### 流行为
- **带宽内控制标签与 thinking 扫描**：`packages/ai/src/dialect/kimi.ts` 中的 `KimiInbandScanner` 处理原始输出流中的 XML 风格工具控制标签（`<|tool_calls_section_begin|>`、`<|tool_call_begin|>`、`<|tool_call_argument_begin|>`、`<|tool_call_end|>`、`<|tool_calls_section_end|>`）与 `<think>...</think>` thinking 块，发出结构化 `InbandScanEvent` 事件（`text`、`thinkingStart`、`thinkingDelta`、`thinkingEnd`、`toolStart`、`toolEnd`）。
- **流标记修复**：`packages/catalog/src/compat/openai.ts`（`detectStreamMarkupHealingPattern`）中的 `streamMarkupHealingPattern: "kimi"` 为 `kimi-code`、`moonshot` 或 `kimi-k2` 模型 ID 修复跨 chunk 边界的截断或分裂的带宽内控制令牌。
- **空闲看门狗超时**：原生 K2.7 Code 模型（`packages/catalog/src/compat/openai.ts`）的 `streamIdleTimeoutMs` 下限扩展到 300s，以防止长时间初始推理生成期间的过早流中止。

### 认证与用量
- **设备 OAuth 流程**：在 `packages/catalog/src/compat/rules/auth/kimi-code.kdl` 中声明为 `login "device-code"` 规则（`packages/ai/src/registry/engine/device-code.ts`），header 钩子在 `packages/ai/src/registry/oauth/kimi.ts`。使用 OAuth 2.0 Device Authorization Grant（`urn:ietf:params:oauth:grant-type:device_code`），client ID `17e5f671-d194-4dfb-9706-5516cb48c098`，宿主 `${resolveOAuthHost()}`（`https://auth.kimi.com`，可经 `KIMI_CODE_OAUTH_HOST` 或 `KIMI_OAUTH_HOST` 覆盖）。
  - 经 `POST /api/oauth/device_authorization` 发起，以 `userCode` 和 `verificationUriComplete` 提示用户，并以退避方式轮询 `POST /api/oauth/token` 处理 `authorization_pending` 与 `slow_down`。令牌刷新使用 `grant_type: "refresh_token"`。
- **指纹 Header 与设备 ID**：`packages/ai/src/registry/oauth/kimi.ts` 中的 `getKimiCommonHeaders()` 注入设备跟踪 header：`User-Agent: KimiCLI/<ver>`、`X-Msh-Platform: kimi_cli`、`X-Msh-Version`、`X-Msh-Device-Name`、`X-Msh-Device-Model`、`X-Msh-Os-Version` 与 `X-Msh-Device-Id`。`getDeviceId` 将随机 hex UUID 持久化到 `path.join(getAgentDir(), "kimi-device-id")`（模式 0600），失败时回退到临时进程 UUID。
- **用量与配额跟踪器**：`packages/ai/src/usage/kimi.ts` 中的 `kimiUsageProvider` 以 OAuth bearer 令牌与 `getKimiCommonHeaders()` 请求 `GET /coding/v1/usages`（`https://api.kimi.com/coding/v1/usages`，可经 `KIMI_CODE_BASE_URL` 覆盖）。
  - 凭据过期时（`credential.expiresAt <= nowMs`）短路。解析 `KimiUsagePayload`：把 `usage` 对象映射为 `Total quota` 汇总行，把 `limits` 数组（提取 `detail` 与 `window` 时长/时间单位）映射为 `UsageLimit` 条目，经 `parseResetTime`（`reset_at`、`resetTime`、`ttl`）解析重置时间戳。

### Catalog 模型处理
- **Provider 描述符**：`packages/catalog/src/provider-models/descriptors.ts` 定义：
  - `kimi-code`：默认模型 `"kimi-for-coding"`，环境变量 `KIMI_API_KEY`，经 `kimiCodeModelManagerOptions` 动态发现。
  - `moonshot`：默认模型 `"kimi-k2.7-code"`，环境变量 `MOONSHOT_API_KEY` 与 `KIMI_API_KEY` 回退，经 `moonshotModelManagerOptions` 动态发现（默认基础 URL `https://api.moonshot.ai/v1`，可经 `MOONSHOT_BASE_URL` 覆盖）。
- **身份分类**：`packages/catalog/src/identity/family.ts` 导出 `isKimiModelId`（匹配 `moonshotai/kimi` 或 `/(^|\/)kimi[-.]/`）、`isKimiK26ModelId`（`/kimi-k2(\.6|p6)/`）和 `isKimiK3ModelId`（`/kimi-k3/`）。`packages/catalog/src/provider-models/openai-compat.ts` 中的 `isKimiK27CodeModelId` 匹配 `/kimi-k2.7-code/`。
- **K2.x 与 K3 推理差异**：
  - **K2.x**：原生 Moonshot K2.x 模型使用二进制 thinking（`thinking: { type: "enabled" | "disabled" }`），经 `packages/catalog/src/compat/openai.ts` 中的 `thinkingFormat: "zai"`。在 `moonshotModelManagerOptions` 中配置 4 档 effort 范围 `[Minimal, Low, Medium, High]`。K2.6 保留完整 thinking 上下文（`thinkingKeep: "all"`）。
  - **K3**：K3 模型使用 OpenAI 风格 `reasoning_effort`（`thinkingFormat: "openai"`）。配置 3 档线上刻度 `LOW_HIGH_MAX_REASONING_EFFORTS`（`[Low, High, Max]`）、`defaultLevel: Effort.Max` 与强制推理（`requiresEffort: true`，`packages/catalog/src/model-thinking.ts` 中的 `impliesMandatoryReasoning`）。`moonshotModelManagerOptions` 盖章 1M 上下文窗口、131,072 maxTokens 与视觉输入（`["text", "image"]`）。
- **输出 token 上限**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `kimiCodeMaxTokens` 派生各家族的输出限制：`k3` / `k3-256k` 为 131,072（`KIMI_CODE_K3_MAX_TOKENS`），`kimi-for-coding` / `kimi-for-coding-highspeed` 为 32,768（`KIMI_CODE_FOR_CODING_MAX_TOKENS`），旧版 K2 发现行回退 32,000（`KIMI_CODE_DEFAULT_MAX_TOKENS`）。在 catalog 生成器（`packages/catalog/scripts/generate-models.ts`）中应用。

## Ollama
Ollama 集成由 `packages/ai` 中两个不同的 provider 定义组成：`ollama` 面向本地 Ollama 实例（经指向本地端点 `/v1` 的 `baseUrl` 使用 `openai-responses` 或 `openai-completions` API，默认 `http://127.0.0.1:11434/v1`），`ollama-cloud` 面向 Ollama Cloud（使用 `https://ollama.com/api/chat` 的原生 `ollama-chat` API 传输）。入口模块为 `packages/ai/src/providers/ollama.ts`（原生流式）、`packages/catalog/src/provider-models/openai-compat.ts`（本地 Ollama catalog 选项 `ollamaModelManagerOptions`）和 `packages/catalog/src/provider-models/ollama.ts`（Ollama Cloud catalog 选项 `ollamaCloudModelManagerOptions`）。

### 特殊处理
- **传输路由**：本地 `ollama` 默认为 OpenAI 兼容路径（`openai-responses` / `openai-completions`），而 `ollama-cloud` 使用原生 `ollama-chat` 协议。
- **Thinking / 推理支持**：对 `ollama-chat`，推理经 `createChatBody` 中由 `mapReasoning` 映射的原生 `think` 字段控制（`minimal`/`low` -> `"low"`、`medium` -> `"medium"`、`high`/`xhigh` -> `"high"`、`max` -> `"max"`，设置 `disableReasoning` 时为 `false`）。Ollama Cloud 上 GLM-5.2 的 effort 级别限制为 `high` 与 `max`（`packages/catalog/src/provider-models/ollama.ts` 中的 `OLLAMA_CLOUD_GLM_52_THINKING`）。OpenAI-compat 路径上的本地 `ollama` 支持 `reasoning.effort` 值 `low`、`medium`、`high`、`max`、`none`（`packages/catalog/src/model-thinking.ts` 中的 `OLLAMA_REASONING_EFFORTS`），并为本地 KV-cache/chat 模板保全自动启用 `replayReasoningContent: true`（`packages/catalog/src/compat/openai.ts` 中的 `LOCAL_OPENAI_COMPAT_PROVIDERS`）。
- **工具选择模拟**：`packages/ai/src/providers/ollama.ts` 中的 `selectToolsForToolChoice` 在请求特定具名工具选择时（`{ type: "function", function: { name } }` 或 `{ name }`）手动将 `context.tools` 过滤到目标工具。`mapToolChoice` 把 `"none"` 映射到 `"none"`、`"required"`/`"any"`/具名对象映射到 `"required"`、`"auto"` 映射到 `undefined`。
- **Developer 角色与历史清洗**：Developer 系统 prompt 若是初始系统 prompt 或 agent 归属的，保持在 Ollama 的 `system` 角色，但用户归属的 developer 回合降级为 `user` 以稳定前缀缓存。若不存在 `user` 角色，`convertMessages` 把最后一个 system 回合降级为 `user`，防止 Ollama 发出 `done_reason: "load"` 而不生成输出。对 `ollama-cloud`，assistant 历史消息中的 `thinking` 字段被剥离（`convertMessages`），因为 Ollama Cloud 对携带 `thinking` 的传入历史返回 HTTP 400。
- **Schema 清洗**：工具 schema 经 `sanitizeSchemaForOllama(toolWireSchema(tool))` 确保兼容性。
- **模型加载 / `keep_alive` 与错误重写**：当请求不含用户回合或 Ollama 生成零 token 时，Ollama 返回 `done_reason: "load"`，映射为带 `EMPTY_OLLAMA_LOAD_COMPLETION_MESSAGE` 的 stopReason `"error"`。来自本地 llama.cpp 后端（HTTP 500）的格式错误工具调用 JSON 错误由 `packages/ai/src/error/format.ts` 中的 `rewriteOllamaToolCallJsonError` 重写。`shouldRetryOllamaResponse` 重试 5xx 错误，除非匹配 `LLAMA_CPP_TOOL_CALL_PARSE_PATTERN`。

### 流行为
- **NDJSON / JSONL 事件协议**：原生 `ollama-chat` 流式传输经 `readJsonl<OllamaChatChunk>` 解析的 NDJSON chunk。
- **推理与内容处理**：推理 chunk 以 `chunk.message.thinking` 到达（产生 `thinking_start`、`thinking_delta`、`thinking_end`）。内容文本以 `chunk.message.content` 到达。结构化工具调用以 `chunk.message.tool_calls` 到达。
- **流标记修复**：文本通道的工具调用与推理恢复启用流标记修复（`StreamMarkupHealing` 使用 `getStreamMarkupHealingPattern`）。当原生 `chunk.message.thinking` 存在时，`suppressHealedThinking` 设为 `true` 以避免重复计算推理块。
- **Finish reason 映射**：`mapDoneReason` 映射 `done_reason`：`"length"` -> `"length"`、`"tool_calls"` -> `"toolUse"`、`"load"` -> `"error"`、带工具调用的 `undefined` -> `"toolUse"`。产生工具调用的自然 `stop` 被提升为 `"toolUse"`。
- **看门狗与本地 prefill**：响应前超时经 `armPreResponseTimeout` 以 `firstEventTimeoutMs`（派生自 `PI_STREAM_FIRST_EVENT_TIMEOUT_MS` 或 `idleTimeoutMs`）启动，同时向 `fetchWithRetry` 传递 `timeout: false` 以避免重度本地 prefill 期间过早的 Bun fetch 超时中止。重试延迟为 `[2000, 5000, 10000]`。
- **空补全重试**：`streamOllama` 以 `withReplaySafeStreamRetry` 包装，透明重试仅有 EOS 的空补全。

### 认证与用量
- **凭据来源**：在 `packages/catalog/src/compat/rules/auth/ollama.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），提示可选 API key（`allowEmpty: true`），以 `envVars: ["OLLAMA_API_KEY"]` 默认无认证本地使用。`packages/catalog/src/compat/rules/auth/ollama-cloud.kdl` 要求在 `https://ollama.com/settings/keys` 创建的 API key，`envVars: ["OLLAMA_CLOUD_API_KEY"]`。
- **认证 header**：本地请求在提供时附加 `Authorization: Bearer ${apiKey}`；`ollama-cloud` 要求 `Authorization: Bearer ${apiKey}`。
- **用量与配额**：配额跟踪经 `packages/ai/src/usage/ollama.ts` 中的 `ollamaUsageProvider` 与 `ollamaCloudUsageProvider` 注册。两者都不暴露独立的用量/配额 API（`validatesCredentials: false`，空 `limits`），依赖流完成 chunk 中返回的逐响应 `prompt_eval_count`（输入）与 `eval_count`（输出）。

### Catalog 模型处理
- **描述符**：定义于 `packages/catalog/src/provider-models/descriptors.ts`：
  - `ollama`：`defaultModel: "gpt-oss:20b"`、`allowUnauthenticated: true`、`envVars: ["OLLAMA_API_KEY"]`，选项经 `ollamaModelManagerOptions` 构建。从 `generate-models.ts` 静态烘焙中排除（`DISCOVERY_ONLY_PROVIDERS`）。
  - `ollama-cloud`：`defaultModel: "gpt-oss:120b"`、`envVars: ["OLLAMA_CLOUD_API_KEY"]`、`catalogDiscovery: { label: "Ollama Cloud", oauthProvider: "ollama-cloud" }`，选项经 `ollamaCloudModelManagerOptions` 构建。
- **本地 Catalog 发现**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `ollamaModelManagerOptions` 先尝试在 `/v1/models` 上 `fetchOpenAICompatibleModels`。若不可用，回退到查询 `/api/tags` 的原生 `fetchOllamaNativeModels`。
- **云 Catalog 发现**：`packages/catalog/src/provider-models/ollama.ts` 中的 `ollamaCloudModelManagerOptions` 使用 `OLLAMA_CLOUD_API_KEY` 查询 `https://ollama.com` 上的 `/api/tags`。
- **经 `/api/show` 的上下文长度与能力检测**：本地与云发现都查询每个模型的 Ollama `/api/show` 以检查 `model_info` 与 `capabilities`。
  - 上下文长度从 `model_info` 中以 `.context_length`、`.num_ctx` 或 `.context_window` 结尾的键提取。回退上下文窗口为 `128_000`（`OLLAMA_FALLBACK_CONTEXT_WINDOW`）。
  - 能力盖章：`capabilities.includes("thinking")` 设置 `reasoning: true` 并配置 `thinking` effort 配置（`[minimal, low, medium, high]`）。`capabilities.includes("vision")` 盖章 `input: ["text", "image"]`。
- **输出 token 上限封顶**：Ollama Cloud 对 DeepSeek V4 Pro/Flash 模型强制 `OLLAMA_CLOUD_MAX_OUTPUT_TOKENS = 65_536`（`isOllamaCloudOutputCapped`）。`ollamaCloudModelManagerOptions` 把 `maxTokens` 封顶为 `min(contextWindow, 65536)` 并设置 `omitMaxOutputTokens: true`。`packages/ai/src/providers/ollama.ts` 中的 `resolveNumPredict` 进一步把线上载荷上的 `num_predict` 钳制到 `65_536`。
- **缓存 Provider ID**：由 `packages/catalog/src/provider-models/cache-provider-id.ts` 中的 `resolveModelCacheProviderId` 解析，`ollama` 使用 `http://127.0.0.1:11434` 或端点哈希。

## Cursor

Cursor 在 `packages/ai` 中的集成经 HTTP/2 Connect RPC 传输（`/agent.v1.AgentService/Run`）运行，发送长度前缀的二进制 Protobuf 消息（`AgentClientMessage` 与 `AgentServerMessage`）。关键实现入口包括 `packages/ai/src/providers/cursor.ts`（连接生命周期、Connect 消息流与帧分发）、`packages/ai/src/providers/cursor-pi-args.ts`（纯参数与路径变换）、`packages/ai/src/providers/cursor/exec-modern.ts`（本地工具结果帧构建器）、`packages/catalog/src/compat/rules/auth/cursor.kdl`（`login "custom" hook="cursor"`）与 `packages/ai/src/registry/oauth/cursor.ts`（PKCE 浏览器认证与令牌刷新）中的认证策略、`packages/ai/src/usage/cursor.ts`（多端点配额跟踪），以及 `packages/catalog/src/discovery/cursor.ts`（Connect RPC 模型发现）。

### 特殊处理
- **纯参数翻译（`cursor-pi-args.ts`）**：路径与参数格式化函数（`piReadPath`、`piReadPathHasRange`、`piReadDisplayPath`、`piGrepSkip`、`piJoinPath`、`piLsPath`、`piEscapeRegexLiteral`、`piLimit`、`piTimeout`）严格独立于 Protobuf 导入，使旧版 shim 可以共享它们而不把 protobuf schema 打包进虚拟注册表。
- **空 Grep 模式拒绝**：`pattern` 为空且 `glob` 非空的 `grepArgs` 帧会被预先拒绝（`emptyGrepPatternRejection`）并给出描述性错误，迫使模型重试或切换工具，而不是在块持久化之后触发本地工具失败。
- **原生工具与 `SoftToolRequirement` 的交互**：
  - 原生工具（`CURSOR_NATIVE_TOOL_NAMES`：`bash`、`read`、`write`、`delete`、`ls`、`grep`、`todo`）在构建 `requestContext` MCP 工具定义时被省略。
  - **例外**：只要通告了 pi-agent 工具，`write` 会在 `buildMcpToolDefinitions` 中被显式重新纳入。`write` 作为分阶段预览（如 `ast_edit`）的 `xd://` 传输。没有 `write`，分阶段预览无法解析，`SoftToolRequirement('write')` 升级会中止回合。
- **`rootPromptMessagesJson` 与 Blob 存储**：
  - `buildGrpcRequest` 以 SHA-256 二进制 blob ID（`blobStore`）的形式在 `rootPromptMessagesJson` 与 `turns` 中传递对话历史。
  - 系统 prompt 存储为单独的 JSON blob（`buildCursorSystemPromptJsons`），使得当下游 prompt 变化时服务器端前缀 blob 缓存可以独立命中。
- **Thinking 重放防护**：
  - assistant thinking 内容仅在相同模型的 Kimi K3 变体上于回合历史中重放（`canReplayCursorThinking`、`assertCursorKimiK3HistoryReplayable`）。外部或隐藏的推理被省略，以防止非 Cursor 的 thinking 块泄漏进原生对话回合。

### 流行为
- **长度前缀 Connect 框架**：
  - Connect HTTP/2 流使用 5 字节 header（1 字节标志 + 4 字节大端 uint32 载荷长度）。
  - `CONNECT_END_STREAM_FLAG`（`0b00000010`）标记携带 JSON 错误对象的终止帧（`parseConnectEndStream`）。
- **Trailer 与传输错误处理**：
  - 监控 HTTP/2 trailers（`grpc-status`、`grpc-message`），使用 `mapH2TransportError` 映射 socket 或 TLS 断连。
- **双向 RPC 分发**：
  - 服务器流式传输 `AgentServerMessage`（`interactionUpdate`、`execServerMessage`、`kvServerMessage`、`interactionQuery`）。
  - 客户端写入 `AgentClientMessage`（`runRequest`、每 5 秒周期性 `clientHeartbeat`、`interactionResponse`）与 `ExecClientMessage` 工具响应（`readResult`、`writeResult`、`execClientThrow`、`requestContextResult`）。
- **交互查询握手**：
  - 托管的 web 搜索 / Exa / 未命名的 field-9 WebFetch 发送 `interactionQuery` 并阻塞回合直到客户端写入 `interactionResponse`。
  - 心跳保持 HTTP/2 存活但不是语义进度；未应答的查询会静默直到 300s 空闲看门狗（`Provider stream stalled while waiting for the next event`）。
  - `handleInteractionQuery` 批准网络权限门，拒绝交互式 ask / switch-mode / create-plan。VM setup 保持不应答，因为其结果 oneof 只有 success。
- **异步执行排空与回合完成**：
  - `handleServerMessage` 异步处理帧使 socket 持续排空。分发在 `inFlightDispatches` 中跟踪，并在最终确定流完成之前受 `options.signal` 中止处理约束。
  - 流完成验证 `turnEnded`（`sawTurnEnded`）否则抛出 `incomplete-stream`。
- **工具调用合成**：
  - `synthesizeCursorExecToolCall` 在 assistant 输出消息上生成展示用的 `toolCall` 块，以在 UI 与转录中镜像本地工具执行。

### 认证与用量
- **凭据与 Header**：
  - 经随 `Authorization: Bearer <token>` 发送的 `CURSOR_ACCESS_TOKEN` 认证。
  - 客户端 header：`x-ghost-mode: true`、`x-cursor-client-version: cli-2026.07.23-e383d2b`、`x-cursor-client-type: cli`、`x-request-id`。
- **PKCE OAuth 与轮询**：
  - 深链 PKCE 登录生成 verifier/challenge 并重定向到 `https://cursor.com/loginDeepControl`。
  - 以指数退避轮询 `https://api2.cursor.sh/auth/poll?uuid=...&verifier=...`（1s 到 10s 延迟，最多 150 次）。
  - 刷新经 POST `https://api2.cursor.sh/auth/exchange_user_api_key` 交换刷新令牌。
- **用量与配额跟踪（`packages/ai/src/usage/cursor.ts`）**：
  - 标准配额从 `https://api2.cursor.sh/auth/usage` 获取（`parseCursorUsage`）。
  - 对带 WorkOS 用户会话的 OAuth 凭据（`WorkosCursorSessionToken=${userId}::${accessToken}`），从 `https://cursor.com/api/usage-summary` 获取个人用量（`parseCursorIndividualUsage`），从 `https://cursor.com/api/auth/me` 获取用户资料邮箱。

### Catalog 模型处理
- **描述符配置（`packages/catalog/src/provider-models/descriptors.ts`）**：
  - 配置 provider ID `"cursor"`、默认模型 `"claude-4.6-opus-high"`、运行时环境变量 `CURSOR_ACCESS_TOKEN`、catalog 发现环境变量 `CURSOR_API_KEY`。
- **缓存 Provider ID（`packages/catalog/src/provider-models/cache-provider-id.ts`）**：
  - 返回 `"cursor:max-mode-v3"` 以确保上下文窗口缓存失效。
- **模型发现（`packages/catalog/src/discovery/cursor.ts`）**：
  - `fetchCursorUsableModels` 经 Connect RPC 调用 `GetUsableModels`（`/agent.v1.AgentService/GetUsableModels`）。
  - 从 `details.maxMode` 设置 `cursorMaxMode`，指定 `api: "cursor-agent"`，映射 1M max-mode 与 200k 默认上下文窗口，`maxTokens` 默认 64,000。
  - 动态发现与来自 `models.json` 的内置参考模型合并。

## Devin
Devin 集成（`devin-agent` API）使用 Connect 协议与 gRPC/Protobuf 消息经 HTTP/1.1 与 Codeium Cascade 后端服务通信。其实现横跨 `packages/ai/src/providers/devin.ts` 中的 provider 流逻辑（`streamDevin`、`DEVIN_API_URL`）、`packages/catalog/src/compat/rules/auth/devin.kdl` 中的认证策略（`login "oauth-code"` 规则、`packages/ai/src/registry/engine/oauth-code.ts`），以及位于 `packages/catalog/src/discovery/devin-gen/exa/*` 的 Connect protobuf schema。

### 特殊处理
* **Connect 二进制协议与帧包装**：传输使用 HTTP/1.1 上的 Connect 协议，指向 `https://server.codeium.com`。请求载荷为序列化 Protobuf（`GetChatMessageRequestSchema`），gzip 压缩，并包装在 5 字节 Connect 流式二进制帧 header 中（`CONNECT_COMPRESSED_FLAG = 0x01`，4 字节大端载荷长度）。流结束帧携带 `CONNECT_END_STREAM_FLAG = 0x02` 与 JSON 错误 trailer（`readConnectTrailerError`）。
* **帧大小防护**：读取器在 `streamDevin` 中强制 16MB 帧载荷上限（`MAX_CONNECT_FRAME_PAYLOAD`），在缓冲前拒绝损坏的帧长度 header。
* **消息格式映射**：系统 prompt 规范化（`normalizeSystemPrompts`）到顶层 `prompt` 字段。消息在 `buildChatMessagePrompts` 中格式化：
  * 用户/developer 消息映射为 `ChatMessageSource.USER`，带确定性消息 ID（`cascadeId\0index\0role`）。
  * assistant 消息映射为 `ChatMessageSource.SYSTEM`，带 text、`thinking`、`signature` 和 `toolCalls`。原生 Devin assistant 回合保留 `responseId` 或回退到 `bot-<uuid>`。
  * 工具结果映射为 `ChatMessageSource.TOOL`，带 `toolCallId` 与 `toolResultIsError`。
* **会话线程与停止模式**：会话线程传递 `options.conversationId` 或 `options.sessionId` 作为 `cascadeId`。默认停止模式包括 `<|user|>`、`<|bot|>`、`<|context_request|>`、`<|endoftext|>` 和 `<|end_of_turn|>`（`DEVIN_DEFAULT_STOP_PATTERNS`）。工具选择指定 `auto` 选择与临时系统 prompt 缓存（`CacheControlType.EPHEMERAL`）；`disableParallelToolCalls` 是 catalog `compat.supportsParallelToolCalls` 的反值，因此原生允许并行工具的配置可以使用它们。
* **路由器分配**：带 `compat.modelRouter`（当前为 `adaptive`）的 catalog 配置是服务器端分发器，不是有效的 `chatModelUid`。在聊天前，`assignDevinModel` 用当前用户/developer prompt 与该回合的 `cascadeId` 调用 `AssignModel`，然后在匹配的 `GetChatMessage` 请求上发送返回的 `modelUid` 加 `modelAssignmentJwt`。缺少分配会使回合失败；响应的 `actualModelUid` 以 `AssistantMessage.upstreamModel` 呈现。

### 流行为
* **Protobuf 帧流式**：`streamDevin` 读取分块响应字节，解析 5 字节 Connect header。解压后的二进制载荷解码为 `GetChatMessageResponseSchema`。
* **不透明错误恢复（`invalid_argument`）**：带 `invalid_argument` 错误码（如 "internal error occurred"）的流结束 trailer 在 `streamDevin` 中触发历史恢复。当合格历史请求大小超过 512KB（`LARGE_HISTORY_RECOVERY_BYTES`）时，错误被重新分类为 `AIError.Flag.ContextOverflow` 以调用自动上下文修剪，而不是作为无效请求失败。
* **事件流翻译**：
  * `deltaThinking` -> `thinking_start` / `thinking_delta`（签名从 `deltaSignature` 填充）。
  * `deltaText` -> `text_start` / `text_delta`。
  * `deltaToolCalls` -> `toolcall_start` / `toolcall_delta`。
* **节流的流式工具参数**：流中参数解析使用 `parseStreamingJsonThrottled`（`toolLastParseLen`）以在流式 JSON 增量上维持 O(N) 性能，在 `toolcall_end` 时执行权威的 `parseStreamingJson`。
* **停止原因解析**：把 `StopReason.MAX_TOKENS` 映射为 `length`、活动工具调用为 `toolUse`，默认 `stop`。

### 认证与用量
* **双认证生命周期**：
  * **会话令牌前缀**：API key 凭据经 `normalizeDevinSessionToken` 规范化，确保 `devin-session-token$` 前缀。
  * **JWT 交换**：`fetchDevinAuthMetadata` 使用 `MetadataSchema` 内的 `apiKey` 向 `/exa.auth_pb.AuthService/GetUserJwt` 发送初始 Connect 请求（`GetUserJwtRequestSchema`）。服务器返回 `userJwt`（及可选的服务器基础 URL 覆盖），包含在后续 chat 请求元数据中。
* **CLI OAuth 流程**：在 `packages/catalog/src/compat/rules/auth/devin.kdl` 中声明为 `login "oauth-code"` 规则（`packages/ai/src/registry/engine/oauth-code.ts`），使用 `https://app.devin.ai/auth/cli/continue` 执行 PKCE OAuth 流程。令牌在 `https://api.devin.ai/auth/cli/token` 交换，过期时间从 JWT 载荷派生或 1 年默认回退。
* **用量呈现**：流式响应帧包含 token 计数（`msg.usage`：`inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`），直接输入 `calculateCost(model, output.usage)`，外加在 `usage.credits` 上呈现的 credit 计量（`creditCost`、`committedCreditCost`、`committedAcuCost`）。账户计划与余额报告使用 `devinUsageProvider`（`packages/ai/src/usage/devin.ts`），它以原生 CLI 身份调用 `SeatManagementService/GetUserStatus`，把 prompt/flow/flex credit 桶、按日期的日/周配额窗口、计划层级、超额余额与账户/组织身份映射进 `/usage`。按 credit 计费的计划省略无日期的百分比窗口，避免渲染为已耗尽的配额。

### Catalog 模型处理
* **模型管理器配置**：`packages/catalog/src/provider-models/special.ts` 中的 `devinModelManagerOptions` 在有 API key 时以 `dynamicModelsAuthoritative: true` 配置动态发现。`descriptors.ts` 在 `CATALOG_PROVIDERS` 中注册 `devin`（`DEVIN_API_KEY`、OAuth provider `devin`、`defaultModel: "swe-1-6"`）。
* **静态种子**：Cascade 的 catalog 按凭据限定作用域，因此无 `DEVIN_API_KEY` 的 catalog 生成获取不到任何东西，也从不把 provider 标记为权威——否则之前的 `models.json` 快照会被永久保留。`DEVIN_STATIC_MODELS`（`special.ts`）把两个活跃的 SWE-1.6 通道（`swe-1-6-fast`、`swe-1-6`）种子化为 `staticModels`，并由 `scripts/generate-models.ts` 无条件推送；其中的 `CREDENTIAL_SCOPED_PROVIDERS` 把 Devin 排除在生成期获取之外并丢弃其之前的快照行（退役已死的 `devin/swe-1-6-slow` 行）。配置的 `baseUrl` 把种子重新指向该主机。
* **动态发现**：`packages/catalog/src/discovery/devin.ts` 中的 `fetchDevinModels` 以 `packages/catalog/src/wire/devin.ts` 中的原生 `chisel` 发现元数据和每个受支持的展示槽位调用一元 Connect RPC `GetCliModelConfigs`（`/exa.api_server_pb.ApiServerService/GetCliModelConfigs`）。`normalizeDevinModels` 丢弃禁用/内部配置，把 `ClientModelConfig` 转换为 `ModelSpec<"devin-agent">` 条目（默认 200k 上下文窗口、64k max tokens），并保留服务器提供的输出上限、定价维度、工具/并行工具/图像支持、描述与 `new`/`beta`/`recommended` 徽章。例外：`DEVIN_IMAGE_BLIND_UIDS` 从 `swe-1-6`/`swe-1-6-fast` 剥离图像模态，其配置通告 `supports_images` 但后端静默丢弃 `ChatMessagePrompt.images` 字段（已实测验证；其余每个模型都读取它）。空但 200 的 catalog 响应记录一条过期身份固定警告。路由器配置（`displayOption MODEL_ROUTER` 或 `isModelRouter`）以 `compat.modelRouter` 保持独立。
* **家族折叠**：服务器 `modelFamilyMetadata` effort 通道先折叠，按规范化家族标签为键，并为 Fast Mode 顺序 1 拆分出 `-fast` 兄弟；服务器的默认成员成为折叠规格的 `requestModelId` 与 `thinking.defaultLevel`。静态 `DEVIN_VARIANT_COLLAPSE_TABLE` 然后处理活跃配置缺少家族元数据的已知家族。
* **Thinking 检测**：`supportsDevinThinking` 优先使用 `modelInfo.modelFeatures.supportsThinking`；标签正则模式（`/think|thinking|minimal|high|medium|low|xhigh|max|reasoning/i` 对 `/\bno thinking\b/i`）只是无特性时的回退。
* **Compat 解析**：`packages/catalog/src/compat/devin.ts` 中的 `buildDevinCompat` 设置 `trustExplicitThinkingOnly: true`（`ResolvedDevinCompat`），防止隐式 effort 阶梯推断（`model-thinking.ts`）。
* **推理 Effort 路由**：Devin 模型使用兄弟模型路由而非线上推理字段（`variant-collapse.ts`）。`DEVIN_VARIANT_COLLAPSE_TABLE` 把模型家族（如 `gpt-5-6-luna`、`claude-opus-5`）跨线上 effort 级别（`low`、`medium`、`high`、`xhigh`、`max`）映射到具体的路由兄弟模型 UID。
* **选择器对等**：`DEVIN_VARIANT_COLLAPSE_TABLE.providerAliases` 镜像原生 CLI 的短标签（`opus`、`claude`/`sonnet`、`haiku`、`gemini`、`gpt`、`codex`、`swe`）与带点的上游拼写（`gpt-5.6-terra`、`gemini-3.7-flash`、`swe-1.7-lightning`、`grok-4.6`、`glm-5.2`、`claude-haiku-4.5`）。Provider 别名只能经 `resolveVariantAlias(provider, id)` 解析——它们被刻意排除在 `resolveBareVariantAlias` 与反向索引之外，因此裸的 `gpt` 或 `opus` 保留其全局含义，不能重新键控配置。仅在发现时折叠的家族没有手工表别名，因此 `resolveProviderModelReference`（`packages/coding-agent/src/config/model-resolver.ts`）还会反向解析在活动模型的 `thinking.effortRouting` 中找到的任何原始线上 uid；精确的活动模型 id 仍然胜出。

## GitLab Duo

GitLab Duo 经 OMP 中两个不同的 provider 集成：**GitLab Duo Non-Agentic**（`gitlab-duo`）使用标准 HTTP/SSE 子 provider 经 GitLab AI Gateway 代理 LLM 请求，以及 **GitLab Duo Agent**（`gitlab-duo-agent`）经基于 WebSocket 的 agent 执行协议连接 GitLab Duo Workflow Service（DWS）。`gitlab-duo` 的入口模块是 `packages/ai/src/providers/gitlab-duo.ts` 与 `packages/catalog/src/compat/rules/auth/gitlab-duo.kdl`（OAuth 钩子在 `packages/ai/src/registry/oauth/gitlab-duo.ts`），而 `gitlab-duo-agent` 实现于 `packages/ai/src/providers/gitlab-duo-workflow.ts`、`packages/catalog/src/compat/rules/auth/gitlab-duo-agent.kdl`，catalog 发现位于 `packages/catalog/src/discovery/gitlab-duo-workflow.ts`。

### 特殊处理
- **`gitlab-duo` 模型路由与代理**：`packages/ai/src/providers/gitlab-duo.ts` 中的 `MODEL_MAPPINGS` 把 Duo 模型标识符（`duo-chat-opus-4-6`、`duo-chat-sonnet-4-6`、`duo-chat-gpt-5-1`、`duo-chat-gpt-5-codex` 等）映射到底层 provider 类型（`anthropic` 或 `openai`）与 API 风味（`anthropic-messages`、`openai-completions`、`openai-responses`）。请求使用经 `getDirectAccessToken` 交换的直接访问令牌代理到 GitLab AI Gateway 端点（`https://cloud.gitlab.com/ai/v1/proxy/anthropic/` 或 `https://cloud.gitlab.com/ai/v1/proxy/openai/v1`）。
- **`gitlab-duo-agent` ChatML 目标生成**：把 OMP 对话历史（`context.messages`）翻译为单个扁平化的渲染 ChatML prompt 字符串（`packages/ai/src/providers/gitlab-duo-workflow.ts` 中的 `buildGitLabDuoWorkflowGoal`、`renderGitLabDuoWorkflowChatMl`、`buildGitLabDuoWorkflowInlineFlowConfig`）。以 `gitlab-duo-workflow-chatml-note.md` 中的系统 prompt 指令为指导。
- **`gitlab-duo-agent` 内联流程规格**：发送一个环境内联工作流定义（`buildGitLabDuoWorkflowInlineFlowConfig`），带名为 `"omp_agent"` 的 `AgentComponent`，其模板承载 OMP 的系统 prompt 与用户模板 `{{goal}}`，带 UI 日志事件（`on_agent_reasoning`、`on_agent_final_answer`、`on_tool_execution_success`、`on_tool_execution_failed`）。
- **`gitlab-duo-agent` 字节预算与溢出**：强制目标字节限制（`GITLAB_DUO_WORKFLOW_GOAL_SOFT_OVERFLOW_BYTES` = 1MB、`GITLAB_DUO_WORKFLOW_GOAL_HARD_OVERFLOW_BYTES` = 2MB）。超过限制的目标触发溢出错误消息（`buildGitLabDuoWorkflowGoalOverflowMessage`），驱动会话循环中的自动上下文压缩。
- **`gitlab-duo-agent` 工具执行协议**：把 OMP 工具映射为 MCP 工具定义（`buildGitLabDuoWorkflowMcpTools`、`GitLabMcpToolDefinition`），在 `startRequest.mcpTools` 中发送。经 WebSocket 收到的工具调用请求（`runMCPTool`、`run_mcp_tool`）被提取（`extractGitLabDuoWorkflowAction`）、分发到 OMP 工具执行（`mapGitLabDuoWorkflowActionToOmpTool`、`emitGitLabDuoWorkflowActionToolCall`），并经 `buildGitLabDuoWorkflowActionResponse` 返回。
- **`gitlab-duo-agent` 命名空间设置自动启用**：REST 设置例程调用 `ensureGitLabDuoWorkflowSettings`，向 `/api/v4/ai/duo_workflows/settings` 提交 `buildGitLabDuoWorkflowSettingsBody`，以启用所需的命名空间标志（`duo_workflow`、`duo_workflow_service`、`duo_agent_platform`）。

### 流行为
- **`gitlab-duo` 委托流式**：在 `streamGitLabDuo`（`packages/ai/src/providers/gitlab-duo.ts`）内直接调用 `streamAnthropic`、`streamOpenAICompletions` 或 `streamOpenAIResponses`，在注入 Direct Access header（`Authorization: Bearer <direct_access_token>`）后原样透传底层 SSE 事件。
- **`gitlab-duo-agent` WebSocket agent 循环**：经 WebSocket 连接（`wss://<instance>/api/v4/ai/duo_workflows/ws` 或 DWS runway 主机 `buildGitLabDuoWorkflowWebSocketUrl`）。接收由 `parseGitLabDuoWorkflowSocketData` 解析并在 `runGitLabDuoWorkflowSocket`（`packages/ai/src/providers/gitlab-duo-workflow.ts`）中处理的原始 JSON 事件。
- **`gitlab-duo-agent` 事件处理与推理**：提取工作流检查点（`extractGitLabDuoWorkflowCheckpoint`），从 `on_agent_reasoning` UI 日志事件派生发出增量文本（`emitGitLabDuoWorkflowText`）与思维链推理（`emitGitLabDuoWorkflowThinking`）。
- **`gitlab-duo-agent` 批准与完成信号**：监控工作流批准状态（`isGitLabWorkflowApprovalStatus`：`PLAN_APPROVAL_REQUIRED`、`TOOL_CALL_APPROVAL_REQUIRED`）与完成状态（`isGitLabWorkflowCompletionStatus`：`INPUT_REQUIRED`、`FINISHED`）。
- **`gitlab-duo-agent` 超时与健康截止**：在 WebSocket 上实现 90 秒空闲截止（`GITLAB_DUO_WORKFLOW_IDLE_TIMEOUT_MS`）。socket 不活动触发中止并在既有 `workflowID` 上恢复。REST 设置调用受 30 秒超时约束（`GITLAB_DUO_WORKFLOW_REST_TIMEOUT_MS`）。
- **`gitlab-duo-agent` 有界重启**：
  - 步骤限制超限：当服务器报告最大步骤限制（`isGitLabDuoWorkflowStepLimitMessage`）时，新工作流最多 4 次重启（`GITLAB_DUO_WORKFLOW_MAX_STEP_LIMIT_RESTARTS`）。
  - 通用错误：瞬态处理故障（`isGitLabDuoWorkflowGenericProcessingError`）最多 1 次重试（`GITLAB_DUO_WORKFLOW_MAX_GENERIC_ERROR_RETRIES`）。
  - 停滞检测：当 `detectGitLabDuoWorkflowStall` 在工具边界检测到连续未变的检查点内容长度（`lastToolBoundaryContentLength`）时，最多 2 次重启（`GITLAB_DUO_WORKFLOW_MAX_STALL_RESTARTS`）。

### 认证与用量
- **`gitlab-duo` 认证**：支持经 `GITLAB_TOKEN` 的 PAT 或 `packages/catalog/src/compat/rules/auth/gitlab-duo.kdl` 声明的 OAuth（`login "oauth-code"`，引擎 `packages/ai/src/registry/engine/oauth-code.ts`），缓存清除钩子在 `packages/ai/src/registry/oauth/gitlab-duo.ts`。Direct Access 令牌经 `POST /api/v4/ai/third_party_agents/direct_access` 获取，带 `DuoAgentPlatformNext: true`（`packages/ai/src/providers/gitlab-duo.ts` 中的 `getDirectAccessToken`），缓存 25 分钟（`DIRECT_ACCESS_TTL_MS`）。OAuth 使用 PKCE 与 `DEFAULT_CLIENT_ID`（可经 `GITLAB_CLIENT_ID` / `GITLAB_REDIRECT_URI` 覆盖）与回调端口 8080。
- **`gitlab-duo-agent` 认证**：接受经 `GITLAB_TOKEN` 的 PAT 或 `packages/catalog/src/compat/rules/auth/gitlab-duo-agent.kdl` 中声明为 `login "oauth-code"` 规则的 OAuth（`packages/ai/src/registry/engine/oauth-code.ts`）。Direct Access 工作流令牌经 `POST /api/v4/ai/duo_workflows/direct_access` 获取（`requestGitLabDuoWorkflowDirectAccess`）。OAuth 依赖官方 GitLab VS Code client ID（`GITLAB_DUO_WORKFLOW_OAUTH_CLIENT_ID = "36f2a70cddeb5a0889d4fd8295c241b7e9848e89cf9e599d0eed2d8e5350fbf5"`），重定向到 `vscode://gitlab.gitlab-workflow/authentication`（`pasteCodeFlow: true`）。
- **`gitlab-duo-agent` 协议 header**：请求包括 `x-gitlab-client-type: node-websocket`、`x-gitlab-language-server-version: 8.104.0` 以及由 `buildGitLabDuoWorkflowWebSocketHeaders` 构造的资源作用域 header（`x-gitlab-project-id`、`x-gitlab-namespace-id`、`x-gitlab-root-namespace-id`）。
- **用量跟踪**：两个 provider 都不使用 `packages/ai/src/usage/` 下的模块。对 `gitlab-duo-agent`，上下文占用从服务器检查点遥测提取（`extractGitLabDuoWorkflowContextUsage` 读取 `agent_context_usage`），优先 `"Chat Agent"` 与 `"context_builder"` 条目，并在 `applyGitLabDuoWorkflowContextUsage` 中应用于 prompt token 估算。

### Catalog 模型处理
- **Provider 描述符**：定义于 `packages/catalog/src/provider-models/descriptors.ts`：
  - `gitlab-duo`：默认模型 `duo-chat-opus-4-6`，`envVars: ["GITLAB_TOKEN"]`。模型经 `getGitLabDuoModels()` 静态构建。
  - `gitlab-duo-agent`：默认模型 `claude_sonnet_4_6_vertex`，`envVars: ["GITLAB_TOKEN"]`，`dynamicModelsAuthoritative: true`，管理器选项由 `packages/catalog/src/provider-models/special.ts` 中的 `gitLabDuoWorkflowModelManagerOptions` 构建。
- **命名空间自动发现**：`discoverGitLabDuoWorkflowNamespace`（`packages/catalog/src/discovery/gitlab-duo-workflow.ts`）从显式覆盖、配置或 workspace Git remote（`discoverGitLabDuoWorkflowProject`）定位根命名空间。模型经 GraphQL 查询 `aiChatAvailableModels(rootNamespaceId:)` 发现（`fetchGitLabDuoWorkflowModels`）。
- **上下文窗口解析**：`packages/catalog/src/discovery/gitlab-duo-workflow.ts` 中的 `resolveGitLabDuoWorkflowContextWindow` 从模型引用推断上下文窗口大小（Claude Opus/Sonnet：1,000,000；Haiku：200,000；GPT-5：400,000；默认：200,000）。
- **缓存分区**：`gitLabDuoWorkflowModelCacheProviderId`（`packages/catalog/src/provider-models/special.ts`）通过对 `apiKey`、`baseUrl`、`namespaceId`、`projectId` 与 workspace `cwd` 哈希来分区动态 catalog 缓存键。
- **Catalog 生成规则**：`scripts/generate-models.ts` 把 `gitlab-duo-agent` 从静态生成发现中排除，以防止单账户命名空间模型被烘焙进静态 catalog，只把 `buildGitLabDuoWorkflowFallbackModel` 作为通用回退种子打包。

## Pi Native
Pi Native 是一种无损的内部 server/client 传输协议，用于 pi-ai 客户端（如容器化的 `omp` 或 sidecar agent 槽位）把请求执行委托给持有真实 provider 凭据的 `omp auth-gateway`。当 `Model` 设置 `transport: "pi-native"` 时激活，`packages/ai/src/stream.ts` 中的 `streamSimple` 短路本地 provider 解析，把规范 `Context` 直接 POST 到 `/v1/pi/stream`。主要入口模块是客户端侧的 `packages/ai/src/providers/pi-native-client.ts`（`streamPiNative`）、线上框架侧的 `packages/ai/src/providers/pi-native-server.ts`（`parseRequest`、`encodeStream`、`formatError`），以及服务器侧的 `packages/ai/src/auth-gateway/server.ts`（`POST /v1/pi/stream` 路由处理器）。

### 特殊处理
- **无损透传与无方言**：不同于 OpenAI/Anthropic 路由，`pi-native` 不是文本工具调用方言（`docs/toolconv/pi-native.md`）。工具调用保持为 `Context` 与 `AssistantMessageEvent` 内的规范 pi-ai `ToolCall` 内容块。它保留一等公民的 pi-ai 字段（服务层级、缓存标记、thinking 预算、工具选择变体、图像块、工具调用 ID），无外部线上量化。
- **线上请求与最小边界校验**：客户端向 `${model.baseUrl}/v1/pi/stream` POST `{ modelId: "${provider}/${id}", context, options, stream: true }`（`packages/ai/src/providers/pi-native-client.ts` 的 `resolveStreamUrl`）。`packages/ai/src/providers/pi-native-server.ts` 的 `parseRequest` 接受 `modelId`、`model.id` 或字符串 `model`（支持 `streamProxy` 目标交换）。校验只检查对象形态与数组（`context.messages`、可选 `context.systemPrompt`、`context.tools`），消息/工具内部留待下游 provider 执行时校验。
- **选项白名单与非线上键剥离**：服务器在 `packages/ai/src/providers/pi-native-server.ts` 的 `parseRequest` 中对照 `ALLOWED_OPTION_KEYS`（31 个键）过滤 `options`，静默丢弃未知键以实现跨版本兼容。客户端经 `packages/ai/src/providers/pi-native-client.ts` 的 `buildWireOptions` 中的 `NON_WIRE_KEYS` 剥离运行时专属与函数值字段（`signal`、`apiKey`、`fetch`、`onPayload`、`onResponse`、`onSseEvent`、`execHandlers`、`cursorExecHandlers`、`cursorOnToolResult`、`providerSessionState`）。
- **网关选项修改**：在 auth-gateway（`packages/ai/src/auth-gateway/server.ts`）上，`openai-codex-responses` 模型的采样控制（`temperature`、`topP`、`topK`、`minP`、`stopSequences`、惩罚项）被剥离以防止 400 错误，透传请求 header 被捕获（`captureRequestHeaders`）并合并到客户端 header 之下。
- **分发优先级与缓存绕过**：在 `packages/ai/src/stream.ts` 的 `streamSimple` 中，`model.transport === "pi-native"` 优先于扩展注册的自定义 API（`getCustomApi`）。`packages/ai/src/stream.ts` 的 `assertExplicitOpenAIResponsesPromptCacheSupport` 为 `pi-native` 传输显式绕过 prompt 缓存断言，因为校验推迟到网关解析的模型。

### 流行为
- **逐字 SSE 框架**：服务器的 `encodeStream`（`packages/ai/src/providers/pi-native-server.ts`）把每个规范 `AssistantMessageEvent` 逐字作为 JSON 序列化的 SSE 帧（`data: ${JSON.stringify(event)}\n\n`）流式输出，以 `data: [DONE]\n\n` 终止。客户端（`packages/ai/src/providers/pi-native-client.ts` 的 `streamPiNative`）使用 `readSseJson` 并把事件直接推入 `AssistantMessageEventStream`。
- **二次方部分框架**：增量事件包括滚动的 `partial: AssistantMessage` 快照，使线上带宽在回合长度上为 O(N²)。这一开销在 provider 延迟主导的回环 / sidecar 拓扑中被接受。
- **空闲与首事件看门狗**：客户端用带 `PI_STREAM_FIRST_EVENT_TIMEOUT_MS` 与 `PI_STREAM_IDLE_TIMEOUT_MS` 的 `iterateWithIdleTimeout` 包装 SSE 流。`packages/ai/src/providers/pi-native-client.ts` 中的 `isPiNativeProgressEvent` 忽略 `type: "start"` 事件，使初始设置不重置空闲超时。
- **合成终止边界**：若 SSE 流在没有 `done` 或 `error` 事件的情况下关闭，客户端的 `streamPiNative` 经 `makeSyntheticAssistant` 构造合成 assistant 消息。若调用方中止，推入 `{ type: "error", reason: "aborted", error: { ..., stopReason: "aborted", errorMessage: "stream closed without terminal event" } }`；非正常干净关闭时推入 `{ type: "done", reason: "stop", message: { ..., stopReason: "stop" } }`。
- **服务器迭代器异常回退**：若服务器的 `encodeStream` 事件迭代器抛出异常，它会排队 `data: {"type":"error","reason":"error","errorMessage":"..."}\n\n` 随后 `data: [DONE]\n\n`，使客户端迭代器得以解决而非挂起。
- **Thinking 循环守卫**：`packages/ai/src/stream.ts` 的 `streamSimple` 用 `withThinkingLoopGuard` 与 `withProviderInFlightLimit` 包装 `streamPiNative`，确保 Gemini、DeepSeek 与 Grok 的失控 thinking 流以可重试的空内容错误中止。

### 认证与用量
- **Bearer 令牌授权**：客户端（`packages/ai/src/providers/pi-native-client.ts` 的 `buildHeaders`）在 `Authorization: Bearer <apiKey>` 中传递 `options.apiKey`（网关 bearer 令牌），除非显式提供 `model.headers.Authorization`。
- **网关凭据解析**：服务器路由处理器（`packages/ai/src/auth-gateway/server.ts`）先校验网关 bearer。缺失/无效令牌经 `packages/ai/src/providers/pi-native-server.ts` 的 `formatError` 返回 `401`。有效请求实例化 `buildGatewayApiKeyResolver`，使用 `sessionId`/`promptCacheKey` 与格式 `"pi-native"` 从 `AuthStorage` 获取目标 provider 凭据。
- **错误信封与网关映射**：服务器经 `formatError` 以 `{ error: { type, message } }` 及 HTTP 状态、`application/json` 和 `Cache-Control: no-store` 发出错误。客户端的 `decodeGatewayError` 把非 2xx 响应转换为 `AIError.AuthGatewayError`，保留 HTTP 状态、header 与错误 `type`。
- **用量与 header 跟踪**：Token 用量（`input`、`output`、`cacheRead`、`cacheWrite`、`cost`）直接携带在规范 `AssistantMessage` 事件内。客户端经 `notifyProviderResponse` 通知响应元数据（`x-request-id`、header）。

### Catalog 模型处理
- **无 Catalog Provider 条目**：`pi-native` 不是 `packages/catalog` 中的 provider（不在 `descriptors.ts` 的 `CATALOG_PROVIDERS`、`src/provider-models/*`、`src/identity/classify.ts`、`src/model-thinking.ts` 与 `scripts/generate-models.ts` 中）。
- **传输覆盖属性**：仅作为 `packages/catalog/src/types.ts` 中 `Model` 接口上的 `transport?: "pi-native"` 定义。
- **本地 Catalog 解析**：元数据（定价、上下文窗口、max tokens、`ThinkingConfig` 中的 thinking 配置、能力标志、provider 优先级）从 catalog 模型定义（如 `anthropic/claude-3-5-sonnet`）本地解析，而执行分发路由到网关 `baseUrl`。

---

# Catalog providers

`CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中每个本身不是传输的条目，每个 provider id 一节，按字母排序。这些 provider 搭载上文记录的某个传输；每节只覆盖该 provider 在其之上添加的内容：特殊处理、认证与用量/配额跟踪，以及 catalog 接线。id 本身就是传输的 provider（anthropic、openai、openai-codex、azure、google、google-vertex、amazon-bedrock、bedrock-mantle、cursor、devin）由前半部分各自的传输小节覆盖。共享引擎的 provider（google-gemini-cli、google-antigravity、gitlab-duo、gitlab-duo-agent、kimi-code、moonshot、ollama、ollama-cloud）两者兼有：上文是引擎机制，下文是逐 id 的认证/用量/catalog 接线。

## ai& (`aiand`)
ai&（`aiand`）是一个 OpenAI 兼容的推理 API provider（aiand.com），提供开源权重与旗舰 LLM，带动态模型 catalog 发现、推理 effort 元数据和 token 用量定价。传输：OpenAI Chat Completions。

### 特殊处理
- **基础 URL 规范化**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `normalizeAiandBaseUrl` 修剪基础 URL、默认 `https://api.aiand.com/v1`、剥离尾随斜杠，并在省略时追加 `/v1`。除 OpenAI Chat Completions 流水线外无其他内容。

### 认证与用量
- **API-Key 认证**：支持经 `AIAND_API_KEY` 环境变量配置的 API key 认证（`packages/ai/src/stream.ts` 中的 `getEnvApiKey("aiand")` 解析）或显式 `apiKey` 选项。
- **控制台登录与校验**：在 `packages/catalog/src/compat/rules/auth/aiand.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），提示从 `https://console.aiand.com/api-keys` 获取 API key，并对照 `https://api.aiand.com/v1/models` 校验凭据（`validate "models-endpoint"`）。注册于 `packages/ai/src/registry/registry.ts`。

### Catalog 模型处理
- **Provider 描述符**：注册于 `packages/catalog/src/provider-models/descriptors.ts`，`defaultModel: "moonshotai/kimi-k2.7-code"`、`envVars: ["AIAND_API_KEY"]` 与 `dynamicModelsAuthoritative: true`。
- **静态种子模型**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `AIAND_STATIC_MODELS` 提供 9 个内置离线模型规格（`qwen/qwen3.6-27b`、`deepseek-ai/deepseek-v4-flash`、`google/gemma-4-31b-it`、`openai/gpt-oss-120b`、`deepseek-ai/deepseek-v4-pro`、`moonshotai/kimi-k2.7-code`、`moonshotai/kimi-k2.6`、`zai-org/glm-5.2`、`zai-org/glm-5.1`），经 `createAiandStaticModel` 创建，带 effort 推理阶梯（`[low, medium, high]`，默认 `medium`）。当权威在线 catalog 生成被禁用时，种子模型在 `scripts/generate-models.ts` 中推送。
- **权威发现**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `aiandModelManagerOptions` 设置 `dynamicModelsAuthoritative: true` 并经 `dropCachedModelIdsOnStaticMismatch: AIAND_STATIC_MODEL_IDS` 使静态 ID 失效。提供 `apiKey` 时，`fetchDynamicModels` 使用 `fetchOpenAICompatibleModels` 与 `mapAiandModel` 查询 `/v1/models`。
- **Thinking 配置（`mapAiandThinking`）**：`mapAiandThinking` 经 `AIAND_EFFORT_BY_WIRE_VALUE`（`minimal`、`low`、`medium`、`high`、`xhigh`、`max`）把线上的字符串数组 `reasoning_efforts` 转换为 pi `Effort` 级别，并在有效时从 `reasoning_effort_default` 设置 `defaultLevel`。efforts 为空时返回 `undefined`。
- **成本映射（`mapAiandCost`）**：`mapAiandCost` 经 `toPositiveNumber` 提取 `input_per_1m` 与 `output_per_1m` 美元 token 价格。非美元组织计费货币（如 `currency !== "usd"`）回退到 `{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`，避免成本模型损坏。
- **模型属性映射（`mapAiandModel`）**：`mapAiandModel` 映射模型描述或名称（`toModelName`），检查 `capabilities` 中的 `"reasoning"`（附加 `thinking`）与 `"vision"`（设置 `input: ["text", "image"]`），并解析 `context_window`。

## AIML API (`aimlapi`)
AIML API 是一个 AI 模型聚合平台，经统一 OpenAI 兼容端点提供对多供应商模型的访问。它使用 OpenAI Chat Completions（`openai-completions`）传输流水线。

### 特殊处理
- **非聊天模型过滤**：动态模型列表经 `isLikelyAimlApiChatModelId`（`packages/catalog/src/provider-models/openai-compat.ts`）过滤，排除由正则 `/(?:^|[/:._-])(?:audio|embed|embedding|embeddings|i2i|i2v|image|speech|t2i|t2v|tts|video)(?:$|[/:._-])/i` 或子串（`dall-e`、`dalle`、`flux`、`imagen`、`sora`、`veo`、`whisper`）匹配的音频、嵌入、图像、视频和 TTS 模型。
- **标准传输流水线**：使用未定制的 `openai-completions` 传输，无自定义请求变换器或错误处理器（`packages/catalog/src/provider-models/openai-compat.ts`）。

### 认证与用量
- **环境认证**：配置为经 `AIMLAPI_API_KEY` 环境变量发现凭据（`packages/catalog/src/provider-models/descriptors.ts`、`packages/catalog/src/compat/rules/auth/aimlapi.kdl`）。
- **API 授权**：以 HTTP `Authorization: Bearer <key>` header 向目标主机 `https://api.aimlapi.com/v1` 传递密钥。
- **用量跟踪**：在 `packages/ai/src/usage/` 中没有注册专门的配额或用量解析模块。

### Catalog 模型处理
- **描述符注册**：定义于 `PROVIDER_DESCRIPTORS`，`defaultModel: "gpt-5.5-2026-04-23"`、`dynamicModelsAuthoritative: true`、标签 `"AIML API"`（`packages/catalog/src/provider-models/descriptors.ts`）。
- **动态发现**：经 `packages/catalog/src/provider-models/openai-compat.ts` 中的 `aimlApiModelManagerOptions()` 管理，获取 `https://api.aimlapi.com/v1/models` 并经 `filterModel`（`isLikelyAimlApiChatModelId`）与 `mapWithBundledReference` 映射候选。
- **规范解析**：多供应商命名空间模型（如 `alibaba/qwen3-32b`、`x-ai/grok-4-3`）经 `buildModelProviderPriorityRank` 解析规范参数默认值，其中 `aimlapi` 参与跨 provider 身份查找（`packages/catalog/src/identity/priority.ts`、`packages/catalog/test/canonical-limit-fallback.test.ts`）。

## Alibaba Coding Plan (`alibaba-coding-plan`)
Alibaba Coding Plan 提供托管在阿里云 DashScope 平台上的面向编码的模型端点。它使用 `OpenAI Chat Completions` 传输（`openai-completions`），连接国际（`https://coding-intl.dashscope.aliyuncs.com/v1`）或中国大陆（`https://coding.dashscope.aliyuncs.com/v1`）端点。

### 特殊处理
- **结构化 API key 解析**：在 `packages/ai/src/providers/openai-shared.ts` 中，当启用 `alibabaCodingPlanAuth`（`packages/ai/src/providers/openai-completions.ts`）时，JSON 格式的 API key（由登录/OAuth 存储发出）被解析以提取 bearer `token` 并经 `enterpriseUrl` 覆盖 `baseUrl`。
- **低优先级选择**：包含在 `LOW_PRIORITY_PROVIDERS`（`packages/catalog/src/identity/priority.ts`）中，防止 `alibaba-coding-plan` 模型在歧义的自动角色选择中胜过主要 provider。
- **宿主分类**：归入 `packages/catalog/src/hosts.ts` 的 `alibabaDashscope` 宿主条目（`urlMarkers: ["dashscope", "token-plan."]`）。
- **OAuth 结构化 key 标志**：注册于 `needsStructuredApiKey`（`packages/ai/src/registry/oauth/index.ts`），把端点与令牌元数据（`enterpriseUrl`、`access`、`refresh`、`expires`）序列化为 JSON 键字符串。

### 认证与用量
- **交互式登录与端点选择**：在 `packages/catalog/src/compat/rules/auth/alibaba-coding-plan.kdl` 中声明（`login "custom" hook="alibaba-coding-plan"`），实现于 `packages/ai/src/registry/oauth/alibaba-coding-plan.ts`（`loginAlibabaCodingPlan`），提示用户在国际（`https://coding-intl.dashscope.aliyuncs.com/v1`）、中国大陆（`https://coding.dashscope.aliyuncs.com/v1`）或自定义代理基础 URL 之间选择。
- **API key 校验**：对预设端点经 `apiKeyValidation.validateOpenAICompatibleApiKey`（`packages/ai/src/registry/api-key-validation.ts`）对照模型 `qwen3.5-plus` 校验凭据，自定义 URL 使用 `validateApiKeyAgainstModelsEndpoint`（`packages/ai/src/registry/oauth/alibaba-coding-plan.ts`）。
- **环境变量**：API key 经 `ALIBABA_CODING_PLAN_API_KEY` 获取（`packages/catalog/src/provider-models/descriptors.ts`）。
- **用量与配额跟踪**：不同于 `alibaba-token-plan`，`alibaba-coding-plan` 在 `packages/ai/src/usage/` 中没有专门的用量 provider 或配额跟踪。

### Catalog 模型处理
- **模型管理器选项**：`alibabaCodingPlanModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）经 `createOpenAICompatibleModelManagerOptions` 创建管理器选项，配置 `providerId: "alibaba-coding-plan"`、`defaultBaseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1"` 与 `mapWithBundledReference`。
- **描述符与默认值**：注册的描述符（`packages/catalog/src/provider-models/descriptors.ts`）设置 `defaultModel: "qwen3.7-plus"`。
- **模型来源**：模型规格打包在 `packages/catalog/src/models.json` 的 `"alibaba-coding-plan"` 下。

### 流行为
- **扩展流空闲超时**：把 `streamIdleTimeoutMs` 设为 600,000 ms（`packages/catalog/src/compat/openai.ts` 中的 `ALIBABA_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS = 600_000`），防止流看门狗在第一个 SSE 事件之前的长初始生成延迟期间过早中止。

## QwenCloud Token Plan (`alibaba-token-plan`)
QwenCloud Token Plan 提供阿里云 Qwen 与 DeepSeek 模型套件的模型订阅访问。它使用 OpenAI Chat Completions 传输（`openai-completions` API schema）经 HTTP POST JSON 与 Server-Sent Events（SSE）流式运行（`packages/ai/src/providers/openai-shared.ts`）。

### 特殊处理
- **显式凭据隔离**：`resolveOpenAIRequestSetup`（`packages/ai/src/providers/openai-shared.ts`）要求显式 `ALIBABA_TOKEN_PLAN_API_KEY` 或 `BAILIAN_TOKEN_PLAN_API_KEY` 凭据，并显式禁用通用 `$env.OPENAI_API_KEY` 回退，防止密钥泄漏到 QwenCloud 端点。
- **区域基础 URL 路由**：凭据支持区域锁定端点：国际新加坡（`ALIBABA_TOKEN_PLAN_BASE_URL` = `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`）与中国北京（`ALIBABA_TOKEN_PLAN_CN_BASE_URL` = `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`）。区域密钥不可互换；存储的 `baseUrl` 在推理与模型发现中覆盖 catalog 默认值（`packages/catalog/src/provider-models/openai-compat.ts`）。
- **存储去重**：`hasAuthCredentialForProvider`（`packages/ai/src/auth/sqlite-credential-store.ts`）解析 JSON 复合凭据（`parseAlibabaTokenPlanCredential`）以比较内部 `token` 字符串而非原始 JSON 文本。

### 认证与用量
- **环境与线上凭据**：先解析 `ALIBABA_TOKEN_PLAN_API_KEY` 再解析 `BAILIAN_TOKEN_PLAN_API_KEY`。支持普通 bearer key（`sk-sp-...`）或序列化 JSON 字符串（`{ token, cookie?, baseUrl? }`），经 `parseAlibabaTokenPlanCredential` 解析并经 `serializeAlibabaTokenPlanCredential` 格式化（`packages/catalog/src/wire/alibaba-token-plan.ts`）。
- **交互式登录**：在 `packages/catalog/src/compat/rules/auth/alibaba-token-plan.kdl` 中声明（`login "custom" hook="alibaba-token-plan"`），实现于 `packages/ai/src/registry/oauth/alibaba-token-plan.ts`（`loginAlibabaTokenPlan`），提示区域（1=国际，2=中国北京，3=自定义 URL），经 `${baseUrl}/models` 校验 API key（`validateApiKeyAgainstModelsEndpoint`），并接受可选的 `cs-data.qwencloud.com` 浏览器 `Cookie` header 用于配额报告。
- **控制台配额抓取**：`alibabaTokenPlanUsageProvider`（`packages/ai/src/usage/alibaba-token-plan.ts`）使用存储的 `Cookie` header 从 `https://home.qwencloud.com/tool/user/info.json` 获取 `secToken`，并向 `https://cs-data.qwencloud.com/data/api.json?product=sfm_bailian&action=IntlBroadScopeAspnGateway&api=zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage` 发送带 URL 编码参数的 POST。
- **配额窗口与排名**：解析 `per5HourPercentage`/`per5HourResetTime`（5 小时窗口，`credits:5h`）与 `per1WeekPercentage`/`per1WeekResetTime`（7 天窗口，`credits:7d`）。`alibabaTokenPlanRankingStrategy` 配置 `credits:5h` 为主限额（5h 窗口）、`credits:7d` 为次限额（7d 窗口）。

### Catalog 模型处理
- **权威发现**：配置 `dynamicModelsAuthoritative: true`（`packages/catalog/src/provider-models/descriptors.ts`）。`/models` 发现按订阅限定作用域；成功的端点响应是权威的，即使为空也覆盖静态回退 catalog（`packages/catalog/scripts/generate-models.ts`）。
- **发现过滤与覆盖**：`isAlibabaTokenPlanChatModelId`（`packages/catalog/src/provider-models/openai-compat.ts`）过滤非聊天前缀（`qwen-audio-`、`qwen-image-`、`text-embedding-`、`wan2.7-`）。发现的 `deepseek-v4*` 模型以 `reasoning: true` 与 effort thinking（`[Effort.High, Effort.Max]`）映射。
- **静态 Catalog 回退**：`ALIBABA_TOKEN_PLAN_STATIC_MODELS` 在无凭据或发现失败时提供静态 catalog 种子回退（`packages/catalog/scripts/generate-models.ts`）。

## Baseten (`baseten`)
Baseten 为托管开源权重 LLM（包括 Moonshot Kimi、DeepSeek、Zhipu GLM 和 gpt-oss 系列）提供高性能基础设施。请求经 OpenAI Chat Completions 传输（`openai-completions` API）执行，目标默认基础 URL `https://inference.baseten.co/v1`。

### 特殊处理
- 除 `openai-completions` 流水线外无其他内容。

### 认证与用量
- **API Key 认证**：经 `BASETEN_API_KEY` 认证（`packages/catalog/src/provider-models/descriptors.ts`）。登录流程在 `packages/catalog/src/compat/rules/auth/baseten.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），指向面板 `https://app.baseten.co/settings/api_keys`，占位符 `bt_...`。
- **端点校验**：`packages/catalog/src/compat/rules/auth/baseten.kdl` 中的 API key 校验经 `GET https://inference.baseten.co/v1/models` 验证凭据（`models-endpoint` 校验类型）。
- **用量核算**：通过标准 OpenAI Chat Completions 用量处理调和 token 用量与定价（`packages/ai/src/providers/openai-shared.ts` 中的 `calculateOpenAIUsageAccounting`）。

### Catalog 模型处理
- **Provider 描述符**：注册于 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`），`id: "baseten"`、`defaultModel: "moonshotai/Kimi-K2.7-Code"`、`envVars: ["BASETEN_API_KEY"]`、`dynamicModelsAuthoritative: true`，发现标签 `"Baseten"`。
- **模型管理器选项**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `basetenModelManagerOptions` 以 `defaultBaseUrl: "https://inference.baseten.co/v1"` 与 `requireApiKey: true` 配置模型解析。
- **动态模型发现与定价**：`fetchDynamicModels` 查询 `https://inference.baseten.co/v1/models`。`mapModel` 解析原始记录元数据，包括 `supported_features`、`input_modalities`（视觉能力为 `image`）、上下文与补全 token 边界（`context_length`、`max_completion_tokens`），以及每百万 token 定价（`prompt`、`completion`、`input_cache_read`）。
- **原生推理识别**：当动态特性列表包含 `reasoning` 或 `reasoning_effort` 时，为 `openai/gpt-oss-120b`、`deepseek-ai/DeepSeek-V4-Pro` 与 `zai-org/GLM-5.2` 标记 `reasoning: true`。
- **推理 Effort 档位限制**：`packages/catalog/src/model-thinking.ts` 中的 `getModelDefinedEfforts` 与 `packages/catalog/src/provider-models/openai-compat.ts` 中的 `basetenModelManagerOptions` 把 `zai-org/GLM-5.2`（`isGlm52ReasoningEffortModelId`）与 `openai/gpt-oss-120b`（`isOpenAIGptOssModelId`）路由的推理 effort 档位限制为双档 `HIGH_MAX_REASONING_EFFORTS` 刻度（`[high, max]`）。
- **身份优先级与宿主匹配**：在 `PROVIDER_PRIORITY`（`packages/catalog/src/identity/priority.ts`）中获得优先级，并经 `packages/catalog/src/hosts.ts` 中的 URL 标记 `baseten.co` 匹配。

## Cerebras (`cerebras`)
Cerebras 在晶圆级引擎硬件上为开源权重模型（如 `zai-glm-4.7`、`gpt-oss-120b`、`qwen-3-235b-a22b-instruct-2507` 与 `gemma-4-31b`）提供超快推理。它经 OpenAI Chat Completions（`openai-completions`）传输通信。

### 特殊处理
- **`all_strict` 工具模式**：`packages/catalog/src/compat/openai.ts`（`isCerebras`）中 Cerebras 的 `toolStrictMode` 默认为 `"all_strict"`，在 `openai-completions.ts`（`AppliedToolStrictMode`）中对所有传入工具 schema 强制 `strict: true`。
- **`supportsUsageInStreaming: false`**：经 `packages/catalog/src/compat/openai.ts` 中的 `supportsUsageInStreaming: !isCerebras` 配置，在 `openai-completions.ts` 中抑制 `stream_options: { include_usage: true }`，防止流式响应时的 API 拒绝。
- **空 400/413 上下文溢出检测**：Cerebras 上下文与载荷溢出错误返回空 HTTP 400 或 413 响应体。在 `packages/ai/src/error/flags.ts` 中由 `OVERFLOW_NO_BODY_PATTERN`（`/\b4(00|13)\s*(status code)?\s*\(no body\)/i`）识别，允许 `isContextOverflow` 设置 `Flag.ContextOverflow`，使 agent 会话自动压缩上下文而非终止性失败。
- **Gemma 图像输入序列化**：匹配 `gemma-4-31b` 的模型在经 `packages/ai/src/providers/openai-completions.ts` 中的 `convertMessages` 处理时，把附着的图像块序列化为 Chat Completions `image_url` data URI（`data:image/png;base64,...`）。

### 认证与用量
- **API Key 登录**：在 `packages/catalog/src/compat/rules/auth/cerebras.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），默认校验模型 `gpt-oss-120b`，基础 URL `https://api.cerebras.ai/v1`。
- **环境解析**：注册于 catalog 描述符 `descriptors.ts` 与 `packages/catalog/src/compat/rules/auth/cerebras.kdl`，使用环境变量 `CEREBRAS_API_KEY`。

### Catalog 模型处理
- **Provider 注册**：`descriptors.ts`（`CATALOG_PROVIDERS`）中的 catalog 条目设置 `id: "cerebras"`、`defaultModel: "zai-glm-4.7"`，并把选项构建委托给 `cerebrasModelManagerOptions`。
- **管理器选项与发现**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `cerebrasModelManagerOptions` 使用 `createOpenAICompatibleModelManagerOptions`，`providerId: "cerebras"`，默认基础 URL `https://api.cerebras.ai/v1`。
- **Gemma 图像能力覆盖**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `applyCerebrasDiscoveryOverrides` 在模型映射期间检查 `CEREBRAS_IMAGE_INPUT_MODEL_IDS`（`Set(["gemma-4-31b"])`），显式向 `input` 能力追加 `"image"`（`input: ["text", "image"]`），覆盖远程端点发现元数据中缺失的视觉能力标志。

## Cloudflare AI Gateway (`cloudflare-ai-gateway`)
Cloudflare AI Gateway 经 Cloudflare 边缘基础设施把请求代理到模型 provider，使用 Anthropic Messages 传输。基础 URL 要求在模型配置中把 `<account>` 与 `<gateway>` 路径占位符替换为用户特定的 Cloudflare 账户 ID 与网关 slug。

### 特殊处理
- **自定义授权 header**：使用 `cf-aig-authorization: Bearer <key>` 而非标准 `x-api-key` 或 `Authorization` header（`packages/ai/src/providers/anthropic.ts:buildAnthropicHeaders`）。
- **抑制客户端凭据**：`apiKey` 与 `authToken` 在 Anthropic 客户端选项对象上设为 `null`，使凭据仅经预构建的默认 header 传输（`packages/ai/src/providers/anthropic.ts:3027-3037`）。
- **签名代理检测**：匹配 `gateway.ai.cloudflare.com/.+/anthropic` 的 URL 经 `isCloudflareAnthropicGateway` 识别为 Anthropic 签名代理（`packages/catalog/src/compat/anthropic.ts:CLOUDFLARE_ANTHROPIC_GATEWAY_URL_MARKER`、`isAnthropicSigningProxyUrl`）。
- **OAuth 会话保护**：被排除在接收 Claude OAuth `account_uuid` header 之外，防止身份泄漏到第三方代理（`packages/coding-agent/src/session/session-metadata.ts`）。

### 认证与用量
- **认证提示**：在 `packages/catalog/src/compat/rules/auth/cloudflare-ai-gateway.kdl` 中声明（`login "custom" hook="cloudflare-ai-gateway"`），实现于 `packages/ai/src/registry/oauth/cloudflare-ai-gateway.ts`（传输在 `packages/ai/src/registry/cloudflare-ai-gateway.ts`），提示 Cloudflare AI Gateway 令牌/API key（`cf-aig-...`）并引导用户查看 Cloudflare 认证文档。
- **环境变量**：从 `CLOUDFLARE_AI_GATEWAY_API_KEY` 读取 API key 凭据（`packages/catalog/src/provider-models/descriptors.ts`）。
- **账户与网关解析**：使用 `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic` 作为基础 URL 模板，其中 `<account>` 与 `<gateway>` 占位符替换为用户的 Cloudflare 账户 ID 与网关 slug（`packages/catalog/src/provider-models/openai-compat.ts:cloudflareAiGatewayModelManagerOptions`）。

### Catalog 模型处理
- **描述符与默认模型**：经 `anthropicMessagesDescriptor` 接线，默认模型 `anthropic/claude-opus-4-8`（`packages/catalog/src/provider-models/descriptors.ts`）。
- **静态回退模型**：当发现未返回任何模型时，在 catalog 生成期间注入 `CLOUDFLARE_FALLBACK_MODEL`（`claude-sonnet-4-5`，启用推理，200k 上下文）（`packages/catalog/scripts/generated-policies.ts`、`packages/catalog/scripts/generate-models.ts:536-538`）。
- **优先级接线**：在 `providerPriority` 中分配 catalog 优先级 39（`packages/catalog/src/identity/priority.ts`）。

## CoreWeave Serverless Inference (`coreweave`)
CoreWeave Serverless Inference 提供由 Weights & Biases（W&B）基础设施驱动的托管 AI 模型推理，位于 `https://api.inference.wandb.ai/v1`。它使用 "OpenAI Chat Completions" 传输运行。

### 特殊处理
- **项目 header 注入**：`packages/ai/src/providers/openai-shared.ts` 中的 `applyCoreWeaveProjectHeader` 在 `resolveOpenAIRequestSetup` 中拦截 `coreweave` 模型的请求并注入所需的 `OpenAI-Project` HTTP header。header 解析由 `packages/catalog/src/wire/coreweave.ts` 中的 `resolveCoreWeaveProject` 与 `coreWeaveProjectHeaders` 处理，检查 `COREWEAVE_PROJECT`、`WANDB_INFERENCE_PROJECT` 或 `WANDB_ENTITY`/`WANDB_PROJECT`。`removeBlankCoreWeaveProjectHeaders` 移除空项目 header 以允许回退到环境变量。
- **GPT-OSS 推理变换**：在 `openAiCompletionsDescriptor`（`packages/catalog/src/provider-models/openai-compat.ts`）中，以 `openai/gpt-oss-` 开头的模型被变换为设置 `reasoning: true` 并配置基于 effort 的 thinking（`Effort.Low`、`Effort.Medium`、`Effort.High`）。

### 认证与用量
- **API Key 与环境解析**：经 `COREWEAVE_API_KEY` 认证，回退 `WANDB_API_KEY`（`descriptors.ts`、`packages/ai/src/stream.ts` 中的 `getEnvApiKey`）。
- **登录流程与项目校验**：交互式登录在 `packages/catalog/src/compat/rules/auth/coreweave.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），引用 `https://wandb.ai/settings` 的设置。`requireCoreWeaveProjectHeaders`（`packages/ai/src/registry/oauth/coreweave.ts`）强制在对照 `https://api.inference.wandb.ai/v1/models` 校验凭据前，可以从环境变量构造有效的 `OpenAI-Project` header。

### Catalog 模型处理
- **描述符配置**：注册于 `packages/catalog/src/provider-models/descriptors.ts` 的 `CATALOG_PROVIDERS`，ID `coreweave`，默认模型 `openai/gpt-oss-120b`，发现标签 `"CoreWeave Serverless Inference"`。
- **模型管理器与动态发现**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `coreWeaveModelManagerOptions` 经 `createSimpleOpenAICompletionsOptions` 为 `https://api.inference.wandb.ai/v1` 构建 provider 选项，在 catalog 模型获取时动态提供 `coreWeaveProjectHeaders(Bun.env)`。

## DeepSeek (`deepseek`)
DeepSeek provider 经 OpenAI Chat Completions 传输（`openai-completions`）直接对接 DeepSeek API（`https://api.deepseek.com/v1`）。它驱动官方 DeepSeek 模型如 `deepseek-v4-pro` 与 `deepseek-v4-flash`，实现 provider 特定的推理标志、令牌剥离流过滤器、自定义 prompt-cache 用量核算与 Bearer 清洗的 API key 存储。

### 特殊处理
- **推理 Compat 与 `whenThinking` 切换**：直连 DeepSeek reasoning 模型（`packages/catalog/src/compat/openai.ts` 中的 `isDirectDeepseekReasoning`）配置 `supportsToolChoice: false`（推理调用上省略 `tool_choice`）与 `reasoningDisableMode: "zai-thinking-disabled"`。推理激活时触发 `whenThinking` compat 指针切换，合并 `extraBody: { thinking: { type: "enabled" } }`。设置任何 `tool_choice` 都会丢弃推理字段（`disableReasoningOnToolChoice: true`）。见 [Provider compat 参考](./provider-compat-reference.md)。
- **推理内容不变量**：在后续回合重放确切的先前 `reasoning_content`（`requiresReasoningContentForToolCalls` 与 `requiresReasoningContentForAllAssistantTurns`），拒绝合成 `"."` 占位（`allowsSyntheticReasoningContentForToolCalls: false`）。工具回合上空的 assistant 内容提升为 `"."`（`requiresAssistantContentForToolCalls: true`）。
- **Chat 模板令牌剥离与修复**：`packages/ai/src/providers/openai-completions.ts` 中的 `stripDeepseekSpecialTokens` 缓冲并剥离原始流式 chat 模板令牌（`<｜User｜>`、`<｜Assistant｜>` 等）。带宽内 DSML 工具块（`<｜DSML｜tool_calls>`）经带模式 `"dsml"` 的 `StreamMarkupHealing` 修复。
- **线上参数与流看门狗**：输出 token 上限使用 `max_tokens`（`maxTokensField: "max_tokens"`）。事件间流看门狗扩展到 300 秒（`DEEPSEEK_REASONING_STREAM_IDLE_TIMEOUT_MS`），以容纳冗长的 prefill/thinking 延迟。函数工具启用 `supportsStrictMode: true`。

### 认证与用量
- **API Key 规范化与登录**：在 `packages/catalog/src/compat/rules/auth/deepseek.kdl` 中声明为带 `normalize "strip-bearer"` 的 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），修剪输入并剥离任何前导 `Bearer ` 前缀（不区分大小写），对照 `/v1/models` 校验。运行时凭据依赖 `DEEPSEEK_API_KEY`。
- **Prompt-Cache 用量核算**：DeepSeek 返回顶层用量字段 `prompt_cache_hit_tokens` 与 `prompt_cache_miss_tokens`。`calculateOpenAIUsageAccounting`（`packages/ai/src/providers/openai-shared.ts`）检测 `isDeepSeekUsage`，把净输入 token 映射为 `Math.max(0, promptTokens - cachedTokens)`（即 miss 计数），并把 `cacheWrite` 设为 `0`，避免把未缓存的 prompt token 双重计费为显式缓存写入。

### Catalog 模型处理
- **描述符与管理器**：`packages/catalog/src/provider-models/descriptors.ts` 中的 catalog 条目 `deepseek` 设置 `defaultModel: "deepseek-v4-pro"` 并使用 `deepseekModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`），目标 `https://api.deepseek.com`。内置发现过滤器面向支持工具调用的 `deepseek-v4` 模型。
- **推理 Effort 阶梯**：为 `deepseek-v4-pro` 配置 `HIGH_MAX_REASONING_EFFORTS`（`[high, max]`），为 `deepseek-v4-flash` 配置 `LOW_HIGH_MAX_REASONING_EFFORTS`（`[low, high, max]`）。跨 DeepSeek 模型把 `xhigh` effort 请求规范化为 `max`（`isDeepseekModelIdOrName`）。

## Fire Pass (`firepass`)
Fire Pass 是 Fireworks AI 的订阅层级，为 Kimi K2.6 Turbo 提供专用的高吞吐路由访问。它使用 OpenAI Chat Completions 传输（`https://api.fireworks.ai/inference/v1`），带 Fireworks 路由器端点翻译。

### 特殊处理
- **线上模型 ID 翻译（`wireModelIdMode: "firepass"`）**：`buildOpenAICompat`（`packages/catalog/src/compat/openai.ts`）为 `firepass` 或 Fireworks 快速路由模型（`isFireworksFastRouter`）指定 `wireModelIdMode: "firepass"`。`applyWireModelIdTransform`（`packages/ai/src/providers/openai-shared.ts`）使用 `toFirepassWireModelId`（`packages/catalog/src/fireworks-model-id.ts`）通过把点替换为 `p`，把友好的 catalog ID（如 `kimi-k2.6-turbo`）转换为 Fireworks 路由器线上 ID（`accounts/fireworks/routers/kimi-k2p6-turbo`）。
- **最大输出 token 上限**：输出 token 经 `packages/catalog/src/provider-models/openai-compat.ts` 中的 `clampFireworksKimiMaxTokens` 与 `packages/catalog/scripts/generate-models.ts` 中的 `applyKimiMaxTokensCap` 封顶为 32,768（`FIREWORKS_KIMI_MAX_TOKENS`），防止 Kimi K2 模型上的失控推理轨迹。
- **五档 thinking effort**：`getThinkingConfig`（`packages/catalog/src/model-thinking.ts`）把 `firepass` 映射到 `FIVE_TIER_EFFORTS_LOW_TO_MAX`（`low`、`medium`、`high`、`xhigh`、`max`）。

### 认证与用量
- **认证**：在 `packages/catalog/src/compat/rules/auth/firepass.kdl` 中定义为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），使用环境变量 `FIREPASS_API_KEY`（`fpk_...`）。
- **校验**：专用 `fpk_...` 密钥只授权路由器端点，在 `/v1/models` 上失败。`packages/catalog/src/compat/rules/auth/firepass.kdl` 中的校验使用 `validate "chat-completions"` 直接目标 `accounts/fireworks/routers/kimi-k2p6-turbo`。

### Catalog 模型处理
- **描述符**：注册于 `packages/catalog/src/provider-models/descriptors.ts`（`id: "firepass"`、`defaultModel: "kimi-k2.6-turbo"`、`envVars: ["FIREPASS_API_KEY"]`）。
- **管理器选项**：`firepassModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）返回不带动态发现的静态配置，依赖 `models.json` 中的规范内置 catalog。
- **脚本清理**：`dropFireworksWireIds`（`packages/catalog/scripts/generate-models.ts`）在 catalog 生成期间剥离内部 `accounts/fireworks/` 线上 ID。

## Fireworks (`fireworks`)
Fireworks（`packages/catalog/src/compat/rules/auth/fireworks.kdl`）是一个高吞吐 AI 推理 provider，经 OpenAI 兼容的 HTTP REST API（`https://api.fireworks.ai/inference/v1`）服务 serverless 与专用模型。它使用 OpenAI Chat Completions 传输（`packages/ai/src/providers/openai-completions.ts` 中的 `streamOpenAICompletions`），带自定义模型 ID 线上翻译、thinking 参数冲突解决与优先层级处理。

### 特殊处理
- **`wireModelIdMode: "fireworks"` 与线上模型 ID 变换**：`applyWireModelIdTransform`（`packages/ai/src/providers/openai-shared.ts`）由 `packages/catalog/src/compat/openai.ts` 中解析的 `wireModelIdMode: "fireworks"` 启用，调用 `toFireworksWireModelId`（`packages/catalog/src/fireworks-model-id.ts`）给公共 catalog 模型 ID 加 `accounts/fireworks/models/` 前缀并把版本点转换为 `p`（如 `glm-5.1` 映射到 `accounts/fireworks/models/glm-5p1`）。公共 catalog 规范化使用 `toFireworksPublicModelId`。
- **快速路由与 Fire Pass 模型线上路由**：以 `-fast` 结尾的模型（`packages/catalog/src/fireworks-model-id.ts` 中的 `isFireworksFastModelId`）代表高吞吐服务路由。`buildOpenAICompat`（`packages/catalog/src/compat/openai.ts`）把 `isFireworksFastRouter` 解析为 `wireModelIdMode: "firepass"`，经 `toFirepassWireModelId` 把线上分发映射到 `accounts/fireworks/routers/<id>-fast` 而非 `accounts/fireworks/models/`。
- **`dropThinkingWhenReasoningEffort` 冲突解决**：`compat.dropThinkingWhenReasoningEffort` 在 `packages/catalog/src/compat/openai.ts` 中对 Fireworks 设为 `true`。当请求参数中存在 `reasoning_effort` 时，`applyOpenAIExtraBody`（`packages/ai/src/providers/openai-shared.ts`）删除顶层 `thinking` 开关对象，防止 Fireworks 因同时拒绝两个参数而返回 HTTP 400。
- **Qwen thinking 格式覆盖**：`buildOpenAICompat`（`packages/catalog/src/compat/openai.ts`）给 Fireworks 托管的 Qwen 模型（如 `fireworks/qwen3.7-plus`）指定 `thinkingFormat: "openai"` 而非 `"qwen"`，强制使用 `reasoning_effort` 而非阿里 DashScope 的 `enable_thinking` 布尔值（Fireworks 会以 400 拒绝后者）。
- **服务层级 / 优先级控制**：`excludesInferredOpenAIServiceTier` 与 `shouldSendServiceTier`（`packages/ai/src/types.ts`）允许 `fireworks` 请求在启用 `providers.fireworksTier: priority`（或 `/fast` 模式）时发送 `service_tier: "priority"`，抑制不需要的层级默认值。
- **流标记修复**：`packages/ai/src/utils/stream-markup-healing.ts` 中的 `modelMayLeakDsmlToolCalls` 标记 `provider === "fireworks"`，调用 `ThinkingInbandScanner` 缓冲并清理泄漏到可见文本增量中的 DSML XML 标记。

### 认证与用量
- **API Key 认证**：使用经 `FIREWORKS_API_KEY` 配置的 HTTP Bearer 令牌认证（`Authorization: Bearer ${apiKey}`，经 `packages/ai/src/stream.ts` 中的 `getEnvApiKey` 解析）。
- **控制面登录校验**：`/login fireworks`（在 `packages/catalog/src/compat/rules/auth/fireworks.kdl` 中声明为 `login "api-key"` 规则，`packages/ai/src/registry/engine/api-key.ts`）对照静态控制面 catalog `GET /v1/accounts/fireworks/models?filter=supports_serverless%3Dtrue&pageSize=1` 校验凭据而非 `/v1/models`（推理端点按账户服务部署，对没有活跃部署的账户返回 500）。
- **用量核算**：Token 用量经 `calculateOpenAIUsageAccounting`（`packages/ai/src/providers/openai-shared.ts`）中的标准 `openai-completions` 核算处理，提取 `prompt_tokens`、`completion_tokens`、`prompt_tokens_details.cached_tokens` 与 `completion_tokens_details.reasoning_tokens`。

### Catalog 模型处理
- **描述符注册**：注册于 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`），`id: "fireworks"`、`defaultModel: "kimi-k2.7-code"`、`envVars: ["FIREWORKS_API_KEY"]`、`createModelManagerOptions: fireworksModelManagerOptions`。
- **控制面发现**：`fireworksModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）经控制面 catalog `GET /v1/accounts/fireworks/models?filter=supports_serverless=true` 枚举模型而非 `/v1/models`，使用 `toFireworksPublicModelId` 把资源名（`accounts/fireworks/models/<id>`）转换为公共 catalog ID。内部账户资源 ID 在 `scripts/generate-models.ts` 的 catalog 生成期间被修剪。
- **快速变体种子**：`buildFireworksFastSeed`（`packages/catalog/src/provider-models/openai-compat.ts`）程序化生成 `-fast` catalog 种子（如 `kimi-k2.7-code-fast`、`glm-5.1-fast`），与精选基础模型配对，保留基础定价但目标高速路由线上路径。
- **Kimi 家族输出 token 上限**：`clampFireworksKimiMaxTokens`（`packages/catalog/src/provider-models/openai-compat.ts`）对 Kimi K2.5/K2.6 模型（`isFireworksKimiK2ModelId`）把输出预算 `maxTokens` 钳制为 `FIREWORKS_KIMI_MAX_TOKENS = 32_768`，防止 Fireworks 报告的 `max_completion_tokens: 65536` 引起的失控推理轨迹。`kimi-k2.7-code` 被显式排除在此上限之外，允许到其完整输出预算（`FIREWORKS_KIMI_K27_CODE_MAX_TOKENS = 65_536`）。
- **推理 Effort 阶梯**：`FIREWORKS_REASONING_EFFORT_MAP`（`packages/catalog/src/model-thinking.ts`）把 `minimal -> "none"` 映射（在 Fireworks 上禁用推理），同时放行 `low`、`medium` 与 `high`。受限模型（如 `minimax-m2.7`、`gpt-oss-120b`）在 catalog 定义中把 effort 阶梯覆盖为 `[low, medium, high]`。

## GitHub Copilot (`github-copilot`)
GitHub Copilot 经 GitHub 统一代理端点（`https://api.githubcopilot.com` 或企业 `copilot-api.<domain>`）路由多供应商模型执行（OpenAI GPT、Anthropic Claude、xAI Grok、Google Gemini）。该 provider 动态分发到三种线上传输：OpenAI Chat Completions、OpenAI Responses 与 Anthropic Messages。

### 特殊处理
- **动态 Copilot header 与发起者**：`buildCopilotDynamicHeaders`（`packages/ai/src/providers/github-copilot-headers.ts`）注入逐请求 header `X-Initiator`（`"user"` 对 `"agent"`，经 `inferCopilotInitiator` 从消息历史推断或经 `getCopilotInitiatorOverride` 覆盖）、`Openai-Intent: conversation-edits`，以及当 `hasCopilotVisionInput` 在用户或工具结果块中检测到图像载荷时的 `Copilot-Vision-Request: true`。
- **API 版本与线上 header**：`COPILOT_API_HEADERS`（`packages/catalog/src/wire/github-copilot.ts`）强制 `User-Agent: opencode/1.3.15`（`COPILOT_USER_AGENT`）与 `X-GitHub-Api-Version: 2026-06-01`（`COPILOT_API_VERSION`）。`packages/catalog/src/provider-models/openai-compat.ts` 中的 `restorableHeaderFallback` 在离线缓存重建期间保留静态线上 header。
- **基础 URL 与端点解析**：`resolveGitHubCopilotBaseUrl`（`packages/ai/src/providers/github-copilot-headers.ts`）与 `parseGitHubCopilotApiKey`（`packages/catalog/src/wire/github-copilot.ts`）解析嵌入在 API key 或凭据中的自定义 `enterpriseUrl` 与 `apiEndpoint` 属性，默认 `https://api.githubcopilot.com`（`PERSONAL_GITHUB_COPILOT_BASE_URL`）。
- **OpenAI 与 Responses compat 标志**：
  - `supportsReasoningParams`：在 `packages/catalog/src/compat/openai.ts` 中禁用（`supportsReasoningParams: provider !== "github-copilot"`），因为 Copilot Chat Completions 端点对 `reasoning_effort` 与推理字段返回 HTTP 400。
  - `supportsDeveloperRole`：对 Chat Completions 规格禁用（`openai-compat.ts`），但在 OpenAI Responses 规格上启用。
  - `strictResponsesPairing`：在 `packages/catalog/src/compat/openai.ts` 中启用（`spec.provider === "github-copilot"`），在 Responses 端点上强制工具调用与工具结果消息之间的严格配对。
  - `supportsImageDetailOriginal`：禁用（`supportsImageDetailOriginal: false`），把图像 detail 从 `"original"` 钳制为 `"auto"`，以避免代理 400/422 拒绝。
- **Anthropic 线上与签名 compat**：
  - `supportsEagerToolInputStreaming`：在 `packages/catalog/src/compat/anthropic.ts` 中禁用（`supportsEagerToolInputStreaming: false`），细粒度工具流式 beta header 被省略，因为 Copilot Anthropic 代理拒绝 `eager_input_streaming`（#2558）。
  - 被识别为签名宿主（`buildAnthropicCompat`），抑制 Claude 模型的未签名 thinking 重放（#2851）。

### 认证与用量
- **设备流 OAuth（`opencode` OAuth 应用）**：
  - 在 `packages/catalog/src/compat/rules/auth/github-copilot.kdl` 中声明（`login "custom" hook="github-copilot"`），`packages/ai/src/registry/oauth/github-copilot.ts` 中的 `loginGitHubCopilotHook` 使用 client ID `Ov23li8tweQw6odWQebz`（`CLIENT_ID`）与作用域 `read:user` 执行 GitHub Device Authorization Flow。
  - `startDeviceFlow` 带 `OPENCODE_HEADERS` POST 到 `https://<domain>/login/device/code`。`pollForGitHubAccessToken` 轮询 `https://<domain>/login/oauth/access_token`，自动处理 `authorization_pending` 与 `slow_down` 限流退避。
  - 登录后，`discoverGitHubCopilotApiEndpoint` 查询 `https://api.github.com/copilot_internal/user`，`enableAllGitHubCopilotModels` 发出模型启用请求（`POST /models/{modelId}/policy`，带 `{ state: "enabled" }` 与 `openai-intent: chat-policy`）。
- **令牌交换与刷新**：
  - `refreshGitHubCopilotToken`（`packages/ai/src/registry/oauth/github-copilot.ts`）直接使用长期 GitHub OAuth 令牌，无二次 JWT 交换循环，把过期时间设为 `FAR_FUTURE_MS`（10 年）。
- **用量与配额核算**：
  - `packages/ai/src/usage/github-copilot.ts` 中的 `fetchInternalUsage` 带 `OPENCODE_HEADERS` 在 `resolveGitHubApiBaseUrl` 上查询 `GET /copilot_internal/user`。
  - `normalizeQuotaSnapshots` 与 `buildLimitFromQuota` 把 `quota_snapshots`（`chat`、`completions`、`premium_interactions`）与 `quota_reset_date` 转换为月度 `UsageLimit` 结构（`copilot:premium`、`copilot:chat`、`copilot:completions`）。`fetchBillingUsage` 提供补充的用户计费详情（`/settings/billing/premium_request/usage`）。
  - `getCopilotPremiumRequests`（`packages/ai/src/providers/github-copilot-headers.ts`）计算模型 premium 请求成本：agent 回合为 `0`（`initiator === "agent"`），用户回合为 `getCopilotPremiumMultiplier(premiumMultiplier, planTier)`。

### Catalog 模型处理
- **描述符与管理**：注册为 `PROVIDER_DESCRIPTORS` 中的 `github-copilot` 描述符（`packages/catalog/src/provider-models/descriptors.ts`），`defaultModel: "gpt-5.5"`，环境变量 `COPILOT_GITHUB_TOKEN`。选项经 `githubCopilotModelManagerOptions` 构建。
- **动态模型发现**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `fetchDynamicModels` 使用 `COPILOT_API_HEADERS` 获取 `/models`。从 `entry.capabilities.limits` 解析窗口/token 限制（`maxContextWindowTokens`、`maxPromptTokens`、`maxOutputTokens`），推断线上 API（`inferCopilotApi`），并配置视觉支持（`extractCopilotSupportsVision`）。
- **长上下文变体合成**：在 `billing.token_prices.long_context` 中通告长上下文定价的模型触发 `createCopilotLongContextVariant`，合成可选的 `-1m` catalog 模型（如 `claude-opus-4.7-1m`，带 `requestModelId: "claude-opus-4.7"`）。基础模型获得指向其长上下文兄弟的 `contextPromotionTarget`。
- **Premium 请求倍率**：模型特定的请求倍率映射在 `COPILOT_PREMIUM_MULTIPLIERS`（`packages/catalog/scripts/generate-models.ts`）中，分配如 `gpt-4o: 0`、`grok-code-fast-1: 0.25`、`claude-haiku-4.5: 0.33`、`gpt-5.4-mini: 0.33` 与 `claude-opus-4.6: 3` 等值。

## GitLab Duo Non-Agentic (`gitlab-duo`)

`GitLab Duo Non-Agentic`（`gitlab-duo`）把 Duo Chat LLM 补全请求代理到 GitLab AI Gateway 代理端点。根据目标模型映射，它动态委托执行到 [Anthropic Messages](#anthropic-messages)、[OpenAI Chat Completions](#openai-chat-completions) 或 [OpenAI Responses](#openai-responses) 线上传输。它搭载共享的 [GitLab Duo](#gitlab-duo) 传输小节。

### 特殊处理
- **模型 ID 映射与路由**：`packages/ai/src/providers/gitlab-duo.ts` 中的 `MODEL_MAPPINGS` 把 Duo 模型标识符（`duo-chat-opus-4-6`、`duo-chat-sonnet-4-6`、`duo-chat-opus-4-5`、`duo-chat-sonnet-4-5`、`duo-chat-haiku-4-5`、`duo-chat-gpt-5-1`、`duo-chat-gpt-5-2`、`duo-chat-gpt-5-mini`、`duo-chat-gpt-5-codex`、`duo-chat-gpt-5-2-codex`）映射到后端 provider（`anthropic` 或 `openai`）、底层模型 ID、API schema（`anthropic-messages`、`openai-completions`、`openai-responses`）与代理目标 URL（`ANTHROPIC_PROXY_URL` = `https://cloud.gitlab.com/ai/v1/proxy/anthropic/` 或 `OPENAI_PROXY_URL` = `https://cloud.gitlab.com/ai/v1/proxy/openai/v1`）。
- **规范模型别名查找**：`packages/ai/src/providers/gitlab-duo.ts` 中的 `getModelMapping` 通过匹配 Duo 别名键或底层规范模型 ID 字符串（如 `gpt-5-codex` 或 `claude-sonnet-4-5-20250929`）解析模型映射。
- **Direct Access 令牌交换与缓存**：`packages/ai/src/providers/gitlab-duo.ts` 中的 `getDirectAccessToken` 经 `POST https://gitlab.com/api/v4/ai/third_party_agents/direct_access` 带 `{ feature_flags: { DuoAgentPlatformNext: true } }` 把用户的 GitLab 访问令牌交换为短期直接访问令牌。结果令牌与 header 缓存在 `directAccessCache` 中 25 分钟（`DIRECT_ACCESS_TTL_MS`）。
- **委托流分发**：`packages/ai/src/providers/gitlab-duo.ts` 中的 `streamGitLabDuo` 校验用户令牌（`MissingApiKeyError`）、获取 direct access header、经 `mapAnthropicToolChoice`（`packages/ai/src/stream.ts`）翻译 Anthropic 工具选择，并使用合成模型规格（`buildModel`）分发到 `streamAnthropic`、`streamOpenAICompletions` 或 `streamOpenAIResponses`（`packages/ai/src/providers/register-builtins.ts`）。

### 认证与用量
- **PAT 与 OAuth 支持**：在 `packages/catalog/src/compat/rules/auth/gitlab-duo.kdl` 中声明（`login "oauth-code"`，引擎 `packages/ai/src/registry/engine/oauth-code.ts`），缓存清除钩子在 `packages/ai/src/registry/oauth/gitlab-duo.ts`，支持经 `GITLAB_TOKEN` 的 Personal Access Token 或 PKCE 浏览器 OAuth。
- **OAuth 授权与 client ID**：在 `packages/catalog/src/compat/rules/auth/gitlab-duo.kdl` 中声明，对 `https://gitlab.com/oauth/authorize` 执行 PKCE OAuth（`scope: "api"`、`callbackPort: 8080`、`pasteCodeFlow: true`）。使用 `client-id`（`"da4edff2e6ebd2bc3208611e2768bc1c1dd7be791dc5ff26ca34ca9ee44f7d4b"`），可经 `GITLAB_CLIENT_ID`（`env="GITLAB_CLIENT_ID"`）与 `GITLAB_REDIRECT_URI`（`redirect-uri-env="GITLAB_REDIRECT_URI"`）覆盖。
- **令牌刷新与缓存失效**：`packages/catalog/src/compat/rules/auth/gitlab-duo.kdl` 中的令牌刷新在 `https://gitlab.com/oauth/token` 交换刷新令牌。交换与刷新都经 `gitLabDuoClearCacheHook`（`packages/ai/src/registry/oauth/gitlab-duo.ts`，调用 `packages/ai/src/providers/gitlab-duo.ts` 中的 `clearGitLabDuoDirectAccessCache`）清除缓存的 direct access 令牌。
- **用量呈现**：除 [GitLab Duo](#gitlab-duo) 流水线外无其他内容。

### Catalog 模型处理
- **描述符配置**：`packages/catalog/src/provider-models/descriptors.ts` 中的 `PROVIDER_DESCRIPTORS` 注册 `gitlab-duo`，`defaultModel: "duo-chat-opus-4-6"` 与 `envVars: ["GITLAB_TOKEN"]`。
- **静态 Catalog 生成**：`packages/catalog` 中的 `scripts/generate-models.ts` 调用 `getGitLabDuoModels`（`packages/ai/src/providers/gitlab-duo.ts`），把 `MODEL_MAPPINGS` 条目转换为 `models.json` 中打包的 `ModelSpec` 定义。
- **Provider 优先级**：`packages/catalog/src/identity/priority.ts` 中的 `PROVIDER_PRIORITY` 给 `gitlab-duo` 分配优先级 35。

## GitLab Duo Agent (`gitlab-duo-agent`)
`gitlab-duo-agent` provider 经 WebSocket action-bridge 协议把 OMP 连接到 GitLab Duo Workflow Service（DWS）进行 agentic 执行。它搭载 `GitLab Duo` 传输小节。

### 特殊处理
- **流直接绕过与 thinking 修复**：在 `packages/ai/src/stream.ts` 中，`gitlab-duo-agent` 绕过 `withProviderInFlightLimit` 与标准 `iterateWithIdleTimeout` 包装。`streamGitLabDuoWorkflow`（`packages/ai/src/providers/gitlab-duo-workflow.ts`）被直接调用，包装在 `healLeakedThinking` 中。
- **运行时命名空间解析与自动启用**：流初始化调用 `resolveGitLabDuoWorkflowNamespaceSelection`（`packages/ai/src/providers/gitlab-duo-workflow.ts`），从选项、`GITLAB_DUO_NAMESPACE_ID`/`GITLAB_DUO_PROJECT_ID` 环境变量或 workspace git remote 解析根命名空间。`ensureGitLabDuoWorkflowSettings` 提交到 `/api/v4/ai/duo_workflows/settings`（30 秒超时，经 `GITLAB_DUO_WORKFLOW_REST_TIMEOUT_MS`），自动启用所需的命名空间设置（`duo_workflow`、`duo_workflow_service`、`duo_agent_platform`）。
- **ChatML 目标与内联规格生成**：把对话历史渲染为 ChatML 目标字符串（`buildGitLabDuoWorkflowGoal`、`renderGitLabDuoWorkflowChatMl`），受 1MB 软限制（`GITLAB_DUO_WORKFLOW_GOAL_SOFT_OVERFLOW_BYTES`）与 2MB 硬限制（`GITLAB_DUO_WORKFLOW_GOAL_HARD_OVERFLOW_BYTES`）约束。发出目标为 `omp_agent` 的环境内联工作流定义（`buildGitLabDuoWorkflowInlineFlowConfig`）。
- **WebSocket action 桥**：工具定义转换为 MCP 格式（`buildGitLabDuoWorkflowMcpTools`），放入 `startRequest.mcpTools`。经 WebSocket 传入的 `runMCPTool`/`run_mcp_tool` action 被提取（`extractGitLabDuoWorkflowAction`）、本地执行，并经 `buildGitLabDuoWorkflowActionResponse` 返回。

### 认证与用量
- **注册表与凭据解析**：在 `packages/catalog/src/compat/rules/auth/gitlab-duo-agent.kdl` 中声明，要求 `GITLAB_TOKEN`（PAT 或经 `env "GITLAB_TOKEN"` 的 OAuth 令牌）。
- **OAuth PKCE 与官方 client ID**：在 `packages/catalog/src/compat/rules/auth/gitlab-duo-agent.kdl` 中声明的浏览器认证（`login "oauth-code"`，引擎 `packages/ai/src/registry/engine/oauth-code.ts`）在 `vscode://gitlab.gitlab-workflow/authentication` 上使用 S256 PKCE 与 `manual-only=#true`。使用官方 GitLab VS Code client ID（`36f2a70cddeb5a0889d4fd8295c241b7e9848e89cf9e599d0eed2d8e5350fbf5`），在 VS Code 拦截重定向时支持手动粘贴回调 URL。令牌刷新在 KDL 规则的 `refresh` 下声明（`packages/ai/src/registry/engine/refresh.ts`）。
- **Direct Access 令牌**：经 `POST /api/v4/ai/duo_workflows/direct_access` 请求临时凭据（`packages/ai/src/providers/gitlab-duo-workflow.ts` 中的 `requestGitLabDuoWorkflowDirectAccess`）。`packages/ai/src/usage/` 下不存在专门的用量模块。
- **上下文遥测用量**：`extractGitLabDuoWorkflowContextUsage` 提取检查点遥测（`agent_context_usage`），优先 `"Chat Agent"` 与 `"context_builder"` 条目，并经 `applyGitLabDuoWorkflowContextUsage` 更新 token 估算。

### Catalog 模型处理
- **Provider 描述符**：注册于 `packages/catalog/src/provider-models/descriptors.ts`，`defaultModel: "claude_sonnet_4_6_vertex"`、`envVars: ["GITLAB_TOKEN"]` 与 `dynamicModelsAuthoritative: true`。省略 `catalogDiscovery` 以防止单账户命名空间发现在静态 catalog 生成期间运行。
- **指纹化作用域缓存**：`packages/catalog/src/provider-models/special.ts` 中的 `gitLabDuoWorkflowModelManagerOptions` 配置动态模型管理。`gitLabDuoWorkflowModelCacheProviderId` 使用 `Bun.hash` 对 `apiKey` 与由 `baseUrl`、`namespaceId`、`projectId` 和 workspace `cwd` 组成的作用域字符串哈希，分区动态 catalog 缓存。
- **GraphQL 发现**：`fetchGitLabDuoWorkflowModels`（`packages/catalog/src/discovery/gitlab-duo-workflow.ts`）调用 `discoverGitLabDuoWorkflowNamespace` 定位根命名空间（经显式配置、环境变量或匹配 `discoverGitLabRemoteProjectPath` 的 git remote），并执行 GraphQL 查询 `aiChatAvailableModels(rootNamespaceId:)` 查询 `defaultModel`、`selectableModels` 与 `pinnedModel`。
- **模型规格与上下文窗口**：`buildGitLabDuoWorkflowModelSpec` 构建带 `reasoning: false` 的模型规格（禁用 thinking UI 控件，因为 Duo Agent Platform 在服务器端管理 Anthropic 推理参数）。`resolveGitLabDuoWorkflowContextWindow` 把模型引用映射到上下文窗口大小（Claude Opus/Sonnet：1,000,000；Haiku：200,000；Gemini：1,000,000；GPT-5：400,000；默认：200,000）。
- **回退模型种子**：`scripts/generate-models.ts` 种子化 `buildGitLabDuoWorkflowFallbackModel()`（`claude_sonnet_4_6_vertex`），使未认证/全新安装也包含默认模型条目。

## GMI Cloud (`gmi-cloud`)
GMI Cloud 是 AI GPU 基础设施与云模型推理 provider，托管开源权重与专有模型端点。它经 OpenAI Chat Completions 传输运行，使用托管在 `https://api.gmi-serving.com/v1` 的标准 `/v1` 线上协议。

### 特殊处理
- 除 OpenAI Chat Completions 流水线外无其他内容。

### 认证与用量
- **API Key 登录与校验**：在 `packages/catalog/src/compat/rules/auth/gmi-cloud.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），引导用户到 `https://console.gmicloud.ai`。Key 校验使用 `kind: "models-endpoint"` 请求 `https://api.gmi-serving.com/v1/models`。
- **环境变量**：主凭据解析检查 `GMI_API_KEY`（`packages/catalog/src/provider-models/descriptors.ts` 中的 `envVars`）。
- **Provider 注册表**：从 `packages/catalog/src/compat/rules/auth/gmi-cloud.kdl` 经 `packages/ai/src/registry/build.ts` 编译进 `packages/ai/src/registry/registry.ts`。

### Catalog 模型处理
- **描述符与网关选项**：注册于 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`），`id: "gmi-cloud"`、`defaultModel: "deepseek-ai/DeepSeek-V4-Flash"` 与 `dynamicModelsAuthoritative: true`。网关选项由 `gmiCloudModelManagerOptions` 创建，包装带 `GMI_CLOUD_BASE_URL`（`https://api.gmi-serving.com/v1`）的 `createSimpleOpenAICompletionsOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）。
- **动态模型发现**：配置 `catalogDiscovery: { label: "GMI Cloud" }`（`packages/catalog/src/provider-models/descriptors.ts`），经 `fetchOpenAICompatibleModels`（`packages/catalog/src/discovery/openai-compatible.ts`）动态查询 `/v1/models`。当 API 凭据可用时，标记为权威的实时发现结果覆盖缓存或静态条目。
- **静态种子模型**：`GMI_CLOUD_STATIC_MODELS`（`packages/catalog/src/provider-models/openai-compat.ts`）为 `deepseek-ai/DeepSeek-V4-Flash` 定义内置回退种子（1,048,576 上下文窗口、384,000 max tokens、每 1M 输入/输出 token `$0.14`/`$0.28`，启用推理并带 `High` 与 `Max` effort 模式）。此种子确保缺少 `GMI_API_KEY` 的全新安装或模型生成运行可以同步解析该 provider 的默认模型（`packages/catalog/scripts/generate-models.ts`、`packages/catalog/test/gmi-cloud-provider.test.ts`）。

## Google Antigravity (`google-antigravity`)
Google Antigravity provider（`google-antigravity`）使用专用 OAuth 凭据把请求路由到 Google Cloud Code Assist daily/sandbox 端点（`daily-cloudcode-pa.googleapis.com`）。它使用共享的 "Google Gemini CLI / Antigravity" 传输（`packages/ai/src/providers/google-gemini-cli.ts`），提供 Google Gemini 3.x/2.5 模型以及 Anthropic Claude 与 OpenAI GPT-OSS 模型的访问。

### 特殊处理
- **Validated 函数调用默认值**：`buildRequest`（`packages/ai/src/providers/google-gemini-cli.ts`）中的默认工具选择模式为 `VALIDATED`（`functionCallingConfig: { mode: "VALIDATED" }`）。Antigravity 上的 Claude 模型即使未声明工具也始终强制 `VALIDATED` 工具模式（`packages/ai/src/providers/google-gemini-cli.ts`）。
- **系统指令与请求信封**：Antigravity 用 `role: "user"` 标记 `systemInstruction` 并原样发送调用方的 prompt。`buildAntigravityRequestEnvelope` 注入结构化 `requestId`（`agent/<id>/<ts>/<trajectoryId>/<step>`）、`userAgent: "antigravity"`、`requestType: "agent"`、`sessionId` 与 `labels`（`model_enum`、`trajectory_id`、`last_step_index`、`last_execution_id`、`used_claude*`），使用 `getAntigravityModelWireProfile`。
- **端点自动故障转移**：在 `ANTIGRAVITY_DAILY_ENDPOINT`（`https://daily-cloudcode-pa.googleapis.com`）与 `ANTIGRAVITY_SANDBOX_ENDPOINT`（`https://daily-cloudcode-pa.sandbox.googleapis.com`）之间运行，状态跟踪回退在 `getAntigravityProviderSessionState`（`packages/ai/src/providers/google-gemini-cli.ts`）中。

### 认证与用量
- **专用 OAuth 流程**：在 `packages/catalog/src/compat/rules/auth/google-antigravity.kdl` 中声明（`login "oauth-code"` 规则，`packages/ai/src/registry/engine/oauth-code.ts`），项目发现钩子在 `packages/ai/src/registry/oauth/google-antigravity.ts`（`googleAntigravityProjectHook`），执行独立 OAuth 流程，带不同的 client 凭据与回调端口 51121。项目发现镜像原生 `antigravity/hub`：精确 200 的 `loadCodeAssist` 调用使用 `ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA`，尊重 free-tier 资格，缺少层级触发一次 `onboardUser` 请求加 30 秒截止内 1 秒的操作轮询，最终加载刷新提供 `cloudaicompanionProject`。
- **模型家族凭据排名**：`antigravityRankingStrategy`（`packages/ai/src/usage/google-antigravity.ts`）按模型家族限定用量限制作用域（`scopeAntigravityLimitsForModel` 经 `getAntigravityCounterKeyForModel`：`claude-` 为 `anthropic`、`gemini-`/`gemma-` 为 `google`、`gpt-`/`openai/` 为 `openai`）。这防止一个计数器（如 Gemini）上的配额耗尽阻塞另一个家族（如 Claude）的多账户凭据选择。

### Catalog 模型处理
- **Catalog 发现**：`fetchAntigravityDiscoveryModels`（`packages/catalog/src/discovery/antigravity.ts`）查询 `/v1internal:fetchAvailableModels`，过滤黑名单 ID（`chat_20706`、`chat_23310`、`gemini-2.5-pro`）与内部模型（`isInternal`），并经 `ANTIGRAVITY_VARIANT_COLLAPSE_TABLE` 应用 effort 档位变体折叠。
- **Claude 与 GPT-OSS 模型可用性**：在 `models.json`（`packages/catalog/src/models.json`）中与 Gemini 3.x/2.5 模型一起暴露 Anthropic Claude 模型（`claude-opus-4-5`、`claude-opus-4-6`、`claude-sonnet-4-5`、`claude-sonnet-4-6`）与 `gpt-oss-120b`。
- **定价回退**：`applyAntigravityPricingFallback`（`packages/catalog/scripts/generated-policies.ts`）使用 `ANTIGRAVITY_PRICING_PEERS`（`google`、`google-vertex`、`anthropic`）与 `ANTIGRAVITY_PRICING_ID_ALIASES`（`gemini-3-flash` -> `gemini-3-flash-preview`、`claude-opus-4-5` -> `claude-opus-4-5@20251101`）回填 0 成本发现模型，把 Gemini 模型映射到 Google API 价格，Claude 模型映射到 Google Vertex 定价。

## Google Gemini CLI (`google-gemini-cli`)
Google Cloud Code Assist（Gemini CLI）（`google-gemini-cli`）是 Google 经 OAuth 认证的 developer 免费与工作区层级，通过 Cloud Code Assist API 端点（`https://cloudcode-pa.googleapis.com`）提供 Gemini 模型的直接访问。搭载共享的 **Google Gemini CLI / Antigravity** 传输小节（`packages/ai/src/providers/google-gemini-cli.ts`）。

### 特殊处理
- **默认端点与 header**：把请求分发到 `https://cloudcode-pa.googleapis.com` 并经 `getGeminiCliHeaders()` 发出 header（`packages/catalog/src/wire/gemini-headers.ts` 中的 `GeminiCLI/0.46.0/<modelId> ...`）。
- **Thinking 传输**：经 `google-level` `thinkingLevel` 传输映射 Gemini thinking（`packages/catalog/src/variant-collapse.ts` 中的 `GEMINI_CLI_VARIANT_COLLAPSE_TABLE`），不同于使用 `budget` 传输的 `google-antigravity`（`ANTIGRAVITY_VARIANT_COLLAPSE_TABLE`）。
- 标准请求流水线：除 Google Gemini CLI / Antigravity 传输流水线外无其他内容。

### 认证与用量
- **OAuth 已安装应用流程**：经 `packages/catalog/src/compat/rules/auth/google-gemini-cli.kdl` 中声明的 Google PKCE OAuth 2.0 授权（`login "oauth-code"`，引擎 `packages/ai/src/registry/engine/oauth-code.ts`），回调端口 `8085`（`/oauth2callback`），请求 Google Cloud 作用域（`cloud-platform`、`userinfo.email`、`userinfo.profile`）。刷新在 `refresh` 下声明（`packages/ai/src/registry/engine/refresh.ts`），项目钩子在 `packages/ai/src/registry/oauth/google-gemini-cli.ts`。
- **项目发现与入门**：`discoverProject`（`packages/ai/src/registry/oauth/google-gemini-cli.ts`）以 `$GOOGLE_CLOUD_PROJECT` / `$GOOGLE_CLOUD_PROJECT_ID` 回退经 `POST /v1internal:loadCodeAssist` 检查既有项目。非 free 层级（`legacy-tier`、`standard-tier`）或新账户调用 `POST /v1internal:onboardUser` 带 `tierId`（`free-tier`、`legacy-tier`、`standard-tier`）并轮询 `pollOperation`（最多 `POLL_MAX_ATTEMPTS` = 24，5 秒间隔）。检测 VPC-SC 限制（`isVpcScAffectedUser` 检查 `SECURITY_POLICY_VIOLATED`）。
- **配额与用量 provider**：`googleGeminiCliUsageProvider`（`packages/ai/src/usage/gemini.ts`）提交 `loadCodeAssist` 与 `retrieveUserQuota`（`/v1internal:retrieveUserQuota`），把剩余桶比例映射为按模型层级（经 `getModelTier` 的 `3-Flash`、`Flash`、`Pro`）分组的用量百分比。

### Catalog 模型处理
- **Provider 描述符**：注册于 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`），`defaultModel: "gemini-3.1-pro-preview"` 与 `specialModelManager: true`，绕过标准模型工厂。
- **模型解析与发现**：`googleGeminiCliModelManagerOptions`（`packages/catalog/src/provider-models/google.ts`）以 `GEMINI_CLI_VARIANT_COLLAPSE_TABLE` 对 Antigravity daily 端点调用 `fetchAntigravityDiscoveryModels`（`packages/catalog/src/discovery/antigravity.ts`），把结果过滤为 Gemini 模型，然后把 provider 重写为 `google-gemini-cli`、推理基础 URL 重写为 `https://cloudcode-pa.googleapis.com`。当 Antigravity 端点对该凭据未授权时（Gemini Code Assist Standard 返回 HTTP 403），回退到 `fetchGeminiCliQuotaModels`（`packages/catalog/src/discovery/gemini-cli.ts`），它从 Cloud Code Assist 上该账户自己的 `retrieveUserQuota` 响应派生模型列表，在 id 已知处从内置 catalog 填充元数据。
- **生成器集成与优先级**：当 `google-antigravity` 访问不可用时，作为 `fetchAntigravityModels`（`packages/catalog/scripts/generate-models.ts`）中的回退 OAuth 令牌 provider。在 provider 优先级中排第二（`packages/catalog/src/identity/priority.ts`）。

## Groq (`groq`)
Groq 为开源权重模型提供由定制 LPU 硬件驱动的高速 LLM 推理，使用 OpenAI Chat Completions 传输（`https://api.groq.com/openai/v1`）。

### 特殊处理
- **上下文溢出**：当错误消息匹配 `packages/ai/src/error/flags.ts` 中 `OVERFLOW_PATTERNS` 的 `/reduce the length of the messages/i` 时检测。
- **推理 Effort 映射**：模型 `qwen/qwen3-32b` 经 `GROQ_QWEN3_32B_REASONING_EFFORT_MAP`（`packages/catalog/src/model-thinking.ts`）把 `Minimal`、`Low`、`Medium`、`High` 与 `XHigh` 映射到 `"default"`。
- **多条系统消息**：默认在 OpenAI 兼容性设置中原生支持，经 `packages/catalog/src/compat/openai.ts` 中 `supportsMultipleSystemMessagesDefault` 的 `isGroqHost`。

### 认证与用量
- **认证**：经 `GROQ_API_KEY` 环境变量认证（`packages/catalog/src/provider-models/descriptors.ts`）。
- **Provider 注册表**：在 `packages/catalog/src/compat/rules/auth/groq.kdl` 中声明并编译进 `packages/ai/src/registry/registry.ts`。
- **优先级**：在 provider 优先级排序中列第 19（`packages/catalog/src/identity/priority.ts`）。

### Catalog 模型处理
- **宿主匹配**：在宿主定义中按 URL 标记 `api.groq.com` 或 provider `groq` 匹配（`packages/catalog/src/hosts.ts`）。
- **管理器选项**：经 `groqModelManagerOptions` 配置，目标 `https://api.groq.com/openai/v1`（`packages/catalog/src/provider-models/openai-compat.ts`）。
- **默认模型**：默认 `openai/gpt-oss-120b`（`packages/catalog/src/provider-models/descriptors.ts`）。

## Hugging Face Inference (`huggingface`)
Hugging Face Inference 提供对托管在 Hugging Face Hub 上的开源模型 serverless 端点的访问，使用 OpenAI Chat Completions 传输（`openai-completions`）指向 `https://router.huggingface.co/v1`。该 provider 使包括 DeepSeek-R1 在内的模型能够进行 serverless LLM 生成。

### 特殊处理
- **标准传输流水线**：除 OpenAI Chat Completions 流水线（`packages/ai/src/providers/openai-completions.ts`）外无其他内容。

### 认证与用量
- **环境回退**：`getEnvApiKey`（`packages/ai/src/stream.ts`）中的环境变量解析查询 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中的 `envVars`，先检查 `HUGGINGFACE_HUB_TOKEN`，随后 `HF_TOKEN`。
- **交互式 CLI 登录**：在 `packages/catalog/src/compat/rules/auth/huggingface.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），提示输入细粒度用户访问令牌（占位符 `hf_...`）。
- **细粒度令牌权限**：认证设置引导用户到 `https://huggingface.co/settings/tokens/new?ownUserPermissions=inference.serverless.write&tokenType=fineGrained`（`packages/catalog/src/compat/rules/auth/huggingface.kdl` 中的 `AUTH_URL`），自动选择带所需 "Make calls to Inference Providers" 权限（`inference.serverless.write`）的细粒度令牌。
- **凭据校验**：在 `packages/catalog/src/compat/rules/auth/huggingface.kdl` 中声明，使用轻量 chat completion 请求（`validate "chat-completions"`）对基础 URL `https://router.huggingface.co/v1` 与校验模型 `openai/gpt-oss-120b` 校验 API key。

### Catalog 模型处理
- **Provider 描述符**：注册于 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`），`id: "huggingface"`、`defaultModel: "deepseek-ai/DeepSeek-R1"`、环境回退 `envVars: ["HUGGINGFACE_HUB_TOKEN", "HF_TOKEN"]`、`catalogDiscovery: { label: "Hugging Face" }`。
- **模型管理器选项**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `huggingfaceModelManagerOptions` 经 `createSimpleOpenAICompletionsOptions` 构建管理器选项，绑定默认基础 URL `https://router.huggingface.co/v1` 并用内置参考规格映射静态模型（`mapWithBundledReference`）。
- **Catalog 描述符**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `openAiCompletionsDescriptor` 在 `PROVIDER_DESCRIPTORS` 中注册 `huggingface`，目标 `https://router.huggingface.co/v1`。
- **Catalog 发现**：经 `catalogDiscovery` 参与 catalog 生成，`generate-models.ts`（`packages/catalog/scripts/generate-models.ts`）经 `resolveProviderApiKey` 解析 API 令牌，并调用 `fetchOpenAICompatibleModels`（`packages/catalog/src/discovery/openai-compatible.ts`）请求 `https://router.huggingface.co/v1/models` 以发现可用的 Hub 推理端点。

## Kilo Gateway (`kilo`)
Kilo Gateway（`kilo`）是一个 AI 模型聚合与代理服务（`https://api.kilo.ai/api/gateway`），使用 OpenAI Chat Completions 传输（`api: "openai-completions"`）。它支持经 `KILO_API_KEY` 或设备码 OAuth 流程（`/login kilo`）的认证，并允许从其 OpenAI 兼容 `/models` catalog 端点进行无认证的动态模型发现。

### 特殊处理
- **设备码 OAuth 认证**：在 `packages/catalog/src/compat/rules/auth/kilo.kdl` 中声明（`login "custom" hook="kilo"`），实现于 `packages/ai/src/registry/oauth/kilo.ts`（`loginKilo`），经 `POST https://api.kilo.ai/api/device-auth/codes` 发起设备授权，返回用户 `code`、`verificationUrl` 与 `expiresIn` 秒数。它经 `callbacks.onAuth` 显示指令，并每 5,000ms 轮询 `GET https://api.kilo.ai/api/device-auth/codes/<userCode>` 直到过期。处理 HTTP 202（待定）、403/410（拒绝/过期）与限流（HTTP 429），批准时（`pollData.status === "approved"`）返回 1 年过期的访问令牌。支持经 `callbacks.signal` 取消。
- **非标准宿主分类**：`modelMatchesHost(hostModel, "kilo")` 在 `packages/catalog/src/compat/openai.ts` 中设置 `isKilo`，把 Kilo 归入非标准 OpenAI 兼容 provider（`isNonStandard`）以管理传输兼容性行为。
- **宿主 URL 匹配**：`packages/catalog/src/hosts.ts` 中的宿主映射把 URL 标记 `api.kilo.ai` 与 provider `"kilo"` 关联。
- **Provider 优先级**：包含在 `packages/catalog/src/identity/priority.ts` 的 provider 优先级序列中（`opencode-go`、`kilo`、`vercel-ai-gateway`）。

### 认证与用量
- **API Key 与 OAuth 令牌**：经静态环境变量 `KILO_API_KEY` 或设备码流程（`/login kilo`）发出的 OAuth 访问令牌认证。
- **Bearer 令牌 header**：请求以标准 Bearer 令牌（`Authorization: Bearer <key>`）向基础 URL `https://api.kilo.ai/api/gateway` 传递凭据。

### Catalog 模型处理
- **Provider 描述符**：注册于 `packages/catalog/src/provider-models/descriptors.ts`，`defaultModel: "anthropic/claude-opus-4.8"`、环境变量 `KILO_API_KEY`、`catalogDiscovery: { label: "Kilo Gateway", allowUnauthenticated: true }`，允许无需 API key 的 catalog 发现。
- **模型管理器与线上描述符**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `kiloModelManagerOptions` 把 `providerId: "kilo"` 映射到基础 URL `https://api.kilo.ai/api/gateway` 并把动态模型发现委托给 `fetchOpenAICompatibleModels`。与 `openAiCompletionsDescriptor("kilo", "kilo", "https://api.kilo.ai/api/gateway")` 关联。
- **Thinking 配置**：经 Kilo 路由的模型（如 `moonshotai/kimi-k2.6`）继承标准 OpenAI 风格 thinking 格式解析（`compat.thinkingFormat = "openai"`）。

## Kimi Code (`kimi-code`)
Kimi Code 经 Moonshot AI 的 `/coding/v1` API 端点提供订阅支持的 Kimi 模型（`kimi-for-coding`、`k3`）访问。它搭载 [Kimi Code](#kimi-code) 传输流水线，把请求执行委托给 `streamKimi`（`packages/ai/src/providers/kimi.ts`）与 `streamOpenAIAnthropicShim`（`packages/ai/src/providers/openai-anthropic-shim.ts`）。

### 特殊处理
- **Prompt 缓存键共享**：`isKimiModel`（`packages/ai/src/providers/kimi.ts`）门控 prompt 缓存；Anthropic 兼容（`packages/ai/src/providers/anthropic.ts:3480`）与 OpenAI 兼容（`packages/ai/src/providers/openai-completions.ts:1508`）请求都附加经 `getOpenAIPromptCacheKey` 派生的 `prompt_cache_key`，在传输切换间共享亲和身份。
- **公共 header 前置**：`packages/ai/src/providers/openai-completions.ts` 中的 `prependHeaders` 向所有 `kimi-code` 请求注入 `getKimiCommonHeaders()`（`packages/ai/src/registry/oauth/kimi.ts`）。
- **Schema 校验与工具选择**：经 `isMoonshotNative`（`packages/catalog/src/hosts.ts`）匹配，强制 `toolSchemaFlavor: "moonshot-mfjs"`（`packages/catalog/src/compat/openai.ts`）。强制 thinking 模型（`kimi-for-coding`、`k3`）在 Anthropic compat（`packages/catalog/src/compat/anthropic.ts`）中解析 `requiresThinkingEnabled = true`，把强制工具选择降级为 `auto`。
- **推理守卫**：`stream.ts:1214` 在执行前检查 `isKimiModel`，禁用 K3 上不受支持的推理配置（`packages/ai/src/providers/openai-completions.ts:1454`）。

### 认证与用量
- **设备 OAuth 流程**：在 `packages/catalog/src/compat/rules/auth/kimi-code.kdl` 中声明为 `login "device-code"` 规则（`packages/ai/src/registry/engine/device-code.ts`），header 钩子在 `packages/ai/src/registry/oauth/kimi.ts`。使用 OAuth 2.0 Device Code Authorization（`client-id` `17e5f671-d194-4dfb-9706-5516cb48c098`），基础 URL `https://auth.kimi.com`（可经 `KIMI_CODE_OAUTH_HOST` 或 `KIMI_OAUTH_HOST` 覆盖）。
- **指纹与设备持久化**：`getKimiCommonHeaders()` 注入跟踪 header（`User-Agent: KimiCLI/<ver>`、`X-Msh-Platform`、`X-Msh-Version`、`X-Msh-Device-Name`、`X-Msh-Device-Model`、`X-Msh-Os-Version`、`X-Msh-Device-Id`）。`getDeviceId` 将随机 hex UUID 持久化到 `path.join(getAgentDir(), "kimi-device-id")`（模式 `0600`），文件写入失败时回退到内存中的临时 UUID。
- **用量与配额跟踪器**：`kimiUsageProvider`（`packages/ai/src/usage/kimi.ts`）为 OAuth 凭据获取 `GET /coding/v1/usages`（`https://api.kimi.com/coding/v1/usages`，可经 `KIMI_CODE_BASE_URL` 覆盖）。令牌过期时（`credential.expiresAt <= nowMs`）短路。把 `usage` 与 `limits` 解析为 `UsageLimit` 条目，当窗口重置时间缺失时把行级重置时间戳（`reset_at`、`resetTime`、`ttl`）携带到窗口对象。

### Catalog 模型处理
- **Provider 描述符**：注册于 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`），`id: "kimi-code"`、`defaultModel: "kimi-for-coding"`、发现标签 `"Kimi Code"`、`envVars: ["KIMI_API_KEY"]`。委托选项经 `kimiCodeModelManagerOptions` 构建。
- **动态模型发现**：`kimiCodeModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）使用 `fetchOpenAICompatibleModels` 以 `KimiCLI/1.0` header 查询 `/coding/v1/models`。经 `kimiSupportsReasoning`、`mapKimiThinking` 与 `mapKimiApiFormat` 映射模型（把 `compat.kimiApiFormat` 设为 `"anthropic"` 或 `"openai"`）。
- **各家族输出上限**：`kimiCodeMaxTokens`（`packages/catalog/src/provider-models/openai-compat.ts`）按 ID 派生输出上限：`k3`/`k3-256k` 为 131,072（`KIMI_CODE_K3_MAX_TOKENS`），`kimi-for-coding`/`kimi-for-coding-highspeed` 为 32,768（`KIMI_CODE_FOR_CODING_MAX_TOKENS`），旧版 K2 行回退 32,000（`KIMI_CODE_DEFAULT_MAX_TOKENS`）。在静态生成（`packages/catalog/scripts/generate-models.ts`）期间应用。

## LiteLLM (`litellm`)
LiteLLM 是一个开源 AI 代理与网关，在 OpenAI 兼容 API 宿主之后统一对多个 LLM provider 的访问。在 `pi` 中，它使用 OpenAI Chat Completions（`openai-completions`）传输流水线运行。

### 特殊处理
- **推理重放排除（`packages/catalog/src/compat/openai.ts`）**：列在 `PROXY_OPENAI_COMPAT_PROVIDERS` 中。不同于原生本地运行时（`llama.cpp`、`vllm`），`replayReasoningContent` 默认 `false`，因为 LiteLLM 代理把回合路由到任意上游 provider（如 Anthropic、OpenAI），重放 `reasoning_content` 可能触发 HTTP 400 错误。
- **回环流超时下限（`packages/catalog/src/compat/openai.ts`）**：虽然 LiteLLM 从 `isLocalOpenAICompatBackend` 中排除，回环 URL（`localhost`、`127.0.0.1`）仍参与 `hasLocalLoopbackBaseUrl`，保留本地流超时下限，避免前置慢速本地后端时过早的 prefill 超时。
- **Anthropic 与 Bedrock 工具兼容性（`packages/ai/src/providers/openai-completions.ts`）**：
  - 当 `context.tools` 为 `undefined` 但对话历史包含工具调用时，为 Anthropic-via-LiteLLM 兼容性把 `params.tools` 设为 `[]`。
  - 当 `context.tools` 显式为空（`[]`，如 `/btw` 或后台回合）时，省略 `params.tools` 与 `tool_choice: "none"`，使 LiteLLM → Bedrock 路由不会生成无效的空 `toolConfig` 块。
- **遥测与网关 header 检测（`packages/agent/src/telemetry.ts`、`packages/ai/src/auth-gateway/http.ts`）**：`detectGatewayFromHeaders` 检查 `x-litellm-call-id`（回退 `x-litellm-model-id` 或 `x-litellm-model-group`）以填充 `pi.gen_ai.gateway.*` span 属性。Auth gateway HTTP 端点暴露 `x-litellm-model-id`、`x-litellm-model-api-base`、`x-litellm-response-cost` 与 `x-litellm-response-duration-ms`。

### 认证与用量
- **凭据与环境（`packages/catalog/src/provider-models/descriptors.ts`、`packages/catalog/src/compat/rules/auth/litellm.kdl`）**：经 `LITELLM_API_KEY` 认证。
- **登录入门（`packages/catalog/src/compat/rules/auth/litellm.kdl`）**：声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），引导用户到设置文档（`https://docs.litellm.ai/docs/proxy/deploy`），提示输入 master/virtual key（`sk-...`），并注明 `LITELLM_BASE_URL` 用于自定义代理端点。CLI `login` 委托给 `SqliteAuthCredentialStore.login()`。
- **默认基础 URL（`packages/catalog/src/provider-models/cache-provider-id.ts`）**：解析为 `Bun.env.LITELLM_BASE_URL` 或 `http://localhost:4000/v1`。

### Catalog 模型处理
- **内置 catalog 排除（`packages/scripts/generate-models.ts`）**：包含在 `DISCOVERY_ONLY_PROVIDERS` 中。LiteLLM 模型从静态 `models.json` 生成中排除，以避免泄漏开发者的 localhost 端点。
- **丰富管理端点发现（`packages/catalog/src/provider-models/openai-compat.ts`）**：`fetchLiteLLMRichModels` 探测 `/model_group/info`、`/v2/model/info`、`/model/info` 与 `/v1/model/info`。它过滤哨兵占位 ID（`all-team-models`、`all-proxy-models`、`no-default-models`），解析上下文限制（`max_input_tokens`）、输出限制（`max_output_tokens`）、`supports_vision`、`supports_reasoning`、`supported_openai_params`（映射 `reasoning_effort`）与逐 token 定价（`input_cost_per_token`、`output_cost_per_token`，缓存读/写成本映射为 $/百万 token）。
- **回退发现与显示名（`packages/catalog/src/provider-models/openai-compat.ts`）**：若丰富端点失败，发现回退到 `/v1/models`（`fetchOpenAICompatibleModels`）并对照 `models.dev` 参考解析规格。从显示名剥离转售商倍率后缀（如 `(1.5x usage)`）。
- **兼容性覆盖（`packages/catalog/src/provider-models/openai-compat.ts`）**：为所有解析出的模型硬编码 `compat.supportsStore: false` 与 `compat.supportsDeveloperRole: false`。

## LM Studio (`lm-studio`)
LM Studio 是运行在用户硬件上的本地 OpenAI 兼容模型服务器（默认 `http://127.0.0.1:1234/v1`）。它使用 [OpenAI Chat Completions](#openai-chat-completions) 传输（`api: "openai-completions"`）流式输出 chat 补全与工具调用。

### 特殊处理
- **仅字符串具名工具选择**：注册于 `STRING_ONLY_NAMED_TOOL_CHOICE_PROVIDERS`（`packages/catalog/src/compat/openai.ts`），`supportsNamedToolChoice: false`。对象风格的强制工具选择（`{ type: "function", function: { name: "..." } }`）降级为 `"required"`，同时通告的 `tools` 列表收窄为单个强制工具。
- **Grammar schema 规范化**：在 catalog compat 中配置 `toolSchemaFlavor: "grammar"`（`packages/catalog/src/compat/openai.ts`）。工具 JSON schema 经 `sanitizeSchemaForGrammar`（`packages/ai/src/utils/schema/normalize.ts`）清洗，把属性位置的裸布尔 `true` 或 `{}` 子 schema 扩展为基本类型 union，以避免 GBNF grammar 解析器失败（`Unrecognized schema: true`，issue #5914）。
- **重放推理内容与只追加上下文**：包含在 `LOCAL_OPENAI_COMPAT_PROVIDERS`（`packages/catalog/src/compat/openai.ts`）与 `LOCAL_INFERENCE_PROVIDERS`（`packages/coding-agent/src/config/append-only-context-mode.ts`）中。本地推理模型自动启用 `replayReasoningContent`，使 `<think>` 块跨回合保留在 `reasoning_content` 中以命中本地 chat 模板的 KV-cache；Qwen thinking 方言也启用 `qwenPreserveThinking`。
- **静态 Catalog 生成器排除**：列在 `DISCOVERY_ONLY_PROVIDERS`（`scripts/generate-models.ts`）与 `LOCAL_ONLY_PROVIDERS`（`test/models-json-no-local-endpoints.test.ts`）中，确保本地端点从不在构建期间获取，也从不提交到静态 `models.json`。

### 流行为
- **看门狗超时下限**：配置 `streamFirstEventTimeoutMs: 0`（`packages/catalog/src/compat/openai.ts`），在长本地模型冷加载或 prompt prefill 期间禁用响应前首事件看门狗，并设置 `streamIdleTimeoutMs: 300_000`（300 秒事件间下限；见 [Provider compat 参考](./provider-compat-reference.md)），防止慢速 token 生成期间的流取消。

### 认证与用量
- **无密钥本地认证**：在 `packages/catalog/src/compat/rules/auth/lm-studio.kdl` 中定义为无密钥 provider（`empty-fallback "lm-studio-local"`，`packages/catalog/src/provider-models/descriptors.ts` 中的 `allowUnauthenticated: true`）。未提供 `LM_STUDIO_API_KEY` 时使用占位符 `"lm-studio-local"`。
- **端点与凭据**：基础 URL 默认 `http://127.0.0.1:1234/v1` 或 `LM_STUDIO_BASE_URL`。交互式 CLI 登录在 `packages/catalog/src/compat/rules/auth/lm-studio.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`）。
- **用量核算**：采用标准 OpenAI Chat Completions 用量核算（`packages/ai/src/providers/openai-shared.ts` 中的 `calculateOpenAIUsageAccounting`）。

### Catalog 模型处理
- **隐式与动态发现**：`ModelRegistry`（`packages/coding-agent/src/config/model-registry.ts`)在未配置时把 `lm-studio` 自动注册为隐式可发现 provider。动态模型解析（`packages/catalog/src/provider-models/openai-compat.ts` 中的 `lmStudioModelManagerOptions` / `packages/coding-agent/src/config/model-discovery.ts` 中的 `discoverLmStudioModels`）查询 `/v1/models`。
- **原生元数据探测**：经 `fetchLmStudioNativeModelMetadata` 探测 LM Studio 的原生端点 `/api/v0/models`（`LM_STUDIO_NATIVE_METADATA_TIMEOUT_MS = 250`）。当 `type === "vlm"` 或能力包含 `vision`/`image` 时设置 `input: ["text", "image"]`（发现期间设置 `imageInputDecoder: "stb"`）。
- **已加载上下文长度**：`getLmStudioNativeContextWindow` 对活动模型优先使用 `loaded_context_length` 而非架构上限（`max_context_length`、`context_length`、`max_model_len`），确保上下文窗口限制准确反映当前 VRAM/RAM 分配。

## Meta Model API (`meta`)
Meta Model API 是 Meta 的商业 API 平台，托管第一方模型如 `muse-spark-1.1`。它经 OpenAI Responses 传输与模型服务交互，目标 `https://api.meta.ai/v1`。

### 特殊处理
- **输出 token 钳制绕过**：`resolveOpenAIResponsesOutputClamp`（`packages/ai/src/providers/openai-shared.ts`）检查 `model.provider === "meta"`，允许 Meta 请求输出到 `model.maxTokens`（131,072 token）而非受默认 64,000 token 上限（`OPENAI_MAX_OUTPUT_TOKENS`）限制。

### 认证与用量
- **API Key 登录**：在 `packages/catalog/src/compat/rules/auth/meta.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），面板 URL `https://developer.meta.com/ai/`。校验向 `https://api.meta.ai/v1/models` 发出 GET 请求（`validate "models-endpoint"`）。
- **环境变量**：Key 解析先检查 `MODEL_API_KEY`，回退 `META_API_KEY`（`packages/catalog/src/provider-models/descriptors.ts`）。

### Catalog 模型处理
- **描述符与管理**：定义于 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`），`defaultModel: "muse-spark-1.1"`。使用 `metaModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`），经 `createOpenAICompatibleModelManagerOptions` 构建（`api: "openai-responses"`、`providerId: "meta"`、`defaultBaseUrl: "https://api.meta.ai/v1"`、`mapModel: mapWithBundledReference`）。
- **静态内置模型**：`META_MUSE_STATIC_MODELS`（`packages/catalog/src/provider-models/openai-compat.ts`）定义 `muse-spark-1.1`：
  - 1,048,576 token 上下文窗口与 131,072 token 最大输出限制。
  - 多模态输入支持（`text`、`image`）。
  - 启用推理并带基于 effort 的 thinking 级别（`minimal`、`low`、`medium`、`high`、`xhigh`）。
  - 兼容标志 `supportsReasoningEffort: true` 与 `includeEncryptedReasoning: true`。

## MiniMax (`minimax`)
MiniMax 提供基础模型（包括 MiniMax-M3 与 M2 代），可经区域国际（`api.minimax.io`）与中国大陆（`api.minimaxi.com`）端点访问。传输取决于描述符类型：标准 `minimax` 与 `minimax-cn` 使用 "Anthropic Messages"（`/anthropic`），MiniMax Token Plan `minimax-code` 与 `minimax-code-cn` 使用 "OpenAI Chat Completions"（`/v1`）。

### 特殊处理
- **累计推理增量**：`packages/catalog/src/compat/openai.ts` 中的 `MINIMAX_PROVIDER_OR_ID_PATTERN` 对任何匹配 `/minimax/i` 的 provider 或模型 ID 标记 `reasoningDeltasMayBeCumulative: true`，防止流重新发送累计 thinking 文本时出现重复推理内容。
- **对象工具参数**：`packages/ai/src/providers/openai-completions.ts` 中的 `streamOpenAICompletions` 拦截以原始 JSON 对象而非标准 JSON 字符串流式传输 `function.arguments` 的 MiniMax 兼容宿主，把对象增量深度合并进 `block.partialArgs`，并在 `toolcall_end` 之前的 `finishToolCallBlock` 序列化单个 concat 安全的字符串增量。
- **单系统消息约束**：`packages/catalog/src/compat/openai.ts` 中的 `isMiniMaxHost`（匹配 `packages/catalog/src/hosts.ts` 中的 `api.minimax.io` 与 `api.minimaxi.com`）把 `supportsMultipleSystemMessagesDefault` 设为 `false`，要求系统 prompt 合并为单条系统消息。
- **Thinking effort 限制**：`packages/catalog/src/identity/family.ts` 中的 `isMinimaxM2FamilyModelId` 对 M2/M3 模型强制 `low|medium|high` 允许的 `reasoning_effort`，拒绝 `minimal`/`xhigh`。
- **带宽内 XML 方言**：`packages/ai/src/dialect/minimax.ts` 注册 `minimax` 方言（`<minimax:tool_call>`）用于回退 XML 工具调用解析。
- **网关 API 覆盖**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `OPENCODE_ZEN_API_RESOLUTION` 与 `OPENCODE_GO_API_RESOLUTION` 强制 OpenCode 网关上的 `minimax-m3` / `minimax-m3-free` / `minimax-m2.7` 经 `/v1/chat/completions` 上的 `openai-completions` 路由，而非 Anthropic `/v1/messages`。

### 认证与用量
- **认证密钥**：使用 `packages/catalog/src/provider-models/descriptors.ts` 中声明的 `MINIMAX_API_KEY`（`minimax`）、`MINIMAX_CODE_API_KEY`（`minimax-code`）与 `MINIMAX_CODE_CN_API_KEY`（`minimax-code-cn`）。
- **Token Plan 登录**：在 `packages/catalog/src/compat/rules/auth/minimax-code.kdl` 与 `minimax-code-cn.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），驱动链接到 `https://platform.minimax.io/subscribe/token-plan`（国际）与 `https://platform.minimaxi.com/subscribe/token-plan`（中国）的提示，并对照模型 `MiniMax-M3` 校验 API key 设置。
- **用量配额**：`packages/ai/src/usage/minimax-code.ts` 中的 `minimaxCodeUsageProvider` 在 `https://api.minimax.io`（或中国等价端点）轮询 `GET /v1/token_plan/remains`，把每个计划桶的滚动区间与周用量窗口解析为剩余百分比供 `omp usage` 使用。

### Catalog 模型处理
- **默认模型**：`MiniMax-M3` 设置于 `packages/catalog/src/provider-models/descriptors.ts`（`minimax`、`minimax-code`、`minimax-code-cn`）。
- **上下文窗口策略**：`scripts/generated-policies.ts` 把 `minimax`、`minimax-cn`、`minimax-code` 与 `minimax-code-cn` 的 `MiniMax-M3` 上下文限制覆盖为 1,000,000 token，匹配已文档化的 1M 长上下文层级而非上游定价边界。
- **OpenAI completions 标志**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `openAiCompletionsDescriptor` 配置 `supportsStore: false`、`supportsDeveloperRole: false`、`supportsReasoningEffort: false` 与 `reasoningContentField: "reasoning_content"`。

## MiniMax Token Plan (`minimax-code`)
MiniMax Token Plan provider（`minimax-code`，连同其中国大陆区域变体 `minimax-code-cn`）使用 OpenAI Chat Completions 传输经 HTTP POST SSE 提供对 MiniMax 订阅模型（如 `MiniMax-M3` 与 `MiniMax-M2.5`）的访问（国际 `https://api.minimax.io/v1`，中国 `https://api.minimaxi.com/v1`）。与普通的 `minimax`（经标准静态 API key 认证路由到 Anthropic Messages 传输）不同，`minimax-code` 使用交互式订阅登录流程，并通过 `omp usage` 提供 token plan 配额监控。

### 特殊处理
- **与普通 `minimax` 的传输差异**：普通 `minimax`（`minimax` / `minimax-cn`）经 `anthropic-messages` 传输（`https://api.minimax.io/anthropic`）通信，而 `minimax-code`（`minimax-code` / `minimax-code-cn`）目标为 `openai-completions` 传输（`/v1/chat/completions`）。
- **流式对象工具调用参数**：`packages/ai/src/providers/openai-completions.ts` 中的 `mergeStreamingArgumentObjects` 处理以部分 JSON 对象而非标准 OpenAI JSON 字符串流式传输 `function.arguments` 的 MiniMax 后端，跨增量深度合并对象属性，防止 `[object Object]` 字符串强制转换。
- **推理内容与 Think 标签去重**：配置 `reasoningContentField: "reasoning_content"`（`packages/catalog/src/provider-models/openai-compat.ts`）。该 provider 解析内联 `<think>`...`</think>` 标签为 thinking 块，同时对 MiniMax-M3 累计推理快照去重，防止可见答案内容开始后重新发出 thinking 文本。
- **Compat 标志限制**：OpenAI 兼容性策略显式禁用 `store`、developer 系统角色与推理 effort 控制（`packages/catalog/src/provider-models/openai-compat.ts` 中的 `supportsStore: false`、`supportsDeveloperRole: false`、`supportsReasoningEffort: false`）。

### 认证与用量
- **交互式订阅登录流程**：在 `packages/catalog/src/compat/rules/auth/minimax-code.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`）。这是一个交互式 API key 提示：它引导到订阅门户（`https://platform.minimax.io/subscribe/token-plan`），提示输入 key（`sk-...`），并经使用 `MiniMax-M3` 的 `POST /v1/chat/completions` 请求（`validate "chat-completions"`）校验 key。
- **环境变量**：国际 `minimax-code` 从 `MINIMAX_CODE_API_KEY` 解析凭据，中国 `minimax-code-cn` 从 `MINIMAX_CODE_CN_API_KEY`（普通 `minimax` 解析 `MINIMAX_API_KEY` / `MINIMAX_CN_API_KEY`）。
- **Token Plan 配额跟踪**：`packages/ai/src/usage/minimax-code.ts` 中的 `minimaxCodeUsageProvider` 以 `Authorization: Bearer ${apiKey}` 查询 `GET /v1/token_plan/remains`。
- **配额指标解析与规范化**：把 `model_remains[]` 条目解析为滚动区间窗口（`current_interval_*`）与 7 天窗口（`current_weekly_*`）。共享计划配额 `general` 限定为 `{ shared: true }`。经 `(100 - remainingPercent) / 100` 计算 `usedFraction`，并在 `current_*_status === 2`（`STATUS_EXHAUSTED`）时覆盖状态。计划外模型（状态 3 `STATUS_UNLIMITED` 且总数为零）被过滤进 `metadata.unavailableModels`。经 `base_resp.status_code === 0` 校验成功，以捕获在 HTTP 200 响应下返回的 API 错误。

### Catalog 模型处理
- **Provider 描述符**：注册于 `packages/catalog/src/provider-models/descriptors.ts`（`id: "minimax-code"`、`id: "minimax-code-cn"`），默认 `MiniMax-M3`。
- **Catalog 接线**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `openAiCompletionsDescriptor` 注册描述符 `"minimax-coding-plan"` 与 `"minimax-cn-coding-plan"`，绑定基础 URL `https://api.minimax.io/v1` 与 `https://api.minimaxi.com/v1`。
- **1M 上下文层级覆盖**：策略生成（`packages/catalog/scripts/generated-policies.ts`）显式把 `minimax-code` 与 `minimax-code-cn` 的 `MiniMax-M3` 上下文窗口覆盖为报告已文档化的 1,000,000-token 层级而非上游 512,000-token 定价边界。
- **宿主匹配**：`packages/catalog/src/hosts.ts` 中的 provider 宿主映射把 `urlMarkers` `api.minimax.io` 与 `api.minimaxi.com` 与 `minimax`、`minimax-code`、`minimax-code-cn` 关联。

## MiniMax Token Plan (China) (`minimax-code-cn`)
MiniMax Token Plan (China) 为中国大陆订阅者提供 MiniMax 模型访问，使用 OpenAI Chat Completions 传输（`openai-completions`）。它连接中国区域端点进行订阅入门、API key 校验与模型执行。

### 特殊处理
- **流式参数深度合并**：`packages/ai/src/providers/openai-completions.ts` 中的 `mergeStreamingArgumentObjects` 处理以原始 JSON 对象而非标准 OpenAI JSON 字符串流式传输 `function.arguments` 的 MiniMax 后端，跨流 chunk 递归合并部分对象增量而不失败或将参数强制为 `[object Object]`（`test/issue-1776-repro.test.ts`、`test/issue-2080-repro.test.ts`）。
- **推理去重与 Think 标签**：内容流中交付的 `<think>` 标签被规范化为 thinking 块（`test/issue-1203-repro.test.ts`），而 `packages/ai/src/dialect/demotion.ts` 中的 `lastCumulativeReasoningBySignature` 与 `streamOpenAICompletionsOnce`（`packages/ai/src/providers/openai-completions.ts`）对 `MiniMax-M3` 跨文本块转换的累计推理快照去重。
- **不支持特性剥离**：请求省略不支持的 thinking 选项（`test/issue-955-repro.test.ts`），并应用 `packages/catalog/src/provider-models/openai-compat.ts` 中的静态兼容性覆盖（`supportsStore: false`、`supportsDeveloperRole: false`、`supportsReasoningEffort: false`、`reasoningContentField: "reasoning_content"`）。

### 认证与用量
- **API Key 与交互式登录**：经 `MINIMAX_CODE_CN_API_KEY` 认证（`packages/catalog/src/provider-models/descriptors.ts`）。在 `packages/catalog/src/compat/rules/auth/minimax-code-cn.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`）的交互式登录指向 `https://platform.minimaxi.com/subscribe/token-plan`，并经对 `https://api.minimaxi.com/v1` 的 `MiniMax-M3` 补全检查校验粘贴的 key。
- **端点与宿主检测**：API 请求目标 `https://api.minimaxi.com/v1`（`packages/catalog/src/models.json`）。`urlMarkers` 在 `packages/catalog/src/hosts.ts` 的 `minimax` 宿主分类中包含 `api.minimaxi.com`。
- **用量遥测可用性**：不同于 `minimax-code`（经 `packages/ai/src/usage/minimax-code.ts` 中的 `minimaxCodeUsageProvider` 从 `https://api.minimax.io/v1/token_plan/remains` 获取配额剩余百分比），`minimax-code-cn` 没有注册用量 provider（`storage.usageProviderFor("minimax-code-cn")` 在 `packages/ai/src/auth-storage.ts` 与 `test/minimax-token-plan-usage.test.ts` 中返回 `undefined`），因此中国区域账户的用量遥测被禁用。

### Catalog 模型处理
- **默认模型**：配置为在 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中默认 `MiniMax-M3`。
- **1M 上下文窗口覆盖**：`packages/catalog/scripts/generated-policies.ts` 把 `minimax-code-cn`（连同 `minimax-code`、`minimax` 与 `minimax-cn`）的 `MiniMax-M3` 上下文窗口从上游 512K 定价边界覆盖为 1,000,000（1M）token（`model.contextWindow = 1_000_000`）。
- **Catalog 策略覆盖**：`generated-policies.ts` 从 `model.compat` 移除 `thinkingFormat`，并强制 `reasoningContentField: "reasoning_content"`、`supportsStore: false`、`supportsDeveloperRole: false` 与 `supportsReasoningEffort: false`。

## Mistral (`mistral`)
Mistral AI 经 `api.mistral.ai/v1` 提供 Mistral、Codestral、Devstral、Ministral 与 Pixtral 模型访问。请求使用 OpenAI Chat Completions 传输（`openai-completions`）。

### 特殊处理
- **Compat 集群（`packages/catalog/src/compat/openai.ts`：`isMistral`）**：
  - `requiresMistralToolIds` / `toolCallIdKind: "mistral-9-alnum"`（`packages/ai/src/providers/openai-shared.ts`）：把工具调用 ID 限制为 9 字符字母数字字符串（`[a-zA-Z0-9]{9}`）。
  - `requiresAssistantAfterToolResult`：在工具结果消息之后、后续内容之前合成 assistant 消息桥（`packages/ai/src/providers/openai-completions.ts`）。
  - `requiresToolResultName`：强制工具结果消息上的工具函数 `name` 属性（`packages/ai/src/providers/openai-completions.ts`）。
  - `requiresThinkingAsText`：把推理与 thinking 内容格式化为纯文本块而非原生推理字段（`packages/catalog/src/compat/openai.ts`）。
  - `maxTokensField: "max_tokens"`：在请求载荷中发出 `max_tokens` 而非 `max_completion_tokens`（`packages/catalog/src/compat/openai.ts`）。
- **数组 `delta.content` 流式规范化（`packages/ai/src/providers/openai-completions.ts`：`normalizeStreamingContentText`）**：解包模型（如 `mistral-medium-2604`）把 `delta.content` 作为类型化数组交付（`[{ type: "text", text: "..." }]`）的流式响应 chunk，防止 `[object Object]` 字符串强制转换 bug。

### 认证与用量
- **认证**：使用 `MISTRAL_API_KEY` 环境变量的 bearer 令牌认证（`packages/catalog/src/provider-models/descriptors.ts`：`mistral`）。
- **用量跟踪**：标准 OpenAI chat completions 用量解析（`packages/ai/src/providers/openai-completions.ts`）。

### Catalog 模型处理
- **Provider 描述符**：经 `mistralModelManagerOptions` 配置，指向 `https://api.mistral.ai/v1`（`packages/catalog/src/provider-models/openai-compat.ts`），默认模型 `devstral-medium-latest`（`packages/catalog/src/provider-models/descriptors.ts`）。
- **宿主匹配**：宿主 URL 标记匹配检查 `mistral.ai`（`packages/catalog/src/hosts.ts`：`mistral`）。

## Moonshot (`moonshot`)
Moonshot 是 Moonshot AI 端点（`https://api.moonshot.ai/v1` 或中国大陆 `https://api.moonshot.cn/v1`）的按量付费开放平台 provider。它搭载 `OpenAI Chat Completions` 传输引擎（`openai-completions` API 表面）并共享 Kimi 家族方言与 thinking 机制（`packages/catalog/src/identity/family.ts` 中的 `isKimiModelId`）。它不同于使用订阅设备 OAuth 与订阅端点（`api.kimi.com` / `/coding/v1/*`）的 `kimi-code`。

### 特殊处理
- **`MOONSHOT_BASE_URL` 覆盖**：`resolveOpenAIRequestSetup`（`packages/ai/src/providers/openai-shared.ts`）用 `$env.MOONSHOT_BASE_URL` 覆盖默认 catalog 基础 URL（`api.moonshot.ai/v1`）（例如密钥被国际端点拒绝的中国大陆平台用户使用 `https://api.moonshot.cn/v1`；issue #2883）。
- **Moonshot Flavored JSON Schema（`moonshot-mfjs`）**：`toolSchemaFlavor` 对原生 Moonshot 宿主（`packages/catalog/src/hosts.ts` 中的 `moonshotNative`）与 Kimi 模型 ID（`isKimiModel`）经 `buildOpenAICompat`（`packages/catalog/src/compat/openai.ts`）默认 `"moonshot-mfjs"`。`normalizeSchemaForMoonshot`（`packages/ai/src/utils/schema/normalize.ts`）在 `packages/ai/src/providers/openai-completions.ts` 与 `openai-responses.ts` 中规范化工具参数（把 `const` 折叠为 `enum`、在裸 enum 上推断 `type`、剥离不支持的构造），以防止 HTTP 400 校验失败（`tools.function.parameters is not a valid moonshot flavored json schema`）。
- **Z.AI thinking 格式与保留 thinking**：`packages/catalog/src/compat/openai.ts` 中的 `isMoonshotKimi` 设置 `thinkingFormat: "zai"`。对 `kimi-k2.6`（及 `kimi-k2.x` 模型），启用 `thinkingKeep: "all"`（`compat/openai.ts` 中的 `usesMoonshotKimiPreservedThinking`）。活动推理回合在 `openai-completions.ts` 中发出 `thinking: { type: "enabled", keep: "all" }`（禁用时为 `{ type: "disabled" }`）（`issues #1838`、`#2113`）。K3 模型经 `MOONSHOT_KIMI_K3_THINKING`（`packages/catalog/src/provider-models/openai-compat.ts`）使用 OpenAI 风格 `reasoning_effort: "max"`。
- **流标记修复与带宽内控制标签**：`modelMayLeakKimiToolCalls`（`packages/ai/src/utils/stream-markup-healing.ts`）与 `detectStreamMarkupHealingPattern`（`packages/catalog/src/compat/openai.ts`）对 `provider === "moonshot"` 返回 `"kimi"`，启用对原始带宽内控制标签（`<|tool_calls_section_begin|>` 等）的流解析。
- **最大 token 输出上限与强制 token**：`alwaysSendMaxTokens`（`packages/catalog/src/compat/openai.ts`）对每个 Kimi 请求强制 `max_tokens`，因为 Moonshot 从 `max_tokens` 计算 TPM 限流。`resolveOpenAIRequestSetup`（`packages/ai/src/providers/openai-shared.ts`）对 K3 模型（`isKimiK3ModelId`）把 `max_tokens` 封顶为 `131_072`。
- **推理内容重放要求**：`requiresReasoningContentForToolCalls`（`packages/catalog/src/compat/openai.ts`）强制工具调用后续回合重放先前 `reasoning_content`（或合成占位 `.`），防止 Moonshot 中止或从零重新推导推理。

### 认证与用量
- **API-Key 认证**：在 `packages/catalog/src/compat/rules/auth/moonshot.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），引导用户到面板 `https://platform.moonshot.ai/console/api-keys`。
- **端点校验**：经 `GET ${MOONSHOT_BASE_URL || "https://api.moonshot.ai/v1"}/models` 校验密钥（`packages/catalog/src/compat/rules/auth/moonshot.kdl` 中的 `validate "models-endpoint"`，带 `base-url-env="MOONSHOT_BASE_URL"`）。
- **环境变量解析**：`packages/catalog/src/provider-models/descriptors.ts` 中的 `envVars: ["MOONSHOT_API_KEY", "KIMI_API_KEY"]` 接受 `KIMI_API_KEY` 作为配置了 Kimi 密钥但没有 `MOONSHOT_API_KEY` 的中国大陆用户的回退（issue #2883）。
- **无专门用量跟踪器**：Token 用量在 `openai-completions` 中直接于 OpenAI 流 chunk `usage` 对象中返回；`packages/ai/src/usage/` 中不存在单独的用量 API 或文件。

### Catalog 模型处理
- **描述符注册**：注册为 `CATALOG_PROVIDERS` 中的 `moonshot`（`packages/catalog/src/provider-models/descriptors.ts`），`defaultModel: "kimi-k2.7-code"`、`envVars: ["MOONSHOT_API_KEY", "KIMI_API_KEY"]`、`createModelManagerOptions: moonshotModelManagerOptions`。
- **动态模型发现**：`moonshotModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）使用 `createOpenAICompatibleModelManagerOptions`，`defaultBaseUrl: Bun.env.MOONSHOT_BASE_URL ?? "https://api.moonshot.ai/v1"`。
- **动态 K3 与 K2.x 模型映射**：在 `moonshotModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）中：
  - 未被引用的 `kimi-k3` 条目盖章 `reasoning: true`、输入 `["text", "image"]`、`MOONSHOT_KIMI_K3_COST`、`contextWindow: 1_000_000`、`maxTokens: 131_072` 与基于 effort 的 `thinking` 配置（issue #5756）。
  - `kimi-k2.x` 条目（如 `kimi-k2.5`、`kimi-k2.6`）标记 `reasoning: true`、视觉 `["text", "image"]` 与多档 effort（`[Minimal, Low, Medium, High]`），确保生成 `thinking` 载荷以使模型不卡住（issue #2113）。
- **宿主与优先级 token 分类**：`packages/catalog/src/hosts.ts` 中的宿主标记 `moonshotNative`（`urlMarkers: ["api.moonshot.ai", "api.kimi.com"]`）映射原生 Moonshot 端点。`packages/catalog/src/identity/priority.ts` 中的家族优先级 token 把 `"moonshot"` 排在 `"kimi-code"` 之后。

## NanoGPT (`nanogpt`)
NanoGPT 是一个按 token 付费的 API 网关，经 OpenAI 兼容接口暴露多样的开源权重与商业语言模型。它使用 OpenAI Chat Completions 传输（`openai-completions`）执行请求，默认基础 URL `https://nano-gpt.com/api/v1`。

### 特殊处理
- **DSML 泄漏修复**：NanoGPT 包含在 `packages/ai/src/utils/stream-markup-healing.ts` 的 `modelMayLeakDsmlToolCalls` 中。在 NanoGPT 上托管的 DeepSeek 模型（如 `nanogpt/deepseek/deepseek-v4-pro`）在流式期间泄漏 `<｜DSML｜tool_calls>...</｜DSML｜tool_calls>` 文本信封时，被路由到 `getStreamMarkupHealingPattern("nanogpt", modelId)` 以把流修复为结构化工具调用。
- **直接路由执行**：NanoGPT 避免在 DeepSeek 请求上追加 `:tools` 模型路由后缀，防止 NanoGPT 服务器端工具解析器在复杂 schema 上触发带 `code: "malformed_tool_call"` 的 `502` 错误。
- **索引工具增量保留**：依赖 `streamOpenAICompletionsOnce`（`packages/ai/src/providers/openai-completions.ts`）中的 `tool_calls[].index` 跟踪，确保来自 NanoGPT 的并行流式工具调用不会跨增量合并或丢失参数。

### 认证与用量
- **API Key 与环境变量**：经 `NANO_GPT_API_KEY` 认证（经 `packages/ai/src/stream.ts` 中的 `getEnvApiKey` 解析，并在 catalog 描述符 `packages/catalog/src/provider-models/descriptors.ts` 中配置）。
- **交互式登录**：在 `packages/catalog/src/compat/rules/auth/nanogpt.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），提示输入从 `https://nano-gpt.com/api` 链接的 API key，并经 `validate "models-endpoint"` 对照 `https://nano-gpt.com/api/v1/models` 校验凭据。

### Catalog 模型处理
- **描述符与选项**：注册于 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`），默认模型 `openai/gpt-5.5`，选项经 `nanoGptModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）配置。
- **模型变体过滤**：在 `fetchDynamicModels` 的动态发现期间，匹配 `NANO_GPT_NON_TEXT_MODEL_TOKENS` 中非文本 token（如 `embedding`、`image`、`vision`、`audio`、`speech`、`transcribe`、`moderation`、`realtime`、`whisper`、`tts`）的模型被 `isLikelyNanoGptTextModelId` 过滤掉。
- **Thinking 变体检测**：带 `:thinking` 或 `:thinking:<level>` 后缀的模型被 `NANO_GPT_THINKING_SUFFIX_RE` 匹配并从模型列表中排除，同时其基础模型 ID 记录在 `thinkingBaseIds` 中，以将对应基础模型标记为具备推理能力（`model.reasoning = true`）。

## Novita (`novita`)
Novita AI 是一个 AI 云平台，为开源模型提供 serverless OpenAI 兼容 LLM 推理。它使用 OpenAI Chat Completions 传输，经 `https://api.novita.ai/openai/v1`。

### 特殊处理
- 除 OpenAI Chat Completions 流水线外无其他内容。

### 认证与用量
- **认证**：在 `packages/catalog/src/compat/rules/auth/novita.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），使用标准 API key 提示（`sk_...`），链接到 `https://novita.ai/settings/key-management`。环境变量 `NOVITA_API_KEY` 在 catalog 描述符（`packages/catalog/src/provider-models/descriptors.ts`）中检查。
- **推理端点 key 校验**：`packages/catalog/src/compat/rules/auth/novita.kdl` 中的密钥校验通过使用 `moonshotai/kimi-k2.7-code` 向 `/chat/completions` 发送请求（`validate "chat-completions"`）。Novita 的 Developer 与 Basic 团队角色缺少 `/openapi/v1/billing/balance/detail` 权限，因此推理校验避免拒绝有效的 developer 密钥。

### Catalog 模型处理
- **模型发现**：经 `novitaModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）配置，`defaultBaseUrl: "https://api.novita.ai/openai/v1"` 与 `dynamicModelsAuthoritative: true`。
- **无认证发现**：描述符设置 `catalogDiscovery.allowUnauthenticated: true`（`packages/catalog/src/provider-models/descriptors.ts`），允许无 API key 从 `/openai/v1/models` 公开获取 catalog。
- **模型过滤**：`filterModel` 验证活跃状态（`status === 1` 或非数字）、要求 `endpoints` 包含 `"chat/completions"`、检查正数 `max_output_tokens`，并使用 `isPublicNovitaModelId` 排除内部测试模型 ID（排除以 `ai_infer_test` 开头的前缀）。
- **成本换算**：`toNovitaCostPerMillion` 把价格字段（`input_token_price_per_m`、`output_token_price_per_m`、`pricing.input_cache_read.price_per_m`）除以 10,000，把 Novita 的每百万 1/10,000 美元费率换算为标准每百万 token 美元。
- **能力与元数据**：`mapNovitaModel` 经 `novitaArrayIncludes` 检查 `features` 中的 `"reasoning"` 与 `"function-calling"`，用 `toInputCapabilities` 解析输入模态，并提取上下文/输出窗口边界。

## NVIDIA (`nvidia`)
NVIDIA NIM（Inference Microservice）经 OpenAI Chat Completions 传输（`openai-completions` API）提供对托管的开放与专有基础模型的访问。基础端点默认 `https://integrate.api.nvidia.com/v1`。

### 特殊处理
- **Qwen thinking 格式**：宿主 `nvidia`（`integrate.api.nvidia.com`，`packages/catalog/src/hosts.ts:63`）把 Qwen 模型（`isQwen`）路由到 `thinkingFormat: "qwen-chat-template"`（`packages/catalog/src/compat/openai.ts:452`）。顶层的 `enable_thinking` 被 NIM 的严格请求 schema 拒绝（`additionalProperties: false`），因此 thinking 经 `chat_template_kwargs.enable_thinking` 传递。
- **DeepSeek 令牌剥离与 DSML 标记**：对 `provider === "nvidia"` 下的 DeepSeek 模型设置 `stripDeepseekSpecialTokens` 为 `true`（`packages/catalog/src/compat/openai.ts:596,755`），从可见输出剥离泄漏的原始 `<｜DSML｜...｜>` 信封与 thinking 标签（`packages/ai/test/openai-completions-compat.test.ts:2096-2216`）。在 `modelMayLeakDsmlToolCalls` 中注册用于流标记修复（`packages/ai/src/utils/stream-markup-healing.ts:227`）。
- **工具选择与推理**：DeepSeek 推理模型在工具选择激活时禁用推理（`disableReasoningOnToolChoice`，`packages/catalog/src/compat/openai.ts:487`），而标准模型支持强制工具选择（`supportsForcedToolChoice: true`，`packages/ai/test/openai-completions-compat.test.ts:1801`）。

### 认证与用量
- **认证**：基于密钥的认证，使用 NVIDIA NGC Personal Keys（`packages/catalog/src/compat/rules/auth/nvidia.kdl` 中的 `auth-url "https://org.ngc.nvidia.com/setup/personal-keys"`），存储于 `NVIDIA_API_KEY`（`packages/catalog/src/provider-models/descriptors.ts:316`）。基础 URL 为 `https://integrate.api.nvidia.com/v1`。
- **登录与校验**：在 `packages/catalog/src/compat/rules/auth/nvidia.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），对照 `nvidia/llama-3.1-nemotron-70b-instruct` 校验密钥（`validate "chat-completions"` 带 `optional=#true`）。致命认证错误（`401`/`403`、`AIError.Flag.AuthFailed`）中止登录；非致命校验错误被捕获以允许自定义或新部署的模型。
- **Provider 注册**：从 `packages/catalog/src/compat/rules/auth/nvidia.kdl` 经 `packages/ai/src/registry/build.ts` 编译进 `packages/ai/src/registry/registry.ts`。凭据存储与去重在 `packages/ai/test/auth-storage-email-dedupe.test.ts:756-775` 中测试。
- **用量**：标准 OpenAI Chat Completions 用量指标；无自定义用量处理器或配额端点。

### Catalog 模型处理
- **描述符与选项**：经 `nvidiaModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts:1072`）与 `openAiCompletionsDescriptor`（`packages/catalog/src/provider-models/openai-compat.ts:5675`）配置。
- **默认值**：默认上下文窗口为 `131072`（`packages/catalog/src/provider-models/openai-compat.ts:5676`）。默认模型为 `nvidia/llama-3.1-nemotron-70b-instruct`（`packages/catalog/src/provider-models/descriptors.ts:315`）。
- **Catalog 发现**：在 catalog 描述符中注册，`catalogDiscovery: { label: "NVIDIA" }`（`packages/catalog/src/provider-models/descriptors.ts:318`）。

## Ollama (`ollama`)
运行在本地或自托管 Ollama 实例上的本地 OpenAI 兼容 provider 集成（默认基础 URL `http://127.0.0.1:11434/v1`）。发现的模型搭载共享的 Ollama 与 OpenAI Responses 传输引擎。

### 特殊处理
- **工具调用错误重写**：`packages/ai/src/error/format.ts` 中的 `rewriteOllamaToolCallJsonError` 拦截来自本地 `llama.cpp` 后端的匹配 `LLAMA_CPP_TOOL_CALL_PARSE_PATTERN` 的 HTTP 500 工具调用 JSON 解析失败，并将其重写为解释上下文溢出期间确定性的模型输出退化。
- **空长度 finish 上下文错误**：当 `buildOpenAICompat`（`packages/catalog/src/compat/openai.ts`）中 `provider === "ollama"` 时，`emptyLengthFinishIsContextError` 设为 `true`，把带 `finish_reason: "length"` 的空补全视为上下文溢出错误。
- **KV-Cache 推理重放**：`packages/catalog/src/compat/openai.ts` 中的 `LOCAL_OPENAI_COMPAT_PROVIDERS` 包含 `"ollama"`，自动启用 `OpenAICompat.replayReasoningContent`，使本地 Qwen3 / DeepSeek-R1 / GLM chat 模板跨回合重建先前 `<think>` 块，实现字节相同的前缀 KV-cache 复用。
- **DSML 工具调用标记修复**：`packages/ai/src/utils/stream-markup-healing.ts` 中的 `modelMayLeakDsmlToolCalls` 与 `packages/catalog/src/compat/openai.ts` 中的 `DSML_HEALING_PROVIDERS` 包含 `"ollama"`，修复可见文本流中泄漏的 DeepSeek DSML 工具调用信封。
- **线上推理 effort 阶梯**：`packages/catalog/src/model-thinking.ts` 中 `spec.provider === "ollama"` 返回 `OLLAMA_REASONING_EFFORTS`（`[low, medium, high, max]`），匹配 Ollama 的原生线上 effort 词汇，无需 compat 级别的 effort 重映射。

### 认证与用量
- **交互式登录与可选密钥**：在 `packages/catalog/src/compat/rules/auth/ollama.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），提示可选 API key/令牌（`empty-fallback ""`，占位符 `"ollama-local"`），指向 auth-url；返回 `""` 表示本地无密钥模式。
- **用量 provider 与配额呈现**：`packages/ai/src/usage/ollama.ts` 中的 `ollamaUsageProvider`（`id: "ollama"`）实现 `fetchUsage`，返回带空 `limits` 与一条说明（未暴露独立配额端点）的 `UsageReport`；`validatesCredentials` 设为 `false`。
- **环境变量回退**：`CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中的 `envVars: ["OLLAMA_API_KEY"]` 从 `process.env.OLLAMA_API_KEY` 解析可选调用方凭据。

### Catalog 模型处理
- **描述符与无密钥注册**：`packages/catalog/src/provider-models/descriptors.ts` 中的 `CATALOG_PROVIDERS` 注册 `id: "ollama"`，`defaultModel: "gpt-oss:20b"`、`envVars: ["OLLAMA_API_KEY"]`、`allowUnauthenticated: true`（允许无密钥创建模型管理器）、`createModelManagerOptions` 委托给 `ollamaModelManagerOptions`。
- **静态包排除**：`scripts/generate-models.ts` 中的 `DISCOVERY_ONLY_PROVIDERS` 包含 `"ollama"`，防止本地端点把机器特定的 localhost 模型烘焙进提交的 `models.json`。
- **动态模型发现**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `ollamaModelManagerOptions` 经 `normalizeOllamaBaseUrl` 规范化端点（默认 `http://127.0.0.1:11434/v1`），并使用 `fetchOpenAICompatibleModels`（`packages/catalog/src/discovery/openai-compatible.ts`）查询 `/v1/models`。若 `/v1/models` 不可用或为空，回退到在 `toOllamaNativeBaseUrl`（`http://127.0.0.1:11434`）上查询 `/api/tags` 的原生 `fetchOllamaNativeModels`。
- **能力探测与上下文长度盖章**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `fetchOllamaShowMetadata` 经 `createOllamaMetadataResolver` 向 `/api/show` POST `{ model: modelId }`。它从匹配 `.context_length`、`.num_ctx` 或 `.context_window` 的 `model_info` 键提取上下文长度（回退 `OLLAMA_FALLBACK_CONTEXT_WINDOW` = 128,000 与 `OLLAMA_DEFAULT_MAX_TOKENS` = 8,192）。`capabilities.includes("thinking")` 设置 `reasoning: true` 并配置 `thinking` efforts（`[minimal, low, medium, high]`），而 `capabilities.includes("vision")` 盖章 `input: ["text", "image"]`。
- **模型缓存分区**：`ollamaModelManagerOptions` 中的 `cacheProviderId` 调用 `resolveModelCacheProviderId`（`packages/catalog/src/provider-models/cache-provider-id.ts`），以从 `baseUrl` 派生的 `ollama:ollama-models-v1:<hash>` 分区本地模型缓存键。

## Ollama Cloud (`ollama-cloud`)
Ollama Cloud 经 `https://ollama.com` 上的原生 `ollama-chat` 协议端点提供对开源权重 LLM 的托管云访问。它搭载 [Ollama](#ollama) 传输小节，与本地 Ollama 的区别在于要求显式 API key 认证并强制云端特定的历史清洗与输出 token 上限。

### 特殊处理
- **Assistant 历史 thinking 剥离**：当 `model.provider === "ollama-cloud"` 时，`convertMessages`（`packages/ai/src/providers/ollama.ts`）从 assistant 历史消息剥离 `thinking` 字段。Ollama Cloud 端点对包含 `thinking` 的传入历史返回 HTTP 400 错误，而本地 `ollama` 保留它们。
- **推理 Effort 映射**：`mapReasoning`（`packages/ai/src/providers/ollama.ts`）经 `model.thinking.effortMap` 映射推理。`OLLAMA_CLOUD_GLM_52_THINKING`（`packages/catalog/src/provider-models/ollama.ts`）把 GLM-5.2 推理 effort 级别限制为 `high` 与 `max`，经 `isOllamaCloudGlm52ReasoningEffortModel`（`packages/catalog/src/model-thinking.ts`）指定。
- **线上级输出 token 钳制**：`resolveNumPredict`（`packages/ai/src/providers/ollama.ts`）对 `ollama-cloud` 模型把 `options.num_predict` 钳制为 `OLLAMA_CLOUD_NUM_PREDICT_CAP`（65,536），作为传入 `maxTokens` 或覆盖时的安全网，防止 HTTP 400 错误（#3392）。本地 `ollama` 端点不钳制 `num_predict`。
- **流标记修复**：注册于 `DSML_HEALING_PROVIDERS`（`packages/catalog/src/compat/openai.ts`）与 `getStreamMarkupHealingPattern`（`packages/ai/src/utils/stream-markup-healing.ts`），用于 XML/markdown 工具调用与推理恢复。

### 认证与用量
- **交互式密钥认证**：在 `packages/catalog/src/compat/rules/auth/ollama-cloud.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），提示输入在 `https://ollama.com/settings/keys` 生成的 API key，空输入以 `ApiKeyRequiredError` 拒绝。
- **环境变量解析**：`descriptors.ts`（`packages/catalog/src/provider-models/descriptors.ts`）与 `getEnvApiKey`（`packages/ai/src/stream.ts`）经 `OLLAMA_CLOUD_API_KEY` 解析凭据。
- **用量核算**：`ollamaCloudUsageProvider`（`packages/ai/src/usage/ollama.ts`）使用 `fetchOllamaUsage` 处理 `ollama-cloud` 用量。因为 Ollama Cloud 没有独立配额 API（`validatesCredentials: false`），用量经逐响应的 `prompt_eval_count` 与 `eval_count` 流指标跟踪。

### Catalog 模型处理
- **描述符与发现接线**：描述符 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）定义 `defaultModel: "gpt-oss:120b"`、`envVars: ["OLLAMA_CLOUD_API_KEY"]`、选项构建器 `ollamaCloudModelManagerOptions` 与 `catalogDiscovery: { label: "Ollama Cloud", oauthProvider: "ollama-cloud" }`。
- **动态模型发现与 `/api/show` 元数据**：`ollamaCloudModelManagerOptions`（`packages/catalog/src/provider-models/ollama.ts`）以 Bearer 令牌认证经 `GET /api/tags` 从 `https://ollama.com` 获取模型，然后逐模型查询 `POST /api/show`（`fetchShowMetadata`）以检查能力（`thinking`、`vision`）与 `model_info` 上下文窗口大小（默认 128,000）。未认证时返回空列表。
- **输出 token 上限与 token 参数省略**：`isOllamaCloudOutputCapped`（`packages/catalog/src/provider-models/ollama.ts`）识别 DeepSeek V4 Pro/Flash 模型，把 `maxTokens` 固定为 `Math.min(contextWindow, OLLAMA_CLOUD_MAX_OUTPUT_TOKENS)`（65,536），防止后端拒绝的请求（ollama/ollama#16890、#7266）。所有发现的云模型设置 `omitMaxOutputTokens: true`（也在 `packages/catalog/scripts/generated-policies.ts` 的 `applyGeneratedModelPolicy` 中强制）。

## OpenCode Go (`opencode-go`)
OpenCode Go 经 `https://opencode.ai/zen/go` 的统一网关提供多 provider 订阅模型（包括 Kimi、DeepSeek、GLM、Qwen 与 MiniMax）访问。根据目标模型，请求经 OpenAI Chat Completions 或 Anthropic Messages 传输流水线路由，带动态 API 解析。

### 特殊处理
- **API 解析与模型 ID 覆盖**：`createOpenCodeApiResolution`（`packages/catalog/src/provider-models/openai-compat.ts`）为 `https://opencode.ai/zen/go` 构建 `OPENCODE_GO_API_RESOLUTION`。显式 ID 覆盖（`minimax-m2.7`、`minimax-m3`、`minimax-m3-free`、`qwen3.5-plus`、`qwen3.6-plus`）优先于基于 npm 的启发式（`@ai-sdk/anthropic`），强制路由解析到 `/v1/chat/completions` 上的 `openai-completions`，防止网关 404 HTML 错误或原始工具调用标记泄漏。
- **推理工具调用重放策略**：当 `isOpenCodeProvider` 为 true（`opencode-go` / `opencode-zen`）且推理激活时，应用 `packages/catalog/src/compat/openai.ts` 中的 `OPENCODE_WHEN_THINKING`。它设置 `requiresReasoningContentForToolCalls: true`、`allowsSyntheticReasoningContentForToolCalls: false` 与 `reasoningContentField: "reasoning_content"`，满足网关在 thinking 工具调用重放中缺失 `reasoning_content` 时返回 400（#1484）或在 thinking 关闭时发送 `reasoning_content` 返回 400（#1071）的要求。
- **`X-Api-Key` 认证规范化**：在 `packages/ai/src/providers/anthropic.ts`（3045–3046 行）中，当 `model.provider === "opencode-go"` 时，传输删除自动生成的 `Authorization` Bearer header，使 `AnthropicMessagesClient` 发出 `X-Api-Key`。对 OpenCode Anthropic 端点的仅 Bearer 请求失败并返回 HTTP `401 Missing API key`（#6510）。

### 认证与用量
- **API Key 登录流程**：在 `packages/catalog/src/compat/rules/auth/opencode-go.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`）。它引导用户到 `https://opencode.ai/auth`，提示输入 API key，并返回存储在 `OPENCODE_API_KEY` 下的修剪后的密钥。
- **滚动消费窗口**：`opencodeGoUsageProvider`（`packages/ai/src/usage/opencode-go.ts`）跨三个滚动时间窗口跟踪 OMP 观测到的请求成本：`rolling-5h`（$12 / 5 小时）、`weekly`（$30 / 7 天）与 `monthly`（$60 / 30 天）。成本从 `ctx.listUsageCosts` 经 `sumWindowCosts` 聚合，以计算比例用量、重置时间戳（`resetsAt`）与限额状态（`ok`、>=80% 为 `warning`、>=100% 为 `exhausted`）。

### Catalog 模型处理
- **权威动态模型**：`opencodeGoModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）与描述符配置（`packages/catalog/src/provider-models/descriptors.ts`，默认模型 `kimi-k2.7-code`）指定 `dynamicModelsAuthoritative: true`。经 `fetchOpenAICompatibleModels` 从 `https://opencode.ai/zen/go/v1/models` 进行的成功运行时发现完全替换内置 provider 模型，而非合并仅回退 ID（`model-manager.ts`）。

## OpenCode Zen (`opencode-zen`)
OpenCode Zen（`opencode-zen`）是一个订阅服务，提供多供应商 AI 模型（Anthropic Claude、DeepSeek、MiniMax、Gemini 等）访问，经 `https://opencode.ai/zen` 的统一代理端点路由。请求根据 catalog 解析规则动态分发到多个底层传输 API——主要是 "Anthropic Messages"（`/zen`）、"OpenAI Chat Completions"（`/zen/v1`）、"OpenAI Responses"（`/zen/v1`）与 "Google Generative AI"（`/zen/v1`）——默认模型为 `claude-opus-4-8`。

### 特殊处理
- **多 API 解析与端点接线**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `createOpenCodeApiResolution` 经 `@ai-sdk/*` npm 元数据解析模型传输目标。`OPENCODE_ZEN_API_RESOLUTION` 定义逐 id 覆盖，把 `"minimax-m3"` 与 `"minimax-m3-free"` 映射到 `https://opencode.ai/zen/v1` 上的 `"openai-completions"`，覆盖会导致 HTTP 400 错误或原始 `<invoke>`/`<|minimax|>`/`<tool_call>` 标记泄漏的上游 `@ai-sdk/anthropic` 标签（#1617）。
- **Anthropic 代理 header 与 beta 处理**：在 `packages/ai/src/providers/anthropic.ts` 中，`opencode-zen` 删除默认 `Authorization` header（`delete defaultHeaders.Authorization`）并提供 `apiKey` 以发出 `X-Api-Key` header。`opencode-zen` 上的 thinking 请求抑制 `context_management_20251015` beta header 与 body 字段（`context_management`），因为 Zen Anthropic 代理以 `400 Extra inputs are not permitted` 拒绝未识别字段（#6510）。
- **Thinking 模式内容重放（`whenThinking`）**：OpenCode 模型的基线 compat 设置 `requiresReasoningContentForToolCalls: false`，以防止在 thinking 禁用的请求上发送未识别参数（#1071）。推理启用时，`packages/catalog/src/compat/openai.ts` 中的 `buildOpenAICompat` 构建 `OPENCODE_WHEN_THINKING` 覆盖层（`requiresReasoningContentForToolCalls: true`、`allowsSyntheticReasoningContentForToolCalls: false`），`packages/ai/src/providers/openai-shared.ts` 中的 `resolveOpenAICompatPolicy` 在请求时指针切换进去，防止 `400 thinking is enabled but reasoning_content is missing in assistant tool call message` 错误（#1484、#2084）。
- **别名推理模型（`big-pickle`）**：模型 ID `big-pickle` 是 OpenCode Zen DeepSeek 推理别名，经 `packages/catalog/src/compat/openai.ts` 与 `packages/catalog/src/model-thinking.ts` 中的 `isOpenCodeDeepseekAlias` 识别。它被分类为 `isDeepseekFamily` 的一部分，在 thinking 工具调用回合期间强制严格的 `reasoning_content` 重放。

### 认证与用量
- **API Key 手动认证**：经 `OPENCODE_API_KEY` 环境变量配置（`packages/catalog/src/provider-models/descriptors.ts` 中的 `CATALOG_PROVIDERS` 描述符）。
- **交互式 CLI 登录流程**：在 `packages/catalog/src/compat/rules/auth/opencode-zen.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`）：它在浏览器打开 `https://opencode.ai/auth` 并提示用户粘贴其 API key。
- **线上认证**：跨 Anthropic 与 OpenAI 兼容协议端点的凭据经 `X-Api-Key` header 而非标准 Bearer 令牌传递。

### Catalog 模型处理
- **描述符与选项**：catalog 条目 `opencode-zen`（`packages/catalog/src/provider-models/descriptors.ts`）设置 `defaultModel: "claude-opus-4-8"`、`dynamicModelsAuthoritative: true`，并从 `packages/catalog/src/provider-models/openai-compat.ts` 实例化 `opencodeZenModelManagerOptions`。
- **动态发现与基础 URL 规范化**：`opencodeZenModelManagerOptions` 调用 `openCodeModelManagerOptions("opencode-zen", config)`，从 `https://opencode.ai/zen/v1/models`（`discoveryBaseUrl`）获取动态 OpenAI 兼容模型。模型映射为正数 `contextWindow`（`context_length`）与 `maxTokens`（`max_completion_tokens`），基础 URL 按 API 类型规范化（`openCodeBaseUrlForApi` / `normalizeOpenCodeBasePath`）。
- **Zen 与 Go 的差异**：
  - **基础 URL 根**：Zen 使用基础路径 `https://opencode.ai/zen`（completions 在 `/zen/v1`），而 OpenCode Go（`opencode-go`）目标 `https://opencode.ai/zen/go`（completions 在 `/zen/go/v1`）。
  - **默认模型**：Zen 默认 `claude-opus-4-8`；Go 默认 `kimi-k2.7-code`。
  - **API 解析覆盖**：Zen（`OPENCODE_ZEN_API_RESOLUTION`）把 `"minimax-m3"` 与 `"minimax-m3-free"` 覆盖为 `"openai-completions"`。Go（`OPENCODE_GO_API_RESOLUTION`）把 `"minimax-m2.7"`、`"minimax-m3"`、`"minimax-m3-free"`、`"qwen3.5-plus"` 与 `"qwen3.6-plus"` 覆盖为 `"openai-completions"`，防止网关 404 或 XML 标记泄漏（#887、#1617）。
  - **模型别名**：Zen 包含 `big-pickle` 别名（DeepSeek 推理），经 `isOpenCodeDeepseekAlias` 唯一检测以应用 DeepSeek compat 策略。

## OpenRouter (`openrouter`)
OpenRouter 是一个统一的多 provider 路由网关，经 OpenAI 兼容接口服务数百个第三方模型。请求使用伪 API `openrouter` 执行，默认分发到 OpenAI Responses 传输，或根据环境配置回退到 OpenAI Chat Completions。

### 特殊处理
- **伪 API 分发与双线上回退**：`packages/ai/src/stream.ts` 中的 `streamSimple` 评估 `model.api === "openrouter"`。当 `$env.PI_OPENROUTER_RESPONSES !== "0"`（默认）时，分发到 `streamOpenAIResponses`（"OpenAI Responses"）；设为 `"0"` 时回退到 `streamOpenAICompletions`（"OpenAI Chat Completions"）。Catalog compat 使用 `ResolvedOpenRouterCompat`（`packages/catalog/src/types.ts`），经 `packages/catalog/src/compat/openai.ts` 中的 `buildOpenRouterCompat` 组合 `ResolvedOpenAICompat` 与 `ResolvedOpenAIResponsesCompat` 构建。
- **路由变体变换（`:nitro` / `:floor`）**：指定 `openrouterVariant`（`"nitro"`、`"floor"`、`"online"`、`"exacto"`、`"extended"`）的选项经 `applyOpenRouterRoutingVariant`（`packages/ai/src/providers/openai-shared.ts`）映射。变体后缀（`:<variant>`）在请求时追加到 `model.id`，除非最后一个斜杠后已有冒号（`lastColon > lastSlash`），保留显式的用户或 catalog 变体覆盖。
- **Provider 顺序与排除偏好**：当 `compat.isOpenRouterHost` 为 true 时，`packages/ai/src/providers/openai-shared.ts` 中的 `applyOpenAIGatewayRouting` 把 catalog `openRouterRouting` 偏好（带 `only?: string[]` 与 `order?: string[]` 的 `OpenRouterRouting` 接口）注入顶层 `provider` 请求参数。
- **Anthropic `cache_control` 断点**：已解析 compat 字段 `cacheControlFormat === "anthropic"`（基线：OpenRouter 宿主 + Anthropic 模型类别）选择 Anthropic 缓存标记方言。在 Chat Completions 线上，`applyOpenAIChatCompletionsPromptCachePolicy`（`openai-completions.ts`）向最新消息的最后一个非空文本部分附加 `cache_control: { type: "ephemeral" }`。在 Responses 线上，`applyOpenAIResponsesPromptCachePolicy`（`openai-responses.ts`）设置 `params.cache_control = cacheRetention === "long" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" }`。
- **Catalog 默认 max-token 省略**：当 `isOpenRouterHost` 为 true 且 `maxTokensExplicit` 为 false 时，`packages/ai/src/providers/openai-shared.ts` 中的 `resolveOpenAIOutputTokenParam` 省略默认输出 token 限制（`max_tokens`、``max_completion_tokens`、`max_output_tokens`）。这防止 OpenRouter 在执行 `provider.order` / `only` 回退时过滤掉其通告的输出上限低于 catalog 最大值的上游；显式指定的调用方 `maxTokens` 被保留。
- **自定义请求 header**：`packages/ai/src/utils/openrouter-headers.ts` 中的 `getOpenRouterHeaders` 向所有请求附加 `User-Agent: omp/<ver>`、`HTTP-Referer: https://omp.sh/`、`X-OpenRouter-Title: omp`、`X-OpenRouter-Categories: cli-agent`、`X-OpenRouter-Cache: true` 与 `X-OpenRouter-Cache-TTL: 3600`，用于边缘响应缓存。

### 认证与用量
- **经 `/api/v1/auth/key` 的认证密钥校验**：在 `packages/catalog/src/compat/rules/auth/openrouter.kdl` 中声明为 `login "oauth-code"` 规则（`packages/ai/src/registry/engine/oauth-code.ts`），带 `paste-key` 校验，目标 `https://openrouter.ai/api/v1/auth/key`。公共 `/api/v1/models` 对未认证请求返回 HTTP 200，因此 `/api/v1/auth/key` 被用作规范身份检查（有效密钥返回 200，否则 401）。密钥解析经 `packages/ai/src/stream.ts` 中的 `getEnvApiKey` 检查 `OPENROUTER_API_KEY`。
- **权威报告成本调和**：`packages/ai/src/providers/openai-shared.ts` 中的 `applyProviderReportedCost` 提取 OpenRouter 与 ClinePass 回显的 `rawUsage.cost`。若估算 token 成本为有限正数，输入、输出、缓存读取与缓存写入成本按 `reportedCost / estimatedCost` 缩放以匹配精确的计费总额；否则 `usage.cost.input` 直接赋予报告成本。

### Catalog 模型处理
- **描述符与无认证发现**：注册为 `CATALOG_PROVIDERS` 中的 `openrouter`（`packages/catalog/src/provider-models/descriptors.ts`），`defaultModel: "openai/gpt-5.5"`、`envVars: ["OPENROUTER_API_KEY"]`、`catalogDiscovery: { label: "OpenRouter", allowUnauthenticated: true }`。
- **动态发现与过滤**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `openrouterModelManagerOptions` 使用 `fetchOpenAICompatibleModels` 带 `api: "openrouter"` 查询 `https://openrouter.ai/api/v1/models`。缓存条目在 `resolveModelCacheProviderId("openrouter")` 下分区。发现的模型被过滤为指定 `supported_parameters.includes("tools")` 的条目。
- **规格映射**：`openrouterModelManagerOptions` 经 `mapOpenRouterThinking` 映射 `modality`（`text`/`image`）、每百万 token 定价（`prompt`、`completion`、`input_cache_read`、`input_cache_write`）、`context_length`、`top_provider.max_completion_tokens` 与推理 effort 阶梯。

## Qianfan (`qianfan`)
Qianfan（百度云）经使用 OpenAI Chat Completions 传输的 OpenAI 兼容 v2 API 提供百度托管模型家族的访问。入口包括用于认证策略与 API key 认证的 `packages/catalog/src/compat/rules/auth/qianfan.kdl`、用于 catalog 注册的 `packages/catalog/src/provider-models/descriptors.ts`（`CATALOG_PROVIDERS`），以及用于模型管理器选项的 `packages/catalog/src/provider-models/openai-compat.ts`（`qianfanModelManagerOptions`）。

### 特殊处理
- 除 OpenAI Chat Completions 流水线外无其他内容。

### 认证与用量
- **API Key 认证与校验**：经 `QIANFAN_API_KEY` 或使用从 `https://console.bce.baidu.com/qianfan/ais/console/apiKey` 获取的格式为 `bce-v3/ALTAK-...` 的 API key 的存储凭据认证。CLI 登录流程在 `packages/catalog/src/compat/rules/auth/qianfan.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），通过向 `https://qianfan.baidubce.com/v2` 发出带 `deepseek-v3.2` 的 chat completion 请求（`validate "chat-completions"`）校验凭据。
- **用量与配额**：应用标准 OpenAI Chat Completions token 用量跟踪（`input`、`output`、`reasoning`）与 HTTP 状态码错误处理。

### Catalog 模型处理
- **Provider 描述符**：配置于 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`），`defaultModel: "deepseek-v3.2"`、`envVars: ["QIANFAN_API_KEY"]`、catalog 发现标签 `"Qianfan"`。
- **模型选项**：`qianfanModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）经 `createSimpleOpenAICompletionsOptions` 构建绑定到 `https://qianfan.baidubce.com/v2` 的 `openai-completions` 选项。
- **内置模型**：`packages/catalog/src/models.json` 中的静态模型规格定义 Qianfan 模型（如 `deepseek-v3.2`，带 `reasoning: true` 与 `baseUrl: "https://qianfan.baidubce.com/v2"`）。

## Qwen Portal (`qwen-portal`)
Qwen Portal 经 `https://portal.qwen.ai/v1` 的 OpenAI 兼容端点提供 Qwen 托管模型访问。它使用 OpenAI Chat Completions 传输进行模型执行与工具调用。

### 特殊处理
- **系统消息限制**：宿主匹配（`packages/catalog/src/hosts.ts` 中的 `qwenPortal`，匹配 `portal.qwen.ai`）设置 `supportsMultipleSystemMessagesDefault = false`（`packages/catalog/src/compat/openai.ts`）。这强制多系统消息块合并为单块，以防止默认 Qwen chat 模板触发的 500 内部服务器错误。

### 认证与用量
- **环境变量**：自动从 `QWEN_OAUTH_TOKEN` 或 `QWEN_PORTAL_API_KEY` 解析凭据（`packages/catalog/src/provider-models/descriptors.ts:385`）。
- **交互式登录**：在 `packages/catalog/src/compat/rules/auth/qwen-portal.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），引导用户从 `https://chat.qwen.ai` 复制令牌或 API key 并提示输入。
- **凭据校验**：使用 `packages/catalog/src/compat/rules/auth/qwen-portal.kdl` 中的 `validate "chat-completions"` 对照 `https://portal.qwen.ai/v1` 校验输入令牌，目标 `coder-model`。
- **用量跟踪**：`packages/ai/src/usage/` 下不存在专门的用量报告模块。

### Catalog 模型处理
- **描述符设置**：`qwenPortalModelManagerOptions` 使用 `createSimpleOpenAICompletionsOptions`（`packages/catalog/src/provider-models/openai-compat.ts:4139`），默认上下文窗口 128,000 token、最大输出 token 8,192（`openai-compat.ts:5894`）。
- **Catalog 配置**：注册于 `descriptors.ts:383`，默认模型 `coder-model`、发现标签 `"Qwen Portal"`、`oauthProvider: "qwen-portal"`。
- **静态模型定义**：在 `packages/catalog/src/models.json` 中暴露预定义静态模型：`coder-model`（Qwen Coder）与 `vision-model`（Qwen Vision，支持 `text` 与 `image` 模态）。

## Sakana AI (`sakana`)
Sakana AI 提供经 `api.sakana.ai` 托管的 Fugu 模型家族的推理模型。
请求经有状态的 OpenAI Responses 传输路由（`api: "openai-responses"`）。

### 特殊处理
- **基础 URL 规范化与覆盖**：`packages/ai/src/providers/openai-shared.ts` 中的 `resolveSakanaRequestBaseUrl`
  与 `packages/catalog/src/provider-models/openai-compat.ts` 中的 `normalizeSakanaBaseUrl` 从 `SAKANA_BASE_URL` 或回退 `FUGU_BASE_URL` 解析基础 URL 覆盖。
  基础 URL 被规范化以移除尾随斜杠并确保 `/v1` 路径后缀，回退到 `https://api.sakana.ai/v1`。

### 认证与用量
- **API Key 解析**：环境变量发现先检查 `SAKANA_API_KEY`，然后回退 `FUGU_API_KEY`
  （配置在描述符 `packages/catalog/src/provider-models/descriptors.ts` 中）。
- **交互式登录**：在 `packages/catalog/src/compat/rules/auth/sakana.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），引导用户
  到 Sakana AI 控制台（`https://console.sakana.ai/api-keys`），对照 `https://api.sakana.ai/v1/models` 校验凭据。

### Catalog 模型处理
- **静态 Fugu 种子**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `SAKANA_FUGU_STATIC_MODELS` 导出内置
  种子规格（`fugu`、`fugu-ultra`、`fugu-ultra-20260615`），provider 默认模型为 `fugu`。
- **动态模型管理器**：`sakanaModelManagerOptions` 把实时 `/models` 发现标记为权威
  （`dynamicModelsAuthoritative: true`），并经 `dropCachedModelIdsOnStaticMismatch` 在种子变化时清除过期缓存模型行。
- **双档 Effort 配置**：`isSakanaFuguReasoningModel`（`packages/catalog/src/model-thinking.ts`）与 `isSakanaFuguModelId`
  （`packages/catalog/src/provider-models/openai-compat.ts`）匹配 Fugu 模型（`/^fugu(?:$|-)/i`），把它们标记为推理
  模型并带双档 effort 刻度（`HIGH_MAX_REASONING_EFFORTS`：`[high, max]`）。

## SiliconFlow (`siliconflow`)
SiliconFlow 是一个高性能 AI 推理平台，提供对开源模型（如 DeepSeek 与 GLM）的访问。它使用 OpenAI Chat Completions 传输（全球 `https://api.siliconflow.com/v1`，中国区域 `https://api.siliconflow.cn/v1`）。

### 特殊处理
- **仅动态 catalog**：在 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中配置为 `dynamicModelsAuthoritative: true`。不打包静态 catalog 模型（省略 `catalogDiscovery` 且 `MODELS_DEV_PROVIDER_DESCRIPTORS` 将其排除在生成器打包之外）；模型经 `/v1/models` 实时发现。
- **非聊天模型过滤**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `isLikelySiliconFlowChatModelId` 使用 `SILICONFLOW_NON_CHAT_MODEL_TOKENS` 过滤 `/v1/models` 返回的非聊天模型（嵌入、重排器、Stable Diffusion、Flux、音频/视频生成器如 Whisper、Wan2、CosyVoice）。
- **运行时元数据注入与回退**：`loadSiliconFlowModelsDevReferences` 以 5,000ms 超时查询 models.dev（`SILICONFLOW_MODELS_DEV_REFERENCE_TIMEOUT_MS`）。缺失模型回退到规范内置规格（`resolveModelReference`）以推断上下文窗口、max tokens 与推理能力，同时排除定价。

### 认证与用量
- **API Key 登录**：经存储在 `SILICONFLOW_API_KEY`（或 `siliconflow-cn` 的 `SILICONFLOW_CN_API_KEY`）中的 API key 认证。在 `packages/catalog/src/compat/rules/auth/siliconflow.kdl` 与 `siliconflow-cn.kdl` 中交互式声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`）。
- **端点校验**：凭据在登录期间经 `models-endpoint` 请求 `https://api.siliconflow.com/v1/models`（`https://api.siliconflow.cn/v1/models`）校验。
- **控制台 URL**：Key 创建说明指向 `https://cloud.siliconflow.com/account/ak`（中国区域为 `https://cloud.siliconflow.cn/account/ak`）。

### Catalog 模型处理
- **管理器构建**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `siliconflowModelManagerOptions` 与 `siliconflowCnModelManagerOptions` 经 `createSiliconFlowModelManagerOptions` 构建动态 OpenAI 兼容模型管理器。
- **默认模型**：`siliconflow` 默认模型为 `zai-org/GLM-5.1`，`siliconflow-cn` 为 `deepseek-ai/DeepSeek-V4-Pro`（定义于 `packages/catalog/src/provider-models/descriptors.ts`）。
- **动态模型发现**：当 API key 可用时，`fetchDynamicModels` 调用 `fetchOpenAICompatibleModels` 从 `/v1/models` 获取实时模型，联接 models.dev 定价/限制（`mapWithBundledReference`）或规范回退参考。

## SiliconFlow (China) (`siliconflow-cn`)
SiliconFlow (China) 是 SiliconFlow AI 模型平台的中国国内部署，为开源权重模型提供针对区域可用性定制的 OpenAI 兼容 LLM 推理。它使用 OpenAI Chat Completions 传输（`openai-completions`），基础 URL `https://api.siliconflow.cn/v1`。

### 特殊处理
- **端点差异**：在 `siliconflowCnModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）中使用 `https://api.siliconflow.cn/v1` 作为模型端点，不同于全球 `siliconflow`（`https://api.siliconflow.com/v1`）。
- **非聊天模型过滤**：模型发现经 `packages/catalog/src/provider-models/openai-compat.ts` 中的 `isLikelySiliconFlowChatModelId` 排除非聊天模型 ID（包含 `bge-`、`bce-`、`stable-diffusion`、`flux`、`kolors`、`sensevoice`、`cosyvoice`、`fish-speech`、`wan2` 等 token 的嵌入、重排器、图像、TTS、音频与视频模型）。
- **内置上游参考回退**：models.dev 中缺失的模型从内置上游模型参考定义（`getBundledModelReferenceIndex`）恢复内在能力（`reasoning`、`input`）、上下文窗口与最大输出 token，同时省略 provider 特定定价。

### 认证与用量
- **环境变量**：经描述符 `envVars`（`packages/catalog/src/provider-models/descriptors.ts`）中配置的 `SILICONFLOW_CN_API_KEY` 认证，与全球 `SILICONFLOW_API_KEY` 分开。
- **API Key 登录**：在 `packages/catalog/src/compat/rules/auth/siliconflow-cn.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），管理控制台 URL `https://cloud.siliconflow.cn/account/ak`，校验端点 `https://api.siliconflow.cn/v1/models`。
- **无用量跟踪**：`packages/ai/src/usage/` 下不存在专门的配额或用量解析模块。

### Catalog 模型处理
- **描述符配置**：定义于 `packages/catalog/src/provider-models/descriptors.ts`，`defaultModel: "deepseek-ai/DeepSeek-V4-Pro"`（`siliconflow` 为 `zai-org/GLM-5.1`）、`envVars: ["SILICONFLOW_CN_API_KEY"]`、`dynamicModelsAuthoritative: true`。
- **仅动态模型发现**：刻意从 `MODELS_DEV_PROVIDER_DESCRIPTORS` 与静态 catalog 生成（`scripts/generate-models.ts`）中省略，从 `https://api.siliconflow.cn/v1/models` 实时获取可用 chat 模型。
- **运行时参考注入**：实时发现的模型与 models.dev catalog 条目（`SILICONFLOW_MODELS_DEV_DESCRIPTORS`）交叉引用，带 5 秒超时（`SILICONFLOW_MODELS_DEV_REFERENCE_TIMEOUT_MS`），在 `loadSiliconFlowModelsDevReferences`（`packages/catalog/src/provider-models/openai-compat.ts`）中注入定价与限制元数据。

## Synthetic (`synthetic`)
Synthetic 是一个为其模型提供双 API 格式支持的 AI 平台，同时暴露 OpenAI 兼容（`https://api.synthetic.new/openai/v1/chat/completions`）与 Anthropic 兼容（`https://api.synthetic.new/anthropic/v1/messages`）端点。调用默认使用 `OpenAI Chat Completions` 传输，但配置后可动态切换到 `Anthropic Messages` 传输。

### 特殊处理
- **双 API 表面**：`streamSynthetic`（`packages/ai/src/providers/synthetic.ts`）利用 `streamOpenAIAnthropicShim`（`packages/ai/src/providers/openai-anthropic-shim.ts`）包装 OpenAI completions 与 Anthropic messages 端点。API 格式可经请求的 `syntheticApiFormat` 选项选择（`"openai"` | `"anthropic"`），默认 `"openai"`。
- **急切模块导入**：`streamSynthetic` 与 `isSyntheticModel` 在 `packages/ai/src/stream.ts` 中急切导入（绕过惰性内建注册），以支持即时模型 provider 分类与路由。
- **动态推理与特性**：在 `packages/catalog/src/provider-models/openai-compat.ts` 中，`syntheticModelManagerOptions` 从 `GET /openai/v1/models` 映射动态模型条目。它检查 `supported_features` 中的 `"reasoning"` 并解析线上 effort 档位（如 `reasoning_parameters.efforts`）以构建 `thinking` 选项并适当设置 `reasoning` 标志。

### 认证与用量
- **认证**：基于密钥的认证，使用 `SYNTHETIC_API_KEY`（`packages/catalog/src/compat/rules/auth/synthetic.kdl`）。经 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`）对照 `GET https://api.synthetic.new/openai/v1/models` 校验。
- **用量与配额轮询**：`syntheticUsageProvider`（`packages/ai/src/usage/synthetic.ts`）以 bearer API key 轮询 `GET https://api.synthetic.new/v2/quotas`。它报告两个不同的限制窗口：
  - `synthetic:requests:5h`：滚动 5 小时请求限制，带逐 tick 重新生成百分比（`rollingFiveHourLimit`）。
  - `synthetic:usd:7d`：以美元计的周 credit 限制（`weeklyTokenLimit`），带逐 tick 美元重新生成速率。

### Catalog 模型处理
- 默认模型：`hf:zai-org/GLM-5.1`（`packages/catalog/src/provider-models/descriptors.ts`）。
- `dynamicModelsAuthoritative: true`：模型经 `syntheticModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）动态获取。
- 模态与视觉：`input` 模态（`"text"`、`"image"`）从 `input_modalities`、`supports_vision` 或回退参考规格动态解析。
- 能力过滤：`supported_features` 严格约束工具支持；若存在但没有 `"tools"`，该模型禁用工具调用。

## Together (`together`)
Together 是一个云推理 provider，经 OpenAI Chat Completions 兼容 API 提供对各种开源与专有基础模型的访问。

### 特殊处理
- **严格 JSON Schema 模式**：被识别为支持严格 schema 模式（`packages/catalog/src/compat/openai.ts` 中的 `detectStrictModeSupport`），对 `together` provider ID 与 `api.together.xyz` 基础 URL 启用。
- **多条系统消息**：被识别为支持多条系统消息（`packages/catalog/src/compat/openai.ts` 中的 `supportsMultipleSystemMessagesDefault`），因此系统消息不被强制合并到索引 0。

### 认证与用量
- **API Key 认证**：使用 `TOGETHER_API_KEY` 环境变量或 `pi-ai login together` 期间的 API key 输入认证。
- **校验**：在 `packages/catalog/src/compat/rules/auth/together.kdl` 中作为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`）校验密钥，对照 `https://api.together.xyz/v1/models`。
- **API 基础 URL**：`https://api.together.xyz/v1`。

### Catalog 模型处理
- **描述符与默认值**：在 `descriptors.ts` 中配置，默认模型 `moonshotai/Kimi-K2.7-Code`，`openai-compat.ts` 中的 `togetherModelManagerOptions`。
- **Catalog 来源**：模型经 models.dev 描述符生成，使用键 `togetherai` 映射到 provider `together`，位于 `https://api.together.xyz/v1`（`packages/catalog/src/provider-models/openai-compat.ts`）。
- **宿主匹配**：列在 `packages/catalog/src/hosts.ts` 中，匹配宿主 URL 标记 `api.together.xyz`，并注册于 `priority.ts` 身份映射。

## Umans AI Coding Plan (`umans`)
Umans AI Coding Plan 是 AI 编码模型的代理服务，以 Anthropic Messages 线上格式（"Anthropic Messages"）运行，默认基础 URL 为 `https://api.code.umans.ai`。

### 特殊处理
- **认证 header 策略**：Anthropic 兼容的 Umans 请求强制 `X-Api-Key` header 认证（声明于 `packages/catalog/src/compat/rules/auth/umans.kdl`）而非 `Authorization: Bearer`（`packages/ai/src/providers/anthropic.ts` 中的 `buildAnthropicClientOptions`）。
- **工具名转义**：配置 `compat.escapeBuiltinToolNames: true`（`packages/catalog/src/compat/anthropic.ts`），在出站请求上给客户端工具名加 `_` 前缀并在返回时剥离，避免与网关内置工具名冲突，除非网关 web 搜索激活（`packages/ai/src/providers/anthropic.ts`）。
- **网关 web 搜索**：通过检查 `X-Umans-Websearch-Provider` 调用方 header 或 `UMANS_WEBSEARCH_PROVIDER`（`native` | `exa`）环境变量路由 web 搜索请求（`packages/ai/src/providers/anthropic.ts`）。启用时，`web_search` 工具名不转义透传。
- **Thinking / 推理 effort**：支持 thinking 配置，级别经 `UMANS_REASONING_EFFORT_BY_LEVEL`（`packages/catalog/src/provider-models/openai-compat.ts`）映射。Umans 上的 GLM-5.2 使用双档 high/max effort 刻度，`max` 映射到 `anthropic-budget-effort` 模式（`xhigh` effort）（`packages/catalog/src/model-thinking.ts`）。

### 认证与用量
- **认证**：使用 `UMANS_AI_CODING_PLAN_API_KEY` 环境变量或 `/login umans` key 提示（`packages/catalog/src/compat/rules/auth/umans.kdl`、`packages/ai/src/registry/engine/api-key.ts`）。Key 校验向 `https://api.code.umans.ai` 执行轻量 Anthropic messages 调用（`max_tokens: 1`）。
- **用量端点**：使用 `Authorization: Bearer <key>` 从 `GET /v1/usage`（`packages/ai/src/usage/umans.ts`）获取配额与限流状态。
- **呈现的限制**：返回滚动 5 小时请求，拆分为模型加权的软上限（`umans:requests:soft`，"effective requests" 契约）与原始突发上限（`umans:requests:hard`，`hard_cap`），外加瞬时会话并发限制（`umans:concurrency`）。软上限只警告——`exhausted` 保留给突发上限，节流实际从那里开始。没有报告突发上限（`hard_cap`）的载荷折叠为单个加权 `umans:requests` 行，可在有效请求限制处耗尽，因此请求耗尽永远不会不可报告；没有加权计数器的旧版载荷回退到单个原始 `umans:requests` 行。在两种单行形态中，加权计数器（存在时）保持权威——超过限制的原始突发流量从不错误地制造耗尽状态。在限流突发发生时也会呈现低优先级状态备注。

### Catalog 模型处理
- **描述符与发现**：注册为 `umans`，默认模型 `umans-coder`（`packages/catalog/src/provider-models/descriptors.ts`）。动态发现从 `GET /v1/models/info` 获取模型详情（`packages/catalog/src/provider-models/openai-compat.ts`）。
- **视觉能力过滤**：`umansSupportsVision` 严格检查 `supports_vision === true`。哨兵字符串值（如 `umans-glm-5.1` 与 `umans-glm-5.2` 的 `"via-handoff"`）映射为纯文本（`["text"]`），使图像内容经客户端视觉移交处理，而非发送导致 HTTP 400 错误的原始图像块（`packages/catalog/src/provider-models/openai-compat.ts`）。
- **定价与回退**：以按量付费与技术别名模型（如 `umans-qwen3.6-35b-a3b` 映射到 `umans-flash`）的定价回退规则生成 catalog 条目（`packages/catalog/scripts/generate-models.ts`）。

## Venice (`venice`)
Venice 是一个注重隐私的 AI 平台，交付无审查与开源模型。它经 OpenAI Chat Completions 传输（`api: "openai-completions"`）运行，默认基础 URL `https://api.venice.ai/api/v1`。

### 特殊处理
- **Qwen 推理方言**：Venice 的严格 chat-completions schema 拒绝 DashScope 的顶层 `enable_thinking`。`buildOpenAICompat` 经 provider 或 `api.venice.ai` 基础 URL 识别 Venice，并把 Qwen 推理级别路由经 OpenAI 风格的 `reasoning_effort`。
- **显式关闭 thinking**：`reasoningDisableMode: "venice-disable-thinking"` 把显式关闭选择编码为 `venice_parameters.disable_thinking: true`，保留同级 Venice 设置如 `include_venice_system_prompt`。

### 认证与用量
- **API Key 登录与校验**：在 `packages/catalog/src/compat/rules/auth/venice.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），引导用户到 `https://venice.ai/settings/api` 获取 API key（`vapi_...` 占位符前缀），并经使用校验模型 `qwen3-4b` 的轻量 `chat-completions` 请求校验凭据。注册于 `packages/ai/src/registry/registry.ts`。
- **环境变量与凭据**：从 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中配置的 `VENICE_API_KEY` 环境变量解析 API key。
- **用量核算**：使用标准 OpenAI Chat Completions 用量核算（`packages/ai/src/providers/openai-shared.ts` 中的 `calculateOpenAIUsageAccounting`），无自定义配额或用量端点。

### Catalog 模型处理
- **Provider 描述符**：注册于 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`），默认模型 `llama-3.3-70b`、`envVars: ["VENICE_API_KEY"]`，catalog 发现配置 `allowUnauthenticated: true`。
- **模型管理器选项**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `veniceModelManagerOptions` 使用 `createOpenAICompatibleModelManagerOptions` 在 `https://api.venice.ai/api/v1` 上配置模型管理。
- **流式用量 compat**：在 `veniceModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）中，映射的模型通过设置 `compat: { ...model.compat, supportsUsageInStreaming: false }` 显式禁用流式用量载荷。
- **Kimi K2.7 Code max token 封顶**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `clampKimiK27CodeMaxTokens`（与 `packages/catalog/scripts/generate-models.ts` 中的 `applyKimiMaxTokensCap`）把 Kimi K2.7 Code 模型（`isKimiK27CodeModelId`）的输出 token（`maxTokens`）封顶为 `KIMI_K27_CODE_RECOMMENDED_MAX_TOKENS`。
- **Catalog 变换**：`packages/catalog/src/provider-models/openai-compat.ts` 中 Venice 的 `openAiCompletionsDescriptor` 在模型 catalog 构建与发现变换期间应用 `clampKimiK27CodeMaxTokens`。

## Vercel AI Gateway (`vercel-ai-gateway`)
Vercel AI Gateway 经统一代理（`https://ai-gateway.vercel.sh`）把 LLM 请求路由到底层上游 provider（如 Anthropic、OpenAI 或 Bedrock）。它根据模型配置在 Anthropic Messages（`anthropic-messages`）、OpenAI Chat Completions（`openai-completions`）与 OpenAI Responses（`openai-responses`）传输协议上运行。

### 特殊处理
- **宿主检测**：`isVercelGatewayHost` 经 `modelMatchesHost({ provider, baseUrl }, "vercelAIGateway")` 评估（`packages/catalog/src/compat/openai.ts`、`packages/catalog/src/hosts.ts`），匹配 `provider === "vercel-ai-gateway"

## vLLM (Local OpenAI-compatible) (`vllm`)
vLLM 是一个开源高吞吐 LLM 服务引擎，运行本地或自托管 OpenAI 兼容推理服务器。它经 HTTP/SSE 使用 OpenAI Chat Completions 传输。入口模块包括用于认证与凭据处理的 `packages/catalog/src/compat/rules/auth/vllm.kdl`，以及用于 catalog 选项与动态模型发现的 `packages/catalog/src/provider-models/openai-compat.ts`（`vllmModelManagerOptions`）。

### 特殊处理
- **推理内容重放（`replayReasoningContent`）**：注册于 `LOCAL_OPENAI_COMPAT_PROVIDERS`（`packages/catalog/src/compat/openai.ts`）。因为本地推理后端依赖前缀 KV-cache 复用，`isLocalOpenAICompatBackend` 自动启用 `replayReasoningContent: true`。当 assistant 历史包含推理内容（`<think>` 块）时，它在后续请求中以 `reasoning_content` 重放，以维持精确的 prompt token 对齐。
- **Qwen thinking 保留（`qwenPreserveThinking`）**：当 `thinkingFormat` 为 `"qwen"` 或 `"qwen-chat-template"` 且 `isLocalOpenAICompatBackend` 为 true 时自动启用（`packages/catalog/src/compat/openai.ts`）。在 compat 对象上设置 `qwenPreserveThinking: true`，在请求体中发出 `preserve_thinking: true`（顶层与 `chat_template_kwargs` 内），使 Qwen 3.6+ chat 模板跨多回合历史保留 `<think>` 块。
- **流空闲超时下限**：作为本地服务后端（`packages/catalog/src/compat/openai.ts` 中的 `isLocalServingBackend`），vLLM 自动应用扩展的流空闲超时下限（`streamIdleTimeoutMs: 300_000` / 5 分钟）而非默认 100 秒，以容纳本地 GPU 或 CPU 上的重度模型 prefill 延迟。
- **仅动态 catalog 排除**：包含在 `DISCOVERY_ONLY_PROVIDERS`（`scripts/generate-models.ts`）与 `LOCAL_ONLY_PROVIDERS`（`test/models-json-no-local-endpoints.test.ts`）中。本地 vLLM 模型从静态 catalog 生成中排除，使机器特定端点从不提交到 `models.json`。

### 认证与用量
- **凭据解析与默认值**：在 `packages/catalog/src/compat/rules/auth/vllm.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`）。从 `VLLM_API_KEY` 环境变量或经 `omp auth-broker login vllm` 存储的凭据读取可选 API key。
- **未认证本地模式**：未提供密钥时默认基础 URL `http://127.0.0.1:8000/v1` 与占位令牌 `"vllm-local"`（`DEFAULT_LOCAL_TOKEN`）（`emptyKeyFallback: "vllm-local"`）。描述符设置指定 `catalogDiscovery: { label: "vLLM", allowUnauthenticated: true }`。
- **文档与端点设置**：登录 helper 指向 `https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html`，用于配置本地 vLLM OpenAI 兼容服务器端点。

### Catalog 模型处理
- **描述符配置**：注册于 `packages/catalog/src/provider-models/descriptors.ts`，`id: "vllm"`、`defaultModel: "gpt-oss-20b"`、`envVars: ["VLLM_API_KEY"]`、`allowUnauthenticated: true`，管理器选项由 `vllmModelManagerOptions` 生成。
- **动态模型发现**：`vllmModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）调用 `fetchOpenAICompatibleModels`，带 `api: "openai-completions"`、`provider: "vllm"`、基础 URL `config?.baseUrl ?? getDefaultModelDiscoveryBaseUrl("vllm")!`（`http://127.0.0.1:8000/v1`）与 10 秒超时（`VLLM_DISCOVERY_TIMEOUT_MS = 10_000`）。
- **上下文窗口提取**：`vllmModelManagerOptions` 中的自定义 `mapModel` 从 vLLM 非标准 `/v1/models` 响应字段 `entry.max_model_len` 提取 `contextWindow`，使用 `toPositiveNumber(entry.max_model_len, model.contextWindow)`。
- **缓存 Provider ID**：由 `packages/catalog/src/provider-models/cache-provider-id.ts` 中的 `resolveModelCacheProviderId("vllm", { baseUrl })` 解析（使用 `getDefaultModelDiscoveryBaseUrl("vllm")`），生成格式为 `vllm:${Bun.hash(baseUrl).toString(36)}` 的基础 URL 哈希缓存键。

## Wafer Serverless (`wafer-serverless`)
Wafer Serverless 是一个按量付费的 provider，经 `https://pass.wafer.ai/v1` 的 OpenAI 兼容 API 代理多个上游模型（如 Zhipu GLM、Moonshot Kimi、Alibaba Qwen 与 DeepSeek）。它依赖 OpenAI Chat Completions 传输（`openai-completions`）。

### 特殊处理
- 上游 thinking 参数选择经 `resolveWaferServerlessThinkingFormat`（`packages/catalog/src/provider-models/openai-compat.ts:2137`）基于 `wafer.provider` 信封提示动态配置：
  - 匹配 `zai`、`zhipu`、`moonshot` 或 `kimi` 的上游设置 `thinkingFormat: "zai"`。
  - 匹配 `qwen`、`alibaba` 或 `dashscope` 的上游设置 `thinkingFormat: "qwen"`。
  - 无信封提示的回退使用 `isReasoningGlmModelId` 或 `isKimiModelId` 判定 `"zai"`（`packages/catalog/src/provider-models/openai-compat.ts:2150`）。
  - `generated-policies.ts` 中的静态策略为内置 GLM/Kimi 模型应用 `thinkingFormat: "zai"`（`packages/catalog/scripts/generated-policies.ts:364`）。
- 所有推理条目配置 `reasoningContentField: "reasoning_content"` 并设置 `supportsDeveloperRole: false`（`packages/catalog/src/provider-models/openai-compat.ts:2244`）。
- `wafer-pass` 已退役，由 `wafer-serverless` 取代（`packages/catalog/scripts/generate-models.ts:79`）。

### 认证与用量
- 使用 bearer API key（`wfr_…` 前缀）认证，经 `WAFER_SERVERLESS_API_KEY` 环境变量提供（`packages/catalog/src/provider-models/descriptors.ts:465`）。
- 交互式登录在 `packages/catalog/src/compat/rules/auth/wafer-serverless.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），引导用户到 `https://app.wafer.ai/usage`。
- Key 校验探测 `https://pass.wafer.ai/v1/models`（`packages/catalog/src/compat/rules/auth/wafer-serverless.kdl` 中的 `validate "models-endpoint"`）。

### Catalog 模型处理
- 在 provider 描述符中注册，`defaultModel: "GLM-5.1"`，基础 URL `https://pass.wafer.ai/v1`（`packages/catalog/src/provider-models/descriptors.ts:463`）。
- 动态 catalog 生成使用 `waferServerlessModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts:2252`），并经 `readWaferRecord` 解析 `/v1/models` 响应（`packages/catalog/src/provider-models/openai-compat.ts:2151`）。
- 从 `wafer.capabilities` 映射模型能力：`vision` 启用 `["text", "image"]` 输入，`reasoning` 启用推理模式，`tools` 设置 `supportsTools`（`packages/catalog/src/provider-models/openai-compat.ts:2193`）。
- 上下文窗口读取 `wafer.context_length`（回退 `max_model_len`），`maxTokens` 封顶为 `65536`（`WAFER_MAX_TOKENS_CAP`，`packages/catalog/src/provider-models/openai-compat.ts:2201`）。
- 定价把 `wafer.pricing` 的内部批发单位转换为美元/M token，使用 `cents * 125 / 10000`（`cents * 0.0125`）（`packages/catalog/src/provider-models/openai-compat.ts:2203`）。
- 模型 ID 在线上逐字保留，无大小写变换（`packages/catalog/src/provider-models/openai-compat.ts:2210`）。

## xAI API (`xai`)
xAI API（`xai`）使用标准 API key 认证提供对 xAI Grok 模型套件的访问。它经 OpenAI Chat Completions 传输路由推理请求（`https://api.x.ai/v1`），不同于使用 OAuth bearer 令牌与 OpenAI Responses 传输的 `xai-oauth`。

### 特殊处理
- **Grok 宿主兼容性**：宿主检测（`packages/catalog/src/hosts.ts` 符号 `hosts.xai`）匹配 provider `"xai"` 与 `api.x.ai` URL，以在 Chat Completions 兼容层中评估 `isGrok`（`packages/catalog/src/compat/openai.ts` 符号 `resolveOpenAICompatForHost`）。
- **Prompt 缓存 header**：当 `isGrok` 为 true 时配置 `promptCacheSessionHeader: "x-grok-conv-id"`（`packages/catalog/src/compat/openai.ts` 符号 `resolveOpenAICompatForHost`），启用会话 ID header 附加以保留 prompt 缓存。
- **推理 Effort 禁用**：在 Chat Completions 兼容性中经 `!isGrok` 检查显式设置 `supportsReasoningEffort: false`（`packages/catalog/src/compat/openai.ts` 符号 `resolveOpenAICompatForHost`），与 `xai-oauth` 的选择性推理 effort 支持形成对比。
- **Provider 优先级排名**：位于 provider 优先级（`packages/catalog/src/identity/priority.ts` 符号 `PROVIDER_PRIORITY`）中 `xai-oauth` 之下（`"xai-oauth"` > `"xai"` > `"mistral"`）。

### 认证与用量
- **认证**：在 `packages/catalog/src/compat/rules/auth/xai.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`）的基于密钥认证。引导用户到 `"https://console.x.ai/team/default/api-keys"`，提示 `"Paste your xAI API key"`（占位符 `"xai-..."`）。
- **校验**：经 `models-endpoint` 对照 `"https://api.x.ai/v1/models"` 执行凭据检查（`packages/catalog/src/compat/rules/auth/xai.kdl` 中的 `validate "models-endpoint"`）。
- **环境回退**：配置为解析 `XAI_API_KEY`（`packages/catalog/src/provider-models/descriptors.ts` 符号 `descriptors`）。
- **用量跟踪**：除 `OpenAI Chat Completions` 流水线外无其他内容。

### Catalog 模型处理
- **描述符配置**：Provider 描述符（`packages/catalog/src/provider-models/descriptors.ts` 符号 `descriptors`）指定默认模型 `grok-4-fast-non-reasoning` 并委托给 `xaiModelManagerOptions`。
- **管理器选项**：经 `createSimpleOpenAICompletionsOptions("xai", "https://api.x.ai/v1", config)` 构建（`packages/catalog/src/provider-models/openai-compat.ts` 符号 `xaiModelManagerOptions`）。
- **Completions 描述符**：以 `openAiCompletionsDescriptor("xai", "xai", "https://api.x.ai/v1")` 注册（`packages/catalog/src/provider-models/openai-compat.ts` 符号 `openAiCompletionsDescriptor`），在 `openai-completions` API 上服务 Grok 模型。

## xAI Grok OAuth (SuperGrok) (`xai-oauth`)
xAI Grok OAuth 经 OpenAI Responses 传输（`api: "openai-responses"`、`baseUrl: "https://api.x.ai/v1"`）提供订阅支持的访问（SuperGrok / X Premium+）到 xAI Grok 模型。认证使用针对 `https://auth.x.ai` 的 RFC 8628 设备码流程，而用量跟踪探测专用的 SuperGrok CLI 计费代理。

### 特殊处理
- **加密推理与历史重放**：`includeEncryptedReasoning` 为 `false`（`packages/catalog/src/compat/openai.ts` 的 `buildOpenAIResponsesCompat`），以抑制加密推理条目重放。`filterReasoningHistory` 为 `true`（`packages/catalog/src/compat/openai.ts`、`packages/ai/src/providers/openai-responses.ts`），以从重放的 Responses 历史中过滤原生推理条目与 thinking 签名。
- **图像 detail 钳制**：`supportsImageDetailOriginal` 为 `false`（`packages/catalog/src/compat/openai.ts` 的 `buildOpenAIResponsesCompat`），把图像 detail 从 `"original"` 钳制为 `"auto"`，因为 xAI 端点对 `"original"` 返回 HTTP 400/422。
- **推理 Effort 门控与摘要**：除非模型在 `isGrokReasoningEffortCapable` 白名单上（`packages/catalog/src/identity/family.ts`，如 `grok-3-mini`、`grok-4.20-multi-agent`、`grok-4.3`、`grok-4.5`），否则 `supportsReasoningEffort` 为 `false`。非 capable 模型（`grok-build`、`grok-build-0.1`、`grok-4.20-0309-reasoning`、`grok-composer-2.5-fast`）设置 `omitReasoningEffort: true` 以防止 `api.x.ai` 上的 HTTP 400。`reasoningSummary` 在 `packages/ai/src/providers/openai-responses.ts` 中设为 `null`（禁用时为 `undefined`），以省略不受支持的 `reasoning.summary` 线上字段。
- **推理 Effort 映射与缓存**：把 `minimal` 映射到 `"low"`（`packages/catalog/src/provider-models/openai-compat.ts` 的 `XAI_REASONING_EFFORT_MAP`）。为会话 prompt 缓存保留发送 `X-Grok-Conv-Id`（`promptCacheSessionHeader`）。

### 认证与用量
- **OAuth 认证**：在 `packages/catalog/src/compat/rules/auth/xai-oauth.kdl` 中声明为 `login "device-code"` 规则（`packages/ai/src/registry/engine/device-code.ts`），令牌钩子在 `packages/ai/src/registry/oauth/xai-oauth.ts`。对 `https://auth.x.ai` 执行 RFC 8628 设备授权（client ID `b1a00492-073a-47ea-816f-4c329264a828`，作用域 `openid profile email offline_access grok-cli:access api:access`）。端点校验与身份 helper 位于 `packages/ai/src/registry/oauth/xai-oauth.ts`（`validateXAIEndpoint`、`fetchXAIOAuthIdentity`）。环境回退：先 `XAI_OAUTH_TOKEN` 再 `XAI_API_KEY`（`descriptors.ts`）。
- **用量跟踪**：`xaiOauthUsageProvider`（`packages/ai/src/usage/xai-oauth.ts`）查询 `https://cli-chat-proxy.grok.com/v1/billing`（`validateXAIBillingEndpoint` 固定为 HTTPS `*.grok.com`），带 header `X-XAI-Token-Auth: xai-grok-cli`（`getXAICliBillingHeaders`）。只接受有效的 OAuth bearer 凭据。探测旧版周 credit（`?format=credits`，`parseWeeklyBillingConfig` 用于 `creditUsagePercent` 与 `productUsage`）与统一月度配额（`parseMonthlyBillingConfig` 用于 `monthlyLimit` 与 `used`），外加正数 `onDemandCap` / `onDemandUsed` 限制。

### Catalog 模型处理
- **精选模型与静态种子**：`XAI_OAUTH_CURATED_MODELS`（`packages/catalog/src/provider-models/openai-compat.ts`）定义静态模型（`grok-build`、`grok-build-0.1`、`grok-4.3`、`grok-4.5`、`grok-4.6`、`grok-4.20-multi-agent-0309`、`grok-4.20-0309-reasoning`、`grok-4.20-0309-non-reasoning`、`grok-composer-2.5-fast`），成本为零（`cost: 0`）。默认模型为 `grok-4.6`（`descriptors.ts`）。`buildXaiOAuthStaticSeed` 在启动时同步种子化 `ModelRegistry`，使 `modelRoles.default = "xai-oauth/<id>"` 在动态刷新之前即可工作。
- **动态精选覆盖层**：`applyXAIOAuthCuration`（`openai-compat.ts`、`xaiOAuthModelManagerOptions`）过滤非聊天前缀（`grok-imagine-`、`grok-stt-`、`grok-voice-`）、覆盖精选上下文窗口（至多 2M）、设置 `maxTokens` 等于 `contextWindow`、保留图像能力与推理标志，并注入缺失的精选模型。
- **参考解析排除**：`isZeroCostXaiOAuthCandidate`（`packages/catalog/src/identity/reference.ts`）把零成本订阅条目从参考索引匹配中排除，使订阅定价与限制不会覆盖公共/付费 Grok 参考。

## Xiaomi MiMo (`xiaomi`)
Xiaomi MiMo 经 OpenAI 兼容端点交付小米专有 MiMo 模型家族（如 `mimo-v2.5` 与 `mimo-v2.5-pro`）。请求经 OpenAI Chat Completions 传输执行，使用标准按量付费基础 URL（`https://api.xiaomimimo.com/v1`）或区域 Token Plan 基础 URL（`https://token-plan-{sgp,ams,cn}.xiaomimimo.com/v1`）。

### 特殊处理
- **MiMo compat 分类**：经 `isXiaomiHost`（`modelMatchesHost(hostModel, "xiaomi")`）与 `isMimoModelIdOrName`（`packages/catalog/src/identity/family.ts`）在 `packages/catalog/src/compat/openai.ts` 中匹配。
- **推理内容不变量**：
  - `requiresReasoningContentForToolCalls: true`（`packages/catalog/src/compat/openai.ts`）：MiMo 模型在标准与 Token Plan 宿主上要求 thinking 模式工具调用后续中精确的 `reasoning_content` 重放。
  - `requiresReasoningContentForAllAssistantTurns: true`（`packages/catalog/src/compat/openai.ts`）：在推理模式期间强制所有先前 assistant 回合上的 `reasoning_content` 存在（经 OpenRouter 路由时除外）。
  - `allowsSyntheticReasoningContentForToolCalls: false`（`packages/catalog/src/compat/openai.ts`）：拒绝工具调用回合上的合成 `reasoning_content` 占位（如 `"."`）。
- **Thinking 格式与 effort 映射**：
  - `thinkingFormat: "zai"`（`packages/catalog/src/compat/openai.ts`）：使用 z.ai 二进制 `thinking` 结构格式化 thinking 模式载荷。
  - `supportsReasoningEffort: false`（`packages/catalog/src/compat/openai.ts`）：抑制标准 `reasoning_effort` 参数。
- **非标准宿主协议标志**：`isXiaomiHost` 归类于 `isNonStandard`（`packages/catalog/src/compat/openai.ts`），设置 `supportsStore: false` 并默认 `supportsDeveloperRole: false`。

### 流行为
- **加宽空闲看门狗超时**：`streamIdleTimeoutMs` 经 `packages/catalog/src/compat/openai.ts` 中的 `XIAOMI_MIMO_STREAM_IDLE_TIMEOUT_MS` 加宽到 300,000 ms（5 分钟），因为 `api.xiaomimimo.com` 上的 MiMo Pro 可能在发出第一个 SSE 事件前停顿约 2 分钟（issue #1770）。

### 认证与用量
- **注册表与 provider 定义**：主 provider 在 `packages/catalog/src/compat/rules/auth/xiaomi.kdl` 中声明；区域 Token Plan provider 在 `packages/catalog/src/compat/rules/auth/xiaomi-token-plan-{ams,cn,sgp}.kdl` 中声明。
- **交互式 key 提示与校验**：标准 Xiaomi 登录（`packages/ai/src/registry/oauth/xiaomi.ts` 中的 `loginXiaomi`）提示标准（`sk-...`）或 Token Plan（`tp-...`）API key 并经 `validateXiaomiApiKey` 校验，而区域 Token Plan provider 在其各自的 `.kdl` 文件中使用声明式 `login "api-key"` 规则。
- **Token Plan 校验回退**：带 `tp-` 密钥的标准 `xiaomi` 登录按 SGP（`https://token-plan-sgp.xiaomimimo.com/v1`）→ AMS（`https://token-plan-ams.xiaomimimo.com/v1`）→ CN（`https://token-plan-cn.xiaomimimo.com/v1`）顺序回退，使用每个端点全新的 `AbortSignal.timeout(15_000)` 信号，使区域超时不会中止后续回退端点。区域 `xiaomi-token-plan-*` 登录对照其特定集群校验。
- **环境变量**：标准 `xiaomi` 为 `XIAOMI_API_KEY`，区域 Token Plan provider 为 `XIAOMI_TOKEN_PLAN_AMS_API_KEY`、`XIAOMI_TOKEN_PLAN_CN_API_KEY`、`XIAOMI_TOKEN_PLAN_SGP_API_KEY`（`packages/catalog/src/provider-models/descriptors.ts`）。

### Catalog 模型处理
- **Provider 描述符**：`packages/catalog/src/provider-models/descriptors.ts` 中的 catalog 描述符配置 `xiaomi`、`xiaomi-token-plan-ams`、`xiaomi-token-plan-cn` 与 `xiaomi-token-plan-sgp`，`defaultModel: "mimo-v2.5"`。
- **动态模型发现**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `xiaomiModelManagerOptions` 检查密钥（`tp-` 对 `sk-`）与 provider ID 以查询标准或区域 `/models` 端点（`XIAOMI_TOKEN_PLAN_BASE_URLS`），在返回的模型上保留区域 provider ID。
- **音频模型过滤**：语音与音频模型从发现与 catalog 生成中排除（`!model.id.includes("-tts") && !model.id.includes("-asr")`），在 `xiaomiModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）与 `scripts/generate-models.ts` 中。
- **宿主匹配**：`modelMatchesHost`（`packages/catalog/src/hosts.ts`）把 `xiaomi` provider ID、`xiaomi-token-plan-` provider 前缀与 `xiaomimimo.com` URL 标记匹配到 `xiaomi` 宿主类别。

## Xiaomi Token Plan (Europe) (`xiaomi-token-plan-ams`)
Xiaomi Token Plan (Europe)（`xiaomi-token-plan-ams`）经小米欧洲 Token Plan 网关（`https://token-plan-ams.xiaomimimo.com/v1`）提供对 Xiaomi MiMo 模型家族（如 `mimo-v2.5` 与 `mimo-v2-omni`）的区域访问。它使用 OpenAI Chat Completions 传输（`api: "openai-completions"`）。此区域 provider 允许 CLI 登录（`omp login`）与动态模型查找，将 `tp-` API key 存储并校验到欧洲集群而不跨区域回退。

### 特殊处理
- **宿主匹配与扩展空闲超时**：经 `packages/catalog/src/hosts.ts` 中的 `providerPrefixes: ["xiaomi-token-plan-"]` 匹配到宿主类别 `xiaomi`。在 `packages/catalog/src/compat/openai.ts` 中，`isXiaomiHost` 匹配，启用配置 `XIAOMI_MIMO_STREAM_IDLE_TIMEOUT_MS = 300_000`（5 分钟流空闲看门狗）的 `isXiaomiMimo`，以容纳 MiMo 模型上的初始响应停顿。
- **TTS/ASR 模型过滤**：动态模型管理器选项（`packages/catalog/src/provider-models/openai-compat.ts` 中的 `xiaomiModelManagerOptions`）与模型生成脚本（`scripts/generate-models.ts`）过滤掉音频模型（`!model.id.includes("-tts") && !model.id.includes("-asr")`）。
- **Provider ID 保留**：`xiaomiModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）显式设置 `providerId: "xiaomi-token-plan-ams"` 并把动态发现条目映射回 `provider: "xiaomi-token-plan-ams"`，而非折叠为通用 `xiaomi`。

### 认证与用量
- **注册表 provider 与认证策略**：在 `packages/catalog/src/compat/rules/auth/xiaomi-token-plan-ams.kdl` 中以 ID `"xiaomi-token-plan-ams"` 声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`）。
- **区域控制台说明**：在 `packages/catalog/src/compat/rules/auth/xiaomi-token-plan-ams.kdl` 中声明的交互式 CLI 登录提示用户输入 `tp-` 前缀 API key 并引导到 Token Plan 控制台 URL（`https://platform.xiaomimimo.com/console/plan-manage`）。
- **单集群校验**：直接对照 `https://token-plan-ams.xiaomimimo.com/v1` 校验密钥（在 `packages/catalog/src/compat/rules/auth/xiaomi-token-plan-ams.kdl` 中经 `validate "chat-completions"` 使用 `mimo-v2.5`），绕过通用 `loginXiaomi` 使用的多区域回退序列。
- **Header 与错误**：请求传递标准 `Authorization: Bearer tp-...` header。认证或网络失败抛出 `AIError.OAuthError` 或 `AIError.ApiKeyRequiredError`。

### Catalog 模型处理
- **Provider 描述符**：注册于 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`），`id: "xiaomi-token-plan-ams"`、`defaultModel: "mimo-v2.5"`、管理器工厂 `xiaomiModelManagerOptions({ ...config, providerId: "xiaomi-token-plan-ams", tokenPlanRegion: "ams" })`。
- **OpenAI-Compat 描述符**：经 `packages/catalog/src/provider-models/openai-compat.ts` 中的 `openAiCompletionsDescriptor("xiaomi-token-plan-ams", "xiaomi-token-plan-ams", "https://token-plan-ams.xiaomimimo.com/v1")` 配置。
- **动态模型管理器**：`xiaomiModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）为 `fetchDynamicModels` 把 `tokenPlanRegion: "ams"` 映射到基础 URL `https://token-plan-ams.xiaomimimo.com/v1`，利用 `createBundledReferenceMap("xiaomi")` 获取基线规格。
- **预打包 catalog 模型**：内置模型（如 `mimo-v2-omni`、`mimo-v2.5`）注册于 `packages/catalog/src/models.json` 的键 `"xiaomi-token-plan-ams"` 下，设置 `baseUrl: "https://token-plan-ams.xiaomimimo.com/v1"` 与 `api: "openai-completions"`。

## Xiaomi Token Plan (China) (`xiaomi-token-plan-cn`)
Xiaomi Token Plan (China) 是 Xiaomi MiMo Token Plan 订阅服务（`https://token-plan-cn.xiaomimimo.com/v1`）的中国区域端点。它使用区域 `tp-...` API key 提供 MiMo AI 模型访问。它使用 "OpenAI Chat Completions" 传输。

### 特殊处理
- **宿主分类**：`packages/catalog/src/hosts.ts` 中的 `KNOWN_HOSTS.xiaomi` 经 `providerPrefixes: ["xiaomi-token-plan-"]` 与 `urlMarkers: ["xiaomimimo.com"]` 匹配 `xiaomi-token-plan-cn`，跨所有 Token Plan 端点启用宿主级兼容性标志。
- **推理内容重放**：`packages/catalog/src/compat/openai.ts` 对小米宿主上的 MiMo 模型标记 `requiresReasoningContentForToolCalls: true` 与 `requiresReasoningContentForAllAssistantTurns: true`，要求先前的 assistant 工具调用回合保留精确的 `reasoning_content`。
- **合成推理拒绝**：`packages/catalog/src/compat/openai.ts` 中的 `allowsSyntheticReasoningContentForToolCalls` 对 MiMo 模型评估为 `false`，拒绝工具调用后续上的合成 `.` 占位。
- **扩展流空闲超时**：`packages/catalog/src/compat/openai.ts` 中的 `XIAOMI_MIMO_STREAM_IDLE_TIMEOUT_MS`（300,000 ms / 5 分钟）覆盖默认首事件/空闲超时，以容纳生成前的推理停顿。
- **音频 SKU 过滤**：`packages/catalog/scripts/generate-models.ts` 为 `xiaomi-token-plan-` provider 过滤掉包含 `-tts` 或 `-asr` 的语音合成与识别 SKU。

### 认证与用量
- **环境变量与登录**：经 `XIAOMI_TOKEN_PLAN_CN_API_KEY` 认证。在 `packages/catalog/src/compat/rules/auth/xiaomi-token-plan-cn.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`）。
- **区域 API key 校验**：提示输入来自 `https://platform.xiaomimimo.com/console/plan-manage` 的 `tp-...` 密钥，并经 `validateXiaomiApiKey` 校验，对 `mimo-v2.5` 发送 `POST /v1/chat/completions` 请求，严格对照 `https://token-plan-cn.xiaomimimo.com/v1`，15 秒超时（`VALIDATION_TIMEOUT_MS`）。
- **用量核算**：应用标准 OpenAI Chat Completions 用量核算（`calculateOpenAIUsageAccounting`）；不存在 provider 特定的用量或配额模块。

### Catalog 模型处理
- **Provider 描述符**：配置于 `packages/catalog/src/provider-models/descriptors.ts`，`id: "xiaomi-token-plan-cn"`、`defaultModel: "mimo-v2.5"`、`envVars: ["XIAOMI_TOKEN_PLAN_CN_API_KEY"]`，`createModelManagerOptions` 委托给带 `tokenPlanRegion: "cn"` 的 `xiaomiModelManagerOptions`。
- **OpenAI compat 条目**：经 `packages/catalog/src/provider-models/openai-compat.ts` 中的 `openAiCompletionsDescriptor` 注册，基础 URL `https://token-plan-cn.xiaomimimo.com/v1`。
- **区域发现与模型管理器**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `xiaomiModelManagerOptions` 把发现固定到 `XIAOMI_TOKEN_PLAN_BASE_URLS.cn`（`https://token-plan-cn.xiaomimimo.com/v1`）。动态模型发现保留 `providerId: "xiaomi-token-plan-cn"`，过滤 `-tts` 与 `-asr` 模型，并使用 `createBundledReferenceMap("xiaomi")` 合并来自内置 `xiaomi` 参考规格的元数据。

## Xiaomi Token Plan (Singapore) (`xiaomi-token-plan-sgp`)
Xiaomi Token Plan (Singapore) provider（`xiaomi-token-plan-sgp`）经 OpenAI Chat Completions 传输（`openai-completions`）把请求路由到小米新加坡 Token Plan 集群。它使用目标 `https://token-plan-sgp.xiaomimimo.com/v1` 的区域绑定 `tp-...` API key 提供对 Xiaomi MiMo 模型（`mimo-v2.5`、`mimo-v2-omni`）的专用访问。此区域条目允许登录与模型存储，与标准 Xiaomi MiMo（`xiaomi`）及其他区域 token plan 端点（`xiaomi-token-plan-ams`、`xiaomi-token-plan-cn`）隔离。

### 特殊处理
- **区域基础 URL 绑定**：`xiaomiModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）在以 `tokenPlanRegion: "sgp"` 配置时显式把 `baseUrl` 设为 `https://token-plan-sgp.xiaomimimo.com/v1`（`XIAOMI_TOKEN_PLAN_BASE_URLS.sgp`），防止 token-plan 密钥回退到标准 Xiaomi 端点 `https://api.xiaomimimo.com/v1`（`XIAOMI_STANDARD_BASE_URL`）。
- **音频/语音模型排除**：`fetchOpenAICompatibleModels`（`packages/catalog/src/provider-models/openai-compat.ts`）与 `scripts/generate-models.ts`（`isXiaomiProvider`）中的模型生成器过滤，把包含 `-tts` 或 `-asr` 的非聊天模型从动态 catalog 发现与生成中排除。
- **扩展流空闲超时**：`modelMatchesHost`（`packages/catalog/src/hosts.ts`）经 `providerPrefixes` 匹配 `xiaomi-token-plan-`，在 `packages/catalog/src/compat/openai.ts` 中继承 `XIAOMI_MIMO_STREAM_IDLE_TIMEOUT_MS`（300,000ms / 5 分钟），防止 MiMo 模型上长初始响应延迟期间的过早超时。

### 认证与用量
- **固定区域校验**：严格对照新加坡端点 `https://token-plan-sgp.xiaomimimo.com/v1` 校验密钥（经 `packages/catalog/src/compat/rules/auth/xiaomi-token-plan-sgp.kdl` 中的 `validate "chat-completions"`）。不同于通用 `loginXiaomi`（对 `tp-` 密钥执行 SGP -> AMS -> CN 回退），`xiaomi-token-plan-sgp` 在认证校验期间禁用跨区域回退。
- **计划管理认证 URL**：声明于 `packages/catalog/src/compat/rules/auth/xiaomi-token-plan-sgp.kdl`，提示用户带指向 `https://platform.xiaomimimo.com/console/plan-manage` 的说明以获取区域 `tp-` 密钥（`placeholder="tp-..."`），与标准的 `https://platform.xiaomimimo.com/#/console/api-keys` 形成对比。
- **校验握手**：校验经使用模型 `mimo-v2.5`（`packages/catalog/src/compat/rules/auth/xiaomi-token-plan-sgp.kdl` 中的 `validate "chat-completions"`）、`max_tokens: 1` 与 `messages: [{ role: "user", content: "ping" }]` 的 `POST /chat/completions` 测试凭据，强制 15 秒超时。
- **用量核算**：Token 消耗与缓存指标使用标准 OpenAI Chat Completions 核算经 `calculateOpenAIUsageAccounting`（`packages/ai/src/providers/openai-shared.ts`）计算。

### Catalog 模型处理
- **Provider 描述符**：注册于 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`），`id: "xiaomi-token-plan-sgp"`、`defaultModel: "mimo-v2.5"`、`createModelManagerOptions` 提供 `tokenPlanRegion: "sgp"` 与 `providerId: "xiaomi-token-plan-sgp"`。静态模型元数据在 `openAiCompletionsDescriptor`（`packages/catalog/src/provider-models/openai-compat.ts`）中声明。
- **Provider 身份保留**：`xiaomiModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）的动态模型获取器（`fetchOpenAICompatibleModels`）给所有发现的模型标记 `provider: "xiaomi-token-plan-sgp"` 与 `baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1"`，确保存储的模型选择映射回 Singapore provider 条目。
- **内置规格映射**：动态模型映射使用 `createBundledReferenceMap`（`packages/catalog/src/provider-models/openai-compat.ts`）把动态模型与 `packages/catalog/src/models.json` 中 `"xiaomi"` 下定义的静态参考规格合并。

## Z.AI (GLM Coding Plan) (`zai`)
Z.AI 经智谱 AI 的 coding plan 基础设施使用 Anthropic Messages 传输（`https://api.z.ai/api/anthropic`）提供 GLM 家族模型（如 `glm-5.2`）。认证同时支持直接 API key 与铸造持久 API key 的 OAuth 浏览器登录流程。

### 特殊处理
- **`zai` thinking 格式方言**：`isZaiThinkingFormat`（`packages/catalog/src/model-thinking.ts`）与 `isZaiReasoningEffortDialect`（`packages/ai/src/providers/openai-shared.ts`）识别使用 `thinkingFormat: "zai"` 方言（`thinking: { type: "enabled" | "disabled" }`）的端点。当推理关闭时（`reasoningDisableMode === "zai-thinking-disabled"` 或线上 effort `"none"`），`resolveOpenAICompatPolicy`（`packages/ai/src/providers/openai-shared.ts`）设置 `params.thinking = { type: "disabled" }`。
- **推理内容后续重放**：在 `streamOpenAICompletionsOnce`（`packages/ai/src/providers/openai-completions.ts`）中，当 `compat.thinkingFormat === "zai"` 且 `model.reasoning` 为 true 时，保留的 thinking 块在跨 API provider 切换（如 Anthropic → OpenAI）时重新序列化为 `assistantMsg.reasoning_content`，以保留结构化推理历史而不降级为文本（#3434）。
- **外部 thinking 保留**：`packages/ai/src/providers/transform-messages.ts` 中的 `targetReadsForeignThinking` 对带 `compat.thinkingFormat === "zai"` 的推理模型返回 true，跨消息变换保留非原生 thinking 块。
- **最大输出 token 钳制**：`packages/ai/src/providers/openai-shared.ts` 中的 `resolveOpenAICompletionsOutputClamp` 把 `isZaiReasoningEffortDialect` 模型（`glm-5.2`）的输出钳制为 `model.maxTokens` 而非默认 64k 上限。
- **宿主 URL 匹配**：`packages/catalog/src/hosts.ts` 中的 `hostMatchesUrl` 对照 `api.z.ai` URL 标记匹配 Z.AI 端点。

### 认证与用量
- **API Key 登录**：在 `packages/catalog/src/compat/rules/auth/zai.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），提示输入 `ZAI_API_KEY`（面板 `https://z.ai/manage-apikey/apikey-list`）并经对 `https://api.z.ai/api/coding/paas/v4` 使用模型 `glm-5.2` 的 chat completions 探测校验。
- **OAuth 流程与浏览器登录**：在 `packages/catalog/src/compat/rules/auth/zai-coding-plan.kdl` 中声明为 `login "oauth-code"` 规则（`packages/ai/src/registry/engine/oauth-code.ts`），key 铸造钩子在 `packages/ai/src/registry/oauth/zai.ts`。它在 `https://chat.z.ai/api/oauth/authorize` 发起授权，带 ZCode 注册的 CLI 重定向 `http://127.0.0.1:9999/callback`（粘贴码回退），并在 `https://zcode.z.ai/api/v1/oauth/token` 交换授权码。
- **持久 key 铸造**：`mintZaiApiKey`（`packages/ai/src/registry/oauth/zai.ts`）经 `businessLogin`（`https://api.z.ai/api/auth/z/login`）把短期 OAuth 令牌交换为业务令牌，经 `getCustomerInfo`（`BIZ_BASE` = `https://api.z.ai`）解析默认组织/项目，创建或复用密钥 `"oh-my-pi"`（`KEY_NAME`），并经 `/copy/${apiKey}` 复制密钥，输出保存为 `storeCredentialsAs: "zai"` 的持久 49 字符 `${apiKey}.${secretKey}` 令牌。
- **用量与配额获取器**：`fetchZaiUsage` / `zaiUsageProvider`（`packages/ai/src/usage/zai.ts`）以直接 key 授权在 `DEFAULT_ENDPOINT`（`https://api.z.ai`）上查询 `QUOTA_PATH`（`/api/monitor/usage/quota/limit`）。`parseLimitItem` 把 `TOKENS_LIMIT` 解析为 token 配额（`zai:tokens:<window>`）、`TIME_LIMIT` 解析为请求配额（`zai:requests:<window>`，或匹配 `isZaiFeatureRequestLimit` 时的 `zai:features:zread:<window>`）、`CREDIT_LIMIT` 解析为 credit 配额（`zai:credits:<window>`，单位 `credits`），用于基于 credit 的 GLM Coding Plan（如 12k credits / 5h + 60k credits / week；`usage` 是配额，`currentValue` 是消耗）。载荷的 `data.level`（如 `"lite"`、`"pro"`、`"max"`）以 `metadata.planType` 呈现。`buildZaiWindow` 把时间单位映射为 1h、1d、1mo 或 1w 窗口，并可选获取 `MODEL_USAGE_PATH`（`/api/monitor/usage/model-usage`）。
- **凭据排名**：`zaiRankingStrategy`（`packages/ai/src/usage/zai.ts`，注册于 `packages/ai/src/auth-storage.ts`）经 `rankZaiRequestLimits` 对请求限额排名（无请求配额时回退到完整凭据限额集合——tokens/requests/credits），选择 5 小时主限额与周次限额窗口。

### Catalog 模型处理
- **描述符与 PAYG 定价**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `MODELS_DEV_PROVIDER_DESCRIPTORS_CODING_PLANS` 定义 `anthropicMessagesDescriptor("zai", "zai", "https://api.z.ai/api/anthropic")`，映射 models.dev 的 `zai` 按量付费定价键而非 `zai-coding-plan`，以避免把订阅费率呈现为全 $0 的 Free 模型（#5598）。
- **默认模型与上下文策略**：`packages/catalog/src/provider-models/descriptors.ts` 中的 `PROVIDER_DESCRIPTORS` 设置默认模型 `glm-5.2`。`generated-policies.ts`（`packages/catalog/scripts/generated-policies.ts`）把 `glm-5.2` 上下文窗口固定为 1,000,000 token，而 `dropUnusableZaiContextTierIds`（`packages/catalog/scripts/generate-models.ts`）过滤 `[1m]` 上下文层级 ID 后缀。
- **GLM-5.2 effort 支持**：`packages/catalog/src/model-thinking.ts` 中的 `getModelDefinedEfforts`（经 `isAnthropicMessagesGlm52ReasoningEffortModel` 检查）给 `glm-5.2` 指定 `HIGH_MAX_REASONING_EFFORTS`（`["high", "max"]`），把 `"none"` 视为禁用状态而非用户档位级别。

## ZenMux (`zenmux`)
ZenMux 是一个基于模型归属使用双传输路由的多 provider 网关。Anthropic 拥有的模型（以 `owned_by: "anthropic"` 或 `anthropic/` 前缀识别）经 Anthropic Messages（`https://zenmux.ai/api/anthropic`）路由，其余所有模型经 OpenAI Chat Completions（`https://zenmux.ai/api/v1`）路由。

### 特殊处理
- **双传输基础 URL 规范化**：`normalizeZenMuxOpenAiBaseUrl` 与 `toZenMuxAnthropicBaseUrl`（`packages/catalog/src/provider-models/openai-compat.ts`）在端点 URL 之间转换。OpenAI 端点默认 `https://zenmux.ai/api/v1`，Anthropic 路由到 `https://zenmux.ai/api/anthropic`，指定自定义基础 URL 时自动转换路径。
- **Anthropic 代理签名完整性**：`KNOWN_HOSTS.zenmux`（`packages/catalog/src/hosts.ts`）识别 ZenMux 为签名宿主。在 `buildAnthropicCompat`（`packages/catalog/src/compat/anthropic.ts`）中，`isZenmux` 把代理标记为 `signingEndpoint`，设置 `replayUnsignedThinking: false`。这确保历史 thinking 块保留有效签名，而非重放会触发 HTTP 400 错误的空签名。
- **严格模式支持**：`detectStrictModeSupport`（`packages/catalog/src/compat/openai.ts`）为 ZenMux OpenAI 兼容端点启用严格结构化工具输出。

### 认证与用量
- **API Key 解析**：`ZENMUX_API_KEY` 注册于 `descriptors.ts`（`packages/catalog/src/provider-models/descriptors.ts`）并经 `packages/ai/src/stream.ts` 中的 `getEnvApiKey("zenmux")` 解析。
- **Key 校验与登录**：在 `packages/catalog/src/compat/rules/auth/zenmux.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），引导用户到 `https://zenmux.ai/settings/keys` 并经 `validate "models-endpoint"` 对照 `https://zenmux.ai/api/v1/models` 校验凭据。
- **无认证发现**：`descriptors.ts` 中的 `allowUnauthenticated: true` 允许无需 API key 的模型 catalog 发现。

### Catalog 模型处理
- **描述符与默认模型**：`descriptors.ts` 定义 provider 描述符，默认模型 `anthropic/claude-opus-4.8`。
- **动态模型发现**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `zenmuxModelManagerOptions` 使用 `fetchOpenAICompatibleModels` 查询 `https://zenmux.ai/api/v1/models`。`isZenMuxAnthropicModel` 检查 `entry.owned_by === "anthropic"` 或 ID 前缀 `anthropic/` 以设置 `api: "anthropic-messages"` 或 `api: "openai-completions"`。
- **定价提取**：`getZenMuxPricingValue` 与 `getZenMuxCacheWritePrice`（`packages/catalog/src/provider-models/openai-compat.ts`）从 `entry.pricings` 提取 token 成本：`prompt` 为输入成本、`completion` 为输出成本、`input_cache_read` 为缓存读取成本，以及 `input_cache_write_1_h`、`input_cache_write_5_min` 或 `input_cache_write` 的层级查找为缓存写入成本。
- **能力与限制**：映射 `entry.display_name`、`entry.context_length`（`contextWindow`）、`entry.max_completion_tokens`（`maxTokens`）、`entry.input_modalities`（`input`）与 `capabilities.reasoning`（`reasoning`）。

## Zhipu Coding Plan (智谱) (`zhipu-coding-plan`)
智谱（Zhipu）BigModel 的国内 coding-plan provider，使用 OpenAI Chat Completions 传输（`openai-completions` API）。它把请求路由到智谱专用的 Coding Plan 端点（`https://open.bigmodel.cn/api/coding/paas/v4`）而非通用 BigModel 端点，以确保 API 调用消耗 coding-plan 配额而非账户余额。

### 特殊处理
- **Z.AI thinking 格式与推理 effort**：配置 `thinkingFormat: "zai"`（`packages/catalog/src/compat/openai.ts` 447 行），经 `thinking: { type: "enabled" }` 与 `reasoning_content` 增量结构化 thinking 输出（交叉引用 Z.AI 格式）。仅对 GLM-5.2+ 模型经 `isGlm52ReasoningEffortModelId`（`packages/catalog/src/compat/openai.ts` 283、469 行）启用 `supportsReasoningEffort`。
- **流看门狗空闲下限**：对 GLM coding-plan 模型 ID（`glm-5...`）在 `isZhipu` 激活时应用 600 秒（`600_000` ms）流空闲超时下限（`GLM_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS = 600_000`、`packages/catalog/src/compat/openai.ts` 39-40、417 行的 `GLM_CODING_PLAN_MODEL_PATTERN`），避免长推理阶段期间虚假的流看门狗中止。
- **Max Tokens 与系统消息**：对 `isZhipu` 设置 `useMaxTokens: true`（`packages/catalog/src/compat/openai.ts` 362 行）并启用 `supportsMultipleSystemMessages: true`（`packages/catalog/src/compat/openai.ts` 408 行）。

### 认证与用量
- **凭据与 API 基础**：经 `ZHIPU_API_KEY` 认证（`packages/catalog/src/provider-models/descriptors.ts` 541 行），API 基础 URL `https://open.bigmodel.cn/api/coding/paas/v4`，面板 URL `https://bigmodel.cn/coding-plan/personal/overview`（`packages/catalog/src/compat/rules/auth/zhipu-coding-plan.kdl`）。
- **API Key 登录与校验**：在 `packages/catalog/src/compat/rules/auth/zhipu-coding-plan.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），密钥格式 `<id>.<secret>`，对照 `https://open.bigmodel.cn/api/coding/paas/v4` 上的 `glm-5.1` 校验。宿主检测经 `hosts.ts` 接线（`zhipu`，urlMarker `open.bigmodel.cn`，`packages/catalog/src/hosts.ts` 42 行）。
- **中文 429 配额分类**：`packages/ai/src/error/rate-limit.ts` 60 行的 `CN_QUOTA_EXHAUSTED_PATTERN`（`/使用.{0,30}?上限|(?:额度|配额)已?(?:用|耗)(?:完|尽)|限额.{0,30}重置|余额不足/`）把智谱的 429 配额耗尽响应（`"429 已达到 5 小时的使用上限。您的限额将在 ... 重置。"`）分类为 `QUOTA_EXHAUSTED`，触发凭据轮换而非瞬态退避。

### Catalog 模型处理
- **Provider 描述符**：注册于 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts` 539 行），默认模型 `glm-5.1`、`dynamicModelsAuthoritative: true`，模型管理器选项来自 `zhipuCodingPlanModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts` 1689、5764 行）。
- **GLM 身份分类**：使用 `parseGlmModel`（`packages/catalog/src/identity/classify.ts` 145 行）把 `glm-<version>[v][-<variant>]` 解析为家族（`"glm"`）、版本、视觉标志（`v`）与变体（`base`、`air`、`turbo`、`flash`、`flashx`、`preview`）。
- **能力门控与策略**：`isReasoningGlmModelId`（`packages/catalog/src/identity/family.ts` 219 行）对版本 >= 4.5（`base`/`air`/`turbo`）门控推理，`isGlm52ReasoningEffortModelId` 对版本 >= 5.2 门控 `reasoning_effort`，`isGlmVisionModelId` 检测视觉模型（`glm-4v`、`glm-4.5v`）。生成策略把 `glm-5.2` 上下文窗口固定为 1,000,000 token（`packages/catalog/scripts/generated-policies.ts` 332 行）。
