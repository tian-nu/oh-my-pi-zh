# edit

> 应用源代码编辑。默认的 `hashline` 模式消费一条以行锚定的补丁字符串，并直接编辑已有文件。

## 源码位置
- 入口与模式注册：`packages/coding-agent/src/edit/index.ts`
- hashline schema：`packages/coding-agent/src/edit/hashline/params.ts`
- 面向模型的 hashline 提示词：`packages/hashline/src/prompt.md`
- 规范的受限解码语法：`packages/hashline/src/grammar.lark`
- 解析与应用：`packages/hashline/src/input.ts`、`packages/hashline/src/parser.ts`、`packages/hashline/src/apply.ts`
- 快照校验/恢复：`packages/hashline/src/snapshots.ts`、`packages/hashline/src/patcher.ts`、`packages/hashline/src/recovery.ts`
- coding-agent 执行/结果整形：`packages/coding-agent/src/edit/hashline/execute.ts`
- 流式预览策略：`packages/coding-agent/src/edit/streaming.ts`、`packages/coding-agent/src/edit/hashline/diff.ts`

## 模式选择与可用性

`edit` 是一个内置核心工具。`resolveEditMode()` 按以下顺序选择生效的线上（wire）契约：

1. 模型特定的已配置变体；
2. `PI_EDIT_VARIANT`；
3. `edit.mode`；
4. 默认 `hashline`。

支持的模式有 `hashline`、`apply_patch`、`patch` 与 `replace`。除非设置了 `PI_STRICT_EDIT_MODE`，否则一份简短的模型排除名单可以把默认的 hashline 契约替换为 `replace`。本页记录的是默认的 hashline 契约；工具的 schema、提示词、示例、渲染器以及可选的自定义 Lark 格式都会随所选模式一起切换。在 `apply_patch` 自定义工具模式下，线上名称为 `apply_patch`；分发仍会到达同一个内部工具。

## 输入

| 字段 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `input` | `string` | 是 | 一个或多个包含 hashline 操作的 `[PATH#TAG]` 段。严格的 custom-tool 语法会把各段包裹在 `*** Begin Patch` / `*** End Patch` 中；普通解析器也接受未包裹的负载。 |

每个段编辑一个已有文件，并且必须从最近一次带锚定的 `read`、`grep` 或成功的 `edit` 结果中复制四位大写十六进制快照标签：

```text
[src/example.ts#1A2B]
PUT 4.=4:
+const value = 2;
```

使用 `write` 创建或整体覆盖文件。hashline 会在应用阶段拒绝未带标签的锚定编辑。

## 规范补丁语法

所有行号都指向原始加标签的快照，而不是同一次调用中更早的 hunk。

| 形式 | 效果 |
| --- | --- |
| `PUT N.=M:` | 用随后的 `+TEXT` 行替换包含首尾的原始行 `N..M`。 |
| `PUT N*:` | 替换从第 `N` 行开始的多行语法块。 |
| `PUT <N:` / `PUT >N:` | 在第 `N` 行之前 / 之后立即插入正文行。`PUT <1:` 表示文件头部。 |
| `PUT >$:` | 在文件末尾追加正文行。 |
| `PUT >N*:` | 在从第 `N` 行开始的语法块之后插入。 |
| `CUT N.=M` / `CUT N*` | 删除并捕获一个包含首尾的范围或已解析的块。添加 `@name` 可写入命名寄存器。 |
| `PUT <N` / `PUT >N` / `PUT >$` | 把匿名寄存器粘贴到间隙中。 |
| `PUT <N @name` / `PUT >N @name` / `PUT >$ @name` | 把命名寄存器粘贴到间隙中。 |
| `PUT N.=M @name` / `PUT N* @name` | 用命名寄存器替换一个范围或块。span/块粘贴必须使用命名寄存器。 |
| `REM` | 删除该段的文件。 |
| `MV DEST` | 在该段完成任何前置编辑后移动/重命名该段的文件。含空格的路径目标需加引号。 |

寄存器名称只能包含 ASCII 字母、数字、`_` 或 `-`。匿名寄存器是批次局部的，每次调用开始时为空。命名寄存器在会话期间持续存在，并且只在其写入落地后才发布。操作按段自上而下执行，因此较早段中的剪切可以供给较晚的粘贴。重复粘贴不会消耗其寄存器。

只有带正文的 `PUT ...:` 头会接受正文行。每个正文行都是 `+TEXT`；单独的 `+` 插入一个空行。正文是最终内容，绝不是统一 diff 的前/后配对。以 `-` 或 `+` 开头的字面内容写作 `+-...` 或 `++...`。`CUT`、基于寄存器的 `PUT`、`REM` 与 `MV` 不接受正文。

### 块锚点

