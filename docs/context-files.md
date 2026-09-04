# Context 文件

Context 文件是 `omp` 在会话开始前自动发现并注入到 agent 项目上下文中的 Markdown 指令文件。用它承载仓库约定、架构笔记、测试与评审期望，以及应随用户账户或项目一起携带的指令。

你从不需要让 agent 去读 `AGENTS.md`、`CLAUDE.md`、`GEMINI.md` 或类似文件 —— 相关文件在会话开始时就已经被发现、加载并放入上下文。

## Context 文件与其他概念的关系

四个名称相似的东西行为各不相同。注意区分：

- **Context 文件**作为纯 Markdown 读取，在生成的项目指令中展示给 agent（默认 prompt 模板中位于 `<repo-rules>` 内）。它们是会话开场的指令和仓库工作的背景。
- **Sticky rules** 来自顶层的原生 `RULES.md`。它们被转换成始终生效的规则，并在当前回合附近重新附加，因此即使可见对话不断增长也持续有效。见下文"Sticky rules 与普通 context"。
- **Discovery providers** 是知道每个工具把文件放在哪里的配置源适配器。完整注册表为 `native`、`omp-plugins`、`claude`、`agent-plugins`、`codex`、`agents`、`claude-plugins`、`gemini`、`opencode`、`cursor`、`windsurf`、`cline`、`github`、`vscode`、`agents-md`、`mcp-json`、`ssh-json` 和 `builtin-defaults`。只有一部分贡献 context 文件（`native`、`claude`、`codex`、`gemini`、`opencode`、`github`、`agents`、`agents-md`）；其余贡献其他能力，如 rules、MCP servers、skills、commands、hooks、tools 或 SSH hosts。贡献 context 文件的同一 provider 也可能同时贡献 MCP servers、slash commands、skills、hooks、tools、prompts 和 settings。
- **Model providers** 是推理后端，如 `anthropic`、`openai`、`google`、`groq`、`ollama` 和 `openrouter`。它们与 context 文件无关，只是两类 id 共用同一个 `disabledProviders` 列表 —— 见下文"禁用 discovery providers"和 [Providers](./providers.md)。

**skills** 与 **rule** 文件（相对于 sticky `RULES.md`）的编写见 [Skills](./skills.md)。用 `SYSTEM.md` 自定义系统提示见 [System prompt customization](./system-prompt-customization.md)。

## 原生 `.omp` 文件

原生 provider 是新项目的推荐格式。它从你的用户 agent 目录和项目内的 `.omp/` 目录读取，并拥有最高的发现优先级，因此在同一作用域内其文件胜过所有其他约定。

| 文件                                          | 作用域  | 行为                                                                                                                                                                                                                                                 |
| --------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.omp/agent/AGENTS.md`                      | 用户    | 用户级 context，对每个会话生效，除非 `native` provider 被禁用。                                                                                                                                                                                      |
| `<nearest-non-empty-ancestor>/.omp/AGENTS.md` | 项目    | 项目 context，但仅当从 cwd 向仓库根遍历时，在**最近的非空 `.omp/` 目录**中存在 `AGENTS.md`。当最近的 `.omp/` 目录缺少此文件时，OMP 不会继续到更远的 `.omp/` 目录。                                                                                   |
| `~/.omp/agent/RULES.md`                       | 用户    | 用户级 sticky rule 内容。作为始终生效的规则加载，而非 context 文件。                                                                                                                                                                                 |
| `<nearest-non-empty-ancestor>/.omp/RULES.md`  | 项目    | 项目 sticky 内容，但仅当 `RULES.md` 存在于遍历选定的同一个最近非空 `.omp/` 目录中。                                                                                                                                                                  |

两个细节很重要：

- **最近的非空 `.omp/` 目录拥有原生项目发现的唯一决定权。**发现从当前工作目录开始向仓库根攀升。一旦找到非空的 `.omp/`，遍历停止；原生 `AGENTS.md` 和 `RULES.md` 都只从该目录读取。文件缺失不会让发现继续向上。
- **空目录和空文件不贡献任何内容。**空的 `.omp/` 目录在遍历中被跳过。在选定的非空目录中，空的 `AGENTS.md` 或 `RULES.md` 不贡献任何内容。

`~/.omp/agent` 是活跃原生 agent 目录的简写。`PI_CODING_AGENT_DIR` 可重定位它。具名 profile（`omp --profile <name>`、`OMP_PROFILE` 或 `PI_PROFILE`）默认使用 `~/.omp/profiles/<name>/agent`；外部工具的用户基础目录（如 `~/.claude`）不按 profile 划分。

### Monorepo 示例

```text
repo/
  .omp/
    AGENTS.md
    RULES.md
  packages/api/
    .omp/
      AGENTS.md
