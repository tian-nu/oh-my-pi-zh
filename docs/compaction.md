# Compaction 与分支摘要

Compaction 和分支摘要是让长会话保持可用且不丢失先前工作上下文的两种机制。

- **Compaction** 将旧历史重写为当前分支上的摘要。
- **分支摘要** 在 `/tree` 导航时捕获被放弃分支的上下文。

两者都作为会话条目持久化，并在重建 LLM 输入时转换回用户上下文消息。

## 关键实现文件

- `packages/agent/src/compaction/compaction.ts` (context-full summarization and handoff generation)
- `packages/snapcompact/src/snapcompact.ts` (snapcompact strategy: history archived as dense bitmap images)
- `packages/agent/src/compaction/branch-summarization.ts`
- `packages/agent/src/compaction/pruning.ts`
- `packages/agent/src/compaction/compaction-v2-streaming.ts` (provider-native streaming compaction)
- `packages/agent/src/compaction/shake.ts` (mechanical content elision)
- `packages/agent/src/compaction/utils.ts`
- `packages/agent/src/compaction/openai.ts`
- `packages/coding-agent/src/session/session-manager.ts`
- `packages/coding-agent/src/session/agent-session.ts`
- `packages/coding-agent/src/session/session-maintenance.ts` (automatic maintenance orchestration)
- `packages/coding-agent/src/session/messages.ts`
- `packages/coding-agent/src/extensibility/hooks/types.ts`
- `packages/coding-agent/src/config/settings-schema.ts`

## 会话条目模型

Compaction 和分支摘要是一等会话条目，而非普通的 assistant/user 消息。

- `CompactionEntry`
  - `type: "compaction"`
  - `summary`，可选 `shortSummary`
  - `firstKeptEntryId`（compaction 边界）
  - `tokensBefore`
  - 可选 `details`、`preserveData`、`fromExtension`
- `BranchSummaryEntry`
  - `type: "branch_summary"`
  - `fromId`、`summary`
  - 可选 `details`、`fromExtension`

重建上下文时（`buildSessionContext`）：

1. 活动路径上最新的 compaction 被转换为一条 `compactionSummary` 消息。
2. 从 `firstKeptEntryId` 到 compaction 点的保留条目被重新包含。
3. 路径上更晚的条目被追加。
4. `branch_summary` 条目被转换为 `branchSummary` 消息。
5. `custom_message` 条目被转换为 `custom` 消息。

这些自定义角色随后在 `convertToLlm()` 中被转换为面向 LLM 的消息：`compactionSummary` 和 `branchSummary` 成为通过静态模板渲染的 user 消息，模板为

- `packages/agent/src/compaction/prompts/compaction-summary-context.md`
- `packages/agent/src/compaction/prompts/branch-summary-context.md`

而 `custom` 消息以 developer 消息的形式原样通过（无模板）。

## Compaction 流水线

### 触发方式

Compaction/上下文维护可以以六种方式运行：

1. **手动上下文压缩**：`/compact [instructions]` 调用 `AgentSession.compact(...)`。
2. **自动溢出恢复**：在同一模型的 assistant 错误匹配上下文溢出之后。
3. **自动不完整输出恢复**：在同一模型的 assistant 消息以 `stopReason === "length"` 结束（OpenAI/Codex `response.incomplete`）之后。
4. **自动阈值维护**：成功 turn 之后，当上下文超过解析出的阈值时。
5. **turn 中阈值维护**：当工具循环 turn 跨越阈值且 `compaction.midTurnEnabled !== false` 时，在下一次 provider 请求之前。
6. **空闲维护**：`runIdleCompaction()` 可以以 `"idle"` 为原因调用相同的自动维护路径。

### Compaction 形态（图示）

