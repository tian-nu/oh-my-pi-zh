# read

> 通过一个 `path` 字符串读取文件、目录、归档、SQLite 数据库、内部资源、图像、文档与 URL。

## 来源
- 入口：`packages/coding-agent/src/tools/read.ts`
- 面向模型的 prompt：`packages/coding-agent/src/prompts/tools/read.md`
- 主要协作方：
  - `packages/coding-agent/src/tools/path-utils.ts` — 把 `path` 与尾部选择器拆分；优先字面文件名；规范化本地路径并恢复误分隔的路径列表。
  - `packages/utils/src/ar`（`@oh-my-pi/pi-utils/ar`）— 统一归档注册表：检测 `archive.ext:inner/path`，索引归档，列出/读取条目。
  - `packages/coding-agent/src/tools/sqlite-reader.ts` — 检测 SQLite 目标、解析选择器、渲染表。
  - `packages/coding-agent/src/tools/fetch.ts` — URL 解析、fetch/渲染管线、URL 缓存/artifacts。
  - `packages/coding-agent/src/internal-urls/router.ts` — 内置内部资源注册表，包括 `ssh://` 与 `xd://`；MCP 可能通告额外的 scheme。
  - `packages/coding-agent/src/edit/notebook.ts` — 把 `.ipynb` 转换为可编辑的 `# %% [...] cell:N` 文本。
  - `packages/coding-agent/src/utils/cpuprofile.ts` / `sample-profile.ts` — 汇总已识别的 profiler 报告。
  - `packages/coding-agent/src/utils/file-display-mode.ts` — 决定 hashline、行号或 raw 显示。
  - `packages/coding-agent/src/workspace-tree.ts` — 渲染目录树。
  - `packages/coding-agent/src/edit/file-snapshot-store.ts` — 存储已读行，供之后的 hashline edit 校验/恢复。
  - `packages/coding-agent/src/tools/index.ts` — 注册 `read: s => new ReadTool(s)`。

## 输入

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `path` | `string` | 是 | 文件系统路径、内部 URL 或 Web URL。可能以 `:50-100` 或 `:raw` 这类尾部选择器结尾。 |

### 选择器语法

对于普通的类文件读取，`packages/coding-agent/src/tools/path-utils.ts` 中的 `splitPathAndSel()` 只在最终后缀匹配下列形式之一时才识别它：

| 后缀 | 含义 |
| --- | --- |
| `:raw` | 原始（raw）/逐字模式。禁用结构化摘要与行前缀。 |
| `:img` | 把本地 `.svg`/`.svgz` 文件栅格化，作为图像块返回以用于视觉输入。仅支持本地 SVG/SVGZ 文件。 |
| `:conflicts` | 扫描本地文件中未解决的 Git 合并冲突区域，在会话冲突历史中注册它们，并渲染紧凑的 `#N Lx-Ly` 索引。 |
| `:N` / `:LN` / `:N-` / `:N..` | 从 1 起始行 `N` 开始，开放结尾。 |
| `:A-B` / `:LA-LB` / `:A..B` | 含两端的 1 起始行区间（`..` 是宽松别名，规范化为 `-`）。 |
| `:A+C` / `:LA+LC` | 从 `A` 开始的 `C` 行；工具会把它转换为结束行 `A + C - 1`。 |
| `:R1,R2,...` | 多个区间，读取前先排序并合并（例如 `:5-16,960-973`）。 |
| `:range:raw` 或 `:raw:range` | 同样的行选择，但输出为 raw。 |

`parseLineRangeChunk()` 中的校验：
- 行号是 1 起始的；`:0` 会抛出。
- `+` 计数必须 `>= 1`。
- `-` 结束值必须 `>= start`。

选择器解析对无法识别的尾部 `:...` 有意放过（fall through）；归档与 SQLite 路径消费各自的冒号语法。