```

在 `repo/packages/api` 启动会话：

- 原生 context 文件是 `repo/packages/api/.omp/AGENTS.md`（最近的一个）。`repo/.omp/AGENTS.md` **不会**同时包含。
- 因为 `repo/packages/api/.omp/` 是最近的非空原生目录，项目 sticky 内容只能来自 `repo/packages/api/.omp/RULES.md`。若该文件不存在，`repo/.omp/RULES.md` **不会**被使用。

把宽泛、持久的项目背景放在 `AGENTS.md`。把 `RULES.md` 留给必须在长对话中保持可见的少量硬性要求。

## 其他受支持的 context 约定

`omp` 也发现其他 agent 工具的 context 和 rule 文件，使现有项目无需迁移即可继续工作。

| Provider id | 约定路径                                    | 作用域         | 说明                                                                                                                                                                                                                                                                                                                                                       |
| ----------- | ------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `native`    | `.omp/AGENTS.md`                            | 用户 + 项目    | 推荐的 OMP 格式。用户文件在活跃原生 agent 目录；项目文件只从向仓库根遍历时最近的非空 `.omp/` 目录读取。                                                                                                                                                                                        |
| `claude`    | `.claude/CLAUDE.md`                         | 用户 + 项目    | 用户文件 `~/.claude/CLAUDE.md`；项目文件仅 `<cwd>/.claude/CLAUDE.md`（不向上遍历祖先）。                                                                                                                                                                                                     |
| `codex`     | `.codex/AGENTS.md`                          | 用户           | 仅用户文件 `~/.codex/AGENTS.md`。项目级 Codex context 经 `agents-md` provider 来自独立的 `AGENTS.md`，而非 `<cwd>/.codex/AGENTS.md`。                                                                                                                                                         |
| `gemini`    | `.gemini/GEMINI.md`                         | 用户 + 项目    | 用户文件 `~/.gemini/GEMINI.md`；项目文件仅 `<cwd>/.gemini/GEMINI.md`（不向上遍历祖先）。                                                                                                                                                                                                     |
| `opencode`  | `.config/opencode/AGENTS.md`                | 用户           | 仅用户文件 `~/.config/opencode/AGENTS.md`。                                                                                                                                                                                                                                                                                                                  |
| `github`    | `.github/copilot-instructions.md`           | 用户 + 项目    | 项目文件仅 `<cwd>/.github/copilot-instructions.md`（不向上遍历祖先），外加用户全局的 `~/.copilot/copilot-instructions.md`（可用 `COPILOT_HOME` 重定位）。来自 `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` 的 `AGENTS.md` 候选也在用户作用域考虑，适用常规的单用户文件去重。                              |
| `agents`    | `.agent/AGENTS.md`, `.agents/AGENTS.md`     | 用户 + 项目    | 用户文件来自 `~/.agent/` 和 `~/.agents/`；项目文件从当前目录向仓库根遍历时发现。                                                                                                                                                                                                             |
| `agents-md` | `AGENTS.md`                                 | 项目           | 独立的（非配置目录）`AGENTS.md` 文件，从当前目录向仓库根遍历发现；当该仓库嵌套在用户 home 目录下时，还会穿过外围 workspace 目录直至（但不包含）home 目录。没有仓库根时，home 下的会话以 home 目录为边界，并包含该边界文件。父目录名以 `.` 开头的文件被忽略 —— 它们属于配置目录 provider。                                                        |
| `claude-md` | `CLAUDE.md`                                 | 项目           | 独立的（非配置目录）`CLAUDE.md` 文件，从当前目录向仓库根遍历发现；当该仓库嵌套在用户 home 目录下时，还会穿过外围 workspace 目录直至（但不包含）home 目录。没有仓库根时，home 下的会话以 home 目录为边界，并包含该边界文件。父目录名以 `.` 开头的文件被忽略 —— 它们属于配置目录 provider。                                                       |
| `github`    | `.github/instructions/**/*.instructions.md` | 项目 rules     | GitHub Copilot / VS Code instruction 文件成为 rules。`applyTo: '*'`、`applyTo: '**'` 或 `applyTo: '**/*'` 被注入为始终生效的内容；其他 `applyTo` glob 列入 rulebook，需要时带生成的描述，可以 `rule://<name>` 读取。缺失 `applyTo` 也会产生 rulebook 条目和发现警告。                          |

