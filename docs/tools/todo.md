# todo

> 对会话 todo 列表应用一次变更，并返回文本摘要加完整的 phase/任务状态。

## Source
- 入口：`packages/coding-agent/src/tools/todo.ts`
- 面向模型的 prompt：`packages/coding-agent/src/prompts/tools/todo.md`
- 主要协作者：
  - `packages/coding-agent/src/tools/index.ts` —— 注册工具、暴露会话 hooks、把关可用性。
  - `packages/coding-agent/src/modes/controllers/event-controller.ts` —— 工具完成时更新可见的 todo UI。
  - `packages/coding-agent/src/session/agent-session.ts` —— 存储缓存的 phases，会话恢复时剥离 done/dropped 任务，发出失败提醒。
  - `packages/coding-agent/src/modes/controllers/todo-command-controller.ts` —— `/todo` 命令路径、自定义条目持久化、transcript 提醒注入。
  - `packages/coding-agent/src/tools/render-utils.ts` —— 渲染器树的折叠预览上限。

## Inputs

params 对象**就是**单个 op——判别符及其字段位于顶层（没有 `ops` 数组包装）。

| Op | Required fields | Optional fields | Effect |
| --- | --- | --- | --- |
| `init` | `list` **or** flat `items` | `phase` (names the phase for the flat `items` form; defaults to `Tasks`) | 整体替换列表——使用 `list` 时采用给定的 phases；使用扁平 `items` 数组时合成一个 phase。规范化前每个新任务都从 `pending` 开始。 |
| `start` | `task` | None | 把一个任务标记为 `in_progress`；其他任何 `in_progress` 任务降级为 `pending`。 |
| `done` | `task` or `phase` or neither | None | 把目标任务、阶段或全部任务标记为 `completed`。 |
| `drop` | `task` or `phase` or neither | None | 把目标任务、阶段或全部任务标记为 `abandoned`。 |
| `block` | `task` or `phase` | `reason` | 把可操作的目标任务标记为 `blocked`；completed/abandoned 任务保持关闭。`reason` 中的空白被折叠为一行。 |
| `unblock` | `task` or `phase` | None | 把被阻塞的目标任务恢复为 `pending` 并清除其阻塞备注。 |
| `rm` | `task` or `phase` or neither | None | 移除目标任务、清空该阶段的任务列表，或清空所有任务列表。 |
| `append` | `phase`, `items` | None | 向某个阶段追加新的 `pending` 任务；阶段缺失时创建它。 |
| `view` | None | None | 回显当前列表。`view` 调用是只读的：不规范化、不写入状态。 |

### Fields

| 字段 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `op` | `"init" \| "start" \| "done" \| "rm" \| "drop" \| "block" \| "unblock" \| "append" \| "view"` | Yes in the schema | 操作判别符。执行时，缺失的 op 只会为无歧义的 `list`/`items` 载荷修复（见 Flow）。 |
| `list` | `{ phase: string; items: string[] }[]` | For `init` (unless a flat `items` list is given) | 整体替换载荷。每个 `items` 数组有 `minItems: 1`。 |
| `task` | `string` | For `start`; for task-targeted `done`/`drop`/`block`/`unblock`/`rm` | 任务内容的精确匹配。 |
| `phase` | `string` | For `append`; for phase-targeted `done`/`drop`/`block`/`unblock`/`rm`; optional for a flat `init` | 阶段名的精确匹配；例外是 `append` 惰性创建缺失的阶段，扁平 `init` 合成一个阶段（默认 `Tasks`）。 |
| `items` | `string[]` | For `append`; or as a flat `init` payload | 要追加的任务，或扁平 `init` 的完整任务列表。按 op 的校验要求至少一个条目；不相关 op 上多余的空白数组在 schema 上有效且会被忽略。 |
| `reason` | `string` | No | `block` 的可选阻塞备注；规范化为单个去除首尾空白的行。 |

## Outputs
该工具返回单次完成的 `AgentToolResult`：

- `content`：一个文本部分，包含来自 `formatSummary(...)` 的摘要。
  - 无错误的空最终状态：`Todo list cleared.`（纯 `view` 调用为 `Todo list is empty.`）。
  - 非空最终状态：剩余条目列表、当前阶段进度，然后是按阶段的树。
  - 若 op 产生校验/运行时错误，摘要以 `Errors: ...` 开头，结果标记为 `isError: true`；变更被丢弃——返回与持久化的状态保持在调用前的列表。