URL 选择器在 `packages/coding-agent/src/tools/fetch.ts` 中单独解析，但对 `:raw`、`:N`、`:A-B`、`:A+C`、`:5-10,20-30` 与 `:range:raw` / `:raw:range` 使用同一个行区间解析器。由于 URL 端口也用 `:`，请在带主机/端口的 URL 上、选择器之前加尾部斜杠，例如 `https://example.com/:80`。
字面文件系统路径优先于选择器解释，因此已存在的、以貌似选择器的文本结尾的 POSIX 文件名会按字面读取。

## 输出
- 通过 `packages/coding-agent/src/tools/tool-result.ts` 中的 `toolResult()` 构建的 single-shot `AgentToolResult`。
- `content` 通常是一个文本块。图像读取可能返回 `[text, image]`。
- `details` 依赖路径。`ReadToolDetails` 可能包括：
  - `kind: "file" | "url"`（URL 路径使用 `kind: "url"`；文件读取通常省略 `kind`）
  - `isDirectory`
  - `resolvedPath`
  - `suffixResolution`
  - URL 字段：`url`、`finalUrl`、`contentType`、`method`、`notes`
  - `truncation`
  - `displayContent`（无前缀文本 + 供 TUI 渲染的起始行）
  - 结构化摘要的 `summary`（`lines`、`elidedSpans`、`elidedLines`）
  - `<path>:conflicts` 的 `conflictCount`
  - 工具恢复出误分隔的路径列表用于 TUI 显示时的 `displayReadTargets`
  - 来自 `packages/coding-agent/src/tools/output-meta.ts` 的 `meta`
- `details.meta.source` 被设为底层路径、URL 或内部 URL。
- `details.meta.truncation` 携带显示的区间、总行数/字节数、下一个偏移，以及缓存 URL 输出可选的 `artifactId`。
- 列表上限触发时，目录/归档列表与 SQLite 表列表也会设置 `details.meta.limits`。

## 流程
1. `ReadTool.execute()` 接受 `{ path }`。`file://...` 输入先用 `expandPath()` 展开。`conflict://<N>[/ours|theirs|base|both]` 在普通 URL 之前处理；`conflict://*` 只写。
2. 它通过 `packages/coding-agent/src/tools/fetch.ts` 的 `parseReadUrlTarget()` 尝试 Web URL 处理。
   - 普通 URL 读取调用 `executeReadUrl()`。
   - 带行选择器的 URL 读取会按需 fetch/渲染进 URL 缓存，然后在本地对渲染后的文本分页。
3. 它检查内部 URL 路由器，包括内置与 MCP 通告的 scheme。
   - 由实际文件支撑的 `local://` 资源会被提升进本地文件路径，使图像、转换、选择器与快照表现得如同文件系统读取。
   - `agent://` 查询提取（`/path` 或 `?q=`）绕过分页，直接返回提取到的内容。
   - `artifact://` 使用有界的、文件支撑的读取器，而不是加载整个 artifact。
   - 其余内部资源由 `#buildInMemoryTextResult()` 在内存中分页。
4. 它优先选择已存在的字面文件系统路径，然后才把貌似选择器的冒号当作归档、SQLite、PDF 图像或行选择器语法处理。
5. 接下来它用 `#resolveArchiveReadPath()` 尝试归档解析。
   - `parseArchivePathCandidates()` 在 `:sub/path` 之前识别 `.tar`、`.tar.gz`、`.tgz`、`.zip`、`.jar`、`.war`、`.ear` 与 `.apk`。
   - 成功时，`#readArchive()` 要么列出目录，要么把条目解码为 UTF-8 文本。
6. 它用 `#resolveSqliteReadPath()` 尝试 SQLite 解析。
   - `parseSqlitePathCandidates()` 在任何 `:table`、`:key` 或 `?query` 后缀之前扫描 `.sqlite`、`.sqlite3`、`.db`、`.db3`。
   - `#readSqlite()` 根据 `parseSqliteSelector()` 分发。
7. 否则它把输入当作本地文件系统路径。
   - `resolveReadPath()` 展开 `~`，相对路径按会话 cwd 解析，裸 `/` 视为会话 cwd，并重试 macOS 截图/NFD/弯引号变体。
   - 若路径不存在，`findUniqueWorkspaceSuffix()` 尝试工作区级的唯一后缀匹配（远程挂载跳过）。匹配活动 `local://` plan 基名的 cwd 根文件名可能恢复该 plan。作为最后的受保护恢复，误分隔的已存在路径列表会逐段读取；调用方仍应每个路径发一次 `read`。
