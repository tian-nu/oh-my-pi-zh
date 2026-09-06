# reflect

> 基于当前生效的长期记忆后端综合生成回答。

## 源码
- 入口：`packages/coding-agent/src/tools/memory-reflect.ts`
- 面向模型的 prompt：`packages/coding-agent/src/prompts/tools/reflect.md`
- Hindsight 协作模块：
  - `packages/coding-agent/src/hindsight/bank.ts` — 尽力的首次使用 bank/mission 设置（`ensureBankExists`）。
  - `packages/coding-agent/src/hindsight/state.ts` — 会话状态、共享 bank 作用域、recall/reflect 配置。
  - `packages/coding-agent/src/hindsight/client.ts` — HTTP `reflect` 调用与错误映射。
- Mnemopi 协作模块：
  - `packages/coding-agent/src/mnemopi/state.ts` — 作用域本地 recall 与上下文格式化。
  - `docs/tools/retain.md` — 共享后端、存储、作用域与 mental-model 行为。

## 注册 / 可见性
- 工具元数据：`approval = "read"`、`strict = true`、`loadMode = "discoverable"`。
- 该工具仅在 `memory.backend = "hindsight"` 或 `"mnemopi"` 时注册；对 `"off"` 与 `"local"` 不注册。
- 在带显式工具列表的不受限会话中，注册会自动包含共享的 `recall`/`retain`/`reflect` 集合。受限列表不会被放宽。
- 在普通 `tools.xdev` 会话中，可发现的 built-in 工具可能以 `xd://reflect` 形式呈现；显式请求的工具保持顶层。
- 执行是单次性的，且不发出进度更新。

## 输入

| 字段 | 类型 | 必填 | 描述 |
|---|---|---:|---|
| `query` | `string` | 是 | 要从长期记忆中回答的问题。 |
| `context` | `string` | 否 | 额外指引。Hindsight 将其作为 `context` 发送；Mnemopi 将去空白后的 context 以 `Additional context:` 追加到 recall query 之后。 |

## 输出
返回单次性的工具结果。

Hindsight：
- `content[0].type = "text"`
- `content[0].text = response.text?.trim() || "No relevant information found to reflect on."`
- `details = {}`
- 该工具直接返回 Hindsight 服务器综合出的文本；不暴露原始 recall 命中结果。

Mnemopi：
- 若无作用域 recall 结果：`content[0].text = "No relevant information found to reflect on."`
- 否则：`content[0].text = "Based on recalled memories:\n\n<formatted context>"`
- `details = {}`
- 本地路径执行 recall 加格式化；不调用综合模型或独立的综合端点。因此其结果可能是原始 recall 上下文，而非融合后的回答。

## 流程
1. 当 `memory.backend` 为 `"hindsight"` 或 `"mnemopi"` 时，`MemoryReflectTool.createIf(...)` 暴露该工具。
2. `execute(...)` 在 `untilAborted(...)` 下运行。
3. 若后端为 `mnemopi`：
   - 读取 `session.getMnemopiSessionState()`，若后端未启动则抛错；
   - 若 `context` 含非空白内容，则以 `<query>\n\nAdditional context:\n<context>` 进行 recall；否则以 `query` 进行 recall；
   - 使用与 `recall` 相同的本地作用域与合并行为调用 `state.recallResultsScoped(...)`；
   - 若存在结果，则通过 `state.formatContextScoped(...)` 渲染，并加上 `Based on recalled memories:` 前缀。
4. 若后端为 `hindsight`：
   - 读取 `session.getHindsightSessionState()`，若后端未启动则抛错；
   - 使用当前 `bankId`、配置与会话状态的 `banksSet` 调用 `ensureBankExists(...)`；
   - `ensureBankExists(...)` 对每个会话状态的每个 bank 尽力 `PUT` 一次 `/v1/default/banks/{bank_id}`（`createBank`），可带 `reflect_mission` / `retain_mission`；失败会被吞掉；
   - 以 `query`、可选的 `context`、配置的 recall 预算与 bank 作用域 tag 过滤器调用 `state.client.reflect(...)`；
   - `HindsightApi.reflect(...)` POST `/v1/default/banks/{bank_id}/reflect`，当调用方省略预算时默认其预算为 `"low"`；本工具总是传入配置的预算；
   - 空或仅空白的响应会被替换为 `No relevant information found to reflect on.`
