# ast_grep

> 通过原生 ast-grep 对受支持的源文件进行结构化代码搜索。

## 源码
- 入口：`packages/coding-agent/src/tools/ast-grep.ts`
- 面向模型的 prompt：`packages/coding-agent/src/prompts/tools/ast-grep.md`
- 主要协作者：
  - `crates/pi-natives/src/ast.rs` — 原生扫描、解析与匹配引擎
  - `crates/pi-ast/src/language/mod.rs` — 原生 wrapper 使用的语言别名与扩展名推断。
  - `packages/coding-agent/src/tools/path-utils.ts` — 路径/glob 解析与多路径解析
  - `packages/coding-agent/src/tools/render-utils.ts` — 解析错误去重与显示上限
  - `packages/coding-agent/src/tools/match-line-format.ts` — hashline 匹配渲染
  - `packages/coding-agent/src/utils/file-display-mode.ts` — hashline 与行号输出模式
  - `packages/natives/native/index.d.ts` — JS 可见的原生绑定契约

## 输入

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `pat` | `string` | Yes | 单个 AST 模式。wrapper 会修剪它并拒绝空字符串。 |
| `path` | `string` | No | 单个文件、目录、glob、带后备文件（backing file）的内部 URL，或抓取到的 web URL——也可以是其中若干个以分号分隔的列表（`"src; tests"`）。省略或为空时默认为 `.`（工作区根目录）。空条目会被拒绝。内部 URL glob 会被拒绝。 |
| `skip` | `number` | No | 匹配偏移量。默认 `0`，随后 `Math.floor(...)`；负数与非有限值会失败。 |

暴露给模型的模式语法与语言支持：
- `$NAME` — 捕获一个 AST 节点。
- `$_` — 匹配一个 AST 节点而不绑定。
- `$$$NAME` — 捕获零个或多个 AST 节点；ast-grep 会在下一个可满足的节点处惰性停止。
- `$$$` — 匹配零个或多个 AST 节点而不绑定。
- 元变量名必须大写，且必须代表完整的 AST 节点，而不是部分 token 或字符串片段。
- 重复使用同一元变量要求在每次出现处代码完全相同。
- 模式必须能解析为推断出的目标语言中的一个有效 AST 节点。
- 受支持的规范语言来自 `SupportLang::all_langs()`（在 `crates/pi-ast/src/language/mod.rs` 中定义）：`astro`, `bash`, `c`, `cmake`, `cpp`, `csharp`, `dart`, `clojure`, `css`, `diff`, `dockerfile`, `emacs-lisp`, `elixir`, `erlang`, `fortran`, `go`, `graphql`, `haskell`, `hcl`, `html`, `ini`, `java`, `javascript`, `json`, `just`, `julia`, `kotlin`, `lua`, `make`, `markdown`, `nix`, `objc`, `ocaml`, `odin`, `php`, `powershell`, `protobuf`, `python`, `r`, `regex`, `ruby`, `rust`, `scala`, `solidity`, `sql`, `starlark`, `svelte`, `swift`, `toml`, `tlaplus`, `tsx`, `typescript`, `verilog`, `vue`, `xml`, `yaml`, `zig`.

`ast_grep` 默认禁用（`astGrep.enabled = false`），启用后即成为可发现的（discoverable）工具。

## 输出
- 单次（single-shot）工具结果。
- 面向模型的 `content` 是一个文本块：
  - 目录/多文件搜索时按文件分组，
  - 匹配行在 hashline 模式下渲染于 `[PATH#HASH]` 之下、内容为 `*LINE:text`，否则为 `*LINE|text`，
  - 多行匹配的续行以行首空格渲染，
  - 当 ast-grep 捕获到元变量时，每个匹配可附带一行 `meta: NAME=value, …`。
- 若未找到匹配，文本为 `No matches found` 或 `No matches found. Parse issues mean the query may be mis-scoped; narrow \`path\` before concluding absence.`，并附上格式化后的解析问题。
- 若 wrapper 截断了可见结果，文本以 `Result limit reached; narrow path or increase limit.` 结尾。
- `details` 包含计数与元数据，而非完整的匹配负载：
  - `matchCount`、`fileCount`、`filesSearched`、`limitReached`
  - 可选的 `parseErrors`、`parseErrorsTotal`、`scopePath`、`searchPath`、`cwd`、`files`、`fileMatches`、`displayContent`、`meta`
- 原生范围（`byteStart`、`byteEnd`、`startLine`、`startColumn`、`endLine`、`endColumn`）只存在于原生结果内部；wrapper 不会把它们直接发给模型。

## 流程
1. `AstGrepTool.execute()` 校验 `pat`、规范化 `skip`，然后把路径解析委托给 `resolveToolSearchScope()`（位于 `packages/coding-agent/src/tools/path-utils.ts`），后者会规范化条目、展开分号分隔的列表（外加有条件的逗号/空白拆分），并拒绝空的 `path` 条目。
2. 内部 URL 通过共享 router 解析；缺少 `sourcePath` 的条目与内部 URL glob 会失败。可读的外部 URL 会被物化为不可变的本地文件以供搜索。
3. 对于多个路径输入，`partitionExistingPaths()` 仅在至少还有一个存活的 base 时丢弃缺失的 base；若所有 base 都缺失，调用失败。
4. `parseSearchPathPreferringLiteral()` 将单个路径拆分为 `basePath` 与可选的 `glob`。`resolveExplicitSearchPaths()` 将多个输入归并为一个公共 base 加 brace-union glob；当公共祖先本身不是所请求路径之一时，则拆分为各自的 `targets`。
5. wrapper 对解析出的 base 路径执行 stat，以决定输出是否应按目录结果分组。
6. 执行分派到以下两者之一：
   - 对单个解析出的 base 调用一次原生 `astGrep(...)`，或
   - `runMultiTargetAstGrep(...)`：对每个目标调用一次原生绑定、把路径重新映射回公共根、全局排序，然后应用 `skip` 与 wrapper 限制。