```text
Before compaction:

  entry:  0     1     2     3      4     5     6      7      8     9
        ┌─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬──────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴──────┘
                └────────┬───────┘ └──────────────┬──────────────┘
               messagesToSummarize            kept messages
                                    ↑
                           firstKeptEntryId (entry 4)

After compaction (new entry appended):

  entry:  0     1     2     3      4     5     6      7      8     9      10
        ┌─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬──────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool │ cmp │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴──────┴─────┘
               └──────────┬──────┘ └──────────────────────┬───────────────────┘
                 not sent to LLM                    sent to LLM
                                                         ↑
                                              starts from firstKeptEntryId

What the LLM sees:

  ┌────────┬─────────┬─────┬─────┬──────┬──────┬─────┬──────┐
  │ system │ summary │ usr │ ass │ tool │ tool │ ass │ tool │
  └────────┴─────────┴─────┴─────┴──────┴──────┴─────┴──────┘
       ↑         ↑      └─────────────────┬────────────────┘
    prompt   from cmp          messages from firstKeptEntryId
```

### 溢出/不完整恢复 vs 阈值/空闲维护

这些自动路径是有意不同的：

- **溢出恢复**
  - 触发：检测到当前模型的 assistant 错误为上下文溢出，且该错误不早于最新一次 compaction。
  - 失败的 assistant 错误消息会在重试前从活动的 agent 状态中移除。
  - 先尝试上下文升级（promotion）；如果配置了更大的模型且可用，agent 切换模型并重试，不做压缩。
  - 如果升级不可用且 compaction 已启用，自动维护会以 `reason: "overflow"` 和 `willRetry: true` 遍历 `compaction.methodOrder`；跳过 handoff，因为其请求会复用已溢出的输入。
  - 成功时，会调度 `agent.continue()` 以重试该 turn。

- **不完整输出恢复**
  - 触发：同一模型的 assistant 消息以 `stopReason === "length"` 结束，且该消息不早于最新一次 compaction。
  - 不完整的 assistant 消息会在恢复前从活动的 agent 状态中移除。
  - 先尝试上下文升级。
  - 如果升级不可用且 compaction 已启用，自动维护以 `reason: "incomplete"` 和 `willRetry: true` 遍历 `compaction.methodOrder`。
  - 与溢出不同，可达的 `handoff` 偏好可以运行，因为输入上下文仍然可用。
  - 软压缩成功时，会调度 `agent.continue()` 以重试该 turn。

- **阈值维护**
  - 触发：成功的、非错误的 assistant 消息，其调整后的上下文 token 超过 `resolveThresholdTokens(...)`。测量计数来自 `calculateContextTokens(...)`，它减去 provider 侧的编排 token（计费，但从不重放进会话前缀），从而避免自动压缩和上下文升级阈值被它们抬高。
  - 当 `compaction.midTurnEnabled !== false` 时，turn 中维护还会在下一次 provider 请求之前检查安全的工具循环边界。
  - 工具输出修剪可以在阈值比较之前降低测得的 token 计数。
  - 上下文升级在 turn 后压缩之前尝试。
  - 如果升级不可用，自动维护以 `reason: "threshold"` 和 `willRetry: false` 遍历 `compaction.methodOrder`。
  - 当 `handoff` 是下一个可运行方法时，turn 后的阈值维护通常会调度一个 post-prompt 任务来生成 handoff 文档并作为 compaction 条目提交；pre-prompt 和 turn 中检查则内联运行所有方法，以避免与下一个 turn 竞争。
  - 成功时，若 `compaction.autoContinue !== false`，turn 后维护会调度一个由 agent 撰写、来自 `prompts/system/auto-continue.md` 的 developer 自动继续提示；turn 中维护从不调度单独的继续，因为核心循环已拥有下一次 provider 请求。

- **空闲维护**
  - 触发：`runIdleCompaction()`，在未在流式传输且未在压缩中时。
  - 使用 `reason: "idle"` 且之后不会自动继续。

### Shake 方法

在 `compaction.methodOrder` 中包含 `shake` 会执行内联的本地缩减，而不是调用摘要模型。它用一个受保护的近期 token 窗口和最小节省阈值，将符合条件工具结果和大型 fenced/XML 块替换为可恢复的 `artifact://` 引用。自动 shake 以 `action: "shake"` 发出正常的自动压缩事件。