块形式从起始行一直到 tree-sitter 节点的结尾来解析。请锚定构造体的起始处，绝不要锚定结束分隔符、最后可见行、空行或内部语句。单行节点会被拒绝，并提示改用对应的显式行操作。当没有可解析的块时，`PUT >N*:` 会降级为普通的 `PUT >N:` 并给出警告；replace/cut 的块形式则会失败而不是猜测。

前导的装饰器、属性与文档注释可能是独立的语法节点。当解析器把第一个装饰器与声明归为一组时，锚定第一个装饰器；否则使用显式范围。独立的行注释不会被自动纳入。在 Markdown 中，一个标题的块会包含其正文以及更深的子节，直到下一个同级或更高级别的标题。

使用紧凑的范围，并把不相邻的改动分开。不要仅仅为了重排格式或调整风格而使用 `edit`；在实质性编辑之后运行项目的格式化器。

## 示例

给定：

```text
[greet.py#A1B2]
1:@cache
2:def greet(name):
3:    print("Hello, " + name)
4:
5:greet("world")
```

替换被装饰的函数，而不改动其调用方：

```text
*** Begin Patch
[greet.py#A1B2]
PUT 1*:
+@cache
+def greet(name):
+    print(f"Hi, {name}")
*** End Patch
```

使用命名寄存器把它移动到另一个之前读过的文件：

```text
*** Begin Patch
[greet.py#A1B2]
CUT 1* @fn
[lib/greet.py#3C4D]
PUT <1 @fn
*** End Patch
```

编辑后重命名：

```text
*** Begin Patch
[greet.py#A1B2]
PUT 5.=5:
+greet("team")
MV lib/welcome.py
*** End Patch
```

## 输出与副作用

hashline 在一次工具调用内完成应用；它不使用 `ast_edit` 所使用的暂存 `xd://resolve` / `xd://reject` 流程。

一个成功的段会返回新的 `[path#TAG]` 头、可选的块解析与移动行、可用的紧凑编辑后预览，以及在恢复或规范化产生警告时的 `Warnings:` 块。`EditToolDetails` 可包含统一 `diff`、`firstChangedLine`、诊断/格式化结果、操作（hashline 模式下为 `update` 或 `delete`）、路径/移动元数据、快照以及按文件的结果。多段输入返回一个汇总结果。

流式渲染器会解析飞行中（in-flight）负载的完整部分，并计算只读 diff。流式预览会跳过临时的未解析块、过期标签与空粘贴，而不是把部分输入呈现为最终失败。执行阶段会正常地重新读取并校验。

对于多段调用，每个段都会在写入开始前完成解析与准备，因此语法、锚点与无操作失败都能快速失败。随后文件按顺序写入；操作系统级的写入失败可能留下已经落地的前缀。命名寄存器的会话状态只针对该落地前缀推进。

## 限制与校验

- 快照标签是四位大写十六进制字符，由规范化后的文件内容派生，并记录在会话快照存储中。
- `read`/`grep` 的暴露范围很重要：针对记录可见范围之外行的编辑会被拒绝。在编辑省略或未显示的范围之前，先重新读取它们。
- 范围是包含首尾的，必须有序，并且在检查目标文件实际边界之前受限于 100,000 行展开的解析放大限制。
- 重叠的编辑或针对同一原始锚点的多个操作会被拒绝。
- 同路径的段会被合并，使其原始行锚点能一起应用。若交错的同路径段会使作者书写的寄存器顺序产生歧义，剪贴板操作会被拒绝。
- 过期标签会尝试基于快照的恢复。只有当记录的快照链能证明存在唯一安全结果时才应用恢复；否则会返回与当前上下文不匹配的结果。
- 字节完全相同的编辑是一个错误。重复三次相同的无操作负载会升级触发无操作循环保护。

## 常见失败

- 缺失/畸形的 `[PATH#TAG]`、未知的快照标签，或已不存在的路径。
- 锚点在文件之外、在记录的已见行范围之外、在省略区域中，或基于无法安全恢复的过期快照。
- 顺序颠倒或重叠的范围。
- 正文型 `PUT` 缺少正文、无正文操作下出现正文行、未知的命名寄存器，或在不明确的匿名剪切之前进行匿名粘贴。
- 块锚点指向不受支持/无效的语法树、空行/结束行或单行节点。
- 统一 diff 污染（`@@`、apply-patch 哨兵、`-old` 行）而不是 hashline 操作与最终内容的 `+` 行。
- `REM` / `MV` 冲突、无效的移动目标、目标碰撞，或文件系统写入失败。
- 解析并应用后与现有字节完全相同的补丁（没有任何改动）。

解析器对常见的模型失误有有限的恢复能力（可选的外层包裹、良性的头部噪音、部分裸行与范围拼写），并在修复输入时给出警告。调用方应当只输出上述规范语法；恢复行为不是第二种公开语法。