8. 目录走 `#readDirectory()`。
9. 非目录按内容类型分支：
   - 图像元数据 / 内联图像
   - 汇总后的 macOS `sample` 或 V8 `.cpuprofile` 报告
   - 可编辑的 notebook 文本
   - markit 转换的文档
   - 二进制文件提示，除非显式给了 `:raw`
   - 可解析代码/散文的结构化摘要
   - 流式文本/行区间读取
10. 本地文本读取由 `streamLinesFromFile()` 流式处理，而不是加载整个文件。单个有界的非 raw 文本区间会在受限侧加上 `1` 行前导与 `3` 行尾随上下文；raw 与多区间读取保持精确。
11. 符合 hashline 条件的本地读取会把文件快照记入会话快照存储，供之后的 hashline edit 校验/恢复。超过快照字节上限的文件不会被快照。
12. 若发生了后缀解析，第一个文本块会加上 `[Path '...' not found; resolved to '...' via suffix match]` 前缀。

## 模式 / 变体

### 本地文本文件
- 无选择器：若启用了摘要且文件符合条件，`#trySummarize()` 调用 `summarizeCode()`。
  - 默认值：`read.summarize.enabled = true`；散文（`.md` 变体与 `.txt`）在 `read.summarize.prose = true` 之前保持不摘要；低于 `read.summarize.minTotalLines = 100` 的文件保持逐字。
  - 硬性防护：文件大小 `<= 2 MiB`（`MAX_SUMMARY_BYTES`），行数 `<= 20_000`（`MAX_SUMMARY_LINES`）。
  - 摘要输出保留所选声明，并用 `…` 或含 `{ … }` 的合并花括号对行替换被省略（elided）的跨度。当至少省略一个跨度时，文本内容以类似 `[…NNln elided; re-read needed ranges, e.g. <path>:5-16,40-80]` 的页脚结尾，其中使用实际省略处的具体区间。
  - 当被省略的块位于匹配的花括号行之间时，`#renderSummary()` 可能把它们合并成一个锚定行，而不是发出单独的起始/结束行。
- 显式选择器或摘要未命中：流式文本读取。
  - 默认开放结尾上限为 `read.defaultLimit = 300`，限制在 `[1, DEFAULT_MAX_LINES]`。
  - 单个有界的非 raw 文本区间在受限侧加上 `RANGE_LEADING_CONTEXT_LINES = 1` / `RANGE_TRAILING_CONTEXT_LINES = 3`。raw 与多区间读取保持精确；目录列表选择器直接切分渲染后的条目，不加上下文。
  - 非 raw 输出使用 `resolveFileDisplayMode()`：
    - 编辑模式为 hashline、读取非 raw、源可变且 edit 工具存在时，输出带行号的 hashline
    - 否则当 `readLineNumbers === true` 时可选输出行号
    - raw 模式两者都抑制
- hashline 模式下的前缀格式是 `[PATH#TAG]` 头部后跟 `LINE:TEXT`，例如 `[src/foo.ts#0A1B]` 与 `41:def alpha():`，来自会话快照存储加 `formatNumberedLine()` / `formatHashlineHeader()`。
- `edit`/hashline 路径稍后消费该头部加裸行号；四位十六进制标签是整个规范化文件的内容派生哈希，可通过记录它的会话快照存储解析。不可变源与 `:raw` 有意抑制 hashline 头部。

### 目录列表
- `#readDirectory()` 用以下参数调用 `buildDirectoryTree()`：
  - `maxDepth = 2`
  - `perDirLimit = 12`
  - `rootLimit = null`
  - 存在行选择器时为 `lineCap = limit`，否则该层不限
- `buildDirectoryTree()` 按最近修改排序同级，显示文件大小与相对年龄，树被截断时可能标记 `limits.resultLimit`。
- 空目录渲染为 `(empty directory)`。

### 归档