当 shake 无法回收足够上下文以降到恢复带以下时，阈值、不完整输出和溢出恢复会前进到下一个配置的方法；这可以防止反复的空转 shake 循环。空闲 shake 不使用该回退，因为空闲计时器在再次运行前会重新检查用量。手动 `/shake` 是一个单独的、更激进的命令，可以针对所有符合条件的历史。

### Snapcompact 方法

在 `compaction.methodOrder` 中包含 `snapcompact` 会用一个本地、确定性的归档过程（来自 `@oh-my-pi/snapcompact` 的 `compact`）取代 LLM 摘要调用：

- 被丢弃的历史被序列化、折叠空白，并打印到模型感知的 PNG 帧上（帧宽按形状固定；帧高贴合实际打印的行数），使用捆绑的公共领域像素字体。形状——以及帧尺寸——在模型行被测量时由**模型 id** 解析：Claude 在 11px 步进上读取 X.org `8x13` 字形（额外字距、黑色墨水——`11on16-bw`；高分辨率行——Opus 4.7+、Fable、Mythos——在 Anthropic 4,784 视觉 token 上限下得到 1932px 帧，较老的行保持 1568px），Gemini 在 22px 间距上读取 `8x13` 字形（额外行距、黑色墨水——2048px 的 `8on22-bw`，因为 Gemini 3.x 对任意像素尺寸的每张图都按固定 1,120 token 预算计费），GPT/Codex 在 1568px 读取相同的 `8on22-bw` 形状（patch 计费与面积成比例，更大的帧无法改善每 token 字符数），Kimi/GLM 在 16px 间距上读取 `8x13` 字形（1568px 的 `8on16-bw`——kimi 的处理器会对超过 1792px 的内容降采样）。经 Vertex 或 OpenRouter 路由的 Claude 仍保持其 Claude 形状。自动选择也是字体感知的（`resolveShapeForText`）：当模型默认字体无法安全渲染转录文本，或宽 CJK 字形占主导且 `silver16-bw` 网格可以安全渲染时，auto 会切换到 `silver16-bw`；强制指定的变体从不被覆盖。未测量的模型回退到其 wire API 家族（Anthropic 家族/未知 → `11on16-bw`，Google → `8on22-bw`，OpenAI 兼容 → `8on22-bw`）；计费（按家族的 patch/预算公式、OpenAI 的 `detail: "original"` 提示）始终跟随承载请求的 API，按解析出的帧尺寸计算。`snapcompact.shape` 设置（默认 `auto`）可以强制使用某个研究评测变体：方形网格（`8x8r`/`8x8u`/`6x6u`/`5x8` × 句子色相/黑色墨水）或各模型的评测优胜者（`6x12-dim`、`8x13-bw`、`8on16-bw`、`8on22-bw`、`11on16-bw`、`silver16-bw`——嵌入式 Silver TrueType 字体，用于 CJK 及其他非拉丁文本的 16px 网格——以及双列自动换行的 `doc-8on16-bw`/`-sent`/`-sent-dim`，其中 `dim` 将停用词以灰色打印）。强制指定的变体保持其几何结构，但会按目标 provider 的图像计费重新定价。同一设置还治理内联的 system-prompt/工具结果图像化（`snapcompact.systemPrompt`、`snapcompact.toolResults`）。
- 序列化保持归档对话稠密：工具结果按头尾截断（默认 2,000 字符、头占比 0.6），工具调用参数值按单值（500）和单次调用（2,000）设上限，工具输出以暗灰色墨水打印，使对话比工具噪音更醒目。所有预算和调暗均可通过 `SerializeOptions` 配置（`toolResultMaxChars`、`toolArgMaxChars`、`toolCallMaxChars`、`truncateHeadRatio`、`dimToolResults`）。
- snapcompact 归档以有界源文本加渲染帧的形式持久化在 `CompactionEntry.preserveData.snapcompact` 下。每次重建上下文时，它被重构为有序的压缩块：最老边缘的纯文本、图像化的中段、然后是最新的纯文本边缘。该条目的 `summary` 只是简短的续接导语加上常规的文件操作列表。
- 后续压缩从该有界源文本（`Archive.text`）重新渲染，而不是盲目沿用旧的 PNG。`maxFrames` 现在默认为 `MAX_FRAMES_DEFAULT`（80）且仅作为上限；当图像化中段很大时它会在内部做 foveate（HQ/LQ/HQ），而两个时间顺序边缘保持逐字文本。
- 不涉及模型、API key 或网络，因此 snapcompact 对溢出恢复也是安全的。它要求当前模型具备视觉能力（`model.input` 包含 `"image"`）；否则自动维护会跳过它并前进到下一个配置的方法。手动 `/compact` 遵循方法顺序，除非给了自定义指令（那意味着定向的 LLM 摘要）。
- 依据：形状表来自 `packages/snapcompact` 中 200k token 的评测，其中对具备视觉能力的模型，位图帧在更低的计费 token 成本下保住了 QA 召回率，优于原始文本。