7. 原生 `ast_grep`（位于 `crates/pi-natives/src/ast.rs`）：
   - 规范化并去重模式，
   - 解析一个 `MatchStrictness`（默认为 `smart`），
   - 从单个文件或能识别 gitignore 的目录扫描中收集候选文件，
   - 若未提供 `lang`，则按扩展名为每个候选推断语言，
   - 为出现的每种语言分别编译模式，
   - 读取每个文件、把语法错误树报告为解析问题、运行 `find_all`，并可捕获元变量绑定。
8. 原生结果按路径与源码位置排序，然后按 `offset`/`limit` 分页。
9. TS wrapper 会规范化解析错误字符串、对其去重、按格式化后的路径对匹配分组、渲染锚点行、附加 limit/parse 提示，并返回 `toolResult(...).text(...).done()`。

## 模式 / 变体
- 单个文件：原生路径就是该文件；输出是渲染后匹配行的平铺列表。
- 目录 + 可选 glob：原生扫描遍历目录，再按编译后的 glob 过滤。
- 多个显式路径/glob：wrapper 将其合并为一个合成作用域；当路径仅在根处汇合时，则对每个目标分别运行原生调用。
- 内部 URL 输入：当 router 将其解析为后备文件路径时受支持。可读的外部 URL 会被物化为不可变的临时文件。
- hashline 输出模式与纯行号模式：由 `resolveFileDisplayMode()` 控制；hashline 模式要求 edit 工具与 hashline 编辑模式，逐文件锚点还额外要求一次成功的整文件快照（`recordFileSnapshot()`）——超出上限或不可读的文件会回退为纯文本输出。

## 副作用
- 文件系统
  - 在 TS wrapper 中对输入路径执行 stat。
  - 原生代码通过 `fs_cache` 读取匹配文件并扫描目录。
- 会话状态（transcript、memory、jobs、checkpoints、registries）
  - 除正常的工具 transcript/结果元数据外没有任何影响。
- 后台工作 / 取消
  - 原生工作通过 `task::blocking(...)` 运行在阻塞 worker 上。
  - 取消与可选的原生超时通过 `CancelToken::heartbeat()` 协作完成。

## 限制与上限
- wrapper 可见的结果上限：`DEFAULT_AST_LIMIT = 50`（定义于 `packages/coding-agent/src/tools/ast-grep.ts`）。
  - 单目标调用依赖 `crates/pi-natives/src/ast.rs` 中的原生默认限制 50。
  - 多目标调用为每个目标抓取 `skip + 50 + 1` 个匹配，在全局排序后重新分页。
- 原生 `limit` 至少被钳制为 `1`；省略的 `offset` 默认为 `0`（见 `crates/pi-natives/src/ast.rs`）。
- 解析问题最多以 `PARSE_ERRORS_LIMIT = 20` 行渲染（见 `packages/coding-agent/src/tools/render-utils.ts`）；`capParseErrors()` 还会把 `details.parseErrors` 限制为这 20 个去重后的条目，而 `details.parseErrorsTotal` 保留上限前去重后的总数。
- 目录扫描使用 `include_hidden: true`、`use_gitignore: true`，并跳过 `node_modules`，除非 glob 文本显式提到了 `node_modules`（见 `crates/pi-natives/src/ast.rs`）。
- wrapper 与原生 `ast_grep` 都不施加硬性的文件数上限；候选数量就是解析后的路径/glob 经 gitignore 过滤后展开得到的数量。
- 多路径合并会在 `resolveExplicitSearchPaths()` 的解析之前先去重相同的路径输入。

## 错误
- TS wrapper 抛出 `ToolError` 的情况包括：空模式、无效的 `skip`、空路径条目、不支持的内部 URL glob、缺少 `sourcePath` 的内部 URL 与缺失的路径。受支持的外部可读 URL 会在搜索前被物化，而不是被拒绝。
- 原生代码对以下情况返回硬错误：
  - 不可读的搜索根或错误的 glob 编译，
  - 取消（`Aborted: Signal`）或超时（`Aborted: Timeout`）。
- 文件级解析失败与按语言划分的模式编译失败不是致命的：它们会累积在 `parseErrors` 中，并与成功的匹配一同呈现；其语言没有可编译模式的文件会被跳过。
- `no matches` 不是错误，即使记录了解析问题也是如此。

## 备注
- TS 工具总是把 `pat` 包装成单元素 `patterns` 数组；即使原生绑定支持多个模式，模型也无法通过 `ast_grep` 发送多个模式。
- `ast_grep` 可以搜索混合语言树，因为原生编译按发现的每种语言进行；但 prompt 仍会告诉模型尽可能保持单语言调用，以减少解析噪声。
- 模式编译针对候选集中出现的每种语言进行。同一模式在一次运行中可能对某些语言成功，却对其他语言产生逐文件的解析错误。
- 含 tree-sitter 错误节点的文件仍会被搜索；语法警告是附加性的，不是跳过条件。
- 关于 glob 语义，`*.ts` 只匹配直接子项，而 `**/*.ts` 会递归匹配；这一点由 `crates/pi-natives/src/ast.rs` 中的原生测试覆盖。
- 输出锚点供后续工具使用，但锚点的确切格式取决于会话编辑模式（`hashline` 与行号模式）。
