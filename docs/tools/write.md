# write

> 创建或覆盖一个文件、可写的内部资源、归档条目、SQLite 行，或完成一次合并冲突解决。

## 来源
- 入口：`packages/coding-agent/src/tools/write.ts`
- 面向模型的 prompt：`packages/coding-agent/src/prompts/tools/write.md`
- 主要协作方：
  - `packages/utils/src/ar`（`@oh-my-pi/pi-utils/ar`）— 统一归档注册表：`parseArchivePathCandidates()` 解析归档选择器，`readArchiveEntries()`/`writeArchive()` 原子地重写容器。
  - `packages/coding-agent/src/tools/sqlite-reader.ts` — 检测 SQLite 路径并执行行 insert/update/delete。
  - `packages/coding-agent/src/tools/conflict-detect.ts` — 解析 `conflict://` URI、注册/校验区域，并展开 side 令牌。
  - `packages/coding-agent/src/internal-urls/router.ts` / `packages/coding-agent/src/tools/xdev.ts` — 可写的内部资源与 `xd://` 工具设备分发。
  - `packages/coding-agent/src/lsp/index.ts` — 写时格式化与诊断直写（writethrough）。
  - `packages/coding-agent/src/tools/auto-generated-guard.ts` — 阻止覆盖自动生成的文件。
  - `packages/coding-agent/src/tools/fs-cache-invalidation.ts` — 写入后使共享 FS 扫描缓存失效。
  - `packages/coding-agent/src/tools/plan-mode-guard.ts` — 解析路径并强制执行 plan 模式的写入策略。

## 输入
| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `path` | `string` | 是 | 目标路径。普通路径写文件。可写的内部 URL 委托给其 handler。`xd://<device>` 用 `content` 中的 JSON 分发已挂载的工具。`archive.ext:inner/path` 为 `.zip` 及 ZIP 格式别名（`.jar`、`.war`、`.ear`、`.apk`、…）、`.tar`、`.tar.gz`/`.tgz`、`.tar.zst`/`.tzst` 或 `.asar` 写入归档条目。`db.sqlite:table` 插入一行；`db.sqlite:table:key` 更新/删除一行。`conflict://<id>` 解决一个已注册的冲突，`conflict://*` 执行批量解决。复制来的 `[path#TAG]` 包装会被接受并移除。 |
| `content` | `string` | 是 | 完整的替换文件/归档/内部资源内容、冲突替换内容或 SQLite 行负载。SQLite 非删除写入必须能解析为 JSON5 对象；空或仅含空白的内容会删除带键的行。对 `xd://` 而言，这是所挂载工具的 JSON 参数对象。 |

实际示例：

```text
path: "src/generated/config.json"
content: "{\n  \"enabled\": true\n}\n"
```

```text
path: "fixtures/archive.zip:templates/email.txt"
content: "hello\n"
```

```text
path: "data/app.sqlite:users:42"
content: "{name: 'Ada', active: true}"
```

## 输出
Single-shot 结果。

- 成功时总是返回至少一个文本块，唯一的例外是 `xd://` 分发会保留所挂载工具自身的内容/错误结果。
  - 普通文件写入：`Successfully wrote <chars> bytes to <relative-path>`（该计数是 `cleanContent.length`，不是编码后的字节长度）。
  - 内部 URL 写入：`Successfully wrote <chars> bytes to <url>`。
  - 归档写入：`Successfully wrote <chars> bytes to <relative-archive-path>:<entry-path>`。
  - SQLite 写入：`Inserted row into <table>`、`Updated row '<key>' in <table>`、`No row updated ...`、`Deleted row ...`、`No row deleted ...` 之一。
  - 冲突解决：冲突专属的成功文本，适当时带全新的 hashline 快照头部。批量解决可能在部分文件成功、部分失败后返回 `isError: true`。
- 执行期间，`onUpdate` 可能发出 `Writing <chars> bytes to <path>...`；`xd://` 会转发所挂载工具的更新。
- 如果从 `read` 输出复制了 hashline 前缀并已先行剥离，第一个文本块会多一条说明。
- 在 hashline 显示模式下，普通文件写入（包括 ACP bridge 写入）与冲突解决会在前面加一个全新的 `[<relative-path>#TAG]` 头部，让下一次 `edit` 无需额外 `read` 就有当前快照标签。批量冲突解决会追加一个 `Snapshots:` 块，为每个成功写入的文件列出一行头部。
- 启用 LSP 写后诊断时，普通文件写入还可能返回 `details.diagnostics` 加 `details.meta.diagnostics`；新写入的 shebang 文件被 chmod 成可执行时，还会返回 `details.madeExecutable`。
- 普通/归档/冲突结果在由文件支撑时设置 `details.resolvedPath`。SQLite 写入还会通过 `sourcePath(...)` 把 `details.meta.source` 设为数据库文件。内部 URL 写入返回空的 `details`；设备分发设置 `details.xdev`。