### 显示转录

Compaction 不再在视觉上重启会话。TUI 渲染**显示转录**（`buildSessionContext({ transcript: true })` / `AgentSession.buildTranscriptSessionContext()`）：按时间顺序的每个路径条目，每次 compaction 在其触发点内联显示为一条细分割线—— `── 📷 compacted · ctrl+o ──`。展开（ctrl+o）会显示摘要。只有 LLM 上下文在 compaction 边界处重置；分割线上方的回滚记录保持完好，包括跨会话恢复。

### 压缩前修剪

在 compaction 检查之前，可能先运行工具结果修剪（`pruneToolOutputs`）。

默认修剪策略：

- 保护最新的 `40_000` 个工具输出 token。
- 要求总估计节省至少 `20_000`。
- 绝不清空低于 `50` token（`MIN_PRUNE_TOKENS`）的结果：`[Output truncated - N tokens]` 占位符本身约花 8 个 token，修剪低于下限的结果会让上下文变大并白白搅动 prompt 缓存。（被取代和无用的结果有各自的规则——无用收集器本就丢弃无节省的候选；被取代的读取出于正确性无论如何都会修剪，不论大小。）
- 绝不修剪 `skill` 工具结果、`skill://` 路径的 `read` 结果，或对活动计划引用文件的读取（通过 `AgentSession` 的计划保护加入）。

被修剪的工具结果被替换为：

- `[Output truncated - N tokens]`

如果修剪改变了条目，会在压缩决策之前重写会话存储并刷新 agent 消息状态。

### 无用结果省略

工具可以把已完成的结果标记为上下文无用——零匹配的搜索、一切仍在运行却超时的 `hub` 等待、空的 `hub` 收件箱清空。该标志源自工具结果（`AgentToolResult.useless`，通过 `ToolResultBuilder.useless()` 或直接设置在返回对象上），由 agent 循环复制到持久化的 `ToolResultMessage`（从不与 `isError` 同时存在——错误总是胜出），并在三处被消费：

- **每 turn 的陈旧结果处理**（`pruneSupersededToolResults`，由 `compaction.dropUseless` 门控，默认开启）：被标记的结果被清空为精确的占位符 `[Uneventful result elided]`（`USELESS_NOTICE`），时机与被取代的读取一样考虑缓存——只在候选之后的后缀较小（≤ ~8k token）或会话空闲超过 provider prompt 缓存生命周期时执行。比通知本身还小的结果从不清空（无节省），受保护的工具豁免。
- **阈值修剪**（`pruneToolOutputs`）：被标记的结果与被取代的读取一样绕过保护近期窗口，并收到 `USELESS_NOTICE` 而非 token 计数占位符。
- **摘要序列化**：`serializeConversation`（agent 和 snapcompact）从摘要器/归档输入中丢弃整个工具调用/结果对——反正摘要化后源区域就被丢弃了，因此排除不损失缓存。

