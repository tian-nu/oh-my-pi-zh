# retain

> 通过当前生效的长期记忆后端存储持久性事实。

## 源码
- 入口：`packages/coding-agent/src/tools/memory-retain.ts`
- 面向模型的 prompt：`packages/coding-agent/src/prompts/tools/retain.md`
- Hindsight 协作模块：
  - `packages/coding-agent/src/hindsight/state.ts` — 逐会话队列、flush、自动 retain。
  - `packages/coding-agent/src/hindsight/backend.ts` — 会话引导、prompt 注入、子代理别名。
  - `packages/coding-agent/src/hindsight/bank.ts` — bank id 派生、tag 作用域、首次使用的 bank/mission 设置。
  - `packages/coding-agent/src/hindsight/client.ts` — HTTP `retain` / `retainBatch` 调用。
  - `packages/coding-agent/src/hindsight/content.ts` — retention transcript 塑形、memory-tag 剥离。
  - `packages/coding-agent/src/hindsight/mental-models.ts` — bank 作用域的 mental-model 种子与缓存渲染。
  - `packages/coding-agent/src/hindsight/seeds.json` — 内置 mental-model 种子定义。
  - `packages/coding-agent/src/hindsight/transcript.ts` — 为自动 retain 提取 user/assistant 轮次。
- Mnemopi 协作模块：
  - `packages/coding-agent/src/mnemopi/backend.ts` — 本地后端引导、prompt 注入、子代理别名、enqueue/clear。
  - `packages/coding-agent/src/mnemopi/state.ts` — 作用域 recall/retain 状态与本地写入。
  - `packages/coding-agent/src/mnemopi/config.ts` — 本地 SQLite 路径、bank、作用域、provider 设置。
  - `packages/mnemopi/src/core/memory.ts` — `remember(...)` 使用的本地记忆运行时。

## 注册 / 可见性
- 工具元数据：`approval = "read"`、`strict = true`、`loadMode = "discoverable"`，尽管成功调用会入队或执行记忆写入。
- 该工具仅在 `memory.backend = "hindsight"` 或 `"mnemopi"` 时注册；对 `"off"` 与 `"local"` 不注册。
- 在带显式工具列表的不受限会话中，注册会自动包含任一受支持后端共享的 `recall`/`retain`/`reflect` 集合。受限列表不会被放宽。
- 在普通 `tools.xdev` 会话中，可发现的 built-in 工具可能以 `xd://retain` 形式呈现；显式请求的工具保持顶层。
- 执行返回一个最终结果，且没有进度回调或取消参数。

## 输入

| 字段 | 类型 | 必填 | 描述 |
|---|---|---:|---|
| `items` | `Array<{ content: string; context?: string }>` | 是 | 要存储的一条或多条记忆。`minItems: 1`。每条 item 必须自包含；`context` 是每条 item 可选的来源说明。 |

## 输出
输出取决于当前生效的 `memory.backend`。

Hindsight：
- `content[0].type = "text"`
- `content[0].text = "<count> memory queued."` 或 `"<count> memories queued."`
- `details = { count: number }`
- 写入在工具返回前不会确认。队列稍后 flush；flush 失败会发出会话警告通知，不会返回给模型。

Mnemopi：
- `content[0].type = "text"`
- `content[0].text = "<count> memory stored."` 或 `"<count> memories stored."`
- `details = { count: number }`
- 该工具同步执行本地写入，但 `rememberScoped(...)` 会捕获每次写入失败并返回 `undefined`；`retain` 忽略该返回值，仍报告请求的数量。因此该响应不是逐 item 的持久化回执。

## 流程
1. 当 `memory.backend` 为 `"hindsight"` 或 `"mnemopi"` 时，`MemoryRetainTool.createIf(...)` 暴露该工具。
2. `execute(...)` 重新读取 `memory.backend` 并分派到对应的会话状态。
3. 若后端为 `mnemopi`：
   - 获取 `session.getMnemopiSessionState()`，若后端未启动则抛错；
   - 对每条 item，以 `source: "coding-agent-retain"`、`importance: 0.75`、`scope: "bank"`、`extract: true`、`extractEntities: true`、`veracity: "tool"`、`memoryType: "fact"` 以及元数据 `{ session_id, cwd, context, tool: "retain" }` 调用 `state.rememberScoped(item.content, ...)`；
   - 写入进入作用域内的 retain bank；同一会话中完全重复的内容会更新 Mnemopi core 中已有的 working-memory 行。
