# grep

> 用正则跨文件、目录、glob 与内部 URL 检索文件内容。

## 源码
- 入口：`packages/coding-agent/src/tools/grep.ts`
- 面向模型的 prompt：`packages/coding-agent/src/prompts/tools/grep.md`
- 关键协作模块：
  - `packages/coding-agent/src/tools/match-line-format.ts` — 面向模型的锚点格式化。
  - `packages/coding-agent/src/tools/path-utils.ts` — 路径规范化、glob 拆分与内部 URL 解析。
  - `packages/coding-agent/src/tools/file-recorder.ts` — 分组输出时的文件排序。
  - `packages/coding-agent/src/tools/grouped-file-output.ts` — 分组后的逐文件文本布局。
  - `packages/coding-agent/src/session/streaming-output.ts` — 行截断与最终字节截断。
  - `packages/coding-agent/src/config/settings-schema.ts` — 默认上下文行数。
  - `packages/natives/native/index.d.ts` — 暴露给 TS 的原生 `grep()` 类型。
  - `crates/pi-natives/src/grep.rs` — 原生正则/文件搜索实现。
  - `docs/natives-text-search-pipeline.md` — 原生搜索流水线概览。

## 输入

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `pattern` | `string` | 是 | 正则模式。`grep.ts` 拒绝纯空白输入，但会原样保留该模式。原生匹配器先尝试 Rust regex，对 lookaround/反向引用等特性再尝试 PCRE2，最后对格式错误的括号/花括号做针对性的字面量恢复。仅当模式包含字面换行符或两字符序列 `\\n` 时才启用 multiline。 |
| `path` | `string` | 否 | 单个文件路径、目录路径、类 glob 路径、归档成员、可读的外部 URL、内部 URL，或单文件行选择器（如 `src/foo.ts:50-100`）——也可以是上述若干项组成的分号分隔列表（`"src; tests"`）。省略或为空时默认为 `.`。空条目会被拒绝。分号分隔的列表无条件拆分；误用逗号或空白连接在一起的条目只有通过存在性校验后才会展开；已存在的含分隔符路径保持不变。内部 URL 不能包含 glob 字符。 |
| `case` | `boolean` | 否 | 区分大小写的搜索。默认为 `true`。对虚拟资源会传给原生 `ignoreCase` 或 JS `RegExp` 标志。 |
| `gitignore` | `boolean` | 否 | 目录扫描期间遵循 `.gitignore`。默认为 `true`。 |
| `skip` | `number` | 否 | 多文件结果的文件页偏移。默认为 `0`；`grep.ts` 会对有限数字向下取整，并拒绝负数或非有限值。单文件搜索会忽略它，因为单文件搜索不按文件分页。 |

`grep` 默认启用（`grep.enabled = true`），是可发现而非必需的工具。上下文默认值可通过 `grep.contextBefore` 与 `grep.contextAfter` 配置。

## 输出
工具在 `content[0].text` 中返回单个文本块，外加结构化的 `details`。

- 命中行由 `formatMatchLine()` 格式化：hashline 模式下，命中行输出 `*LINE:content`，上下文行输出 ` LINE:content`，置于 `[PATH#TAG]` 标题之下。
  - hashline 模式：`[src/login.ts#1F2A]`、`*5:content`、` 9:content`。
  - plain 模式：`*5|content`、` 9|content`。
- 目录与多文件结果通过 `formatGroupedFiles()` 分组为多级、前缀折叠的目录树：每层嵌套一个 `#`，目录标题以 `/` 结尾；文件标题在有可编辑的 hashline 锚点可用时带 `#TAG` 后缀。
- `details` 可能包含：
  - `scopePath` — 格式化后的搜索范围。
  - `matchCount`、`fileCount`、`files`、`fileMatches` — 当前页的计数。
  - `fileLimitReached` — 超过当前 20 文件页之外还有更多命中文件。
  - `perFileLimitReached` — 某个热点文件被裁剪到单文件命中上限。
  - `linesTruncated` — 一行或多行命中被缩短到 `512` 字符加 `…`。
  - `truncated` 与 `meta.truncation` — 最终文本输出被 `truncateHead()` 做了头部截断。
  - `displayContent` — 仅 TUI 使用的渲染文本，用 `│` 沟槽替代模型锚点。
  - `missingPaths` — 因基础路径不存在而被跳过的多路径条目。
- 无命中时结果文本为 `No matches found`（当 `skip` 越过最后一个文件页时为 `No more results (...)`），后面可选地跟有被跳过的缺失路径、不可读归档或超大文件的说明。