该标志从不到达 provider wire 格式，且被标记的对从不会从历史中移除（只在原处清空），因此工具调用/结果配对和 provider 原生历史重放保持完好。

### 边界与切点逻辑

`prepareCompaction()` 只考虑自上一个 compaction 条目（如果有）以来的条目。

1. 找到上一个 compaction 索引。
2. 遵循最新的 `/clear` `reset_boundary` 标记：在最后一个可复用 compaction 之后的边界会取代它，因此原位 `/clear` 之后的 compaction 只摘要重置之后创建的消息（issue #8718）。
3. 计算 `boundaryStart = prevCompactionIndex + 1`。
4. 在有测量用量时，按用量比自适应 `keepRecentTokens`。
5. 在边界窗口上运行 `findCutPoint()`。

有效切点包括：

- 角色为 `user`、`assistant`、`bashExecution`、`hookMessage`、`branchSummary`、`compactionSummary` 的消息条目
- `custom_message` 条目
- `branch_summary` 条目

硬性规则：绝不在 `toolResult` 处切。

如果切点之前紧邻着非消息的元数据条目（`model_change`、`thinking_level_change`、标签等），会通过把切点索引向后移动直到命中消息或 compaction 边界，将它们拉入保留区域。

### 分裂 turn 处理

如果切点不在某个 user turn 的起点，compaction 将其视为分裂 turn。

turn 起点检测把以下视为 user turn 边界：

- `message.role === "user"`
- `message.role === "bashExecution"`
- `custom_message` 条目
- `branch_summary` 条目

分裂 turn 压缩生成两个摘要：

1. 历史摘要（`messagesToSummarize`）
2. turn 前缀摘要（`turnPrefixMessages`）

最终存储的摘要按如下方式合并：

```markdown
<history summary>

---

**Turn Context (split turn):**

<turn prefix summary>
```

### 摘要生成

`compact(...)` 从序列化的会话文本构建摘要：

1. 通过 `convertToLlm()` 转换消息。
2. 用 `serializeConversation()` 序列化。
3. 包裹在 `<conversation>...</conversation>` 中。
4. 可选包含 `<previous-summary>...</previous-summary>`。
5. 可选将扩展 hook 上下文和活动内存后端的 compaction 上下文作为 `<additional-context>` 条目注入。
6. 使用 `SUMMARIZATION_SYSTEM_PROMPT` 执行摘要提示。

提示选择：

- 首次 compaction：`compaction-summary.md`
- 带先前摘要的迭代 compaction：`compaction-update-summary.md`
- 分裂 turn 的第二轮：`compaction-turn-prefix.md`
- 简短 UI 摘要：`compaction-short-summary.md`
- handoff 文档：`handoff-document.md`（由 `generateHandoff(...)` 使用，不是序列化压缩）

远程摘要模式，按顺序咨询（某一层可用时各阶段回退到下一层）：

