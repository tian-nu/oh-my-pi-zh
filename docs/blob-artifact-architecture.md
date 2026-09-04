# Blob 与工件存储架构

本文档描述 coding-agent 如何把大型/二进制负载存储在会话 JSONL 之外、截断的工具输出如何持久化，以及内部 URL（`artifact://`、`agent://`）如何解析回存储的数据。

## 为什么存在两套存储系统

运行时针对不同的数据形状使用两种不同的持久化机制：

- **内容寻址 blob**（`blob:sha256:<hash>`）：全局存储，用于从持久化的会话条目中外置大型图像 base64 负载和 provider 图像 data URL。
- **会话作用域工件**（`<sessionFile-without-.jsonl>/` 下的文件）：每会话的文本文件，用于完整工具输出和 subagent 输出。

两者有意分开：

- blob 存储按内容哈希优化去重和稳定引用，
- 工件存储优化只追加的会话工具链，以及按本地 ID 的人/工具取回。

## 存储边界与磁盘布局

### Blob 存储边界（全局）

`SessionManager` 构造 `BlobStore(getBlobsDir())`，因此 blob 文件位于共享的全局 blob 目录，而非会话文件夹中。

Blob 文件命名：

- 文件路径：`<blobsDir>/<sha256-hex>`
- 规范文件无扩展名；当提供了有效扩展名（图像 MIME 类型）时，会在其旁边硬链接或复制一个带类型的 sidecar `<sha256-hex>.<ext>`，以便 OS 打开器做类型检测
- 存储在条目中的引用字符串：`blob:sha256:<sha256-hex>`，其中哈希必须恰好是 64 个小写十六进制字符

含义：

- 跨会话的相同二进制内容解析为相同的哈希/路径，
- 写入在内容层面幂等，
- blob 可以比任何单个会话文件活得更久。

## 工件边界（会话本地）

`ArtifactManager` 从会话文件路径派生工件目录：

- 会话文件：`.../<timestamp>_<sessionId>.jsonl`
- 工件目录：`.../<timestamp>_<sessionId>/`（去掉 `.jsonl`）

工件类型共享该目录：

- 截断的工具输出文件：`<numericId>.<toolType>.log`（用于 `artifact://`）
- subagent 输出文件：`<outputId>.md`（用于 `agent://`）
- subagent 会话 JSONL sidecar：当任务执行收到工件目录时的 `<outputId>.jsonl`

Subagent 可以采用父级的 `ArtifactManager`；此时父级与 subagent 树共享一个工件目录和数字工件 ID 空间。

## ID 与名称分配方案

### Blob ID：内容哈希

`BlobStore.put()` / `putSync()` 对给定的字节计算 SHA-256 并返回：

- `hash`：十六进制摘要，
- `path`：`<blobsDir>/<hash>`，
- `displayPath`：提供了扩展名时为 `<blobsDir>/<hash>.<ext>`，否则为规范路径，
- `ref`：`blob:sha256:<hash>`。

不使用会话本地计数器。

### 工件 ID：会话本地单调整数

`ArtifactManager` 惰性创建目录，并在首次基于目录的分配时扫描现有 `*.log` 文件以找到最大数字 ID，设置 `nextId = max + 1`。并发的首次分配共享同一个初始化 promise，因此不会重复播种计数器并发号重复。

分配行为：

- 文件格式：`{id}.{sanitizedToolType}.log`
- 工具类型将 `[A-Za-z0-9_-]` 之外的字符折叠为 `_`、修剪周围下划线、上限 64 字符，并回退为 `tool`
- ID 是顺序字符串（`"0"`、`"1"` 等）
- resume 不会覆盖已有工件，因为扫描发生在分配之前

若工件目录缺失，初始化会创建它，分配从 `0` 开始。

没有采用管理器的非持久会话可以把 `saveArtifact(...)` 内容按数字 ID 存在内存中，但 `artifact://` 解析是经注册工件目录的文件后端。

### Agent 输出 ID（`agent://`）

`AgentOutputManager` 从请求的名称分配 ID，首次原样使用，仅重复时加后缀（`-2`、`-3` 等）。嵌套输出使用点号限定的父前缀（例如 `Parent.Child`）。初始化同时扫描 `.md` 输出和 `.jsonl` 子会话文件，使 resume 不会覆盖任何一方；保留的 advisor transcript 词干从不会被原样分配。

## 持久化数据流

### 1) 会话条目持久化改写路径

在会话条目写入之前 —— 增量追加（`#appendToSessionFile`）或整文件改写（`#rewriteSynchronously` / `#rewriteAtomically`）—— `SessionManager` 经 `#lineFor()` 序列化它，后者对截断管线运行 `prepareEntryForPersistence()`。

关键行为：