## 流程
1. `WriteTool.execute()` 解包复制来的 `[path#TAG]` 参数，并从内部 URL 上剥下有效的 read 选择器，使 write 与 read 指向同一资源。可写 URL 上的畸形/区间选择器会被拒绝。
2. 在 hashline 显示模式下，它从 `content` 剥离粘贴进来的 `[PATH#HASH]` 头部与 `LINE:` 前缀。
3. 它校验类 URI 的目标。未知 scheme 与常见的 `xd://` 拼写错误会直接失败，而不会变成本地文件名；刻意创建长得像 URI 的 POSIX 文件名时，请加 `./` 前缀。
4. 若 `path` 是其 handler 暴露了 `write` 的内部 URL，工具会委托给它。`xd://` 在保留结果与审批层级的同时校验 JSON 并分发给所挂载的工具；`local://` 则落到会话本地的文件系统路径。
5. 接下来处理 `conflict://...`。`conflict://<id>/ours` 这类作用域读取是只读的；可写的冲突 URI 不带作用域。替换前会重新校验已注册的磁盘标记。
6. 它调用 `#resolveArchiveWritePath()`。候选归档文件按最长优先检查；都不存在时，用最短的候选归档路径来创建新容器。
7. 归档写入先调用 `enforcePlanModeWrite(..., { op: exists ? "update" : "create" })`，再调用 `#writeArchiveEntry()`。
   - 父目录会被递归创建。
   - 通过 `readArchiveEntries()` 加载既有条目，在条目映射中替换目标，再由 `writeArchive()` 序列化出完整的替换容器。
   - 替换内容先写入同级的临时路径，再改名覆盖目标。先解析既有的归档符号链接，以更新目标而不是替换符号链接。
   - ZIP 格式别名保持为 ZIP。`.tar.gz`/`.tgz` 选择 tar gzip 压缩，`.tar.zst`/`.tzst` 选择 zstd；`.asar` 容器经同一边界重写。只读格式（`.7z`、`.rar`、…）会被拒绝。
   - `invalidateFsScanAfterWrite()` 作用于归档文件路径。
8. 若不是归档，它尝试 SQLite 候选。已存在的非 SQLite 文件会抑制 SQLite 解释。
9. SQLite 写入调用 `enforcePlanModeWrite(..., { op: "update" })`，然后调用 `#writeSqliteRow()`。
   - 数据库必须已经存在。
   - 它用 `{ create: false, strict: true }` 和 `PRAGMA busy_timeout = 3000` 打开 Bun SQLite。
   - 仅含空白的 `content` 配合行键会删除一行。
   - 非空 `content` 用 `Bun.JSON5.parse()` 解析，必须是对象，然后路由到 insert/update 辅助函数。
   - 扫描缓存会失效，连接在 `finally` 中关闭。
10. 否则，它把 `path` 当作普通文件系统文件处理。
    - 它拒绝高置信度误分发的 read 目标：不存在的、selector 形状的文件名配上空内容，或不存在的、分号拼接的选择器路径列表。已存在的字面路径胜出；非空内容是单个有意为之的 selector 形状文件名的逃生口。
    - 变更前执行 plan 模式策略与路径解析。已存在的文件通过自动生成文件守卫。
    - 可用时优先尝试 ACP bridge 的 `writeTextFile`；否则由会话直写（writethrough）写入内容。LSP 设置可能对该写入进行格式化、同步与诊断。
    - 开头的 shebang 可能加上执行位。文件系统扫描缓存会失效。
11. 工具返回文本以及可选的诊断、可执行、已解析路径或设备分发元数据。

## 模式 / 变体
### 普通文件路径
- 目标是不解析为归档选择器、也不解析为已存在或新建的 SQLite 选择器的任何路径。
- 已存在的文件会被覆盖。
- `write.ts` 不会在此路径上调用 `fs.mkdir()`；显式的父目录创建只存在于归档分支，但 `Bun.write()` 本身会为普通文件写入创建缺失的父目录。

