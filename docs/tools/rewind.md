# rewind

> 结束活动检查点：剪除探索性上下文，并保留一份简洁的报告。

## 来源
- 入口：`packages/coding-agent/src/tools/checkpoint.ts`
- 面向模型的 prompt：`packages/coding-agent/src/prompts/tools/rewind.md`
- 主要协作方：
  - `packages/coding-agent/src/session/agent-session.ts` — 校验待处理的 rewind 状态、执行真正的回退，并注入保留的报告。
  - `packages/coding-agent/src/session/session-manager.ts` — 对持久化的会话树分叉，并追加持久化的 summary/report 条目。
  - `packages/coding-agent/src/session/session-context.ts` — `buildSessionContext()` 会把持久化的 `branch_summary` 条目转成重建上下文中的 LLM 可见 `branchSummary` 消息。
  - `packages/coding-agent/src/tools/index.ts` — 注册该工具并共享 `checkpoint.enabled` 开关。

## 注册 / 可见性
- 工具元数据：`approval = "read"`、`strict = true`、`loadMode = "discoverable"`。执行是 single-shot 的；回退的副作用被延迟应用，而不是作为进度更新流式输出。
- 注册要求 `checkpoint.enabled = true`（默认 `false`）。
- 启用后，顶层会话会获得该工具。子 agent 默认不会发现它，但可通过显式的 `tools:`/请求工具列表获得。
- `checkpoint` 与 `rewind` 是一对安全工具：该功能启用时，显式请求其中任何一个都会自动包含另一个。
- 在普通的 `tools.xdev` 会话中，可发现的内置工具可能以 `xd://rewind` 形式呈现；显式请求的工具仍保持顶层。

## 输入

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `report` | `string` | 是 | 调查结论。`execute()` 会对其做 trim，并在结果为空时拒绝。 |

## 输出
工具返回单个文本结果以及结构化 details：

- 文本正文：
  - `Rewind requested.`
  - `Report captured for context replacement.`
- `details`：
  - `report: string` — 裁剪后的报告文本
  - `rewound: true`

返回的工具结果并不等于最终的回退。`AgentSession` 会等到 `turn_end`，再异步应用回退副作用。

## 流程
1. `packages/coding-agent/src/tools/index.ts` 中的工具注册强制 `checkpoint.enabled` 以及顶层/显式子 agent 的可见性规则。`RewindTool.createIf()` 本身总是会构造该工具。
2. 没有活动检查点时，`execute()` 区分两种状态：
   - 存在保留的已完成回退：`ToolError("Checkpoint already completed; continue from the retained rewind report instead of calling rewind again.")`
   - 不存在已完成的回退：`ToolError("No active checkpoint. Create a checkpoint before calling rewind.")`
3. 它对 `params.report` 做 trim；若为空，则抛出 `ToolError("Report cannot be empty.")`。
4. 它返回带 `details.report` 与 `details.rewound = true` 的 `toolResult()`。
5. 在回退工具结果成功时，`AgentSession` 从 `details.report` 或第一个文本内容块中取出报告，存入 `#pendingRewindReport`。
6. 在 `turn_end`，`#extractRewindReport()` 找到待处理或成功的回退结果，并调用 `#applyRewind()`。
7. `#applyRewind()` 先调用 `sessionManager.branchWithSummary(checkpointEntryId, report, { startedAt })`，在检查点分支点记录一条 `branch_summary`。若该条目已无法解析，它会记录一条警告并改为从根分叉。
8. 它追加一条隐藏的持久化 `rewind-report` 自定义消息。其内容由 `prompts/system/rewind-report.md` 渲染，告诉下一回合检查点已完成、不要再次调用 `rewind`，并包含报告；details 中含有 `{ report, startedAt, rewoundAt }`。
9. 它设置 `#lastCompletedRewind`，从新的活动分支重建显示/LLM 会话上下文，并同时替换该回合的活动消息数组和 `agent.state.messages`。因此探索分支与成功的回退工具结果不会出现在下一次 provider 调用中。
10. 它在保留 cost 的同时重置 advisor 会话状态，从新分支同步 todo 状态，并关闭历史被改写的 provider 会话。
11. 最后它清除 `#checkpointState` 和 `#pendingRewindReport`。之后恢复会话或进行树导航时，持久化的保留报告会把 `#lastCompletedRewind` 重新加载（rehydrate）回内存。