1. **大字符串截断**：超大的字符串被切割并加后缀 `"[Session persistence truncated large content]"`；签名字段（`thinkingSignature`、`thoughtSignature`、`textSignature`）被清除而非截断。
2. **瞬态字段剥离**：`partialJson` 和 `jsonlEvents` 从持久化条目中移除。
3. **图像外置到 blob**：
   - `content` 数组中的 image block 在 `data` 尚非 blob 引用且 base64 长度达到阈值（`BLOB_EXTERNALIZE_THRESHOLD = 1024`）时被外置，
   - provider 风格的 `image_url` data URL 在以 `data:image/` 开头且包含 `;base64,` 时被外置，
   - image block 的 `data` 存为解码后的二进制字节，
   - provider data URL 存为原始 UTF-8 data URL 字符串，
   - 持久化的值被替换为 `blob:sha256:<hash>`。

这保持会话 JSONL 紧凑，同时保留可恢复性。

### 2) 会话加载再水化路径

打开会话（`setSessionFile`）时，在迁移之后，`SessionManager` 运行 `resolveBlobRefsInEntries()`。

对于携带 `blob:sha256:<hash>` 的 message/custom-message image block，以及携带 blob 引用的持久化 provider `image_url` 字段：

- 从 blob 存储读取 blob 字节，
- 将 image block 字节转回 base64，
- 将 provider `image_url` blob 转回原始字符串，
- 就地变更内存中的条目字段供运行时消费者使用。

若 blob 缺失：

- image block 解析记录警告并在内存中保留原始 `blob:sha256:` 引用字符串，
- provider `image_url` 解析记录警告并保留原始引用字符串，
- 加载继续。

### 3) 工具输出溢出/截断路径

`OutputSink` 为 bash/python/ssh 及相关执行器提供流式输出。

行为：

1. 每个块经 `sanitizeWithOptionalSixelPassthrough(..., sanitizeText)` 消毒并追加到内存核算。
2. 可选的实时 `onChunk` 接收列上限前的已消毒块，配置时可节流。
3. 每行列上限可以从面向 LLM 的缓冲区中的长行丢弃字节；发生时启动工件镜像，使磁盘文件保留完整的已消毒流。
4. 当内存尾缓冲区将超过溢出阈值（`DEFAULT_MAX_BYTES`，50KB）时，sink 将输出标记为截断，并在工件路径可用时启动工件镜像。
5. 文件 sink 打开后，先写入当前缓冲区，再写入所有排队/后续的已消毒块。
6. 内存缓冲区裁剪到尾窗口，或配置了头保留时裁剪为头 + 省略标记 + 尾。
7. `dump()` 返回摘要，仅在文件 sink 创建成功时含 `artifactId`。

实际效果：

- UI/工具返回显示有界的输出，
- 完整的已消毒输出保留在工件文件中，文件后端工件镜像成功时以 `artifact://<id>` 引用。

若文件 sink 创建失败（I/O 错误、路径缺失等），sink 仅回退到内存截断；完整输出不持久化。

## URL 访问模型

### `blob:` 引用

`blob:sha256:<hash>` 是会话条目负载内的持久化引用，不是由 router 处理的内部 URL scheme。`SessionManager` 在加载时解析它。格式错误的尾部由 `parseBlobRef()` 在任何路径拼接之前拒绝、记录并保持不变，而不是从 blob 目录读取。

### `artifact://<id>`

由 `ArtifactProtocolHandler` 在已注册的活跃会话工件目录上处理：

- 要求数字 ID
- 优先使用调用会话固定的工件目录，再及其他已注册会话，因为数字 ID 是会话本地的
- 搜索文件名前缀 `<id>.`
- 返回原始 `text/plain` 供内联解析
- 缺失时报告可用的数字工件 ID
- 拒绝物化大于 8 MiB 的完整工件；请使用有界的 `read` 选择器或报告的后备路径进行搜索/复制工作流

仅路径消费者可以按任意大小解析后备文件而无需加载其字节。

失败行为：

- 无已注册工件目录：抛出 `No session - artifacts unavailable`，
- 有已注册目录但磁盘上均不存在：抛出 `No artifacts directory found`，
- ID 非数字：抛出 `artifact:// ID must be numeric, got: <id>`。

### `agent://<id>`

由 `AgentProtocolHandler` 在已注册的活跃会话工件目录及 `<artifactsDir>/<id>.md` 上处理：

- `agent://<id>` 返回 markdown 文本
- `agent://Parent/Child` 先尝试嵌套输出 `Parent.Child.md`
- 仅当没有嵌套输出匹配时，斜杠路径才回退为从基础输出做 JSON 提取
- `?q=` 总是执行 JSON 提取
- 路径与查询提取不能组合
- 提取要求有效 JSON 并返回 `application/json`

失败行为：

- 无已注册工件目录：抛出 `No session - agent outputs unavailable`，
- 有已注册目录但磁盘上均不存在：抛出 `No artifacts directory found`，
- 输出缺失时抛出 `Not found: <id>`，目录列举成功时附可用的 `.md` 输出 ID。

Read 工具集成：

- `read` 对非提取的内部 URL 读取支持行范围和 raw 选择器
- 当 `agent://` URL 包含路径或查询提取语法时行选择器被拒绝；提取直接返回，不分页

## Resume、fork 与移动语义

### Resume