示例：

```text
path: "tmp/output.txt"
content: "hello\n"
```

### 归档条目写入
- 选择器语法：`archive.ext:inner/path`。
- 支持的后缀：`.zip` 与 ZIP 格式别名（`.jar`、`.war`、`.ear`、`.apk` 及其他 zip 族扩展名）、`.tar`、`.tar.gz`/`.tgz`、`.tar.zst`/`.tzst` 与 `.asar`。
- 内部路径会被规范化为 `/`，去掉空段与 `.` 段，拒绝 `..`，并拒绝以 `/` 结尾的目录目标。
- 替换一个条目后，通过临时文件加改名整体重写归档。
- 必要时为归档文件创建父目录。

示例：

```text
path: "build/assets.tar.gz:css/app.css"
content: "body { color: black; }\n"
```

### SQLite 表插入
- 选择器语法：`db.sqlite:table`。
- `content` 必须能解析为 JSON5 对象。
- 空对象是允许的，会变成 `INSERT INTO <table> DEFAULT VALUES`。
- SQLite 写入拒绝查询参数。

示例：

```text
path: "data/app.db:users"
content: "{name: 'Ada', active: true}"
```

### SQLite 行更新 / 删除
- 选择器语法：`db.sqlite:table:key`。
- 非空 `content` 更新该行。
- 空或仅含空白的 `content` 删除该行。
- 行查找优先使用单列主键；否则回退到 `rowid`。复合主键与 `WITHOUT ROWID` 表对基于键的写入会被拒绝。

更新示例：

```text
path: "data/app.sqlite:users:42"
content: "{email: 'ada@example.com'}"
```

删除示例：

```text
path: "data/app.sqlite:users:42"
content: ""
```

### 可写的内部资源与工具设备
- 带 `write` hook 的已注册内部 handler 拥有其资源的语义（例如 `vault://`）。`local://` 则被解析进会话本地的 artifact 沙箱，并走普通文件路径。
- `xd://` 列出/分发挂在 `write` 之后的工具设备。先 read `xd://<name>` 获取其生成的输入文档，再把一个 JSON 对象作为 `content` 传入。设备自身的 schema、更新、结果块、错误标志、renderer 元数据与审批层级都会被保留。
- 未知的类 URI scheme 会被拒绝，以防静默创建本地文件。只有在你确实想要该文件名时，才使用 `./scheme://...`。

### 合并冲突解决
- 先 read `<file>:conflicts`；这会注册会话级稳定的 id。`conflict://<N>` 只替换该记录的标记块，并拒绝过期/缺失的区域。
- 与 `@ours`、`@theirs`、`@base` 或 `@both` 完全相等的行会展开为已记录的一侧（`@both` 是先 ours 再 theirs）。`@base` 需要 diff3 base。其余内容按字面处理。
- 带普通内容的 `conflict://*` 会对每个已注册的冲突应用同样的替换/令牌展开。`1: @ours\n2: @theirs` 这类按 id 的指令内容只解决列出的 id；每个非空指令行必须使用一个 side 令牌，且 id 不得重复。
- 批量处理按文件整体全有或全无，自下而上应用。其他文件仍可成功；跨文件的部分成功返回 `isError: true`，而全失败的一趟会抛出异常。成功的 id 会失效，失败文件的 id 保留注册以重试。
- `/ours`、`/theirs`、`/base` 与 `/both` URI 作用域是只读的。


## 副作用
- 文件系统
  - 创建或覆盖普通文件。
  - 写入条目时，通过同级临时文件加改名原子地重写整个归档文件。
  - 显式为归档文件创建父目录；普通文件后端也支持缺失的父目录。
  - 变更已有的 SQLite 数据库；绝不会创建新的 SQLite DB。
  - 为 `conflict://...` 写入解决文件中的冲突标记。
  - 普通文件写入成功后，可能把 shebang 文件 chmod 成可执行。
- 子进程 / 原生绑定
  - 通过 `bun:sqlite` 使用 Bun SQLite 绑定。
  - 使用 `packages/utils/src/ar` 中的统一归档工具：tar 序列化加 gzip/zstd 帧来压缩 tar、`node:zlib` 支撑的 DEFLATE 帧用于 ZIP，以及一个 ASAR 编码器。
  - 可能通过 `packages/coding-agent/src/lsp/index.ts` 与配置好的 LSP 服务端通信。