5. 后端失败以 `logger.warn("reflect failed", ...)` 记录日志，并在需要时作为 `Error` 实例重新抛出。

## 模式 / 变体
- Hindsight 工具路径：一次远程 reflect 请求，可选由 `context` 聚焦。
- Mnemopi 工具路径：一次本地作用域 recall，随后进行上下文格式化。
- Hindsight bank 作用域：
  - `global` — 无 tag 过滤器。
  - `per-project` — 每个项目 label 一个独立 bank id（git 主 checkout 根目录 basename；仓库外为 cwd basename）。
  - `per-project-tagged` — 共享 bank id 加 `project:<project label>` 过滤器，`tagsMatch = "any"`。
- Mnemopi bank 作用域：
  - `global` — 读取共享 bank。
  - `per-project` — 读取由绝对 cwd basename 加上该 cwd 哈希派生的 bank。
  - `per-project-tagged` — 读取 cwd 派生的项目 bank 与共享 bank，然后合并结果。
  - 按项目模式还可能包含启动时发现的、与 cwd 匹配的安全旧 bank。
- 会话作用域：读取跨会话的记忆数据，但不持久化本地输出。子代理别名使用父级的后端作用域。

## 副作用
- 网络
  - Hindsight：来自 `ensureBankExists(...)` 的可选 `PUT /v1/default/banks/{bank_id}`，随后 `POST /v1/default/banks/{bank_id}/reflect`。
  - Mnemopi：除非本地运行时在 recall 期间使用配置的 embedding 或 LLM provider，否则无。
- 会话状态
  - 仅读取会话持有的后端作用域与配置。不更新 `lastRecallSnippet`、Hindsight mental-model 缓存或 retain 队列。
- 后台工作 / 取消
  - 若工具调用 signal 被取消，则通过 `untilAborted(...)` 中止。

## 限制与上限
- 工具可用性要求 `memory.backend` 为 `"hindsight"` 或 `"mnemopi"`；`memory.backend` 默认为 `"off"`。
- 工具级参数：仅 `query` 必填；`context` 可选。两者都是普通字符串，无 schema 级最小长度。
- Hindsight 预算来自 `hindsight.recallBudget`，默认为 `"mid"`。
- 此处 Hindsight `reflect` 没有客户端 token 上限参数；其请求截止时间默认为 `hindsight.reflectTimeoutMs = 120_000`。
- Hindsight bank 初始化跟踪每个会话状态至多 `MISSION_SET_CAP = 10_000` 个 bank id，之后丢弃排序集合的一半。
- Mnemopi 结果数量由 `mnemopi.recallLimit` 限制，默认为 `8`，运行时会钳制到至少 1；每条 recall 内容预览默认上限为 500 字符。

## 错误
- 当 `memory.backend == "mnemopi"` 但不存在任何状态时，抛出 `Mnemopi backend is not initialised for this session.`。
- 当 `memory.backend == "hindsight"` 但不存在任何状态时，抛出 `Hindsight backend is not initialised for this session.`。
- Hindsight HTTP、fetch 与超时失败会变成 `HindsightError`；HTTP 错误在可用时包含 `statusCode` 与解析后的 `details`。
- Hindsight `ensureBankExists(...)` 失败以 debug 级别记录日志并对调用方隐藏；只有后续 reflect 请求可能可见地失败。
- Mnemopi recall 对每个目标捕获失败并记录日志。健康的目标仍会贡献结果；若所有尝试的目标都失败，则抛出原始错误或一个多 bank `AggregateError`，而不会转换为无信息文本。
- 工具捕获到的非 `Error` 失败在重新抛出前会被规范化为 `new Error(String(err))`。

## 备注
- 共享后端细节见 `docs/tools/retain.md`：存储、子代理别名、bank 作用域、种子 mental-model 与 prompt 注入。
- Hindsight `reflect` 不直接读取缓存的 `<mental_models>` 块。它基于 bank 内容查询 Hindsight 服务器。同一会话可能另行在 developer 指令中拥有 mental-model 上下文。
- Hindsight reflect 与 retain mission 是 bank 级服务端设置，而非逐请求载荷。该工具只在 reflect 前尽力确保它们。
- Mnemopi `reflect` 是本地 recall 加格式化。它不实现通用面向模型的 `reflect` prompt 所承诺的综合。