- `ArtifactManager` 在首次分配时扫描一次现有 `{id}.*.log` 文件并继续编号。
- `AgentOutputManager` 扫描现有 `.md` 和子 `.jsonl` ID 并继续名称加后缀。
- `SessionManager` 在加载时将 blob 引用再水化为 base64/data URL。

### Fork

`SessionManager.fork()` 创建带新会话 ID 和 `parentSession` 链接的新会话文件，然后返回旧/新文件路径。工件复制由 `AgentSession.fork()` 处理：

- 先 flush 当前会话，
- 尝试将旧工件目录递归复制到新工件目录，
- 容忍旧目录缺失，
- 非 ENOENT 的复制错误作为警告记录，fork 仍完成。

fork 后的 ID 含义：

- 复制成功时，新会话的工件计数器在新的 `ArtifactManager` 首次扫描时从已复制的最大 ID 之后继续，
- 复制失败/跳过时，新会话的工件 ID 从 `0` 开始。

fork 后的 blob 含义：

- blob 是全局且内容寻址的，因此无需复制 blob 目录。

### 移动到新 cwd

`SessionManager.moveTo()` 将会话文件和工件目录都重命名到新的默认会话目录，后续步骤失败时有回滚逻辑。这会在迁移会话作用域的同时保留工件身份。

## 失败处理与回退路径

| 情况                                                      | 行为                                                                                   |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| image block 再水化时 blob 文件缺失                        | 警告并在内存中保留 `blob:sha256:` 引用字符串                                           |
| provider `image_url` 再水化时 blob 文件缺失               | 警告并在内存中保留 `blob:sha256:` 引用字符串                                           |
| `BlobStore.get` 读取 blob ENOENT                          | 返回 `null`                                                                            |
| 工件目录缺失（`ArtifactManager.listFiles`）               | 返回空列表（分配可以从零开始）                                                         |
| 无已注册工件目录（`artifact://`）                         | 抛出 `No session - artifacts unavailable`                                              |
| 无已注册工件目录（`agent://`）                            | 抛出 `No session - agent outputs unavailable`                                          |
| 已注册工件目录在磁盘上缺失                                | 抛出显式的 `No artifacts directory found`                                              |
| 找不到工件 ID                                             | 抛出并列出可用 ID                                                                      |
| 完整 `artifact://` 解析超过 8 MiB                         | 拒绝内联物化；有界选择器/仅路径工作流仍可用                                            |
| OutputSink 工件写入器初始化失败                           | 仅以有界的内存输出继续                                                                 |
| 非持久 `saveArtifact`                                     | 文本存入 `SessionManager` 内存 map；非文件后端 URL 数据                                |

## 二进制 blob 外置与文本输出工件

- **Blob 外置**针对持久化会话条目内容内的图像负载和 provider 图像 data URL；它把 JSONL 中的内联负载字符串替换为稳定的内容引用。
- **工件**是执行输出和 subagent 输出的纯文本文件；文件后端的工件可通过内部 URL 按会话本地 ID 寻址。

两套系统只是间接相交：都减少会话 JSONL 膨胀，但它们有不同的身份、生命周期和取回路径。

## 实现文件

- [`src/session/blob-store.ts`](../packages/coding-agent/src/session/blob-store.ts) — blob 引用格式、哈希、put/get、外置/解析辅助函数。
- [`src/session/artifacts.ts`](../packages/coding-agent/src/session/artifacts.ts) — 会话工件目录模型与数字工件 ID/路径分配。
- [`src/session/streaming-output.ts`](../packages/coding-agent/src/session/streaming-output.ts) — `OutputSink` 的截断/溢出到文件行为与摘要元数据。
- [`src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts) — `BlobStore`/`ArtifactManager` 构造、持久化变换与 blob 再水化调用点、会话 fork/move 交互。
- [`src/session/session-persistence.ts`](../packages/coding-agent/src/session/session-persistence.ts) — `prepareEntryForPersistence()`：大字符串截断、瞬态字段剥离与同步图像 blob 外置。
- [`src/session/session-loader.ts`](../packages/coding-agent/src/session/session-loader.ts) — `resolveBlobRefsInEntries()`：加载时 blob 引用再水化为 base64 / data URL。
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts) — 交互式 fork 期间的工件目录复制。
- [`src/internal-urls/artifact-protocol.ts`](../packages/coding-agent/src/internal-urls/artifact-protocol.ts) — `artifact://` 解析器。
- [`src/internal-urls/agent-protocol.ts`](../packages/coding-agent/src/internal-urls/agent-protocol.ts) — `agent://` 解析器 + JSON 提取。
- [`src/internal-urls/router.ts`](../packages/coding-agent/src/internal-urls/router.ts) — 内部 URL router 接线。
- [`src/task/output-manager.ts`](../packages/coding-agent/src/task/output-manager.ts) — `agent://` 的会话作用域 agent 输出 ID 分配。
- [`src/task/executor.ts`](../packages/coding-agent/src/task/executor.ts) — subagent 输出工件写入（`<id>.md`）与会话 JSONL sidecar。
