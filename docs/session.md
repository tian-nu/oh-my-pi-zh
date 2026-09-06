# Session 存储与条目模型

本文档是 coding-agent 会话在运行时如何表示、持久化、迁移与重建的权威来源。

## 范围

涵盖：

- Session JSONL 格式与版本化
- 条目分类与树语义（`id`/`parentId` + leaf 指针）
- 加载旧文件或畸形文件时的迁移/兼容行为
- Context 重建（`buildSessionContext`）
- 持久化保证、失败行为、截断/blob 外部化
- 存储抽象（`FileSessionStorage`、`MemorySessionStorage`）及相关工具

除影响会话数据的语义外，不涉及 `/tree` UI 渲染行为。

## 实现文件

- [`src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts) —— 编排：tree/leaf、追加、持久化、blobs、生命周期工厂
- [`src/session/session-entries.ts`](../packages/coding-agent/src/session/session-entries.ts) —— entry/header 类型、`SessionEntry` 联合、`CURRENT_SESSION_VERSION`
- [`src/session/session-migrations.ts`](../packages/coding-agent/src/session/session-migrations.ts) —— 版本迁移
- [`src/session/session-loader.ts`](../packages/coding-agent/src/session/session-loader.ts) —— 文件加载 + blob 引用解析
- [`src/session/session-context.ts`](../packages/coding-agent/src/session/session-context.ts) —— `buildSessionContext`
- [`src/session/session-persistence.ts`](../packages/coding-agent/src/session/session-persistence.ts) —— 截断 + 图像 blob 外部化
- [`src/session/session-paths.ts`](../packages/coding-agent/src/session/session-paths.ts) —— 磁盘布局、目录编码、终端面包屑
- [`src/session/session-listing.ts`](../packages/coding-agent/src/session/session-listing.ts) —— 发现（list/recent/resolve）
- [`src/session/session-storage.ts`](../packages/coding-agent/src/session/session-storage.ts) —— 存储抽象
- [`src/session/session-title-slot.ts`](../packages/coding-agent/src/session/session-title-slot.ts) —— 固定宽度当前标题槽
- [`src/session/indexed-session-storage.ts`](../packages/coding-agent/src/session/indexed-session-storage.ts) —— 本地索引 + 有序远程后端存储适配器
- [`src/session/messages.ts`](../packages/coding-agent/src/session/messages.ts) —— 自定义消息转换器
- [`src/session/blob-store.ts`](../packages/coding-agent/src/session/blob-store.ts) —— 内容寻址 blob 存储
- [`src/session/history-storage.ts`](../packages/coding-agent/src/session/history-storage.ts) —— prompt 历史（独立子系统）

## 磁盘布局

默认文件会话位置：

```text
~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl
```

`<encoded-cwd>` 由规范化后的 cwd 派生（因此符号链接别名共享同一桶）：home 下的目录为 `-<relative>`，临时根下的目录为 `-tmp-<relative>`，其余为 `--<encoded-absolute>--`，路径分隔符替换为 `-`。

访问时，短暂 hashed 方案（`<scope>-<project-basename>-<sha256(canonical-cwd)>`，用于 17.2.5-17.2.8，并在 17.2.9 由 #7397 回退）写入的桶会尽力迁移回路径编码的名称，同时迁移 home 相对桶更旧的 `--<home-encoded>-*--` 拼写。

Blob 存储位置：

```text
~/.omp/agent/blobs/<sha256>
```

终端面包屑文件写入：

```text
~/.omp/agent/terminal-sessions/<terminal-id>
```

面包屑内容是原始 cwd 与会话文件路径，外加可选的第三行 `fresh`。fresh 面包屑保留一个 `/new` 边界，其惰性创建的 JSONL 文件尚不存在，从而防止 `continueRecent()` 重新打开上一个会话。写入是同步、有序且尽力而为的。

## 文件格式

会话文件是 JSONL：每行一个 JSON 对象。当前文件物理上以固定宽度、256 字节的 `type: "title"` 槽开头，随后是会话 header，然后是 `SessionEntry` 值。旧文件可能直接以 header 开头。加载器剥离物理槽，并将其当前标题/来源折叠进逻辑 header。

- 逻辑上第一条目始终是会话 header（`type: "session"`）。
- 其余逻辑条目是 `SessionEntry` 值。
- 条目在运行时只追加；分支导航移动指针（`leafId`）而非变更既有条目。

### Header（`SessionHeader`）

```json
{
  "type": "session",
  "version": 3,
  "id": "1f9d2a6b9c0d1234",
  "timestamp": "2026-02-16T10:20:30.000Z",
  "cwd": "/work/pi",
  "title": "optional session title",
  "titleSource": "auto",
  "additionalDirectories": ["/work/shared"],
  "previousSessionFiles": ["/old/location/session.jsonl"],
  "providerPromptCacheKey": "optional inherited cache identity",
  "parentSession": "optional lineage marker"
}
```

备注：

- `additionalDirectories` 记录 `cwd` 之外规范化、去重后的工作区根。
- `previousSessionFiles` 记录成功移动后的先前绝对位置。
- `providerPromptCacheKey` 为符合条件的完整 fork 携带继承的 provider prompt-cache 身份。
- `parentSession` 是不透明的谱系字符串。当前代码根据流程（`fork`、`forkFrom`、`createBranchedSession` 或显式 `newSession({ parentSession })`）写入会话 id 或会话路径。将其视为元数据，而非类型化外键。

- `titleSource` 为 `auto` 或 `user`；自动重命名不能覆盖用户标题。

### Entry Base（`SessionEntryBase`）

所有非 header 条目都包含：

```json
{
  "type": "...",
  "id": "8-char-id",
  "parentId": "previous-or-branch-parent",
  "timestamp": "2026-02-16T10:20:30.000Z"
}
```

根条目（首次追加或 `resetLeaf()` 之后）的 `parentId` 可为 `null`。

## Entry Taxonomy

`SessionEntry` 是以下类型的联合：

- `message`
- `thinking_level_change`
- `model_change`
- `service_tier_change`
- `compaction`
- `branch_summary`
- `reset_boundary`
- `custom`
- `custom_message`
- `label`
- `title_change`
- `ttsr_injection`
- `credential_pin`
- `session_init`
- `mode_change`

### `message`

直接存储一个 `AgentMessage`。

```json
{
  "type": "message",
  "id": "a1b2c3d4",
  "parentId": null,
  "timestamp": "2026-02-16T10:21:00.000Z",
  "message": {
    "role": "assistant",
    "provider": "anthropic",
    "model": "claude-sonnet-4-5",
    "content": [{ "type": "text", "text": "Done." }],
    "usage": {
      "input": 100,
      "output": 20,
      "cacheRead": 0,
      "cacheWrite": 0,
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "total": 0
      }
    },
    "timestamp": 1760000000000
  }
}
```

### `model_change`

```json
{
  "type": "model_change",
  "id": "b1c2d3e4",
  "parentId": "a1b2c3d4",
  "timestamp": "2026-02-16T10:21:30.000Z",
  "model": "openai/gpt-4o",
  "role": "default"
}
```

`role` 可选；context 重建时缺失视为 `default`。

### `service_tier_change`

```json
{
  "type": "service_tier_change",
  "id": "c1d2e3f4",
  "parentId": "b1c2d3e4",
  "timestamp": "2026-02-16T10:21:45.000Z",
  "serviceTier": { "openai": "priority", "google": "flex" }
}
```

`serviceTier` 是按 family 的映射，以 `openai`/`anthropic`/`google` 为键（各值 `auto`/`default`/`flex`/`scale`/`priority`），无活动 tier 时为 `null`。存储单个字符串（`"flex"`、`"openai-only"`、`"claude-only"` 等）的旧条目会在读取时规范化为该映射。

### `thinking_level_change`

```json
{
  "type": "thinking_level_change",
  "id": "c1d2e3f4",
  "parentId": "b1c2d3e4",
  "timestamp": "2026-02-16T10:22:00.000Z",
  "thinkingLevel": "high"
}
```

`configured` 可额外保留用户选择的选择器（`"auto"` 或具体级别）。读取旧条目的读者会回退到 `thinkingLevel`。

### `compaction`

```json
{
  "type": "compaction",
  "id": "d1e2f3a4",
  "parentId": "c1d2e3f4",
  "timestamp": "2026-02-16T10:23:00.000Z",
  "summary": "Conversation summary",
  "shortSummary": "Short recap",
  "firstKeptEntryId": "a1b2c3d4",
  "tokensBefore": 42000,
  "details": { "readFiles": ["src/a.ts"] },
  "preserveData": { "hookState": true },
  "fromExtension": false
}
```

### `branch_summary`

```json
{
  "type": "branch_summary",
  "id": "e1f2a3b4",
  "parentId": "a1b2c3d4",
  "timestamp": "2026-02-16T10:24:00.000Z",
  "fromId": "a1b2c3d4",
  "summary": "Summary of abandoned path",
  "details": { "note": "optional" },
  "fromExtension": true
}
```

从根分支（`branchFromId === null`）时，`fromId` 是字面字符串 `"root"`。

### `reset_boundary`

由 `/clear` 追加的无载荷标记。折叠后的实时转录与重建的模型 context 从最近适用边界之后开始；完整历史转录导出仍保留其之前的条目。

### `custom`

核心子系统或 extension 拥有的不透明、非 LLM 记录。`buildSessionContext` 不直接把它们变成模型消息，但子系统特定的重放代码可消费 `customType` 值以恢复运行时状态或诊断被打断的轮次。

```json
{
  "type": "custom",
  "id": "f1a2b3c4",
  "parentId": "e1f2a3b4",
  "timestamp": "2026-02-16T10:25:00.000Z",
  "customType": "com.example.my-extension.state",
  "data": { "state": 1 }
}
```

当前核心拥有的值包括：

| `customType` | `data schema` | Writer and consumer |
| --- | --- | --- |
| `tool_execution_start` | `{ toolCallId: string, toolName: string, startedAt: string, args?: { command?: string, path?: string }, intent?: string }` | `AgentSession` 在工具实现即将开始前写入一个标记。退出诊断把它与 assistant 工具调用及工具结果结合，以重建仍处于 pending 的调用。参数摘要是截断后的投影；旧版完整参数对象在读取时也被接受。 |
| `session_exit` | `{ reason: string, kind: "normal" \| "signal" \| "fatal" \| "process_exit", recordedAt: string, pendingToolCalls?: Array<{ toolCallId?: string, toolName: string, args?: unknown, intent?: string, assistantTimestamp?: number, startedAt?: string }> }` | 正常销毁与事后清理会在会话有 assistant 历史或 pending 工具调用时记录退出。写入方立即调用 `flushSync()`，使后续进程能检查最后一次持久化的轮次；刷新失败会被记录。恢复诊断消费最新有效记录。 |
| `user_todo_edit` | `{ phases: TodoPhase[] }` | SDK/UI 的 todo 编辑持久化完整的 phase 快照。todo 恢复会向后扫描最新的快照（或成功的 `todo` 工具结果）并恢复其 phases。 |
| `vibe-session-lifecycle` | Version-1 event with `{ version: 1, id, ownerId, parentSessionId, action, ... }`; `spawn` adds `cli`, `agent`, `childSessionFile`, and `createdAt`; turn events add `turn`; tombstone events add `reason`. | Vibe 运行时持久化并重放子进程派生、轮次开始/结束、tombstone 与 tombstone 撤销等转换，以恢复其拥有的子会话与进行中的状态。无效或超出范围的事件会被忽略。 |
| `autoresearch-control` | `{ mode: "on" \| "off" \| "clear", goal?: string }` | 内置的 autoresearch 命令写入 mode/goal 变更，实验上限关闭写入 `mode: "off"`。恢复时 `reconstructControlState()` 重放有效记录，以恢复 autoresearch 是否活动及其 goal；`clear` 移除 goal。 |

恢复时，若非终止的对话尾部之后存在有效的最近 `session_exit`，加载器会追加一条带 `stopReason: "aborted"` 的合成 assistant 消息，并重建显示/agent context。正常退出仅在记录了 pending 工具调用时才触发该转换；异常退出类型可在没有该列表时触发它。这可防止恢复的转录把被打断的轮次呈现为仍然存活。

表中的字符串为其核心消费者保留。extension 不得使用它们。extension 记录请使用命名空间标识符，如反向域名或包限定名；冲突可能使核心重放逻辑把 extension 数据解释为生命周期状态。未知的命名空间值对核心会话 context 重建保持不透明。

### `custom_message`

由 extension 提供、确实参与 LLM context 的消息。`content` 可以是字符串或文本/图像内容块，`attribution` 记录是由用户还是 agent 发起。

```json
{
  "type": "custom_message",
  "id": "a2b3c4d5",
  "parentId": "f1a2b3c4",
  "timestamp": "2026-02-16T10:26:00.000Z",
  "customType": "my-extension",
  "content": "Injected context",
  "display": true,
  "details": { "debug": false },
  "attribution": "agent"
}
```

### `label`

```json
{
  "type": "label",
  "id": "b2c3d4e5",
  "parentId": "a2b3c4d5",
  "timestamp": "2026-02-16T10:27:00.000Z",
  "targetId": "a1b2c3d4",
  "label": "checkpoint"
}
```

`label: undefined` 清除 `targetId` 的标签。

### `title_change`

会话重命名的只追加审计条目。它记录 `title`、`source`（`auto` 或 `user`），并可选记录 `previousTitle` 与 `trigger`。当前标题也会更新到固定宽度标题槽中，使列表无需整文件重写。

### `ttsr_injection`

```json
{
  "type": "ttsr_injection",
  "id": "c2d3e4f5",
  "parentId": "b2c3d4e5",
  "timestamp": "2026-02-16T10:28:00.000Z",
  "injectedRules": ["ruleA", "ruleB"]
}
```

### `credential_pin`

记录 provider 与一个假名化 SHA-256 账户/作用域哈希，用于把恢复的 OAuth 流量重新固定到服务账户，并保留账户作用域的 prompt-cache 复用。它不存储原始账户身份；导出的哈希仍可关联，并非匿名。

### `session_init`

```json
{
  "type": "session_init",
  "id": "d2e3f4a5",
  "parentId": "c2d3e4f5",
  "timestamp": "2026-02-16T10:29:00.000Z",
  "systemPrompt": "...",
  "task": "...",
  "tools": ["read", "edit"],
  "outputSchema": { "type": "object" },
  "outputSchemaMode": "strict",
  "restrictToolNames": true,
  "spawns": "*",
  "readSummarize": false
}
```

### `mode_change`

```json
{
  "type": "mode_change",
  "id": "e2f3a4b5",
  "parentId": "d2e3f4a5",
  "timestamp": "2026-02-16T10:30:00.000Z",
  "mode": "plan",
  "data": { "planFile": "/tmp/plan.md" }
}
```

## 版本化与迁移

当前会话版本：`3`。

### v1 -> v2

当 header `version` 缺失或 `< 2` 时应用：

- 为每个非 header 条目添加 `id` 与 `parentId`。
- 用文件顺序重建线性父链。
- 迁移 compaction 字段 `firstKeptEntryIndex` -> `firstKeptEntryId`（存在时）。
- 设置 header `version = 2`。

### v2 -> v3

当 header `version < 3` 时应用：

- 对 `message` 条目：把旧版 `message.role === "hookMessage"` 改写为 `"custom"`。
- 设置 header `version = 3`。

### 迁移触发与持久化

- 迁移在会话加载期间运行（`setSessionFile`）。
- 若运行过任何迁移，内存表示会标记为整文件重写，而非立即重写。
- 下一次持久化操作在增量追加继续之前执行整文件重写。

## 加载与兼容行为

`loadEntriesFromFile(path)` 行为：

- 文件缺失（`ENOENT`）-> 返回 `[]`。
- 至少 8 MiB 的当前文件使用流式 JSONL 加载器；较小或非文件存储使用整文本读取。
- 无法解析的行由宽松 JSONL 解析器处理。
- 可选固定宽度标题槽会被移除并折叠进 header。
- 若第一条逻辑条目不是有效会话 header（`type !== "session"` 或缺字符串 `id`）-> 返回 `[]`。

`SessionManager.setSessionFile()` 行为：

- 加载器的 `[]` 被视为空/不存在会话，并以该确切路径上的新初始化会话替换；其 header 会立即物化。
- 有效文件被加载、需要时迁移、解析 blob 引用，然后建立索引。

## 树与叶子语义

底层模型是只追加树 + 可变 leaf 指针：

- 每个追加方法恰好创建一个新条目，其 `parentId` 为当前 `leafId`。
- 新条目成为新的 `leafId`。
- `branch(entryId)` 只移动 `leafId`；既有条目保持不变。
- `resetLeaf()` 设置 `leafId = null`；下次追加创建一个新根条目（`parentId: null`）。
- `branchWithSummary()` 把 leaf 设为分支目标并追加 `branch_summary` 条目。

`getEntries()` 按插入顺序返回所有非 header 条目。正常操作中既有条目不会被删除；重写在更新表示（迁移、移动、定向重写辅助）的同时保留逻辑历史。

## Context 重建（`buildSessionContext`）

`buildSessionContext(entries, leafId?, byId?, options?)` 解析发送给模型的内容。`options.transcript: true` 改为构建显示用转录。完整转录模式内联保留 compaction；`collapseCompactedHistory` 只渲染当前压缩尾部，`keepDanglingToolCalls` 在轮次中途的 UI 重建期间保留仍在运行的 tool call。

算法：

1. 确定 leaf：
   - `leafId === null` -> 返回空 context。
   - 显式 `leafId` -> 若找到则使用该条目。
   - 否则回退到最后一个条目。
2. 沿 `parentId` 走到根，遇到重复 id 即停止以限制损坏的循环，然后反转得到根->leaf。
3. 沿路径派生运行时状态：
   - 最新 `thinking_level_change` 中已解析与配置的思考选择器
   - 最新 `service_tier_change` 中的 service tier
   - `model_change` 条目中的模型映射（`role ?? "default"`）；在出现显式 default 之前，assistant 消息推断仅是旧版回退
   - 去重后的 `injectedTtsrRules`
   - 最新 `mode_change` 中的 mode/modeData（默认 mode `"none"`）
4. 选择发射边界：
   - 更晚的 `reset_boundary` 会把到该边界为止的一切从模型 context 与折叠实时转录中隐藏
   - 否则最新 compaction 发射其摘要加保留的/压缩后消息（provider 原生替换历史可提供保留的模型 context）
   - 完整转录导出保留重置前历史，并按时间顺序渲染 compaction
5. 把 `message`、`custom_message` 与 `branch_summary` 条目转换为消息。其他条目类型只影响重放状态或元数据。
6. 从重放中移除悬空的 tool call（除非为轮次中途的转录显式保留），中和被重写轮次上受保护的 reasoning 元数据；从模型 context 中丢弃不安全的 aborted/error assistant 轮次及与其配对的工具结果。

## 持久化保证与失败模型

### 持久化 vs 内存

- `SessionManager.create/open/continueRecent/forkFrom` -> 持久模式（`persist = true`）。
- `SessionManager.inMemory` -> 非持久模式（`persist = false`），使用 `MemorySessionStorage`。

### 写入流水线

完成的条目更新内存，并在追加调用中一旦越过惰性文件创建门槛即同步交给文件/内存存储。没有 `fsync`，因此该保证覆盖软件崩溃，而非断电。流式部分文本在完成消息被追加前不持久化。

- 新的普通会话在包含 assistant 消息或调用方调用 `ensureOnDisk()` 之前只存在于内存。
- 该门槛之前，条目保留在内存中；越过它即写入完整标题槽、header 与累积条目。
- 之后，条目增量追加。
- 保存编辑器草稿会强制产生可发现的 header 并带标记存储 `draft.txt`；若草稿消失而只剩启动元数据，close 会移除该仅草稿会话。显式 `ensureOnDisk()` 的会话保持可恢复。
- 并发的完成追加会以权威的整文重写取代进行中的原子重写，使陈旧发布无法覆盖它们。

### 持久性操作

- `flush()` 排空异步磁盘/存储队列与打开的 writer（无 `fsync`）；`flushSync()` 在支持处执行同步排空/整文重写。
- 原子整文重写使用带提交守卫的存储 `writeTextAtomic`；文件存储先在目标上分阶段，然后重命名覆盖，包括 EPERM 安全的移开回退。
- 重写服务重命名、条目重写、迁移/净化、移动/fork 与恢复。会话标题变更通常更新固定宽度标题槽并追加 `title_change` 审计条目，而非重写正文。

### 错误行为

- 持久化错误被闩锁，由后续 flush/close/write 操作重新抛出；第一次以会话文件上下文记录一次。
- 失败的原子发布会尝试权威修复。若存储可能已发布写入且无法证明修复持久，`SessionPersistenceIndeterminateError` 会连同原始错误与恢复错误一起 fail-closed。
- writer 关闭会传播第一个有意义的错误。

## 数据大小控制与 blob 外部化

持久化条目之前：

- 超过 500,000 字符的字符串以 `"[Session persistence truncated large content]"` 截断，但签名/加密的 provider 块、签名字段与完整 Anthropic 原生 web-search 历史块除外——它们必须为重放保持字节精确。
- 移除瞬态 `jsonlEvents`。
- 若对象同时有字符串 `content` 与数值 `lineCount`，截断后重新计算行数。
- `image_url` 字段中的图像 data URL 无论长度如何，始终在 blob 存储中内容寻址，并替换为 `blob:sha256:<hash>`。其他 base64 图像载荷在 1,024 字符处外部化：图像内容/数据载荷与图像生成结果。
- 权威 reasoning 条目已存在于 `providerPayload` 时，省略冗余的 OpenAI Responses `thinkingSignature` 副本。

加载时，持久化的 blob 引用解析回下游传输所期望的内联载荷形状。

## 存储抽象

`SessionStorage` 拥有 `SessionManager` 使用的类文件系统操作：同步目录/存在性/写入/stat/list 操作；异步读取、切片读取、写入、带守卫的原子写入、重命名、unlink、感知 artifact 的删除、标题更新、writer 创建与后端排空。

实现与适配器：

- `FileSessionStorage`：真实本地文件
- `MemorySessionStorage`：map/chunk 支撑的内存存储，用于非持久会话与测试
- `IndexedSessionStorage`：共享本地索引加有序远程发布，用于 Redis/SQL 支撑的存储

`SessionStorageWriter` 暴露 `append`、可选 `appendSync`、`flush`、可选 `flushSync`、`isOpen`、`close` 与 `getError`。

## 会话发现辅助函数

发现辅助函数位于 `session-listing.ts`；`SessionManager` 暴露项目作用域的包装：

- `getRecentSessions(sessionDir, limit?)` -> 轻量欢迎元数据，默认 limit 4
- `findMostRecentSession(sessionDir)` -> 按 mtime 最新
- `listSessions(sessionDir, storage)` / `SessionManager.list(...)` -> 带生命周期状态的项目作用域
- `listSessionsReadOnly(...)` -> 相同元数据，不做备份恢复
- `listAllSessions(storage)` / `SessionManager.listAll()` -> 全部项目作用域
- `resolveResumableSession(...)` -> 先本地查找，再可选全局回退

最近/最近一次扫描只读取 4 KiB 前缀。完整列表读取该前缀加有界 32 KiB 尾部以获取生命周期状态。扫描按 stat 键控并缓存；大集合用有界并行 worker 处理。普通按目录扫描还会在主 JSONL 缺失时恢复最新的孤儿 EPERM 备份。恢复匹配不区分大小写，接受会话 id 前缀、完整文件名前缀或时间戳后的 id 后缀。

## 相关但不同：prompt 历史存储

`HistoryStorage`（`history-storage.ts`）是用于 prompt 回忆/搜索的独立 SQLite 子系统，而非会话重放。

- DB：`~/.omp/agent/history.db`
- 表：`history(id, prompt, created_at, cwd, session_id)`
- FTS5 索引：`history_fts`，由触发器维护同步
- 用内存中的 last-prompt 缓存对连续相同的 prompt 去重
- 插入经异步排空队列批量处理（约 100 ms 延迟），使 prompt 捕获不阻塞轮次执行

会话图/状态重放请使用会话文件；prompt 历史 UX 请使用 `HistoryStorage`。
