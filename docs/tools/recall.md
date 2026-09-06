# recall

> 在当前生效的长期记忆后端中搜索并返回匹配的记忆。

## 源码
- 入口：`packages/coding-agent/src/tools/memory-recall.ts`
- 面向模型的 prompt：`packages/coding-agent/src/prompts/tools/recall.md`
- Hindsight 协作模块：
  - `packages/coding-agent/src/hindsight/state.ts` — 会话状态、recall 查询默认值与 prompt 侧自动 recall。
  - `packages/coding-agent/src/hindsight/content.ts` — 结果格式化与 UTC 时间戳格式化。
  - `packages/coding-agent/src/hindsight/client.ts` — HTTP `recall` 调用与错误映射。
  - `packages/coding-agent/src/hindsight/bank.ts` — bank id 与 tag 过滤器作用域。
- Mnemopi 协作模块：
  - `packages/coding-agent/src/mnemopi/state.ts` — 作用域本地 recall 与带 id 的结果格式化。
  - `packages/coding-agent/src/mnemopi/config.ts` — 本地 bank 作用域与 recall 限制。
  - `docs/tools/retain.md` — 共享后端、存储、作用域与保留行为。

## 注册 / 可见性
- 工具元数据：`approval = "read"`、`strict = true`、`loadMode = "discoverable"`。
- 该工具仅在 `memory.backend = "hindsight"` 或 `"mnemopi"` 时注册；对 `"off"` 与 `"local"` 不注册。
- 在带显式工具列表的不受限会话中，注册会自动包含任一受支持后端共享的 `recall`/`retain`/`reflect` 集合。受限列表不会被放宽。
- 在普通 `tools.xdev` 会话中，可发现的 built-in 工具可能以 `xd://recall` 形式呈现；显式请求的工具保持顶层。
- 执行是单次性的。该工具不发出流式参数/结果更新。

## 输入

| 字段 | 类型 | 必填 | 描述 |
|---|---|---:|---|
| `query` | `string` | 是 | 自然语言搜索查询。该工具原样透传，唯一例外是 Mnemopi `per-project-tagged` 可能运行一次内部共享 bank 回退查询。 |

## 输出
返回单次性的工具结果。

存在匹配时：
- `content[0].type = "text"`
- `content[0].text = "Found <n> relevant memory/memories (as of YYYY-MM-DD HH:MM UTC):\n\n<bullet list>"`
- `details = {}`

Hindsight 的 bullet 格式来自 `formatMemories(...)`：
- 每条 bullet 形如 `- <text> [<type>] (<mentioned_at>)`；类型与时间戳后缀仅在这些字段存在时出现。

Mnemopi 的 bullet 格式来自 `formatScopedRecallWithIds(...)`：
- 每条 bullet 形如 `- <content> (id: <id>) [<source>] (<YYYY-MM-DD>) c:<score>`；不可用的 id 渲染为 `(id unavailable)`，source、date 与 score 缺失时省略。
- Mnemopi 的 recall 内容默认是上限 500 字符的预览（`RECALL_CONTENT_PREVIEW_CHARS` / `RecallOptions.contentPreviewChars`，位于 `packages/mnemopi/src/core/beam/recall.ts`；`0` 或负数上限禁用截断——显式工具路径使用默认值）。被截断的预览以 `…` 结尾；整体执行 `memory_edit update` 之前，请用 `read memory://<id>` 获取完整行。
- 尽管内部 recall 行带有 `truncated` 与 `full_length`，该工具仍返回带 `details = {}` 的格式化文本，不暴露这些字段。

无匹配时：
- `content[0].text = "No relevant memories found."`
- `details = {}`
- `useless = true`，使调用方/渲染器可以把结果视为不贡献上下文的输出。

## 流程
1. 当 `memory.backend` 为 `"hindsight"` 或 `"mnemopi"` 时，`MemoryRecallTool.createIf(...)` 暴露该工具。
2. `execute(...)` 在 `untilAborted(...)` 下包装该操作。
3. 若后端为 `mnemopi`：
   - 读取 `session.getMnemopiSessionState()`，若后端未启动则抛错；
   - 调用 `state.recallResultsScoped(params.query)`；
   - 作用域 recall 用 `recallEnhanced(query, recallLimit, { includeFacts: true, channelId: bank })` 查询每个已解析的 recall bank，按 id/内容合并并去重结果、排序，然后截断到 `recallLimit`；
   - 按项目模式可能纳入安全的旧 bank，条件是其中所有 working-memory 行都属于当前绝对 cwd；启动扫描上限为 64 个候选 bank 目录；
   - 在 `per-project-tagged` 下，共享 bank 可能收到一次额外的回退查询，其中项目 bank 的字面 token 被去除，以便宽泛的全局记忆仍能匹配；
   - 结果带 id 格式化，供之后的整行读取与 `memory_edit` 使用。