- `details`：
  - `phases: TodoPhase[]`
  - `storage: "session" | "memory"`
  - `completedTasks?: TodoCompletionTransition[]`：当某任务在调用期间从非 completed 变为 `completed` 时出现
  - `op?: TodoOperation` 标识解析后的操作，包括后来产生 op 专属错误的变更；在 schema 校验失败与旧版 transcript 条目上缺失。

`TodoPhase` / `TodoItem` 状态模型：

- `TodoPhase`: `{ name: string, tasks: TodoItem[] }`
- `TodoItem`: `{ content: string, status: "pending" | "in_progress" | "completed" | "abandoned" | "blocked", blocker?: string }`

TUI 渲染器（`todoToolRenderer`）把调用与结果合并为一个 transcript 块，并把 phases 渲染为树。折叠的 transcript 预览把树条目上限设为 `PREVIEW_LIMITS.COLLAPSED_ITEMS`（`8`）。

## Flow
1. `TodoTool.execute(...)` 从 `session.getTodoPhases?.() ?? []`（`packages/coding-agent/src/tools/todo.ts`）克隆当前缓存的 phases。
2. `resolveTodoParams(...)` 校验原始的单 op 载荷。由于工具启用了 `lenientArgValidation`，它只会在形状无歧义时修复缺失的 `op`：非空 `list` 意味着 `init`；非空 `items` 加 `phase` 意味着 `append`；仅当不存在任何 phase 时，裸的非空 `items` 才意味着 `init`。有歧义的目标字段与其他所有 schema 失败都会返回 `Invalid todo arguments: ...`。
3. `applyParams(...)` 用 `applyEntry(...)` 应用解析后的 op。
4. 每个 op 都会变更工作中的 phase 数组：
   - `initPhases(...)` 从头重建列表。
   - `start` 按精确 `content` 解析任务，把所有其他 `in_progress` 任务降级为 `pending`，然后把目标标记为 `in_progress`。
   - `done` / `drop` 用 `getTaskTargets(...)` 锁定一个任务、一个阶段或全部任务。
   - `block` 需要任务或阶段目标。它只把 `pending`、`in_progress` 或已 `blocked` 的目标标记为 blocked，保留 completed/abandoned 任务；重复 block 可替换或清除备注。
   - `unblock` 需要任务或阶段目标，只把被阻塞的目标改为 `pending`。
   - `rm` 移除一个任务、清空某个阶段的 `tasks`，或清空所有阶段的 task 数组。
   - `appendItems(...)` 解析或创建目标阶段，并压入新的 `pending` 任务，除非相同任务内容已存在于任何位置。
5. 缺失的任务/阶段引用与 op 专属失败会记录进 `errors` 数组；任何错误都会在最后丢弃该 op 的变更。
6. 成功变更后，`normalizeInProgressTask(...)` 强制单一活动任务不变量：
   - 若多个任务为 `in_progress`，只有第一个保持活动，其余变为 `pending`；
   - 若没有 `in_progress` 任务，按阶段/任务顺序的第一个 `pending` 任务会被自动提升为 `in_progress`；
   - blocked 任务会被跳过，因此当所有未完成工作都被阻塞时，列表可以没有活动任务。
7. 仅当 op 未产生错误且不是 `view` 时，`execute(...)` 才用 `session.setTodoPhases?.(...)` 存储更新后的 phases；失败的 op 会被丢弃。存在 `session.getSessionFile()` 时 `storage` 为 `"session"`，否则为 `"memory"`。
8. `getCompletionTransitions(...)` 对比变更前与更新后的 phases（失败的调用与 `view` 调用跳过）；新完成的任务在 `details.completedTasks` 中返回。
9. details 在成功或 op 专属失败时包含解析后的 `op`，包括从被省略输入推断出的 op。无法通过 schema 校验的载荷会在拿到 op 之前返回。
10. agent 运行时在 `packages/coding-agent/src/session/agent-session.ts` 中监听 `todo` 工具结果；成功结果刷新缓存的 todos，失败结果注入一条隐藏的下轮提醒，告知模型在重试之前 todo 进度不可见。
11. event controller 在成功时用 `result.details.phases` 更新可见的 todo UI，出错时显示警告（`packages/coding-agent/src/modes/controllers/event-controller.ts`）。