- 受支持的归档容器（`packages/utils/src/ar/registry.ts` 中的扩展名表）：tar 族 `.tar`、`.tar.gz`/`.tgz`、`.tar.bz2`/`.tbz2`/`.tbz`、`.tar.xz`/`.txz`、`.tar.zst`/`.tzst`、`.tar.z`；ZIP 族 `.zip`、`.jar`、`.war`、`.ear`、`.apk`、`.whl`、`.ipa`、`.xpi`、`.vsix`、`.nupkg`、`.cbz`；独立格式 `.rar`/`.cbr`、`.7z`、`.iso`、`.cab`、`.cpio`、`.rpm`、`.ar`/`.a`/`.lib`、`.deb`、`.lzh`/`.lha`、`.arj`、`.asar`；单流 `.gz`、`.bz2`、`.xz`、`.zst`、`.z`、`.lzma`。
- 语法：`archive.ext`、`archive.ext:path/inside`、`archive.ext:path/inside:50-60`。
- `openArchive()` 通过 `@oh-my-pi/pi-utils/ar` 注册表（`packages/utils/src/ar/open.ts`）分发；上限在 `packages/utils/src/ar/limits.ts`：内存中归档上限 256 MiB，索引读取 64 MiB，单个成员解出 64 MiB。
- 归档路径规范化 `/`，丢弃 `.` 段，拒绝 `..`。
- 目录读取列出直接子项；size > 0 时文件显示 `name` 加 ` (size)`。
- `#readArchiveDirectory()` 中目录列表默认上限为 `500` 条。
- 文件条目按 UTF-8 解码。非 UTF-8 条目返回 `[Cannot read binary archive entry '...' (...)]` 而不是字节。
- 文本归档条目复用常规的内存分页/锚定路径。

### Profiler 报告
- 有效的 macOS `sample` 调用树文件（`*.sample.txt`）与 V8 `.cpuprofile` JSON，在最多 `32 MiB` 内被渲染为瓶颈摘要而非原始转储。
- 行选择器对渲染后的摘要分页。`:raw` 绕过 profile 渲染并读取原始文件。
- 只是恰好有上述名称/扩展名、却无法解析为预期报告的文件会落到普通文本处理。


### SQLite 数据库
- 数据库检测既要求匹配的扩展名，也要求有效的 SQLite 文件头（`isSqliteFile()`）。
- `parseSqliteSelector()` 的选择器形式：

#### `db.sqlite`
- `kind: "list"`
- 列出非 `sqlite_%` 表及其行数。
- `#readSqlite()` 通过 `applyListLimit()` 把渲染列表上限设为 `500` 张表。

#### `db.sqlite:table`
- `kind: "schema"`
- 返回 `sqlite_master.sql` 加示例行。
- 示例大小是 `DEFAULT_SCHEMA_SAMPLE_LIMIT = 5`。

#### `db.sqlite:table:key`
- `kind: "row"`
- 表恰好有一个 PK 列时按主键解析；否则回退到 `rowid` 查找。
- 行查找不允许查询参数。

#### `db.sqlite:table?limit=...&offset=...&order=...&where=...`
- `kind: "query"`
- 默认值：`limit = 20`、`offset = 0`。
- `limit` 上限为 `500`。
- `order` 接受 `column` 或 `column:asc|desc`，且必须指名一个已存在的列。
- 只有在 `validateWhereClause()` 拒绝注释、分号以及 `LIMIT`、`OFFSET`、`UNION`、`ATTACH`、`PRAGMA` 这类控制关键字之后，`where` 才会被接受。
- 未知查询参数会抛出。

#### `db.sqlite?q=SELECT ...`
- `kind: "raw"`
- 不能与表选择器或任何其他查询参数组合。
- 空 `q` 会抛出。
- `executeReadQuery()` 准备 SQL、拒绝绑定参数，并从 `statement.iterate()` 收集行，上限为 `MAX_RAW_QUERY_ROWS = 1000`；它不校验 SQL 是否以 `SELECT` 开头。