标注"（不向上遍历祖先）"的 provider 只查看当前工作目录的配置目录。如果需要向上遍历祖先的行为，优先使用原生 `.omp/AGENTS.md` 格式或独立的 `AGENTS.md` / `CLAUDE.md`（`agents-md` / `claude-md` provider），或从持有配置目录的目录启动 `omp`。

发现注册表还包含完全不贡献 context 文件的 provider：`cursor`（`.cursor/rules/*.mdc` 和旧版 `.cursorrules` rules，外加 MCP servers 和 settings）、`windsurf`（`.windsurf/rules/*.md`、旧版 `.windsurfrules` 和全局 Windsurf rules，外加 MCP servers）、`cline`（`.clinerules` rules）、`vscode` 和 `mcp-json`（MCP servers）、`claude-plugins`（Claude marketplace 插件：skills、commands、rules、hooks、tools、MCP servers）、`omp-plugins`（OMP 插件：skills、commands、rules、prompts、hooks、tools、MCP servers）、`agent-plugins`（Agent Plugins 标准包：skills 和 MCP servers）、`ssh-json`（SSH hosts）以及 `builtin-defaults`（内置默认 rules）。它们与 rules、其他能力以及下文的共享 `disabledProviders` 开关相关。

## 加载顺序与遮蔽

当两个 provider 描述_同一_作用域时，优先级更高的 provider 胜出。完整注册表优先级：

| 优先级 | Provider id                                        |
| ------: | -------------------------------------------------- |
|      100 | `native`                                           |
|       90 | `omp-plugins`                                      |
|       80 | `claude`                                           |
|       75 | `agent-plugins`                                    |
|       70 | `agents`, `claude-plugins`, `codex`                |
|       60 | `gemini`                                           |
|       55 | `opencode`                                         |
|       50 | `cursor`, `windsurf`                               |
|       40 | `cline`                                            |
|       30 | `github`                                           |
|       20 | `vscode`                                           |
|       10 | `agents-md`                                        |
|       10 | `claude-md`                                        |
|        5 | `mcp-json`, `ssh-json`                             |
|        1 | `builtin-defaults`                                 |

发现到的文件随后按作用域去重：

- **所有 provider 只保留一个用户 context 文件。**由于 `native` 优先级最高，`~/.omp/agent/AGENTS.md` 遮蔽所有其他用户级 context 文件。
- **每个目录深度一个项目 context 文件。**深度从当前目录算起：cwd 为深度 0，其父目录为深度 1，依此类推。祖先的配置子目录（`.claude/`、`.github/`、`.gemini/` 等）与该祖先算作同一深度。
- **同一深度，更高优先级的 provider 遮蔽其余。**
- **跨深度，多个文件都可存活。**在 monorepo 中，祖先的 `AGENTS.md` 与包级的是不同深度，两者都加载。
- **字节完全相同的文件在排序后合并。**项目副本中距 cwd 最近的一个存活。唯一存活的用户作用域文件排在项目文件之后，因此当其内容与项目内容相同时是它存活。

最终注入顺序是**更远的项目祖先在前**，然后是更靠近 cwd 的项目文件，最后是存活的用户作用域文件。越靠后的文件位于生成上下文的末尾附近，也更醒目。

### 遮蔽示例

```text
repo/
  AGENTS.md
  packages/api/
    AGENTS.md
    .github/copilot-instructions.md
```