4. 若后端为 `hindsight`：
   - 获取 `session.getHindsightSessionState()`，若后端未启动则抛错；
   - 每条输入 item 交给 `HindsightSessionState.enqueueRetain(...)`；
   - `HindsightRetainQueue.enqueue(...)` 追加该 item：当队列达到 `RETAIN_FLUSH_BATCH_SIZE` 时立即 flush，否则为 `RETAIN_FLUSH_INTERVAL_MS` 启动一个防抖定时器；
   - flush 时，`HindsightRetainQueue.#doFlush(...)` 校验所有权，通过 `ensureBankExists(...)` 尽力确保 bank 存在，把 items 映射为带 `context ?? config.retainContext`、`metadata.session_id` 与 bank 作用域 tag 的 `MemoryItemInput`，然后发送一次异步 `retainBatch(...)` 请求。

## 模式 / 变体
- Hindsight 工具路径：仅排队批量写入。
- Mnemopi 工具路径：直接向作用域内的 retain bank 本地 `remember(...)`。
- `computeBankScope(...)` 的 Hindsight bank 作用域：
  - `global` — 一个共享 bank，无项目 tag。
  - `per-project` — bank id 追加 `-<project label>`，其中 label 是 git 主 checkout 根目录的 basename（仓库外为 cwd basename）。
  - `per-project-tagged` — 共享 bank，并在保留的记忆上打 `project:<project label>` tag。
- `computeMnemopiBankScope(...)` 的 Mnemopi bank 作用域：
  - `global` — retain 与 recall 使用共享 bank。
  - `per-project` — retain 与 recall 使用由绝对 cwd basename 加上该绝对 cwd 的哈希派生出的项目 bank。
  - `per-project-tagged` — retain 写入 cwd 派生的项目 bank；recall 同时读取共享 bank。
  - 按项目 recall 还可能纳入安全的旧 bank，条件是其中存储的 working-memory 行全部匹配当前 cwd；扫描上限为 64 个候选 bank 目录。
- 会话作用域：
  - 工具调用的 retain 是当前后端内的逐会话工作；
  - 持久化的 Hindsight 记忆是跨会话的服务端 bank 数据；
  - 持久化的 Mnemopi 记忆是本地 SQLite 数据；
  - 对两种受支持后端，子代理都别名化父级记忆状态。

## 副作用
- 文件系统
  - Hindsight：对保留的记忆无。不写入本地记忆文件。
  - Mnemopi：写入 `mnemopi.dbPath` 下的本地 SQLite，默认位于 agent memories 目录之下（`mnemopi/mnemopi.db`），需要时每个作用域 bank 一个数据库文件。
- 网络
  - Hindsight：通过 `retainBatch(...)` 发送 `POST /v1/default/banks/{bank_id}/memories`，并在每个会话状态对每个 bank 首次写入前通过 `ensureBankExists(...)` 可选发送 `PUT /v1/default/banks/{bank_id}`（该集合随主会话状态创建，并与子代理别名共享）。
  - Mnemopi：除非配置的 embedding 或 LLM provider 在提取期间发起调用，否则无。
- 会话状态
  - Hindsight：追加到内存中的 `HindsightRetainQueue`，包含 `metadata.session_id`，并为子代理共享父级状态。
  - Mnemopi：通过会话作用域内的 `Mnemopi` 实例写入，包含 `session_id`、`cwd` 与可选的 `context`，并与子代理共享作用域资源。
- 用户可见 prompt / 交互式 UI
  - Hindsight 异步 flush 失败会发出 `session.emitNotice("warning", ...)`；模型不会被告知。
  - Mnemopi 写入失败由 `rememberInScope(...)` 记录日志；工具响应不暴露逐 item 的失败。
