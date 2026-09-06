# 自定义系统提示

本文说明编程 agent 如何组装其系统提示（system prompt），以及用户可以用 `SYSTEM.md`、`APPEND_SYSTEM.md`、`TITLE_SYSTEM.md` 与相应 CLI 标志控制哪些内容。

主要实现：

- `packages/coding-agent/src/main.ts`（`discoverSystemPromptFile`、`discoverAppendSystemPromptFile`、`applyResolvedSystemPromptInputs`）
- `packages/coding-agent/src/sdk.ts`（`CreateAgentSessionOptions`、prompt 构建）
- `packages/coding-agent/src/system-prompt.ts`（`buildSystemPrompt`、`resolvePromptInput`）
- `packages/coding-agent/src/prompts/system/system-prompt.md`（默认指令模板）
- `packages/coding-agent/src/prompts/system/custom-system-prompt.md`（`SYSTEM.md` 生效时使用的模板）
- `packages/coding-agent/src/prompts/system/project-prompt.md`（项目/环境页脚）

## 输入与优先级

| 输入                                    | 来源                   | 作用                                                                                                   |
| --------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------- |
| `--system-prompt <text-or-file>`        | CLI                    | 使用内置的自定义 prompt 模板，而非默认指令模板。优先级最高。 |
| `SYSTEM.md`                             | 发现到的配置文件 | 与标志相同的模板切换；标志缺席时使用。                                          |
| `--append-system-prompt <text-or-file>` | CLI                    | 向渲染后的 prompt 追加文本。追加优先级最高。                                             |
| `APPEND_SYSTEM.md`                      | 发现到的配置文件 | 与追加标志效果相同；标志缺席时使用。                                            |

`SYSTEM.md` 与 `APPEND_SYSTEM.md` 先按项目范围搜索，再按用户范围搜索。在每个作用域内，config base 依次为 `.omp`、`.claude`、`.codex`、`.gemini`：

1. `<cwd>/.omp/<file>`、`<cwd>/.claude/<file>`、`<cwd>/.codex/<file>`、`<cwd>/.gemini/<file>`
2. `~/.omp/agent/<file>`、`~/.claude/<file>`、`~/.codex/<file>`、`~/.gemini/<file>`

原生用户路径随活动 profile 变化：使用 `omp --profile work` 时，`~/.omp/agent` 变为 `~/.omp/profiles/work/agent`。`PI_CONFIG_DIR` 会改变原生 config 目录名。这一共享 config 查找不会把 `PI_CODING_AGENT_DIR` 当作任意的替换基目录。

发现过程**不会**向上遍历祖先目录。在 `<repo>/packages/api` 中启动 OMP 不会发现 `<repo>/.omp/SYSTEM.md`；请从 `<repo>` 启动、把文件放到当前目录的 config base 下，或使用用户级文件。共享 config 目录契约见 [配置用法](./config-usage.md)。

标志胜过所有发现到的文件。对每个文件名而言，项目作用域胜过用户作用域；同一作用域内，上述顺序中的第一个 config base 胜出。

### 文本或文件解析

对于单行值，OMP 首先尝试把该值当作文件路径读取。若读取因路径不存在（或太长而不可能是路径）而失败，则按字面使用该值。包含换行的值不经文件读取、直接按字面使用。其他文件读取失败会被记录，原值仍按字面使用。

## `SYSTEM.md` 替换了什么

`SYSTEM.md` 不会成为一条原始的、唯一的系统消息。CLI 会把它存储为 `CreateAgentSessionOptions.customSystemPrompt`，而 `buildSystemPrompt` 渲染 `custom-system-prompt.md` 而非默认的 `system-prompt.md`。

自定义模板保留以下这些生成的部分：

- 自定义文本与任何追加文本；
- 发现到的 context 文件；
- 发现到的技能（skills）；
- 始终应用的规则与 rulebook 列表；
- 启用时的密钥脱敏（secret-redaction）指引。

独立的项目/环境页脚仍然保留，承载工作站数据、更深层目录的 context 指针、可选的工作区信息以及最终的完成要求。可选的附加系统块（例如计算机工具安全与活动的嵌套仓库 context）在适用时也仍然保留。

当前日期与工作目录不再位于页脚中：它们会在每个 provider 请求的第一个用户轮次中作为 `<system-reminder>` 块发出（`date-cwd-reminder.md`）。把按请求产生的字节移出系统提示，可以让在系统内容之后渲染工具 schema 的开源权重 provider（DeepSeek、Qwen、GLM 等）保持其前缀缓存，也能让跨过午夜的会话无需重建 prompt 即可刷新日期（#7404）。

消失的是默认指令模板独有的内容：其内置的角色/性格文本、工具清单与通用工具策略、内部 URL 目录、探索/委派/工作流规则以及 `xd://` 协议指引。生成的技能与规则**不会**丢失；自定义模板会显式渲染它们。

后果：

- 若要添加少量指令并保留完整的默认 prompt，请只使用 `APPEND_SYSTEM.md` 或 `--append-system-prompt`。
- 若要替换默认指令模板并保留生成的项目 context、技能与规则，请使用 `SYSTEM.md` 或 `--system-prompt`。
- 若自定义 prompt 仍需要默认工具策略或工作流，请自行复制并维护所需指引；不支持从 `system-prompt.md` 选择性继承。