## Modes / Variants
### State transitions

| Current status | `start` | `done` | `drop` | `block` | `unblock` | `rm` | `append` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `pending` | 目标变为 `in_progress` | `completed` | `abandoned` | `blocked` | 无变化 | 移除 | 新任务以 `pending` 进入 |
| `in_progress` | 目标保持 `in_progress`；非目标的活动任务变为 `pending` | `completed` | `abandoned` | `blocked` | 无变化 | 移除 | 状态不变 |
| `blocked` | 若被指定可设为 `in_progress` | `completed` | `abandoned` | 保持 blocked；备注可能改变 | 变 `pending`，清除备注 | 移除 | 状态不变 |
| `completed` | 若被指定可设回 `in_progress` | 保持 `completed` | 若被指定则变为 `abandoned` | 无变化 | 无变化 | 移除 | 状态不变 |
| `abandoned` | 若被指定可设回 `in_progress` | 若被指定则变为 `completed` | 保持 `abandoned` | 无变化 | 无变化 | 移除 | 状态不变 |

规范化随后在 op 运行后重新应用单一活动任务规则。

### Op targeting rules
- `done`、`drop`、`rm`：
  - 设置 `task`：影响一个内容精确匹配的任务。
  - 否则设置 `phase`：影响该名称精确匹配的阶段中的每个任务。
  - 否则：影响每个阶段中的每个任务。
- `block` 与 `unblock` 使用相同的 task-or-phase 查找，但拒绝省略目标。
- `append` 是唯一会创建缺失阶段的 op。
- `init` 完全丢弃先前的 phases。

### Markdown round-trip helpers
同一文件还暴露 `/todo` 使用的非工具辅助函数：
- `phasesToMarkdown(...)` 把 phases 序列化为标题加复选框条目（`[ ]`、`[/]`、`[x]`、`[-]`、`[!]`）。阻塞原因保留在尾部的 `<!-- blocker: ... -->` 注释中。
- `markdownToPhases(...)` 解析该格式，把孤儿任务默认放进 `Todos` 阶段，同时接受 `>` 表示 `in_progress`、`~` 表示 `abandoned`，恢复阻塞备注，并执行相同的规范化步骤。

## Side Effects
- Filesystem
  - 工具本身没有。
- Session state (transcript, memory, jobs, checkpoints, registries)
  - 通过 `setTodoPhases` 变更会话 todo 缓存。
  - `storage` 报告会话是否有支撑的会话文件，但工具本身不追加自定义会话条目。
  - 成功的工具结果消息携带 `details.phases`；`getLatestTodoPhasesFromEntries(...)` 之后可从这些 transcript 条目重建状态。
  - 失败的 `todo` 结果使 `agent-session` 加入一条隐藏的下轮提醒（`customType: "todo-error-reminder"`）。
- User-visible prompts / interactive UI
  - transcript 块由 `todoToolRenderer` 渲染并与调用行合并。
  - `event-controller` 用成功结果更新可见的 todo 面板。
  - 出错时 `event-controller` 显示 `Todo update failed...`；可见面板可能保持陈旧，直到后续调用成功。
  - `/todo expand` 在固定 HUD 中显示每个 phase 与任务；`/todo collapse` 恢复其有界的预览。两者都仅用于显示，不改动 todo 状态。
- Background work / cancellation
  - 会话级自动清除 `completed`/`abandoned` 任务已被移除（该定时器会在两次工具调用之间变更规范 phases）；TUI todo 组件在 `tasks.todoClearDelay` 之后仍会清除已关闭条目（仅显示层面，`packages/coding-agent/src/modes/interactive-mode.ts`）。