从 `repo/packages/api` 启动：

- `repo/AGENTS.md` 由 `agents-md` 在深度 2 发现并保留。
- `repo/packages/api/AGENTS.md`（`agents-md`，优先级 10）和 `repo/packages/api/.github/copilot-instructions.md`（`github`，优先级 30）都解析到深度 0。GitHub 更高的优先级遮蔽了包级独立 `AGENTS.md`，因此 Copilot 文件在该深度胜出。
- 保留的两个文件按根在前、包在后的顺序排列，因此 `packages/api` 的文件更醒目。
- 如果添加 `repo/packages/api/.omp/AGENTS.md`，`native`（优先级 100）直接赢得深度 0，遮蔽两个更低优先级的文件。

## 注入行为

使用默认 prompt 模板时，发现的 context 文件作为一个 `<repo-rules>` 块注入开场项目 prompt，按上述排序每个存活的文件一个 `<file>` 元素：

```xml
<repo-rules>
You MUST follow the context files below for all tasks:
<file path="/abs/path/to/repo/AGENTS.md">
...root content...
</file>
<file path="/abs/path/to/repo/packages/api/.github/copilot-instructions.md">
...package content...
</file>
</repo-rules>
```

当 `SYSTEM.md` 选择内置的自定义 prompt 模板时，同样的文件改为输出到该模板的 `<project>` / `<instructions>` 部分。无论哪种模式，agent 都能看到每个文件的绝对路径和完全展开的 Markdown 内容（`@` import 已解析）。

加载是自动的 —— 无需在会话中指示 agent 去搜索 `AGENTS.md`、`CLAUDE.md`、`GEMINI.md`、`.cursorrules` 等文件。

未被自动加载的更深目录的 `AGENTS.md`（例如当前目录之下的）会在单独的 `<dir-context>` 块中呈现，列出其路径并告知 agent 在编辑这些目录之前先阅读它们。这些文件是指针，而非完整注入的内容。

## `@` import

在任何 context 文件内，`@path` 标记在注入前内联展开为被引用文件的内容：

```markdown
# Project notes

Read @docs/architecture.md before changing storage code.
Shared release steps live in @../RELEASE.md and personal aliases in @~/.notes/aliases.md.
```

确切规则：

- **相对路径从导入文件自身所在目录解析**，而不是会话的工作目录。
- **`~/` 和 `~`** 从用户 home 目录解析；绝对路径按原样使用。
- **fenced 代码块和 inline code span 内的标记保持原样** —— 当你想_书写_一个 `@token` 而不展开它时很有用。
- **`git@github.com:org/repo.git` 和 `user@example.com` 风格的标记不被视为 import。**只有当 `@` 位于行首或空格/tab 之后时标记才算数。
- **末尾的句末标点被去除**（`. , ; : ! ? ) ] } " '`），因此 `@docs/setup.md.` 导入 `docs/setup.md`。
- **import 递归最多五跳。**被导入的文件自身可再含 `@` import，总深度上限五。
- **循环被跳过。**已进入当前展开树的文件不会被再次展开，因此互相导入能干净终止。
- **目标缺失或不可读时，原始 `@token` 文本原地保留**而非报错。

## Sticky rules 与普通 context

大部分指导使用普通 context 文件（`AGENTS.md`、`CLAUDE.md`、`GEMINI.md`、`.github/copilot-instructions.md` 等）：仓库概览、代码风格、构建与测试命令、评审期望和本地约定。它们加载进开场的生成项目上下文。

顶层的 **`RULES.md`** 用于那少数几条硬性要求 —— 即使长对话把开场上下文推到 transcript 很靠后的位置，它们也必须保持生效：

```markdown
# ~/.omp/agent/RULES.md

Never commit or push unless the user explicitly asks.
Do not edit generated files.
```

`RULES.md` 的特殊性：

