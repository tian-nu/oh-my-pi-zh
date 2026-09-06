# learn

> 将一条可复用的经验教训捕获到长期记忆，并可选择创建或更新一个受管 skill（managed skill）。

## 源码
- 入口：`packages/coding-agent/src/tools/learn.ts`
- 面向模型的 prompt：`packages/coding-agent/src/prompts/tools/learn.md`
- 受管 skill 辅助函数：`packages/coding-agent/src/autolearn/managed-skills.ts`
- 本地记忆后端：`packages/coding-agent/src/memory-backend/local-backend.ts`
- 本地经验教训持久化：`packages/coding-agent/src/memories/index.ts`（`saveLearnedLesson(...)`）

## 注册 / 可见性
- `loadMode = "essential"` 且 `strict = true`，因此该工具保持顶层注册，而不挂载到 `xd://` 之下。
- 审批是动态的：包含 `skill` 的调用，或 `memory.backend = "local"` 时的任何调用，其 `approval = "write"`；仅记忆性的 Hindsight/Mnemopi 调用其 `approval = "read"`。
- 注册要求 `autolearn.enabled = true`（默认 `false`）且 `memory.backend` 为 `"hindsight"`、`"mnemopi"` 或 `"local"`。
- 启用的顶层会话会在普通的显式工具列表中自动包含 `learn`。子 agent 不会自动发现或接收它，但当其请求工具/frontmatter 列表显式包含它时可以使用。
- 执行是单次性的，且不发出进度更新。

## 输入

| 字段 | 类型 | 必填 | 描述 |
|---|---|---:|---|
| `memory` | `string` | 是 | 需要记住的持久、自包含的经验教训：是什么、何时以及为什么。schema 没有最小长度；后端特有的净化/存储决定空值是否成功。 |
| `context` | `string` | 否 | 经验教训的来源上下文。 |
| `skill` | `{ action: "create" \| "update"; name: string; description: string; body: string }` | 否 | 经验教训成功后要创建或增强的受管 skill。`body` 是无 frontmatter 的 Markdown。 |

## 输出
- 仅经验教训：
  - `content[0].text = "Lesson stored."` 或 `"Lesson queued for retention."`
  - `details = { skill: null }`
- 经验教训加 skill：
  - `content[0].text = "<lesson result>. Created managed skill \"<name>\"."` 或 `"... Updated ..."`
  - `details = { skill: "<name>" }`
- 与已创作 skill 重名冲突时，在存储/排队经验教训之后返回 `isError: true`，并报告 `details = { skill: null, shadowed: true }`。

## 流程
1. 仅当 `autolearn.enabled` 为 true 且 `memory.backend` 为 `"hindsight"`、`"mnemopi"` 或 `"local"` 时，`LearnTool.createIf(...)` 才暴露该工具。
2. `execute(...)` 在尝试任何 skill 变更之前先存储经验教训：
   - Mnemopi：以 `source: "coding-agent-learn"`、`importance: 0.8`、`scope: "bank"`、启用提取、`veracity: "tool"`、`memoryType: "fact"` 以及 session/cwd/context 元数据调用 `rememberScoped(...)`；返回的 id 缺失即视为失败。
   - 本地后端：调用 `localBackend.save(...)`，它会规范化并写入项目作用域的 `learned.md`；`stored === 0` 视为失败。
   - Hindsight：通过 `state.enqueueRetain(memory, context)` 将保留入队，并把经验教训报告为已排队。
3. 若缺少 `skill`，工具在记忆写入/排队后返回。
4. 若 `skill.action == "create"`，工具以转小写/校验后的名称核对活动的 authored skill。冲突会在经验教训已存储或排队之后返回错误结果。
5. 否则调用 `writeManagedSkill(...)`。skill 写入失败会作为部分结果重新抛出，因为经验教训的持久化已经发生。
6. 与 `manage_skill` 不同，`learn` 写入后不会调用会话的 `refreshSkills` 回调。该受管 skill 会在之后某次 skill 刷新/会话中被发现。

## 模式 / 变体
- 仅记忆的经验教训捕获。
- 经验教训加受管 skill 的 create/update，用于值得固化为 `SKILL.md` 的可重复流程。
- 后端特有的持久化：排队的 Hindsight、作用域的 Mnemopi SQLite，或项目作用域的本地 `learned.md`。
- 受管 skill 文件已存在时 `create` 失败；不存在时 `update` 失败。同名的进程内变更会被串行化。

## 副作用
- 文件系统：
  - 本地后端写入 `<agent-dir>/memories/<encoded-cwd>/learned.md`。
  - 受管 skill 写入 `<agent-dir>/managed-skills/<sanitized-name>/SKILL.md`；默认 agent 目录为 `~/.omp/agent`。
  - Mnemopi 写入其作用域内的 SQLite 数据库。
- 网络：Hindsight 队列稍后向配置的服务器 flush。Mnemopi 可在同步行写入之后调度配置的 embedding/事实提取 provider 工作；本地文件后端存储本身是离线的。
- 会话状态：读取后端状态、设置、cwd 与 session id。此处创建的 skill 不会立即注入活动 skill 列表。
- 后台工作：Hindsight 保留与 Mnemopi 提取/embedding 可在工具结果之后继续进行。

## 限制与上限
- 可用性要求 `autolearn.enabled` 加上受支持的记忆后端；两个设置默认均为禁用/off。
- 受管 skill 名称会去除首尾空白并转小写，然后必须匹配 `[a-z0-9][a-z0-9-]{0,63}`。
- 受管描述会被压缩为一行，并去除控制/格式字符、尖括号、反引号与重复的波浪号。
- 最终受管 `SKILL.md` 内容（含生成的 frontmatter 与描述）上限为 `64_000` 个 UTF-8 字节。
- 受管 skill 从不覆盖 authored skill；已创作名称在发现中胜出。
- 本地经验教训按最新在前排列，并按规范化后的渲染行去重，最多 100 条经验教训条目。在完成 prompt-injection 中和与秘密脱敏之后，经验教训内容上限为 2,000 字符，context 上限为 400 字符。

## 错误
- 缺少 Mnemopi 状态时，抛出 `Mnemopi backend is not initialised for this session.`。
- 本地 Mnemopi 写入未返回 id 时，抛出 `Mnemopi did not store the lesson (no memory id returned).`；不会尝试可选的 skill。
- 本地后端规范化未产出经验教训时，抛出 `Lesson was empty after sanitization; nothing stored.`；不会尝试可选的 skill。
- 缺少 Hindsight 状态时，抛出 `Hindsight backend is not initialised for this session.`。
- `skill.action = "create"` 上的已创作名称冲突会在经验教训成功之后返回 `isError: true` 与 `details = { skill: null, shadowed: true }`。
- 受管 skill 的校验、create/update、安全或大小失败会在经验教训成功之后抛出 `<lesson result>, but the managed skill could not be written: <reason>`。

## 备注
- 请节制使用该工具。一条精确、可复用的经验教训胜过几条含糊的记忆。
- 只在可重复流程上使用 `skill`；普通事实应保持仅记忆。
- 受管 skill 的 frontmatter 由规范化后的名称与净化后的描述生成；`body` 不得包含 frontmatter。
- 受管 skill 与 authored skill 相互隔离。`learn` 写入它们以供之后的发现刷新；若活动会话必须在变更后立即刷新，请使用 `manage_skill`。