- 会话状态
  - 通过 `invalidateFsScanAfterWrite()` 使共享文件系统扫描缓存的条目失效。
  - 在改动目标前强制 plan 模式的写入限制。
  - 更新普通文件与冲突解决的变更/快照状态；已解决的冲突 id 会失效。
  - `xd://` 分发一个已挂载的工具，因此可能有该工具文档记载的副作用。
- 后台工作 / 取消
  - 在 `WriteTool` 中把工具标记为 `concurrency = "exclusive"`。
  - 写入主体用 `untilAborted` 包裹；LSP 直写可以在超时后调度延迟的诊断获取。

## 限制与上限
- 普通/内部文件内容除内存处理外没有工具级字节上限。归档重写继承归档工具的上限：tar/tgz 输入 `256 MiB`、每个既有成员 `64 MiB`，且 ZIP 输出必须满足非 ZIP64 的 32 位条目/计数/偏移限制。
- 自动生成文件检测在 `packages/coding-agent/src/tools/auto-generated-guard.ts` 中最多读取既有文件的 `CHECK_BYTE_COUNT = 1024` 字节与 `HEADER_LINE_LIMIT = 40` 行头部。
- SQLite 写入设置 `PRAGMA busy_timeout = 3000`。
- LSP 直写在 `runLspWritethrough()` 中使用 `5_000` ms 的操作超时，并可能在 `scheduleDeferredDiagnosticsFetch()` 中用 `AbortSignal.timeout(25_000)` 调度一次延迟的诊断获取。
- shebang 可执行处理取决于宿主文件系统的 chmod 支持。

## 错误
- 非法归档子路径会抛出带如下消息的 `ToolError`：
  - `Archive write path must target a file inside the archive`
  - `Archive write path must target a file, not a directory`
  - `Archive path cannot contain '..'`
- SQLite 路径解析在遇到不支持的形式时抛出：
  - `SQLite write paths do not support query parameters`
  - `SQLite write path must target a table`
  - `SQLite row writes require a non-empty row key`
- 缺失的 SQLite DB 呈现为 `SQLite database '<path>' not found`。
- SQLite 内容错误包括非法 JSON5、非对象负载、未知列、非标量值、空更新对象、复合主键与 `WITHOUT ROWID` 键查找。
- 已存在的普通文件在看起来是自动生成的时候，可能被 `assertEditableFile()` 拒绝。
- 类 URI 的未知目标与畸形/缺失的 `xd://` 设备会失败，而不是写本地文件；已挂载的设备呈现其自身的 schema/工具错误。
- 对不存在的 selector 形状目标与分号拼接的选择器列表的空写入，会被当作疑似 read/write 误分发而拒绝。
- 冲突作用域写入是只读的；无效/过期的 id、畸形的批量指令、缺失的 `@base` 与过期的标记位置会呈现 `ToolError`。
- 归档读/写失败与意外的 SQLite 异常会被包进 `ToolError(error.message)`。
- 若没有匹配的 LSP 服务端，或 LSP 格式化/诊断超时，文件写入仍会完成；诊断可能被省略。

## 备注
- 归档路径检测先于 SQLite 检测。匹配归档选择器的路径绝不会被当作 SQLite 处理。
- 当带 `.sqlite` / `.db` 后缀的既有文件缺少 SQLite 魔数时，SQLite 检测会放弃；该路径回退为普通文件写入。
- 归档重写使用统一的 `readArchiveEntries()` / `writeArchive()` 边界与临时文件改名。字符串成员按 UTF-8 编码。
- prompt 禁止两种常见反模式：把本应使用 `edit` 的常规编辑拿去用 `write`，以及未经显式请求就创建 `*.md` / `README` 文件。它还禁止未经请求使用 emoji。
- 普通文件与内部 URL 写入把 `cleanContent.length` 报告为 “bytes”，这在 JS 里是 UTF-16 码元数，不是磁盘上的字节测量。
- `stripWriteContent()` 只在会话的文件显示模式启用了 `hashLines` 时才移除 hashline 前缀；否则内容原样写入。

- 该工具有 `strict = true`、`loadMode = "essential"` 与排他的并发。其 renderer 默认显示 12 行流式预览与 6 行完成预览；`xd://` 结果把渲染委托给所挂载的设备。