## 流程
1. `GrepTool.execute()` 在 `packages/coding-agent/src/tools/grep.ts` 中校验并规范化输入：
   - 拒绝纯空白模式，同时原样保留该模式；
   - 省略或为空的 `path` 默认为 `["."]`（工作区根）；
   - 将 `skip` 规范化为非负整数；
   - 用 `expandDelimitedPathEntries()` 展开被分隔符压平的 `path` 条目，保留已存在的含分隔符路径，无条件拆分分号分隔列表，在至少一个部分能解析时接受逗号拆分，且只有每个部分都能解析时才接受空白拆分；
   - 从每个结果条目中剥离行范围选择器；
   - 从会话设置读取 `grep.contextBefore` 与 `grep.contextAfter`（默认 `1` 与 `3`）；
   - 仅当 `pattern` 包含 `\n` 或真实换行符时启用 multiline。
2. 在共享作用域解析期间，每个 `path` 根都会再次用 `normalizePathLikeInput()` 规范化；对已由分隔符展开规范化的条目，这是 no-op。
3. 诸如 `bundle.zip:src/foo.ts` 之类的归档成员路径会在原生 grep 之前被物化为临时 UTF-8 暂存文件。二进制或非 UTF-8 的归档成员会被报告为跳过/不可读。
4. 内部 URL 与外部 URL 在文件系统作用域解析（`resolveToolSearchScope()`）之前解析：
   - 内部 URL 拒绝 glob 元字符（`*`、`?`、`[`、`{`）；
   - `ssh://` 路径尽早失败（`ssh://` 没有本地支撑文件）；
   - 可读的外部 URL（`http(s)://`、折叠的 `http(s):/host`、当无本地路径存在时的 `www.` 拼写）会被抓取并物化为不可变本地文件；`ftp`/`ws`/`wss` 与被拒绝的抓取会以显式错误失败；
   - 带 `sourcePath` 的资源通过其支撑文件搜索；
   - 无 `sourcePath` 的资源在内存中用 JavaScript `RegExp` 搜索；
   - `omp://` 通过 URL 补全展开为每个内嵌文档文件；
   - 不可变源会被跟踪，以便输出能按文件抑制可编辑的 hashline 编号输出。
5. 多路径调用中，`partitionExistingPaths()` 只跳过 ENOENT 条目。若所有文件系统条目都缺失且没有剩余的虚拟内部资源，工具报错。
6. 路径解析分支：
   - 单条目：`parseSearchPath()` 拆分 `basePath` 与可选 glob；
   - 多条目：`resolveExplicitSearchPaths()`（经由 `resolveToolSearchScope()`）计算公共基础目录、花括号并集 glob、精确文件列表或逐条目目标列表。当公共祖先本身不是被请求的作用域，或普通文件条目会被降级为目录遍历的 glob 并集时（`fanOutFileTargets`），目标会扇出。
7. 行范围选择器在路径/归档/内部解析之后校验。它们只允许用于单文件、归档成员或虚拟资源；glob/目录的行范围选择器会报错。
8. `grep.ts` 对解析后的基础路径做 stat，以决定按文件还是按目录处理。
9. 它以如下参数调用 `@oh-my-pi/pi-natives` 的原生 `grep()`：
   - `pattern`、`ignoreCase`、`multiline`、`gitignore`；
   - `hidden: true`；
   - 来自设置的 `contextBefore` / `contextAfter`；
   - `maxColumns: DEFAULT_MAX_COLUMN`（`512`）；
   - `maxCount: INTERNAL_TOTAL_CAP`（`2000`）；
   - `maxCountPerFile`：单文件命中上限加一；
   - `mode: content`；
   - 合并的 abort `signal` 与 `timeoutMs: SEARCH_GREP_TIMEOUT_MS`（`30_000`）。
10. 原生执行发生在 `crates/pi-natives/src/grep.rs`：
    - `build_matcher()` 对非量词的花括号做清理，并先尝试 Rust regex 引擎；
    - Rust regex 不支持的（包括 lookaround/反向引用）模式会用 PCRE2 重试；
    - 组平衡错误会用字面量括号重试；若两个引擎仍拒绝该模式，则按字面量搜索原模式。
11. grep 分发因解析出的路径集而异：
    - 精确显式文件或扇出的多目标：JS 遍历目标，自行合并 `grep()` 结果，并按绝对路径 + 行号对重叠目标去重；
    - 单文件/目录基础：一次 `grep()` 调用处理原生扫描。