### 追加文本的位置

没有 `SYSTEM.md` 时，追加文本渲染在 `project-prompt.md` 末尾，位于默认指令块与项目/环境内容之后。

有 `SYSTEM.md` 时，追加文本在 `custom-system-prompt.md` 中紧跟自定义文本之后渲染。context、技能与规则紧随其后，独立的项目/环境页脚再跟随该块。模板会防止追加文本与 context 文件被重复输出。

SDK 生成的追加内容（用于已启用的记忆/auto-learn 功能与 MCP 指引）会排在用户提供的追加文本之前。

## 纯文本契约

`SYSTEM.md`、`APPEND_SYSTEM.md`、`--system-prompt` 与 `--append-system-prompt` 都是纯文本。它们是插入到内置 Handlebars 模板中的值；其内容不会被递归地当作 Handlebars 编译。

例如，若 `SYSTEM.md` 包含：

```handlebars
Working in
{{cwd}}
on
{{date}}.
{{#if hasMemoryRoot}}Memory enabled.{{/if}}
```

这些字符会原样到达模型。诸如 `cwd`、`skills`、`rules`、`toolRefs` 之类的内部值是私有模板实现细节，不是面向用户的模板 API。日历日期不再作为模板值刻意暴露——它改由按请求的第一轮 reminder 携带（见上文）。

## 示例

### 向默认 prompt 添加规则

创建 `APPEND_SYSTEM.md` 而不使用 `SYSTEM.md`：

```text
# ~/.omp/agent/APPEND_SYSTEM.md
Prefer Bun APIs over Node APIs in this project.
When you change a public function, run `bun check` before yielding.
```

### 提供自定义基础 prompt

```text
# <cwd>/.omp/SYSTEM.md
You are a code reviewer. Read changes, surface concrete issues, and never edit files.
Cite paths with backticks.
```

OMP 仍会添加生成的 context、技能、规则与项目/环境页脚，但不会添加默认指令模板中的工具与工作流指引。

### 替换 personality 块

默认模板渲染由 `personality` 设置选定的 personality 块（`default`、`friendly`、`pragmatic`、`none`）。用户级的 `PERSONALITY.md` 会替换所选预设的文本：

```text
# ~/.omp/agent/PERSONALITY.md
Follow ASD-STE100 Simplified Technical English for all responses.
```

只检查 agent 目录（默认为 `~/.omp/agent`；支持 profile 与 XDG）——不存在项目级或其他 config base 的查找。`personality: none` 仍会完全省略该块（subagent 总是以 `none` 运行），而空文件或不可读的文件会回退到所配置的预设并记录一条警告。

### 自定义自动会话标题

`SYSTEM.md` 与 `APPEND_SYSTEM.md` 不影响标题生成调用。请使用 `TITLE_SYSTEM.md`：

```text
# ~/.omp/agent/TITLE_SYSTEM.md
Generate a session name using lowercase `<type>:<primary-objective>`.
If the message has no concrete task, output exactly `none`.
```

`TITLE_SYSTEM.md` 使用相同的项目优先、按 config base 发现且不向上遍历祖先的行为。缺席时，OMP 使用其内置的标题 prompt。该覆盖同时用于初始自动标题与 replan 驱动的标题刷新。

即使使用自定义
prompt，生成的标题输出也遵循强制的规范化契约。OMP 只考虑第一条修剪后的行，去掉周围
的引号、`<title>...</title>` 标记与末尾标点，并把
`none` 或 `<title/>` 视为“尚无标题”。超过 80 个字符或
12 个单词的结果会被拒绝而非截断。空、被推迟或被拒绝的输出
会让会话保持未命名状态，因此之后符合条件的标题尝试可以为其命名。

## 完整替换面向 provider 的内容（仅 SDK）

`CreateAgentSessionOptions.systemPrompt` 是一个不同的、更低层的 API。字符串或数组会替换完整渲染出的默认块；回调接收渲染后的块数组并返回其替换结果。这可以省略所有生成的 context 与安全块。

CLI 标志与文件**不会**设置此属性：它们设置的是 `customSystemPrompt` 与 `appendSystemPrompt`，二者继续经由上文所述的内置模板处理。

## 速查

| 目标                                                                                   | 用法                                                                      |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 在保留完整默认 prompt 的同时添加指令                             | `APPEND_SYSTEM.md` 或 `--append-system-prompt`                           |
| 替换默认指令模板，但保留生成的 context、技能与规则 | `SYSTEM.md` 或 `--system-prompt`                                         |
| 替换所有面向 provider 的系统块                                             | SDK `CreateAgentSessionOptions.systemPrompt`                             |
| 自定义自动会话标题                                                     | `TITLE_SYSTEM.md`                                                        |
| 在保留默认 prompt 其余部分的同时替换 personality 块            | `PERSONALITY.md`                                                         |
| 在用户文件中使用 `{{cwd}}` 或其他内部变量                               | 不支持；用户内容按原样插入                         |
| 继承默认模板的选定部分                                             | 不支持；请向默认内容追加或复制所需文本           |
| 按目录覆盖                                                                 | 用于启动 OMP 的 cwd 正下方的受支持 config base        |
| 全局覆盖                                                                        | 活动的原生 agent 目录，或其他受支持的用户 config base |