- **V2 流式 Responses 压缩**（最先尝试，通过 `compaction.remoteStreamingV2Enabled` 默认开启）：对符合条件的模型—— `shouldUseCompactionV2Streaming(...)`：带有 `remoteCompaction.v2StreamingEnabled` 且可解析 Responses endpoint 的 `openai-responses`、`azure-openai-responses` 或 `openai-codex-responses` API——compaction 将完整会话（包括 provider 原生的工具调用历史重放）转发到模型正常的 Responses 流式 endpoint，附带末尾的 `compaction_trigger` 输入项，并要求恰好一个流式输出的 `compaction` 项。请求携带会话路由和 prompt 缓存标识符（routing/session-id header 加 `prompt_cache_key`），并以与普通 turn 相同的方式解析模型的推理努力。替换历史是 Codex 风格的：`compaction.v2RetainedMessageBudget`（默认 `64000` token，钳制到该上限）内保留的真实 user 消息后跟 compaction 项，存储在 `preserveData.openaiRemoteCompaction`（版本 `"v2"`）中。瞬态流错误在 3 分钟超时（`V2_COMPACTION_TIMEOUT_MS`，与 V1 相同）下以指数退避最多重试 `V2_COMPACTION_MAX_RETRIES`（`2`）次；用户中止从不重试。
- **V1 原生 `/responses/compact`**：对 OpenAI/OpenAI Codex 模型（`shouldUseOpenAiRemoteCompaction`），当远程压缩启用且 V2 未运行（不符合条件或失败）时，compaction 尝试 provider 原生的 `/responses/compact` endpoint。它将 provider 替换历史保留在 `preserveData.openaiRemoteCompaction` 中。原生失败会浮出其传输错误，而不是静默切换到通用摘要——除非设置了 `compaction.remoteEndpoint`，此时摘要生成会落到该 endpoint/本地摘要。
- **自定义远程 endpoint**：如果设置了 `compaction.remoteEndpoint` 且远程压缩已启用，本地摘要生成会 POST 以下两种 wire 格式之一：
  - 自定义 omp 摘要器 endpoint 接收 `{ systemPrompt, prompt }`，必须返回至少包含 `{ summary }` 的 JSON。
  - 路径以 `/chat/completions` 结尾的 OpenAI 兼容 endpoint 接收 `{ model, messages, stream: false }`，其中 `messages` 包含一条 system 提示和一条 user 提示。摘要从 `choices[0].message.content` 读取，这使 llama.cpp、vLLM 等自托管 server 可以充当远程压缩器而无需单独的摘要器 shim。

当原生远程压缩（V2 或 V1）成功时，本地 LLM 摘要被完全跳过——持久历史位于 provider 重放载荷中，存储的 `summary` 只是占位导语加文件操作列表。

### Handoff 生成

`packages/agent/src/compaction/compaction.ts` 还导出 `generateHandoff(...)`。Handoff 生成使用与摘要相同的 `completeSimple(...)` oneshot 风格，但它通过发送活动的 system 提示、工具数组和真实 LLM 消息历史来保留活动的 agent 缓存前缀，然后追加一条归属为 agent 的 `user` 消息，内容为 handoff 提示。它强制 `toolChoice: "none"` 并直接返回拼接后的文本块。

Handoff 会在当前会话上提交一个常规的 `CompactionEntry`：`SessionMaintenance.handoff()`（手动 `/handoff`）和自动维护的 `handoff` 方法都通过 `SessionHandoff.generateDocument()` 生成文档，并将其作为压缩摘要存储，`firstKeptEntryId` 来自 `prepareCompaction`，因此近期历史被保留，会话 id、转录和 provider 缓存键不变。

当 `compaction.handoffSaveToDisk` 启用时，**自动触发**的 handoff 还会在持久化会话的 artifact 目录中写入 `handoff-<ISO timestamp>.md`。手动 handoff 不会被此设置写入，非持久化会话没有 artifact 目录。

### 摘要中的文件操作上下文

Compaction 通过 assistant 工具调用跟踪累积的文件活动：

- `read(path)` → 读取集合
- `write(path)` → 修改集合
- `edit(path)` → 修改集合

累积行为：

- 仅当先前条目是 pi 生成的（`fromExtension !== true`）时才包含先前 compaction 的细节。
- 分裂 turn 中，也包含 turn 前缀的文件操作。
- `details.readFiles` 排除同时被修改的文件；`details.modifiedFiles` 携带其余文件（持久化形态不变）。

文件列表是一个分组、前缀折叠的目录树（find 工具形态），带每文件访问标记——`(Read)` 表示只读文件，`(Write)` 表示从未读取的已修改文件，`(RW)` 表示同时出现在累积读取集合中的已修改文件。上限 20 个文件，附一行 `[…N files elided…]`。LLM 摘要策略将其作为 `<files>` 标签追加（通过 `upsertFileOperations`）；snapcompact 则在其摘要模板内渲染为一个 `FILES` 段。

```xml
<files>
# packages/agent/src/compaction/
compaction.ts (Read)
utils.ts (RW)
## prompts/
file-operations.md (Write)
</files>
```