- 它**只**在原生位置读取：活跃的用户 agent 目录，以及从 cwd 向仓库根遍历选定的最近非空项目 `.omp/` 目录。如果该项目目录没有 `RULES.md`，OMP 不会回退到更远的 `.omp/RULES.md`。
- 它作为**始终生效的规则**加载，而非 context 文件，因此在当前回合附近重新附加，并在长会话中保持有效。
- 它**始终是 sticky 的**：frontmatter 无法使其非 sticky。想要条件性或可选加入的行为，请写普通 rule 文件（见 [Skills](./skills.md)）。
- 两个顶层候选都以规则名 `RULES` 合成，而规则去重按名称进行。通常情况下用户 `RULES.md` 遮蔽项目 `RULES.md`；它们不会被拼接。避免把 `.omp/rules/` 或用户 `rules/` 目录下的普通文件命名为 `RULES.md`，因为原生普通规则加载更早，可能遮蔽两个 sticky 候选。

保持 `RULES.md` 简短。长的背景属于 `AGENTS.md`，在那里只花一次 context 预算。

## 禁用 discovery providers

用 `~/.omp/agent/config.yml`、项目 `.omp/config.yml` 或 `--config` 覆盖层中的 `disabledProviders` 设置关闭 provider：

```yaml
# .omp/config.yml
disabledProviders:
  - claude
  - github
```

`disabledProviders` 是一个**具有单一共享 id 命名空间的整体 provider 开关**，被两个互不相关的子系统使用：

| Id 种类               | 示例                                                                               | 列入时的效果                                                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery provider id | `native`, `claude`, `codex`, `gemini`, `opencode`, `github`, `agents`, `agents-md`, `claude-md` | 整个配置源被移除 —— 不仅是其 context 文件，还包括它本会贡献的任何 MCP servers、slash commands、skills、hooks、tools、prompts 和 settings。                                          |
| Model provider id     | `anthropic`, `openai`, `google`, `groq`, `ollama`, `openrouter`                    | 即使凭据存在，模型后端也从选择中移除。见 [Providers](./providers.md)。                                                                                                              |