- `packages/coding-agent/src/tools/sqlite-reader.ts` 中的渲染上限：
- ASCII 表宽 `120`（`MAX_RENDER_WIDTH`）
- 每列宽 `40`（`MAX_COLUMN_WIDTH`）
- `#readSqlite()` 以 `{ readonly: true, strict: true }` 打开 Bun SQLite，并设置 `PRAGMA busy_timeout = 3000`。

### 文档
- `packages/coding-agent/src/tools/read.ts` 中的 `CONVERTIBLE_EXTENSIONS` 覆盖 `.pdf`、`.doc`、`.docx`、`.ppt`、`.pptx`、`.xls`、`.xlsx`、`.rtf`、`.epub`。
- `convertFileWithMarkit()` 把文件转换为文本/markdown；行区间与 `:raw` 选择器随后作用于转换后的输出（`file.pdf:50-100`、`:5-16,40-80`）。
- 对 PDF 而言，嵌入图像会以可浏览的句柄形式呈现。markit 为每个嵌入图像发出一段 `<!-- image: <id> (page N, WxHpt) -->` 区域；`read.ts` 把它改写为 `read <pdf>:<id>.png` 提示（作为 inline code，因此路径中的空格/括号不会破坏 markdown）。读取该句柄（`doc.pdf:p11-img0.png`）会提取图像 —— 给 markit 传一个落在会话 artifact 缓存中的 `imageDir`（`<artifacts>/pdf-assets/<key>/`，按 size+mtime 键控，每个文件只转换一次）—— 并经由常规图像加载路径返回。`doc.pdf:` 列出可提取的成员；未知成员会报错并列出可用列表。请求的成员会与提取出的基名匹配，因此 `..`/分隔符无法逃出缓存。
- 转换失败返回类似 `[Cannot read .pdf file: ...]` 的文本块。

### Jupyter 笔记本
- 除非请求了 `:raw`，`.ipynb` 走 `readEditableNotebookText()`。
- 输出是带如下标记的可编辑纯文本：

```text
# %% [code] cell:0
...
```

- raw 模式绕过该转换，回退到文件文本读取。

### 图像
- 图像检测基于元数据（`readImageMetadata()`）。
- 可接受的最大图像大小是 `20 MiB`（`MAX_IMAGE_INPUT_BYTES`，重导出为 `MAX_IMAGE_SIZE`）。更大的文件会抛出。
- `read <image>?q=<question>` 为解析出的视觉模型加载图像，并把其答案作为一个文本块返回。
- 无 `?q=` 时，支持图像的活动的模型会收到一段文本说明加一个内联图像块。
- 无 `?q=` 时，仅文本的活动模型会收到元数据（MIME、字节数、尺寸、通道、alpha）加 `?q=<question>` 提示。
- `images.questionTimeoutMs` 限制每次委托的图像提问；`0` 禁用该超时。
- 不支持/无法解码的图像格式会抛出 `ToolError`。