## Limits & Caps
- `init.list`：应用于单个 op（`todoSchema`）。params 对象恰好携带一个 op。
- `init.list[*].items`：schema 层级的 `minItems: 1`。
- 扁平 `init.items` 与 `append.items`：共享 schema 允许任意数组长度，但按 op 的执行会拒绝缺失/空列表。
- 渲染器折叠预览：`PREVIEW_LIMITS.COLLAPSED_ITEMS = 8`（`packages/coding-agent/src/tools/render-utils.ts`）。
- 执行期修复：被省略的 `op` 只会为上述无歧义载荷推断；schema 本身仍要求 `op`。
- 自动清除延迟：`tasks.todoClearDelay` 默认 `60` 秒；`< 0` 停用自动清除，`0` 立即清除。仅显示层面——由 TUI 组件应用（`packages/coding-agent/src/modes/interactive-mode.ts`）；该设置在会话层面无效。
- 工具执行模式：`concurrency = "exclusive"`、`strict = true`、`loadMode = "discoverable"`。

## Errors
- 普通的错误 op 载荷会以人类可读字符串累积在 `errors` 中；结果标记为 `isError: true`，变更被丢弃——返回与持久化的状态保持在调用前的列表。
- 错误字符串来自 `packages/coding-agent/src/tools/todo.ts` 中的辅助函数，包括：
  - `Missing list for init operation`
  - `Missing task content`
  - `Duplicate phase "..." in init list` / `Duplicate task "..." in init list`
  - `Task "..." not found`，适用时附带额外的空列表提示；当缺失内容看起来像 ID 时，附带任务按内容（而非 `task-N` ID）引用的提示
  - `Missing phase name`
  - `Phase "..." not found`
  - `Missing phase name for append operation`
  - `block requires a task or phase target`
  - `unblock requires a task or phase target`
  - `Missing items for append operation`
  - `Task "..." already exists`
- 一次 `todo` 调用只携带一个 op；其中的任何错误都会丢弃该 op 所做的全部变更。
- 运行时层级的工具失败在工具体外处理：`agent-session` 注入隐藏提醒，event controller 警告用户可见进度可能陈旧。
- 幂等性因 op 而异：
  - `init` 是整体替换；重放相同载荷产生相同状态。
  - `start`、`done`、`drop`、`block` 与 `unblock` 在既有的目标状态上实际上是幂等的，不过 `start` 还会降级另一个活动任务，重复 `block` 可更新其 reason。
  - `rm` 对定向移除不是幂等的：第二次调用会因任务或阶段已不存在而出错。
  - `append` 不是幂等的：重复的任务内容以 `Task "..." already exists` 被拒绝；`append` op 会预先校验，因此含任何重复项的 op 不会追加任何内容。

## Notes
- 工具内部的任务查找是精确字符串相等。面向模型的 prompt 说明任务内容与阶段名是标识符且应保持唯一；`append` 全局强制任务唯一性，`init` 拒绝载荷中重复的阶段名与重复的任务内容。
- `findTaskByContent(...)` 返回跨阶段的第一个匹配任务。重复的任务内容会使后续定向 op 产生歧义。
- `normalizeInProgressTask(...)` 在 op 之后运行一次，而非在 op 中途。单个 op（如 `init`）可构建中间无效状态，并依赖最终规范化。
- `storage: "session"` 表示会话有会话文件支撑；它不表示本工具写入了持久化的自定义条目。
- 重载持久化因路径而异：
  - 普通 `todo` 调用存续于 transcript 工具结果 details 中；
  - `/todo` 命令编辑额外追加 `customType: "user_todo_edit"` 条目，并注入一条对模型可见、描述手动编辑的 `<system-reminder>` developer 消息。
- 会话恢复时，`AgentSession.#syncTodoPhasesFromBranch()` 在恢复缓存列表前剥离 `completed` 与 `abandoned` 任务。`/todo` 命令通过读取最新的 transcript/自定义条目状态绕开这一行为，使历史上的 done/dropped 任务仍对用户可见。
- 工具可用性由 `todo.enabled` 把关；当启用 `includeYield` 时注册表会排除它，除非会话已 prewalk 武装（`packages/coding-agent/src/tools/index.ts`）。
- 子 agent 不继承 `todo`；`packages/coding-agent/src/task/executor.ts` 也把它作为父进程持有的工具从活动集中过滤掉。例外（两个层面一致）：prewalk 武装的子 agent 保留它——prewalk 计划提示与 todo 门要求子 agent 在交接前提交自己的 todo 列表。