4. 若后端为 `hindsight`：
   - 读取 `session.getHindsightSessionState()`，若后端未启动则抛错；
   - 以 `bankId`、query、配置的 `budget`、`maxTokens`、`types` 以及 bank 作用域的 tag 过滤器调用 `state.client.recall(...)`；
   - `HindsightApi.recall(...)` 向 `/v1/default/banks/{bank_id}/memories/recall` 发 POST；
   - 结果通过 `formatMemories(...)` 格式化为纯文本列表。
5. 后端失败以 `logger.warn("recall failed", ...)` 记录日志，并在需要时作为 `Error` 实例重新抛出。

## 模式 / 变体
- 工具路径：显式的仅 query recall。它不根据最近轮次组合上下文。
- 后端自动 recall 在 `HindsightSessionState.beforeAgentStartPrompt(...)` / `maybeRecallOnAgentStart(...)` 与 `MnemopiSessionState.beforeAgentStartPrompt(...)` / `maybeRecallOnAgentStart(...)` 中拥有更丰富的查询组合路径。
- Hindsight bank 作用域：
  - `global` — 无 tag 过滤器。
  - `per-project` — 每个项目 label 一个独立 bank id（git 主 checkout 根目录 basename；仓库外为 cwd basename）。
  - `per-project-tagged` — 共享 bank id 加 `project:<project label>` 过滤器，`tagsMatch = "any"`，因此打了项目 tag 与未打 tag 的全局记忆都能浮现。
- Mnemopi bank 作用域：
  - `global` — recall 读取共享 bank。
  - `per-project` — recall 读取由绝对 cwd basename 加上该绝对 cwd 哈希派生的 bank。
  - `per-project-tagged` — recall 读取 cwd 派生的项目 bank 与共享 bank，然后合并结果。
  - 按项目模式还可能读取可安全识别的旧 cwd-only bank，以恢复在更早的 git-root 派生方案下创建的记忆。
- 会话作用域：读取跨会话的记忆数据，使用活动会话的缓存配置与作用域。子代理别名使用父级的后端作用域。

## 副作用
- 网络
  - Hindsight：`POST /v1/default/banks/{bank_id}/memories/recall`。
  - Mnemopi：除非配置的本地运行时 provider 在 recall 期间执行 embedding/LLM 工作，否则无。
- 会话状态
  - 显式工具路径成功时无。与后端自动 recall 不同，该工具不更新 `lastRecallSnippet`，也不刷新系统 prompt。
- 后台工作 / 取消
  - 若工具调用 signal 被取消，则通过 `untilAborted(...)` 中止。

## 限制与上限
- 工具可用性要求 `memory.backend` 为 `"hindsight"` 或 `"mnemopi"`；`memory.backend` 默认为 `"off"`。
- Hindsight 客户端对原始 `HindsightApi.recall(...)` 的默认预算为 `"mid"`；该工具会从配置覆盖。
- Hindsight recall 设置：
  - `hindsight.recallBudget = "mid"`
  - `hindsight.recallMaxTokens = 1024`
  - `hindsight.recallTypes = ["world", "experience"]`
  - `hindsight.recallTimeoutMs = 30_000`
- Mnemopi recall 设置：
  - `mnemopi.recallLimit = 8`（运行时钳制到至少 1）
  - `mnemopi.scoping = "per-project"`
  - 每条结果的内容预览上限为 500 字符
- 显式工具路径不应用 `hindsight.recallContextTurns`、`hindsight.recallMaxQueryChars`、`mnemopi.recallContextTurns` 或 `mnemopi.recallMaxQueryChars`；这些上限只影响后端自动 recall 的查询组合。

## 错误
- 当 `memory.backend == "mnemopi"` 但不存在任何状态时，抛出 `Mnemopi backend is not initialised for this session.`。
- 当 `memory.backend == "hindsight"` 但不存在任何状态时，抛出 `Hindsight backend is not initialised for this session.`。
- Hindsight HTTP、fetch 与超时失败会变成 `HindsightError`；HTTP 错误在可用时包含 `statusCode` 与解析后的 `details`。
- Mnemopi recall 对每个目标捕获失败并记录日志。健康的目标仍会贡献结果；若每个尝试的目标都失败，则抛出原始错误（单目标）或带 bank 详情的 `AggregateError`（多目标），而不会转换为空结果。
- 工具捕获到的非 `Error` 失败在重新抛出前会被规范化为 `new Error(String(err))`。

## 备注
- 共享后端细节见 `docs/tools/retain.md`：存储、子代理别名、bank 作用域、mission 设置与 mental-model 行为。
- 该工具不会获取 Hindsight mental model。它们可能已经存在于 agent 的 developer 指令中，因为后端会把 `<mental_models>` 块与 recall 结果分开缓存。
- Mnemopi 的 developer 指令可能包含来自自动 recall 的 `<memories>` 块；本显式工具不更新该块。
- 该工具返回记忆命中结果，不会在它们之间做综合。远程 Hindsight 综合请用 `reflect`；Mnemopi 的 `reflect` 变体是本地 recall 加格式化。