### 内部 URL
- `read` 把内部与 MCP 通告的 scheme 委托给 `InternalUrlRouter`；内置注册表当前包括 `agent://`、`artifact://`、`history://`、`issue://`、`local://`、`mcp://`、`memory://`、`omp://`、`pr://`、`rule://`、`security://`、`skill://`、`ssh://`、`vault://` 与 `xd://`。
- `security://` 保留给 OMP 自有、provider 中立、只读的安全分析存储。
- `xd://` 列出已挂载的工具设备；`xd://<name>` 返回该设备的输入文档。向同一 URI 写 JSON 会通过 `write` 分发该设备。
- `ssh://host/<path>` 读取远程 UTF-8 文件或目录；裸 `ssh://` 列出配置好的主机。远程路径限制为 1 MiB，且需要 POSIX 远程 shell。路径中的字面 `:`、`?` 或 `#` 需要百分号编码。
- `#handleInternalUrl()` 的行为：
- 用 `parseInternalUrl()` 解析 URL，使主机段内的冒号合法
- 对 `agent://`，把非根路径提取或 `?q=` 提取当作特殊的无分页模式
- 把 `artifact://` 路由到有界的 artifact 文件读取器与大输出工作流提示
- 否则在内存中对解析出的文本分页
- 把 `immutable` 传给 `resolveFileDisplayMode()`，从而对 artifacts、skills、memory 与 agent 输出这类不可变资源抑制锚点
- 对 `skill://` 设置 `ignoreResultLimits: true`，使完整技能文本只被显式选择器分页，而非受常规默认行上限限制
- `conflict://` 独立于路由器处理。`<path>:conflicts` 注册块；`conflict://<N>` 读取一个已注册的标记块，`/ours`、`/theirs`、`/base` 或 `/both` 选择一侧。`conflict://*` 只写。
- `issue://<N>` / `pr://<N>`（以及长形式 `issue://<owner>/<repo>/<N>` / `pr://<owner>/<repo>/<N>`）走 `github` 工具写入的同一个 SQLite 缓存；`?comments=0` 选择无评论渲染。裸 `issue://` / `pr://`（以及仓库限定变体）用 `?state=`、`?limit=`、`?author=` 与 `?label=` 浏览实时列表。PR diff 使用 `pr://<N>/diff`、`/diff/<i>` 与 `/diff/all`。每种仓库限定形式也接受 GitHub Enterprise 主机前缀（`pr://ghe.example.com/<owner>/<repo>/<N>`）；不带点的主机（`pr://ghe/<owner>/<repo>/<N>`）在编号形式中被识别。短形式从会话 checkout 解析主机，因此企业仓库无需前缀。
- `memory://` 接受两种语法。`memory://root[/path]` 读取项目记忆根目录下文件支撑的记忆 artifacts（`memory://root` 解析为紧凑的启动摘要 `memory_summary.md`；更深路径寻址 `MEMORY.md` 与 `skills/<name>/SKILL.md` 这类文件，且 `memory://root/...` 支持供 `glob` 使用的 glob 模式）。`memory://<memory-id>` 按 id 查找一条活的 Mnemopi 记忆行 —— 工作记忆或情景记忆 —— 并返回完整存储内容（而非裁剪过的 recall 预览），其前有携带 `id`、`bank`、`store`、`memory_type`、`source`、`timestamp`/`created_at`、`importance`、`veracity`、`session_id` 与 `metadata` 的 YAML frontmatter 头。该 id 语法只在存在活的 mnemopi 后端会话（`memory.backend = mnemopi`）时可解析；使用 `hindsight` 时返回一条纠正性指引（hindsight 记忆不可寻址），未知 id 报错并指引到 `recall` 获取可用 id。这是 `memory_edit update` 的 read 对端：在覆盖被截断的预览之前，先读取完整行。
- `artifact://<id>` 把会话 artifact 解析为纯文本。选择器分页的读取可以任何大小从底层文件流式读取，但无界的 `:raw` 在 `50 KiB`（`MAX_ARTIFACT_RAW_INLINE_BYTES`）以上会被阻止，并给出指向有界区间（`artifact://<id>:1-3000`、`artifact://<id>:raw:1-3000`）与底层文件路径的工作流提示。裸/非 raw 读取流式输出有界的默认页，而不是物化整个 artifact。其他消费者的协议级整资源解析硬上限为 8 MiB（`packages/coding-agent/src/internal-urls/artifact-protocol.ts` 中的 `MAX_INLINE_ARTIFACT_BYTES`）；更大的 artifact 会用同样的选择器与底层路径提示拒绝整资源读取。仅路径消费者（search/grep、bash URL 展开）跳过内容物化，可处理任意大小的 artifact。