id 是精确匹配，两个命名空间不会意外冲突：`google` 禁用 Google 模型后端，而 `gemini` 禁用 Gemini CLI 的发现文件。禁用一个 discovery provider 比看起来更重 —— 例如禁用 `claude` 会同时丢掉 Claude 发现的 MCP servers、commands、skills、hooks、tools 和 settings，不只是 `CLAUDE.md`。若只想去掉 context 文件而保留该 provider 贡献的其余部分，改用 [`disabledExtensions`](#disabling-a-single-context-file)。

只有 `enabledModels` 和 `disabledProviders` 支持**路径限定**条目，可按子树改变 provider 可用性：

```yaml
disabledProviders:
  - github # disabled everywhere
  - path: ~/work/legacy-claude
    providers:
      - claude # disabled only under this directory
```

当 cwd 等于配置路径或位于其下时限定条目生效；`~` 展开为 home。裸字符串条目处处生效。

记住更高优先级的设置层是**替换**数组设置而非追加。如果你的全局配置禁用了 `claude`，但某个项目配置设置 `disabledProviders: [github]`，那么在该项目内 Claude 发现被重新启用，只有 GitHub 被禁用。完整的层优先级、合并规则和路径限定数组细节见 [Settings](./settings.md)。

## 禁用单个 context 文件

`disabledProviders` 移除整个配置源。要只去掉一个 context 文件并保留其 provider 贡献的其余部分，把它的 extension id 列入 `disabledExtensions`：

```yaml
# ~/.omp/agent/config.yml, .omp/config.yml, or a --config overlay
disabledExtensions:
  - context-file:user:CLAUDE.md
```

Context 文件 id 的形式为 `context-file:<level>:<basename>`，其中 `<level>` 是 `user` 或 `project`，`<basename>` 是不含目录部分的文件名：

| Id                                  | 禁用对象                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `context-file:user:CLAUDE.md`       | 用户级 `CLAUDE.md`，同时 Claude 的 MCP servers、commands、skills、hooks、tools 和 settings 继续加载。 |
| `context-file:project:AGENTS.md`    | **每一个**项目级 `AGENTS.md`，遍历到达的每个目录深度 —— 该 id 不携带深度。        |
| `context-file:user:AGENTS.md`       | 每个名为 `AGENTS.md` 的用户级文件，无论来自哪个 provider。                      |

匹配只看级别和文件名，因此一条条目覆盖在该级别贡献同名文件的每个 provider，且项目条目无法缩窄到单一深度。需要按目录控制时，在应有差异的子树中使用项目 `.omp/config.yml`，或上文路径限定的 `disabledProviders` 形式。

禁用不等同于遮蔽，且差异可见：被禁用的文件在去重前就被丢弃，因此不占据其作用域。**它原本遮蔽的文件会取而代之被加载。**在同时持有 `.claude/CLAUDE.md` 和 `AGENTS.md` 的项目中，`CLAUDE.md` 通常赢得深度 0 的作用域；禁用 `context-file:project:CLAUDE.md` 后 `AGENTS.md` 成为项目 context，而不是作用域变空。要让作用域完全没有文件，禁用每个候选名称。

两个日常用例：

- **非交互运行。**为你自己的交互会话写的用户级 context 文件通常不适合由其他程序驱动的 `-p` 运行，后者自带指令。在 `--config` 覆盖层中禁用它可保持交互设置不受影响。
- **委托工作。**当一个 agent 驱动另一个时，调用方自身的操作说明会作为用户级 context 进入被调方的 prompt，可能与它实际接到的任务相矛盾。

`disabledExtensions` 不支持路径限定：只有 `enabledModels` 和 `disabledProviders` 接受 `path:` 形式。与所有数组设置一样，它会被更高优先级的层替换而非合并。

用 `/extensions` 交互式浏览这些 id，它会列出每个发现的 context 文件及其级别、来源和当前状态，并切换同一设置。

## 故障排除

### 文件未被加载

- 原生项目 context 只从最近的非空 `.omp/` 目录读取。该目录必须包含非空的 `AGENTS.md`；否则发现不会继续到更远的原生目录。
- 独立的 `CLAUDE.md` 由 `claude-md` 处理，而非 `native`。
- `.claude/CLAUDE.md`、`.gemini/GEMINI.md` 和 `.github/copilot-instructions.md` 只从当前工作目录的配置目录读取 —— 不从每个祖先读取。
- `~/.codex/AGENTS.md` 和 `~/.config/opencode/AGENTS.md` 仅用户级，没有项目等价物。
- 空文件对原生和独立 provider 不贡献任何内容。
- 被禁用的 discovery provider 不贡献任何内容 —— 检查全局、项目和 `--config` 各层的 `disabledProviders`。
- 单个文件也可以被单独关闭 —— 检查 `disabledExtensions` 是否有匹配的 `context-file:<level>:<basename>` 条目，并记住项目条目作用于每个深度。若是这个原因，`/extensions` 会将该文件显示为 `disabled`。

### 错误的文件胜出

在单个用户作用域或项目深度，更高优先级的 provider 遮蔽其余（native > claude > agents/codex > gemini > opencode > github > agents-md > claude-md）。要强制确定性行为，把你的指导移入 `.omp/AGENTS.md`（native 总是胜出）或禁用竞争的 discovery provider。

### 用户 context 消失了

只有一个用户级 context 文件能存活，而 `~/.omp/agent/AGENTS.md` 优先级最高。若它存在，会遮蔽用户级 `~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md`、`~/.gemini/GEMINI.md`、`~/.config/opencode/AGENTS.md`、`~/.copilot/copilot-instructions.md` 以及 `~/.agent`/`~/.agents` 文件。把用户指导合并进原生文件，或者若你更偏好其他工具的文件则移除原生文件。

### `RULES.md` 被忽略

只有原生 `RULES.md` 位置是 sticky 的：活跃的用户 agent 目录，以及从 cwd 向仓库根选定的最近非空项目 `.omp/` 目录。如果存在更近的非空 `.omp/` 目录，即使它没有 `RULES.md` 也会挡住更远的原生目录。任何其他位置的 `RULES.md` 都不是被识别的约定。

### `@` import 未展开

确认目标相对于导入文件（而非 cwd）存在。fenced 代码块或 inline code span 内的 import 有意保持字面，形如 `git@`/email 的标记从不导入，循环被跳过，展开五跳后停止，目标缺失时原始 `@path` 文本保持不变。
