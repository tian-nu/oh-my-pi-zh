# ast_edit

> 通过原生 ast-grep 预览并应用针对源文件的结构化重写。

## 源码
- 入口：`packages/coding-agent/src/tools/ast-edit.ts`
- 面向模型的 prompt：`packages/coding-agent/src/prompts/tools/ast-edit.md`
- 关键协作模块：
  - `crates/pi-natives/src/ast.rs` — 原生重写规划与文件变更
  - `crates/pi-ast/src/language/mod.rs` — 原生 wrapper 使用的语言别名与扩展名推断
  - `packages/coding-agent/src/tools/path-utils.ts` — 路径/glob 解析与多路径解析
  - `packages/coding-agent/src/tools/resolve.ts` — 预览/应用排队
  - `packages/coding-agent/src/tools/render-utils.ts` — 解析错误去重与显示上限
  - `packages/coding-agent/src/utils/file-display-mode.ts` — hashline 与行号 diff 引用
  - `packages/hashline/src/format.ts` — 为预览锚点生成稳定的 hashline 标题格式
  - `packages/natives/native/index.d.ts` — JS 可见的原生绑定契约

## 输入

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `ops` | `{ pat: string; out: string }[]` | 是 | 一条或多条重写规则。`pat` 不能为空。重复的 `pat` 值会在原生执行前失败。空的 `out` 删除命中的节点。 |
| `paths` | `string[]` | 是 | 一个或多个文件、目录、glob 或由路径支撑的内部 URL。至少需要一个非空条目。内部 URL 的 glob 会被拒绝；抓取来的外部 URL 只读，不能被重写。 |