### Web URL
- `parseReadUrlTarget()` 接受 `http://`、`https://` 或 `www.` 目标。
- 普通 URL 读取调用 `packages/coding-agent/src/tools/fetch.ts` 中的 `executeReadUrl()`。
- `:raw` 表示原始 HTML/正文回退路径；普通 URL 读取偏好渲染过的、适合阅读的输出。
- 缓存输出可用时，`:N`、`:A-B`、`:A+C` 与逗号分隔的多区间不会重新 fetch。它们在先前或当前 URL 渲染的缓存输出上分页。
- `renderUrl()` 中的 URL 渲染管线：
  1. 规范化 scheme（裸 `www.` 补上 `https://`）
  2. 非 raw 时为已知站点尝试特殊 handler
  3. 用 `loadPage()` fetch
  4. 若内容是图像/PDF/DOCX 等，尝试二进制 fetch + markit/图像处理
  5. 直接处理 JSON，经 feed 解析器处理 feeds，直接处理纯文本
  6. 对 HTML 且非 raw 模式，尝试 markdown 替代、`URL.md`、内容协商、feed 替代、HTML 转文本渲染器、提取的链接文档，然后是 `llms.txt`
  7. 回退到原始正文文本/html
- URL 输出会用一个小头部包裹：

```text
URL: ...
Content-Type: ...
Method: ...
Notes: ...

---
```

- `method` 记录获胜路径（`json`、`feed`、`text`、`alternate-markdown`、`md-suffix`、`content-negotiation`、`image`、`markit`、`llms.txt`、`raw`、`raw-html` 等）。
- 当 fetch 到的资源是受支持的图像并经受住缩放时，URL 读取可能返回内联图像块。

## 副作用
- 文件系统
  - 打开并流式读取本地文件。
  - tar/tgz 归档在索引前整体读入内存（256 MiB 上限）；ZIP 归档经区段式中央目录读取索引。
  - 可能从会话 artifacts 目录读取 URL 缓存 artifact 文件。
  - URL 输出被截断或行区间分页需要持久化缓存正文时，写入 URL 输出 artifacts。
- 网络
  - URL 模式执行 HTTP fetch、二进制重新 fetch 与备选端点探测。
- 子进程 / 原生绑定
  - 对 `.db`/`.sqlite*` 使用 Bun SQLite。
  - 通过统一 `@oh-my-pi/pi-utils/ar` 注册表读取归档；ZIP 在 `packages/utils/src/ar/zip.ts` 中基于 `node:zlib` DEFLATE codec 加帧。
  - URL HTML 渲染可以委托给 `packages/coding-agent/src/tools/fetch.ts` 中的站点 handler 与 HTML 转文本后端。
- 会话状态
  - 把本地文本读取的整文件快照记录进 `session.fileSnapshotStore`，供之后的过期锚点恢复。
  - 把会话 `cwd`、`settings` 与 `localProtocolOptions` 传入进程级全局 `InternalUrlRouter.instance().resolve()` 以处理内部 URL。
  - 对缓存/截断的 URL 输出使用 `session.allocateOutputArtifact()`。
- 后台工作 / 取消
  - 只有确定性的磁盘读取不可中止：普通文件行/区间读取（`streamLinesFromFile`、多区间）与目录列表（`#readDirectory`）以 `undefined` 代替 `AbortSignal` 调用，因此读取中途的中断不会在本可瞬间完成的读取上呈现误导性的 "Operation aborted"。其余每个分支都保留信号，其辅助函数调用 `throwIfAborted(signal)` 以立即停止：URL/内部 URL 读取（网络）、归档、sqlite、文档转换、图像解码、结构化摘要、冲突扫描与后缀 glob 路径解析。

## 限制与上限
- `packages/coding-agent/src/session/streaming-output.ts` 中的共享文本截断默认值：
  - `DEFAULT_MAX_LINES = 3000`
  - `DEFAULT_MAX_BYTES = 50 * 1024`
- 本地文本开放结尾默认行上限：`read.defaultLimit`（默认 `300`），限制在 `[1, DEFAULT_MAX_LINES]`。
- 单个有界的非 raw 文本区间在受限侧加 `1` 行前导与 `3` 行尾随上下文。raw 与多区间读取保持精确。
- 文件流式块大小：`8 * 1024` 字节（`READ_CHUNK_SIZE`）。
- 行读取的本地流式字节预算：`max(DEFAULT_MAX_BYTES, maxLinesToCollect * 512)`。
- 结构化摘要只在文件大小 `<= 2 MiB` 且行数 `<= 20_000` 时运行。
- Profile 摘要只对最多 `32 MiB` 的已识别报告运行；`:raw` 绕过它们。
- 图像输入上限：`20 MiB`。
- 本地目录的目录树上限：深度 `2`，每目录子项 `12`。
- 归档目录默认列表上限：`500` 条；归档成员上限 `64 MiB`，tar/tgz 容器上限 `256 MiB`。
- SQLite：
  - 默认行查询上限 `20`
  - schema 示例上限 `5`
  - 最大查询上限 `500`
  - raw `?q=` 行上限 `1000`（`MAX_RAW_QUERY_ROWS`）
  - 表列表上限 `500`
  - 渲染宽度 `120`、列宽 `40`
  - busy 超时 `3000` ms