## 模式 / 变体
- 常规回退：检查点条目存在；会话历史从该确切条目分叉。
- 兜底回退：检查点条目 ID 在当前会话树中缺失；回退从根分叉并记录一条警告。
- 延迟到回合结束应用：工具结果只请求回退；分叉与上下文替换在周围 assistant 回合结束之后进行。
- 恢复的检查点：活动持久化分支上未完成的、成功的检查点工具结果会重新加载（rehydrate）检查点状态，从而允许进程恢复后再回退。

## 副作用
- 会话状态（transcript、memory、jobs、checkpoints、registries）
  - 从检查点分支加上保留的 summary/report 重建活动对话历史；它不会恢复文件或进程状态。
  - 添加一条隐藏的自定义消息 `rewind-report`，携带渲染好的恢复指引与报告。
  - 记录 `#lastCompletedRewind`，清除活动检查点与待处理报告，重置 advisors，重新同步 todo 状态，并关闭因历史改写而失效的 provider 会话。
  - 把持久化的会话叶子重新定位到检查点分支点，并追加新的会话条目。
- 文件系统
  - 通过常规的 `SessionManager` 追加持久化，把新的 `branch_summary` 与 `custom_message` 条目持久化进会话 `.jsonl` 文件。
  - 会话文件在会话目录中命名为 `<ISO-timestamp-with-:-and-.-replaced>_<uuidv7>.jsonl`；未传入覆盖值时，默认目录选择为 `~/.omp/agent/sessions/<encoded-cwd>/`。
- 用户可见的 prompt / 交互式 UI
  - 工具结果在回合结束应用之前可见。
  - 重建上下文时，持久化的 `branch_summary` 会成为 LLM 可见的 `branchSummary` 消息；上下文压缩（compaction）渲染会把它呈现为 user 角色的 `<summary>` 块。
  - 隐藏的 `rewind-report` 自定义消息会成为下一次 provider 调用的 developer 角色保留指引。
- 后台工作 / 取消
  - 回退应用被推迟到 `turn_end`。没有独立的 job 对象或取消句柄。

## 限制与上限
- 可用性由 `checkpoint.enabled` 门控，默认 `false`。
- 子 agent 需要显式的请求工具条目；请求任一检查点工具都会自动带上其姊妹工具。
- 一个会话最多只有一个活动检查点；没有命名检查点或在多个检查点之间选择的途径。
- 报告文本在 `trim()` 之后必须非空。
- 回退只恢复活动的对话/会话树上下文；不存在文件、artifact、blob、进程或 git 的恢复途径。
- 持久化的报告/summary 内容受全局会话持久化上限 `MAX_PERSIST_CHARS = 500_000` 约束。

## 错误
- `ToolError("Checkpoint already completed; continue from the retained rewind report instead of calling rewind again.")` — 当活动分支已包含保留的完成结果时抛出。
- `ToolError("No active checkpoint. Create a checkpoint before calling rewind.")` — 当既无活动检查点也无已完成的回退时抛出。
- `ToolError("Report cannot be empty.")` — 当 trim 后的报告为空时抛出。
- 应用期间检查点条目 ID 缺失不会让已完成的工具调用失败；`#applyRewind()` 会记录 `Rewind branch checkpoint missing, falling back to root` 并从根分叉。

## 备注
- 检查点选择是隐式的。`rewind` 总是以单个 `#checkpointState` 为目标——该状态来自上一次未完成的成功 `checkpoint`，或由它重新加载（rehydrate）而来；不存在检查点列表、标签或 ID 参数。
- 恢复的状态是活动的对话/会话树上下文：
  - 持久化分支重置为 `checkpointEntryId` 或回退到根
  - 被放弃的探索路径的分支 summary
  - 保留的 `rewind-report` 自定义消息
  - 从该分支重建的内存中消息
- 不恢复：
  - 文件系统或 git 状态
  - `packages/coding-agent/src/session/artifacts.ts` 下的 artifacts
  - `packages/coding-agent/src/session/blob-store.ts` 下的 blob-store 负载
  - `packages/coding-agent/src/session/history-storage.ts` 中的 prompt 历史记录行
  - `packages/coding-agent/src/session/agent-storage.ts` 中的 auth 或其他 agent 存储
- 不存在并发编辑的对账。回退既不合并也不还原代码或会话周边的外部状态。
- 回退不会破坏持久化的会话历史。`branchWithSummary()` 会追加一条新的 `branch_summary` 条目并移动叶子；被放弃的条目仍留在 `.jsonl` 日志中，但离开了活动分支。
