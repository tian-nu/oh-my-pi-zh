# memory_edit

> 按 id 更新、遗忘或失效 Mnemopi 长期记忆。

## 源码
- 入口：`packages/coding-agent/src/tools/memory-edit.ts`
- 面向模型的 prompt：`packages/coding-agent/src/prompts/tools/memory-edit.md`
- 后端协作模块：`packages/coding-agent/src/mnemopi/state.ts`（`editScopedMemory(...)`）

## 注册 / 可见性
- 工具元数据：`approval = "read"`、`strict = true`、`loadMode = "discoverable"`，尽管成功的调用会修改本地记忆。
- 注册要求 `memory.backend = "mnemopi"`；当后端为 `"off"`、`"local"` 或 `"hindsight"` 时，该工具不存在。
- 在带显式工具列表的无限制会话中，注册会自动为 Mnemopi 包含 `memory_edit`。受限列表不会被扩充。
- 在普通 `tools.xdev` 会话中，可发现的 built-in 工具可能以 `xd://memory_edit` 呈现；显式请求的工具仍保持顶层。
- 执行是同步、单次的，没有进度回调或取消参数。

## 输入

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `op` | `"update" \| "forget" \| "invalidate"` | 是 | 要应用的编辑操作。 |
| `id` | `string` | 是 | `recall` 返回的记忆 id。 |
| `content` | `string` | 否 | 用于 `update` 的替换记忆文本。 |
| `importance` | `number` | 否 | 用于 `update` 的替换重要性；会被钳制到 `0..1`。 |
| `replacement_id` | `string` | 否 | 为 `invalidate` 记录的取代旧记忆的新记忆 id。 |

## 输出
- `content[0].type = "text"`
- 成功变更的文本为 `Memory <id> updated|deleted|invalidated in bank <bank> (<store>).`
- 未知或不符合操作条件的 id 产生文本 `Memory <id> was not found...`；这是状态为 `not_found` 的普通结果。
- 事实行 id 产生文本 `Memory <id> is a read-only fact...; it cannot be edited. Read it with memory://<id>.`；这是状态为 `not_editable` 的普通结果。
- `details` 为 `{ status, bank?, store? }`，其中 status 为 `"updated" | "deleted" | "invalidated" | "not_found" | "not_editable"`；当解析到某一行时 store 为 `"working" | "episodic" | "fact"`。

## 流程
1. `MemoryEditTool.createIf(...)` 仅在 `memory.backend == "mnemopi"` 时暴露该工具。
2. `execute(...)` 获取 `session.getMnemopiSessionState()`；后端未初始化则失败。
3. `update` 至少需要 `content` 或 `importance` 之一。
4. `importance` 在调用后端前会被钳制到 `0..1`。
5. 工具调用 `state.editScopedMemory(op, id, { content, importance, replacementId })`。
6. 后端按顺序搜索去重后的 retain、recall 与全局目标：返回第一个成功的可编辑结果，否则返回第一个已解析但不符合条件的结果，否则返回 `not_found`。
7. 工具渲染返回的状态，并在 `details` 中原样透传后端结果。

## 模式 / 变体
- `update` 替换 working 记忆的文本和/或重要性。内容替换是整体替换，不是补丁式修改。
- `forget` 永久删除 working 记忆行。
- `invalidate` 以软方式取代 working 或 episodic 行，并可能记录 `replacement_id`。
- 事实行可读但不可变；所有操作都返回 `not_editable`。
- 对 episodic id 执行 `update`/`forget` 会返回 `not_found` 并附上其 bank/store 位置，因为这些操作只支持 working 记忆。

## 副作用
- 文件系统：修改包含已解析行的本地 Mnemopi SQLite 数据库，该数据库可能是 retain、recall、shared 或安全发现的 legacy bank。
- 网络：无；编辑操作不调用 embedding 或 extraction provider。
- 会话状态：读取活动会话的作用域 Mnemopi 状态；不重写已注入的 `<memories>` 上下文。

## 限制与上限
- 可用性要求 `memory.backend = "mnemopi"`；Hindsight 与本地文件记忆不暴露该工具。
- `id` 必须直接提供；工具不按内容搜索。
- recall 预览默认上限为 500 字符。`update` 之前务必先执行 `read memory://<id>`；该 URL 会在相同的作用域 bank 中解析出完整行。
- 既无 `content` 也无 `importance` 的 `update` 会在任何后端写入前被拒绝。
- 超出 `0..1` 的 `importance` 值会被钳制而不会报错。

## 错误
- 当工具已暴露但缺少会话状态时，抛出 `Mnemopi backend is not initialised for this session.`
- 对空更新抛出 `memory_edit update requires content or importance.`
- 缺失的 id、用于 update/forget 的 episodic id 以及事实 id 都是普通结果而非抛出的错误；请检查 `details.status`。
- 当没有作用域 bank 包含该行时，`read memory://<id>` 抛出 `Mnemopi memory <id> not found`。

## 备注
- 每次 update 之前都要读取完整的 `memory://<id>` 行。把被裁剪的 recall 预览复制进 `content` 会删除未显示的部分。
- 对历史可能仍有价值的过期 working/episodic 记忆，优先使用 `invalidate`。
- 只有当 working 记忆行需要被硬删除时才使用 `forget`。