共享的 AST 模式语法与语言目录：见 [`ast_grep`](./ast-grep.md#inputs)。

- `ast_edit` 使用相同的 `$NAME`、`$_`、`$$$NAME` 与 `$$$` 元变量语义。
- 工具 prompt 增加了重写相关的约束：
  - 元变量名必须大写，且必须代表完整的 AST 节点，
  - `pat` 中的捕获会被代入 `out`，
  - 每次重写都是 1:1 的结构替换；一个捕获不能展开成多个兄弟节点，除非语法本身允许在该位置展开。

`ast_edit` 由 `astEdit.enabled` 默认启用。它是可发现的，而非必需工具集的一部分。

## 输出
- `ast_edit` 本身的单次预览结果。非空提案以 `Staged as a proposal — files NOT modified yet...` 开头，并指明 resolve/reject 设备路径。
- 面向模型的 `content` 是一个文本块，按文件分组展示提议的编辑（针对目录/多文件运行）。
  - 每处变更渲染为两行。hashline 模式在 `[PATH#TAG]` 标题下使用 `-LINE:before` / `+LINE:after`；plain 模式使用 `-LINE:COLUMN before` / `+LINE:COLUMN after`。
  - 每个 `before`/`after` 片段只显示首行，并在 wrapper 中被截断到 120 字符。
  - 适用时追加 `Limit reached; narrow paths.` 以及格式化后的解析问题。
- 若无重写命中，文本为 `No replacements made`；存在解析问题时再加上格式化后的解析问题。
- `details` 包含汇总的预览元数据：
  - `totalReplacements`、`filesTouched`、`filesSearched`、`applied`、`limitReached`
  - 可选的 `parseErrors`、`parseErrorsTotal`、`scopePath`、`files`、`fileReplacements`、`displayContent`、`searchPath`、`cwd`、`meta`
- 工具始终先预览（直接结果中 `applied: false`）。真正的文件写入只会在之后通过向 `xd://resolve` 的纯文本 `write` 发生；正文即理由。
- 当预览产生了替换时，`ast_edit` 还会排队一个待处理的 resolve 动作。成功的 apply 返回的是单独的 resolve 分发结果（在 `write` 调用上），而不是另一个 `ast_edit` 结果。

## 流程
1. `AstEditTool.execute()` 在 `packages/coding-agent/src/tools/ast-edit.ts` 中校验每个 op：
   - 空的 `pat` 失败，
   - 至少需要一个 op，
   - 重复的 `pat` 值失败，
   - ops 被转换为 `Record<pattern, replacement>`。
2. wrapper 通过 `$envpos(..., 1000)` 读取 `PI_MAX_AST_FILES`，并将其用作预览与应用的 native `maxFiles` 上限。
3. 路径规范化、内部 URL 处理、缺失路径划分与多路径解析遵循与 `ast_grep` 相同的 `path-utils.ts` 流程。
4. 作用域的 `isDirectory` 标志（由 `resolveToolSearchScope` 中的 stat 设置）决定是否渲染分组的目录输出。
5. `runAstEditOnce(...)` 在首轮始终以 `dryRun: true` 和 `failOnParseError: false` 运行原生 `astEdit(...)`。
6. `crates/pi-natives/src/ast.rs` 中的原生 `ast_edit`：
   - 规范化重写映射，并按模式字符串对规则排序，
   - 解析 strictness（默认 `smart`），
   - 通过单文件或感知 gitignore 的目录扫描收集候选文件，
   - 为每个候选文件独立推断语言，除非内部已提供 `lang`，
   - 为每种发现的语言编译每条重写；在某语言中无法解析的规则会跳过该语言的文件并上报解析问题，
   - 解析每个文件，跳过带语法错误树的文件，为每个命中收集 `replace_by(...)` 编辑，执行替换数与文件数上限，并返回文本化的 before/after 片段及源范围。
7. TS wrapper 对解析错误去重并设上限，按文件分组变更，并渲染预览 diff 行。
8. 若预览发现替换且 `applied` 为 false，`queueResolveHandler(...)` 会注册一个非强制的待处理 resolve 调用器。待处理期间，会话呈现一个携带 resolve 提醒的 `SoftToolRequirement`（`toolName: "write"`，带 `xd://resolve` 或 `xd://reject` 的 `satisfies` 谓词）；agent 运行时注入该提醒，且仅当模型在该轮拒绝时才强制 `write`。
9. 在 `write xd://resolve` 分发时，排队的回调以 `dryRun: false` 重跑同一组重写，重算计数，若实际结果不再匹配预览（`stalePreview`）则返回错误结果。当前实现会在重跑后比较替换总数与各文件计数；若新一次运行已写出不同的计数，结果会被标记为 error。
10. 在非 stale 的 apply 上，回调返回 `Applied N replacements in M files.`（hashline 模式下后面跟有根据 apply 后内容重新记录的 `[path#tag]` 快照标题）；在丢弃（`write xd://reject`）时，分发返回丢弃消息而不改动文件。

## 模式 / 变体
- 单文件：针对一个文件预览或应用。
- 目录 + 可选 glob：原生扫描遍历目录，再按编译后的 glob 过滤。
- 多个显式路径/glob：wrapper 将它们合并为一个合成作用域；当各路径仅在根处汇合时，则按目标逐个运行原生调用。
- 内部 URL 输入：仅当 router 将其解析为底层文件路径时才支持。
- 预览模式：始终是 `ast_edit` 工具的直接结果。
- 应用模式：只能在预览后通过排队的 resolve 回调（向 `xd://resolve` 或 `xd://reject` 的 `write`）到达。
- hashline 输出模式与 plain 行/列模式：由 `resolveFileDisplayMode()` 控制。

## 副作用
- 文件系统
  - 预览读取文件并扫描目录。
  - apply 先在内存中暂存每个变更文件，校验整轮通过后再写入暂存文件；后续的 compute/overlap 失败不会对先前文件造成部分改动。
- 会话状态（transcript、memory、jobs、checkpoints、registries）
  - 通过 `queueResolveHandler(...)` 注册非强制的待处理 resolve 调用器。
  - 待处理期间呈现带 resolve 提醒的 `SoftToolRequirement`；agent 运行时仅在不合规时强制 `write`——无引导消息，也无每次预览的强制工具选择。
- 用户可见的 prompt / 交互式 UI
  - 直接的 `ast_edit` 结果都是预览。
  - 后续的 apply/丢弃通过向 `xd://resolve` 与 `xd://reject` 的写入暴露。
- 后台工作 / 取消
  - 原生预览/应用工作通过 `task::blocking(...)` 在阻塞 worker 上运行。
  - 取消与可选的原生超时通过 `CancelToken::heartbeat()` 协作完成。

## 限制与上限
- wrapper 暴露的文件上限：`packages/coding-agent/src/tools/ast-edit.ts` 中的 `PI_MAX_AST_FILES`，默认 `1000`。
- 原生 `maxFiles` 与 `maxReplacements` 在 `crates/pi-natives/src/ast.rs` 中提供时都会被钳制到至少 `1`。
- wrapper 从不设置 `maxReplacements`；因此原生行为默认为单次运行内实际上不限制替换数。
- 解析问题通过 `packages/coding-agent/src/tools/render-utils.ts` 中的 `capParseErrors(...)` 去重并限制在 `PARSE_ERRORS_LIMIT = 20` 条内；`details.parseErrors` 携带受限后的列表，`details.parseErrorsTotal` 携带受限前去重后的数量。
- 目录扫描使用 `include_hidden: true`、`use_gitignore: true`，并在 `crates/pi-natives/src/ast.rs` 中跳过 `node_modules`，除非 glob 文本显式提到 `node_modules`。
- 不存在单独的 glob 展开数量上限。候选数量即解析后的路径/glob 在 gitignore 过滤后展开的数量；随后原生 `maxFiles` 会在触及文件数达到配置值后停止变更。
- 预览文本在 `packages/coding-agent/src/tools/ast-edit.ts` 中把每个渲染出的 `before` 与 `after` 首行截断到 120 字符。

## 错误
- 对空模式、重复的重写模式、空路径条目、不支持的内部 URL glob、无 `sourcePath` 的内部 URL 以及缺失路径，TS wrapper 抛出 `ToolError`。
- 原生代码对以下情况返回硬错误：
  - 无法为候选推断出受支持的语言（在 wrapper 的 best-effort 模式下作为解析问题上报），
  - 内部/原生调用中不支持的显式 `lang`，
  - glob 编译失败或搜索根不可读，
  - 计算出的编辑相互重叠（`Overlapping replacements detected; refine pattern to avoid ambiguous edits`），
  - 越界的编辑范围或非 UTF-8 的替换文本，
  - apply 期间的写入失败，
  - 取消或超时。
- 在 `failOnParseError: false` 下（wrapper 始终如此），模式编译失败与文件解析失败会变成 `parseErrors`，而不是中止整轮运行。
- 若所有重写模式都编译失败，原生 `ast_edit` 返回成功的零替换结果，并填充 `parseErrors`。
- 含 tree-sitter error 节点的文件会被跳过而不重写；它们不会得到部分编辑。
- 若预览在成功后变得 stale，apply 可能失败。resolve 回调会比较替换总数与各文件计数，并返回错误结果，而不是对不匹配的预览静默报告成功。

## 备注
- `ast_edit` 不向模型暴露原生 `lang`、`strictness`、`selector`、`maxReplacements`、`failOnParseError` 或 `timeoutMs` 字段。运行时把调用形态固定为预览优先、smart strictness、best-effort 解析模式。
- 支持混合语言作用域：原生层推断每个候选的语言，并按发现的语言分别编译每条规则。仅对部分语言可解析的模式会重写这些语言的文件，并对不兼容的语言上报解析问题。
- 幂等性不做语法层面的强制。像 `foo($A) -> foo($A)` 这样的重写预览为零变更，因为输出等于输入；会持续匹配自身输出的重写在重复调用时仍可能产生替换。
- 重写按文件累积，随后在重叠检查后从文件末尾向前应用。相互独立的命中可以共存；重叠的命中会中止整轮运行。
- 原生重写规则的顺序按模式字符串排序，而非按原始 `ops` 数组顺序，因为 `normalize_rewrite_map(...)` 会对 `(pattern, rewrite)` 对排序。
- 预览/应用的一致性通过 apply 重跑后的总数与各文件计数校验，而非对每个替换载荷做逐字节 diff。