旧版本写入的摘要中的旧式 `<read-files>`/`<modified-files>` 标签会在重新追加前（连同 `<files>`）被剥离，因此旧摘要在下一次压缩时自我修复。

### 持久化与重载

摘要生成（或 hook 提供的摘要）之后，agent 会话：

1. 用 `appendCompaction(...)` 追加 `CompactionEntry`；handoff 方法在同一会话上把生成的文档作为条目摘要提交。
2. 通过 `buildDisplaySessionContext()` 从活动叶子重建显示上下文。
3. 用重建的上下文替换活动的 agent 消息。
4. 从重建的分支同步活动 todo 阶段，并关闭历史被重写的 provider 会话。
5. 发出 `session_compact` hook 事件。

## 分支摘要流水线

分支摘要绑定到树导航，而非 token 溢出。

### 触发

在 `navigateTree(...)` 期间：

1. 用 `collectEntriesForBranchSummary(...)` 从旧叶子到公共祖先计算被放弃的条目。
2. 如果调用方要求摘要（`options.summarize`），在切换叶子前生成摘要。
3. 如果摘要存在，用 `branchWithSummary(...)` 将其附加到导航目标。

运维上这通常由 `/tree` 流程在 `branchSummary.enabled` 启用时驱动。

### 分支切换形态（图示）

```text
Tree before navigation:

         ┌─ B ─ C ─ D (old leaf, being abandoned)
    A ───┤
         └─ E ─ F (target)

Common ancestor: A
Entries to summarize: B, C, D

After navigation with summary:

         ┌─ B ─ C ─ D (abandoned branch, unchanged)
    A ───┤
         └─ E ─ F ─ [summary of B,C,D] (new leaf)
```

### 准备与 token 预算

`generateBranchSummary(...)` 按如下计算预算：

- `tokenBudget = model.contextWindow - branchSummary.reserveTokens`

`prepareBranchEntries(...)` 然后：

1. 第一轮：从所有被摘要的条目收集累积文件操作，包括先前 pi 生成的 `branch_summary` 细节。
2. 第二轮：从最新向最旧遍历，添加消息直到达到 token 预算。
3. 优先保留近期上下文。
4. 为连续性，仍可能在预算边缘附近包含大型摘要条目。

在分支摘要输入期间，compaction 条目作为消息（`compactionSummary`）被包含。

### 摘要生成与持久化

分支摘要：

1. 转换并序列化选定的消息。
2. 包裹在 `<conversation>` 中。
3. 若提供了自定义指令则使用之，否则用 `branch-summary.md`。
4. 以 `SUMMARIZATION_SYSTEM_PROMPT` 调用摘要模型。
5. 前置 `branch-summary-preamble.md`。
6. 追加文件操作标签。

结果作为 `BranchSummaryEntry` 存储，带可选细节（`readFiles`、`modifiedFiles`）。

## 扩展与 hook 触点

### `session_before_compact`

压缩前 hook。

可以：

- 取消压缩（`{ cancel: true }`）
- 提供完整的自定义压缩载荷（`{ compaction: CompactionResult }`）

hook 的 `customInstructions` 只携带公开的用户焦点。内部摘要器指引——目前是 plan-mode 的 "Approve and compact context" 提炼提示——通过 `CompactOptions` 上单独的 `internalGuidance` 通道传递，只到达原生摘要，从不到达此 hook 或 `session.compacting`；当两者都设置时，摘要器使用 `internalGuidance`，而 hook 仍看到公开的 `customInstructions`（issue #4359）。

### `session.compacting`

默认压缩的提示/上下文自定义 hook。

可以返回：

- `prompt`（覆盖基础摘要提示）
- `context`（注入 `<additional-context>` 的额外上下文行）
- `preserveData`（存储在压缩条目上）

### `session_compact`

压缩后通知，带保存的 `compactionEntry` 和 `fromExtension` 标志。

### `session_before_tree`

在默认分支摘要生成之前的树导航时运行。

可以：