- `executeReadUrl()` 中展示给模型的 URL 读取结果截断为 `300` 行与 `50 KiB`；完整缓存输出可作为 artifact 附加。
- 内联 fetch 的 URL 图像：
  - 源字节上限 `20 MiB`
  - 缩放后内联输出上限 `300 KiB`
- 唯一后缀自动解析的 glob 超时：`5000` ms。
- 文件快照存储保留 `256` 个路径，每个最多 `4` 个版本（`packages/hashline/src/snapshots.ts` 中的 `DEFAULT_MAX_PATHS` / `DEFAULT_MAX_VERSIONS_PER_PATH`）；超过 `4 MiB`（`SNAPSHOT_MAX_BYTES`）的文件不会被快照。
- 当 artifact 超过 `50 KiB` 时，无界的 `artifact://<id>:raw` 读取会被拒绝；请使用有界的 `:raw:N-M` 区间。

## 错误
- 校验与操作失败呈现为 `ToolError`。
- 选择器错误包括：
  - `Line selector 0 is invalid; lines are 1-indexed. Use :1.`
  - 非法的 `A+B` / `A-B` 形状
  - `agent://.../path:50` 的 `Cannot combine query extraction with line selectors`
  - 目录/归档目录列表上的多区间
- `conflict://*` 读取会被拒绝；未知/过期的冲突 id 需要重新读取 `<path>:conflicts`。
- 缺失的本地/归档/sqlite 路径先尝试唯一后缀解析；没有唯一匹配或受保护恢复时它们报错。
- 越界的行读取不抛出。它们返回解释性文本，并给出 `Use :1 ...` 或 `Use :<last line> ...` 这类建议。
- 疑似二进制的本地文件返回提示，除非请求了 `:raw`。
- 二进制归档条目不抛出；它们返回文本提示。
- 文档转换失败返回文本提示。
- 图像过大/不支持/非法的情况会抛出。
- SQLite 解析器提前拒绝不支持的参数组合；DB/运行时错误会被捕获并作为 `ToolError(message)` 重新抛出。
- 当 HTTP fetch 成功但 `response.ok === false` 时，URL fetch 失败不会抛出；它返回 `method: "failed"` 的失败 URL 读取与解释性 notes。
- 大型无界 raw artifact 读取返回工作流提示，而不是把 artifact 加载进内存。

## 备注
- raw 读取与不可变内部资源会抑制 hashline 锚点，因为没有可供之后 `edit` 消费的可编辑底层目标。
- `splitPathAndSel()` 有意把未知的尾部 `:...` 当作路径的一部分，因此 `archive.zip:inner/file` 与 `db.sqlite:table:key` 仍然可用。
- `resolveReadPath()` 包含 macOS 特有的文件名回退，针对截图时间戳、NFD Unicode 规范化与弯引号。
- 裸 `/` 解析为会话 cwd，而非文件系统根。
- URL 缓存键按会话作用域，并按请求的 URL + raw/渲染模式规范化；请求的 URL 与最终重定向的 URL 都会被缓存。
- URL 行区间读取请求 `ensureArtifact: true, preferCached: true`，因此之后的翻页读取可以从 artifact 存储重新打开同一渲染正文。
- 除 “no bound parameters” 之外，raw SQLite `q=` 执行不受关键字限制；read 工具依赖周边契约来保持其只读。
- 文件快照存储不是读取加速缓存。它的存在是为了在读取之后文件发生变化时校验并恢复 hashline 编辑。