- 后台工作 / 取消
  - Hindsight flush 稍后在防抖定时器或队列大小阈值触发时运行；后端的 `enqueue(...)` 与 `clear(...)` 会显式将其排空。flush 时的会话所有权不匹配会被记录日志并丢弃该批次。
  - Mnemopi 的事实/实体提取与 embedding 可能在同步行写入后继续。后端的 `enqueue(...)` 请求完整 consolidation；后端 clear 会在删除其数据库文件之前释放作用域实例。
  - `retain.execute()` 本身不处理 abort signal。

## 限制与上限
- 输入 schema 要求 `items.length >= 1`；item 字符串没有 schema 级的最小长度。
- 工具可用性要求 `memory.backend` 为 `"hindsight"` 或 `"mnemopi"`；`memory.backend` 默认为 `"off"`。
- Hindsight 队列 flush 阈值：`RETAIN_FLUSH_BATCH_SIZE = 16`。
- Hindsight 队列防抖：`RETAIN_FLUSH_INTERVAL_MS = 5_000`。
- Hindsight 队列写入使用 `retainBatch(..., { async: true })`；客户端请求超时默认为 `hindsight.retainTimeoutMs = 60_000`，但不等待服务端 consolidation。
- Hindsight 自动 retain 设置：
  - `hindsight.autoRetain = true`
  - `hindsight.retainEveryNTurns = 3`
  - `hindsight.retainOverlapTurns = 2`
  - `hindsight.retainContext = "omp"`
  - `hindsight.retainMode = "full-session"`
- Mnemopi retain 设置：
  - `mnemopi.autoRetain = true`
  - `mnemopi.retainEveryNTurns = 4`
  - `mnemopi.scoping = "per-project"`

## 错误
- 当 `memory.backend == "mnemopi"` 但不存在任何状态时，抛出 `Mnemopi backend is not initialised for this session.`。
- 当 `memory.backend == "hindsight"` 但不存在任何状态时，抛出 `Hindsight backend is not initialised for this session.`。
- 在已释放状态上入队会抛出 `Hindsight retain queue is closed.`。
- Hindsight flush 时的 API 失败会被捕获、记录日志并转换为警告通知，而不是工具错误。
- Hindsight bank/mission 创建失败以 debug 级别记录日志并在 `ensureBankExists(...)` 中吞掉；后续写入仍会执行。
- Mnemopi `remember(...)` 失败会在 `MnemopiSessionState.rememberInScope(...)` 中被捕获、记录日志，不会重新抛给工具调用方。

## 备注
- Hindsight 存储在服务端。`hindsightBackend.clear(...)` 会排空本地队列、清除本地缓存/状态，并警告上游删除必须在 Hindsight UI 或 `deleteBank` 中完成。
- Mnemopi 存储是本地 SQLite。`mnemopiBackend.clear(...)` 会删除每个活动作用域 bank 的数据库文件，若会话仍处于活动状态则随后重新水合后端。
- Hindsight 自动 retain 与本文档工具使用同一个 bank 但走不同路径：`retainSession(...)` 提取纯 user/assistant transcript、剥离 `<memories>` / `<mental_models>` 块，并调用单条 `retain(...)`。
- Mnemopi 自动 retain 以 `source: "coding-agent-transcript"`、`importance: 0.65`、`veracity: "unknown"`、`memoryType: "episode"` 存储准备好的 transcript。
- Hindsight mental-model 引导位于共享后端：`HindsightSessionState.runMentalModelLoad(...)` 可选地解析种子、创建缺失的模型，然后缓存渲染后的 `<mental_models>` 块用于 prompt 注入。
- 内置的 Hindsight 种子是 `user-preferences`、`project-conventions` 与 `project-decisions`。`projectTagged: true` 的种子继承活动作用域的 retain tag；未打 tag 的种子读取整个 bank。
- Hindsight mental-model 默认值：`hindsight.mentalModelsEnabled = true`、`hindsight.mentalModelAutoSeed = true`、`hindsight.mentalModelRefreshIntervalMs = 5 * 60 * 1000`、`hindsight.mentalModelMaxRenderChars = 16_000`。首轮加载等待上限为 `MENTAL_MODEL_FIRST_TURN_DEADLINE_MS = 1500`。
- Hindsight 种子生命周期是仅创建。修改 `packages/coding-agent/src/hindsight/seeds.json` 不会改变已存在的服务端模型。
- `recall.md` 与 `reflect.md` 依赖相同的后端选择与作用域行为。