- 取消导航
- 提供自定义 `{ summary: { summary, details } }`，在用户要求摘要时使用

### `session_tree`

导航后事件，暴露新/旧叶子及可选摘要条目。

## 运行时行为与失败语义

- 手动压缩会先中止当前的 agent 操作。
- `abortCompaction()` 取消手动压缩、自动压缩和 handoff 生成控制器。
- 自动压缩为 UI/状态更新发出开始/结束会话事件。
- 自动压缩可以尝试多个模型候选并重试瞬态失败；长重试延迟时，若有其他候选可用则优先切换。
- 溢出错误被排除在通用重试路径之外，因为它们由上下文升级/压缩处理。
- 如果自动压缩失败：
  - 溢出路径发出 `Context overflow recovery failed: ...`
  - 不完整输出路径发出 `Incomplete response recovery failed: ...`
  - 阈值/空闲路径发出 `Auto-compaction failed: ...`
- 分支摘要可通过中止信号（如 Escape）取消，返回已取消/中止的导航结果。

## 设置与默认值

来自 `settings-schema.ts`：

- `compaction.enabled` = `true`
- `compaction.methodOrder` = `["remote", "snapcompact", "handoff", "shake", "soft"]`。`remote` 在可用时使用 provider 原生的 OpenAI 兼容 server 压缩；不可用或失败的方法前进到下一个偏好。
- `compaction.asyncEnabled` = `true`。异步（投机）压缩：当上下文进入阈值前区间 `[threshold − lead, threshold)`（lead = `clamp(threshold × 0.125, 8192, 32000)`）时，维护基于分支快照为第一个配置的 LLM 支持方法（`remote`、`handoff` 或 `soft`）启动后台摘要，用一个侧会话 id 与活动 turn 隔离。当实际跨越阈值时，已备好的结果被立即提交，隐藏摘要延迟；快照之后的 turn 原样追加在摘要之后。当分支前缀变化（新压缩、重置边界、`/tree` 导航）、provider 原生重放载荷不再被活动模型可读，或上下文自计算起增长超过 `keepRecentTokens` 时（新的投机会取代它），已备好的结果被丢弃。当扩展注册了 `session_before_compact` 时跳过投机。投机运行时状态行会脉冲显示自动压缩图标，结果备好时以强调色保持。
- `compaction.reserveTokens` 默认未设置。压缩层通常施加 `16384` token 下限及至少上下文窗口的 15%；在小窗口上该默认不现实时，预算检查使用 15% 的比例保留。显式配置的保留会被尊重。
- `compaction.keepRecentTokens` = `20000`
- `compaction.autoContinue` = `true`
- `compaction.midTurnEnabled` = `true`
- `compaction.handoffSaveToDisk` = `false`
- `handoff` 方法通过活动缓存侧请求流水线生成 handoff 文档，并将其作为压缩条目提交到当前会话（不创建新会话）；`/handoff` 手动做同样的事。
- `compaction.remoteEndpoint` = `undefined`
- `compaction.remoteStreamingV2Enabled` = `true`
- `compaction.v2RetainedMessageBudget` = `64000`
- `compaction.thresholdPercent` = `-1` 且 `compaction.thresholdTokens` = `-1`；正的固定 token 上限优先于百分比，否则使用基于保留的阈值。
- `compaction.idleEnabled` = `false`
- `compaction.idleThresholdTokens` = `200000`
- `compaction.idleTimeoutSeconds` = `300`
- `compaction.supersedeReads` = `true`
- `compaction.dropUseless` = `true`
- `snapcompact.systemPrompt` = `"none"`（`"agents-md"` 和 `"all"` 选择加入瞬态 system-prompt 图像化）
- `snapcompact.toolResults` = `false`（大型历史工具结果的瞬态图像化）
- `snapcompact.shape` = `"auto"`
- `branchSummary.enabled` = `false`
- `branchSummary.reserveTokens` = `16384`

这些值在运行时由 `AgentSession`、`SessionMaintenance` 以及压缩/分支摘要模块消费。