12. 虚拟内部资源在 JS 中用 `RegExp` 搜索；归档暂存路径与虚拟路径会在渲染前映射回面向用户的选择器。
13. 随后 JS 输出整形会：
    - 把多文件输出限制为每页 20 个文件（`DEFAULT_FILE_LIMIT`），用 `skip` 作为下一个文件偏移；
    - 把多文件作用域的每文件命中数限制为 20，单文件作用域限制为 200；
    - 轮转挑选各文件的命中，避免单个文件独占页面；
    - 通过 `formatMatchLine()`（面向模型）与 `formatCodeFrameLine()`（面向 TUI）格式化行；
    - 在 hashline 模式下，用 `recordFileSnapshot()` 为每个渲染的文件记录整文件快照，以铸造 `#TAG` 锚点（归档、虚拟与不可变路径会被跳过）。
14. 最终文本经 `truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER })` 处理，因此实际上限是 `streaming-output.ts` 中的默认字节上限，而非默认行数上限。
15. `toolResult()` 附上文本及限制/截断元数据。

## 模式 / 变体
1. **单文件路径**
   - `grep()` 搜索一个文件。
   - 输出是命中/上下文行的扁平列表。
   - 在原生匹配与 JS 每文件上限之后，可见上限是最先的 `200` 个命中。
2. **单目录路径或单个类 glob 路径**
   - `parseSearchPath()` 可能把输入拆成 `path` + `glob`。
   - 一次原生 `grep()` 以 `gitignore` 与 `hidden:true` 扫描目录树。
   - 结果被分组到 20 文件页；配合限制消息中显示的下一个文件偏移使用 `skip`。
   - JS 会对所选文件的命中做轮转。
3. **多个显式路径/glob**
   - `resolveExplicitSearchPaths()` 把它们折叠为公共基础，并折叠为花括号并集 glob、显式文件列表，或在公共祖先本身不是被请求的作用域（或普通文件条目会被降级为目录遍历）时按目标搜索。
   - 缺失条目除非全部缺失，否则非致命跳过。
4. **归档成员路径**
   - 仅支持 UTF-8 文本条目。成员被提取到临时暂存文件供原生 grep 使用，然后显示为 `archive.ext:member`。
5. **内部 URL 路径**
   - 文件系统支撑的资源搜索其解析后的 `sourcePath`。
   - 无 `sourcePath` 的虚拟资源在内存中搜索其解析后的内容。
   - `omp://` 展开为所有内嵌文档文件，因此可被用作文档搜索根。
   - 无内部 URL glob。
   - 不可变与虚拟源会抑制可编辑的 hashline 锚点。

## 副作用
- 文件系统
  - 对解析后的搜索根与输入路径做 stat。
  - 通过原生 `grep()` 读取命中文件。
  - 通过 `recordFileSnapshot()` 把整文件快照记录到会话文件快照存储，用于 hashline 锚点。
- 会话状态（transcript、memory、jobs、checkpoints、registries）
  - 读取会话设置以获取上下文默认值。
  - 使用 `session.internalRouter` 解析内部 URL。
  - 用截断/限制元数据填充工具 `details.meta`。
- 后台工作 / 取消
  - 在 JS 层用 `untilAborted(signal, ...)` 包裹。
  - `grep.ts` 把 abort `signal` 与 `timeoutMs: SEARCH_GREP_TIMEOUT_MS`（`30_000`）传入原生 `grep()`，因此原生扫描可取消且有时间上限。

