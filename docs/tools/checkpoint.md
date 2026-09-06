# checkpoint

> 标记当前顶层对话状态，以便之后的 `rewind` 能把探索性上下文收拢成一份报告。

## 源码
- 入口：`packages/coding-agent/src/tools/checkpoint.ts`
- 面向模型的 prompt：`packages/coding-agent/src/prompts/tools/checkpoint.md`
- 关键协作者：
  - `packages/coding-agent/src/session/agent-session.ts` — 工具成功后捕获活动 checkpoint。
  - `packages/coding-agent/src/session/session-manager.ts` — 持久化常规会话条目流；不持久化活动 checkpoint 标记。
  - `packages/coding-agent/src/tools/index.ts` — 注册该工具，并用 `checkpoint.enabled` 门控。
  - `packages/coding-agent/src/config/settings-schema.ts` — 定义默认关闭的功能开关。

## 注册 / 可见性
- 工具元数据：`approval = "read"`、`strict = true`、`loadMode = "discoverable"`。执行为一次性；工具不流式输出进度更新。
- 注册要求 `checkpoint.enabled = true`（默认 `false`）。
- 顶层会话在启用时收到该工具。子 agent 默认不发现它，但可以通过显式 `tools:`/请求工具列表收到它。
- `checkpoint` 与 `rewind` 是一对安全组合：在该功能启用期间显式请求任一名称时，注册会自动包含另一个。
- 在普通 `tools.xdev` 会话中，可发现的 built-ins 可能以 `xd://checkpoint` 呈现；显式请求的工具仍保持顶层。

## 输入

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `goal` | `string` | 是 | 调查目标。schema 必填，并在工具结果中原样回显；实现不会 trim 它，也不会拒绝空字符串。 |

## 输出
该工具返回单个文本结果，外加结构化 details：

- 文本正文：
  - `Checkpoint created.`
  - `Goal: <goal>`
  - `Run your investigation, then call rewind with a concise report.`
- `details`：
  - `goal: string`
  - `startedAt: string` — 在 `CheckpointTool.execute()` 内创建的 ISO 时间戳

不返回 checkpoint ID、工件 URI、任务句柄、文件路径或恢复 token。

## 流程
1. `packages/coding-agent/src/tools/index.ts` 中的工具注册强制 `checkpoint.enabled` 与顶层/显式子 agent 可见性规则。`CheckpointTool.createIf()` 本身总是构造该工具。
2. 当 `session.getCheckpointState?.()` 已设置时，`CheckpointTool.execute()` 以 `ToolError("Checkpoint already active.")` 拒绝嵌套 checkpoint。
3. 它创建 `startedAt = new Date().toISOString()` 并返回普通 `toolResult()` 载荷。工具方法本身不修改 checkpoint 状态。
4. 在之后成功的 checkpoint 工具结果事件上，`AgentSession` 捕获三个运行时字段：
   - `checkpointMessageCount` — 当前 `agent.state.messages.length`，在 checkpoint 工具结果已追加之后
   - `checkpointEntryId` — `sessionManager.getEntries().at(-1)?.id ?? null`，即 checkpoint 时刻最后一条持久化的会话条目 ID
   - `startedAt` — 从工具 details 复制，或重新生成
5. `AgentSession` 把该对象存入 `#checkpointState`，清除 `#pendingRewindReport`，并清除先前的 `#lastCompletedRewind`。
6. 在恢复、会话切换或树导航时，`#rehydrateCheckpointRewindState()` 扫描当前持久化分支。最近的、且之后没有保留的 rewind 报告的成功 checkpoint，会重建活动 checkpoint 边界与守卫。

## 副作用
- 会话状态（transcript、memory、jobs、checkpoints、registries）
  - 在内存中设置 `AgentSession.#checkpointState`。
  - 把 checkpoint 边界记录为消息数加持久化的 checkpoint 工具结果条目 ID。
  - 常规的成功工具结果条目足以在恢复后重建未完成的 checkpoint；没有单独的 checkpoint 标记条目。
  - 启用后续的 settle 守卫：若 checkpoint 活动且没有待处理的 rewind 报告，`#enforceRewindBeforeYield()` 会注入一条 developer-role 警告并安排另一个回合。
- 用户可见的 prompt / 交互式 UI
  - 工具结果告诉模型在调查后调用 `rewind`。
  - 若 agent 先试图 `yield`，`AgentSession` 会注入：

```text
<system-warning>
You are in an active checkpoint. You MUST call rewind with your investigation findings before yielding. Do NOT yield without completing the checkpoint.
</system-warning>
```

## 限制与上限
- 可用性由 `checkpoint.enabled` 门控，默认 `false`。
- 每个会话或子 agent 只允许一个活动 checkpoint。
- 子 agent 需要显式的请求工具条目；请求任一 checkpoint 工具会自动包含其姊妹工具。
- Checkpoint 状态不作为专用条目持久化。它从活动分支上成功的 checkpoint 工具结果条目重建，包括进程恢复之后。
- 会话持久化适用于常规 checkpoint 工具调用/结果消息。全局会话持久化截断是 `packages/coding-agent/src/session/session-persistence.ts` 中的 `MAX_PERSIST_CHARS = 500_000`。

## 错误
- `ToolError("Checkpoint already active.")` — 先前的 checkpoint 未被 rewind 或清除时抛出。
- 工具正文没有本地 `try/catch`；意外异常向上传播。

## 备注
- 尽管摘要字符串写着 `Create a git-based checkpoint to save and restore session state`，该实现不调用 git，也不对文件系统状态做快照。
- 捕获的状态只是对话/会话元数据：
  - 内存中的消息数
  - 会话树中持久化的 checkpoint 工具结果条目 ID
  - 时间戳
- 不捕获：
  - 工作树内容或已暂存变更
  - 工件或 blob-store 内容
  - `packages/coding-agent/src/session/history-storage.ts` 中的 SQLite prompt-history 行
  - `packages/coding-agent/src/session/agent-storage.ts` 中的 auth 或 agent 记录