## 限制与上限
- 文件页上限：`20` 个文件（`packages/coding-agent/src/tools/grep.ts` 中的 `DEFAULT_FILE_LIMIT`）。
- 每文件命中上限：多文件作用域 `20`（`MULTI_FILE_PER_FILE_MATCHES`），单文件作用域 `200`（`SINGLE_FILE_MATCHES`）。
- 原生/JS 预选上限：`2000` 个命中（`INTERNAL_TOTAL_CAP`）。
- 行截断：每条输出行 `512` 字符（`packages/coding-agent/src/session/streaming-output.ts` 中的 `DEFAULT_MAX_COLUMN`）。原生 grep 会标记被截断的行；JS 报告 `linesTruncated`。
- 最终文本截断：`truncateHead()` 默认字节上限 `50 * 1024` 字节（`packages/coding-agent/src/session/streaming-output.ts` 中的 `DEFAULT_MAX_BYTES`）。`grep.ts` 把 `maxLines` 覆盖为 `Number.MAX_SAFE_INTEGER`，因此普通 grep 输出受字节上限而非行数上限约束。
- 上下文默认值：`packages/coding-agent/src/config/settings-schema.ts` 中的 `grep.contextBefore = 1`、`grep.contextAfter = 3`。
- 分页：`skip` 是多文件作用域的文件页偏移。当还有更多文件时，结果文本提示 `Use skip=<N> for the next page`。
- 原生目录扫描缓存：本工具在原生层禁用——`GrepOptions` 没有 `cache` 字段；`build_grep_walk_request` 在 `crates/pi-natives/src/grep.rs` 中硬编码 `.cache(false)`。
- 原生 grep 墙钟预算：每次调用 `30_000ms`（`packages/coding-agent/src/tools/grep.ts` 中的 `SEARCH_GREP_TIMEOUT_MS`）；触发时抛出 `Grep timed out after 30s; ...`。
- 原生每文件大小上限：`4 * 1024 * 1024` 字节（`crates/pi-natives/src/grep.rs` 中的 `MAX_FILE_BYTES`，在 `grep.ts` 中镜像为 `NATIVE_GREP_MAX_FILE_BYTES`）。过大的文件系统文件会被跳过并作为部分覆盖呈现（显式文件给名字，目录扫描给计数）。过大的虚拟资源在行模式下按行边界分块搜索；multiline 虚拟搜索回退到 JavaScript 正则。

## 错误
- trimmed `pattern` 为空时报 `Pattern must not be empty`。
- `skip` 为负或非有限时报 `Skip must be a non-negative number`。
- 任一规范化的 `path` 条目为空时报 `Search scope entries must be non-empty paths or globs`。
- 内部 URL 与 glob 元字符时报 `Glob patterns are not supported for internal URLs: ...`。
- `ssh://` 输入时报 `Cannot search a remote ssh:// path (no local file): ...`，并提示用 `read` 读取远程路径或 grep 特定远程文件。
- 对不可抓取的外部 URL scheme（`ftp`/`ws`/`wss`）或拒绝抓取时报 `Cannot search external URL: ... Use \`read\` to fetch web content, then search the returned text.`。
- 行范围选择器错误包括 `Line-range selector requires a single file, not a glob: ...`、`Line-range selector requires a single file: ... is a directory` 与 `Path not found for line-range selector: ...`。
- 当所有归档选择器都不可读、为二进制或非 UTF-8 时报 `Cannot search archive member(s): ...`。
- 当文件系统支撑的解析基础路径缺失时报 `Path not found: ...`（多路径调用会附加提示 `(\`path\` list entries must each exist relative to cwd)`），或当多路径的每个文件系统条目都缺失时报 `Path not found: ...; list each target in the semicolon-delimited \`path\``（不可读归档成员有贡献时会附带归档提示）。
- 虚拟资源的 JavaScript 正则编译可能报告 `Invalid regex: ...`。文件系统支撑的原生搜索通常会从 Rust regex 回退到 PCRE2，最后回退到字面量模式，而不是拒绝正则语法。
- 多文件原生扫描会跳过 `grep.rs` 内部的单文件打开/搜索失败；扫描会带着幸存文件继续。
- 原生 grep 命中 `SEARCH_GREP_TIMEOUT_MS` 时报 ``Grep timed out after 30s; narrow paths or pattern, or scope with `glob` first``。

## 备注
- 文件系统支撑的搜索先用 Rust regex；当模式需要 lookaround 或反向引用等特性时用 PCRE2。虚拟内存资源使用 JavaScript `RegExp`。
- 原生 `build_matcher()` 会自动转义无法成为合法量词的花括号。`a{2,4}` 这类合法量词仍作为正则语法。
- 若 Rust regex 与 PCRE2 都拒绝组语法，原生编译会先转义未转义的括号后重试，最后把原模式按字面量处理。
- 内部 URL 在路径存在性检查之前解析。有支撑的资源变成普通文件系统路径；虚拟资源保留在内存中，且不铸造可编辑的 hashline 锚点。
- `hidden:true` 在 `grep.ts` 中硬编码；没有面向模型的标志可排除点文件。
- `gitignore:false` 只影响原生目录遍历。它不会禁用工具自身的路径规范化或显式文件处理。
- 当 `path` 解析到多个精确文件时，每个目标在 JS 分组前使用 `2000` 内部上限。
- hashline 模式的段落标签是来自会话快照存储的四位十六进制不透明快照标签；`grep` 在可能时记录整文件快照，并在标题下打印裸行号。
