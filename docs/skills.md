# Skills（技能）

Skills 是基于文件的能力包，在启动时被发现，并以如下形式暴露给模型：

- 系统 prompt 中的轻量元数据（name + description）
- 通过 `read` 工具按需读取 `skill://...` 内容
- 可选的交互式 `/skill:<name>` 命令

本文档说明 `packages/coding-agent/src/extensibility/skills.ts`、`packages/coding-agent/src/discovery/builtin.ts`、`packages/coding-agent/src/internal-urls/skill-protocol.ts` 与 `packages/coding-agent/src/discovery/agents-md.ts` 中当前的运行时行为。

## 本代码库中 skill 是什么

一个被发现的 skill 表示为：

- `name`
- `description`
- `filePath`（`SKILL.md` 的路径）
- `baseDir`（skill 目录）
- 来源元数据（`provider`、`level`、路径）

运行时只要求 `name` 与 `path` 即视为有效。实际中，匹配质量取决于 `description` 是否有意义。

## 必需的布局与 SKILL.md 预期

### 目录布局

对于基于 provider 的发现（native/Claude/Codex/Agents/plugin provider），skill 按 **`skills/` 下的一层** 被发现：

- `<skills-root>/<skill-name>/SKILL.md`

像 `<skills-root>/group/<skill>/SKILL.md` 这样的嵌套模式不会被 provider loader 发现。

对 `skills.customDirectories`，扫描使用同样的非递归布局（`*/SKILL.md`）。

```text
Provider-discovered layout (non-recursive under skills/):

<root>/skills/
  ├─ postgres/
  │   └─ SKILL.md      ✅ discovered
  ├─ pdf/
  │   └─ SKILL.md      ✅ discovered
  └─ team/
      └─ internal/
          └─ SKILL.md  ❌ not discovered by provider loaders

Custom-directory scanning is also non-recursive, so nested paths are ignored unless you point `customDirectories` at that nested parent.
```

### `SKILL.md` frontmatter

skill 类型支持的 frontmatter 字段：

- `name?: string`
- `description?: string`
- `globs?: string[]`
- `alwaysApply?: boolean`
- `hide?: boolean`
- `disableModelInvocation?: boolean`（Agent Skills 中相当于 `hide`；由 kebab-case 的 `disable-model-invocation` 规范化而来）
- 其他键作为未知元数据保留

当前的运行时行为：

- `name` 默认为 skill 目录名
- `description` 在以下情况是必需的：
  - native `.omp` provider 的 skill 发现（`requireDescription: true`）
  - `omp-plugins` 扩展包 skill 与 `github` provider（`.github/skills/`），二者同样传入 `requireDescription: true`
  - 通过 `src/discovery/helpers.ts` 中 `scanSkillsFromDir` 进行的 `skills.customDirectories` 扫描（非递归）
- claude/codex/agents/opencode/claude-plugins provider 可以在没有 description 的情况下加载 skill

## 发现流水线

`packages/coding-agent/src/extensibility/skills.ts` 中的 `loadSkills()` 分三趟（pass）进行：

1. **能力 provider**：通过 `loadCapability("skills")`（managed/auto-learn provider 的 skill 在这里跳过，由 pass 3 处理）
2. **自定义目录**：通过 `scanSkillsFromDir(..., { requireDescription: true })`（一层目录枚举）。自定义目录中的 skill 会覆盖同名的默认 provider skill；重复的自定义目录名保持先到先得（first-wins）。
3. **受管（auto-learn）skill**（`omp-managed` provider）最后解析，因此来自 provider 或自定义目录的任何同名已启用 authored skill 都优先

若 `skills.enabled` 为 `false`，发现不返回任何 skill。

### 内置 skill provider 与优先级

Provider 排序先按优先级（更高者胜出），相同时按注册顺序。

当前已注册的 skill provider：

1. `native`（priority 100）— 通过 `src/discovery/builtin.ts` 发现的 `.omp` user/project skill
2. `omp-plugins`（priority 90）— 与通过 `extensions:`、`--extension`/`-e` 加载的扩展包，或 `~/.omp/plugins/node_modules` 下已安装插件相邻的 `skills/`
3. `claude`（priority 80）
4. priority 70 组（按注册顺序）：
   - `claude-plugins`
   - `agents`
   - `codex`
5. `opencode`（priority 55）
6. `github`（priority 30）— `.github/skills/<name>/SKILL.md`（GitHub Agent Skills 布局，仅项目级）
7. `omp-managed`（priority 5）— auto-learn skill，位于 `~/.omp/agent/managed-skills`，在 `src/discovery/builtin.ts` 中注册并无条件发现（只有写入/提示由 `autolearn.enabled` 控制）；总是让位给同名的 authored skill

去重键是 skill 名称。同名项中第一个胜出。

### 来源开关与过滤

`loadSkills()` 应用以下控制：

- 来源开关：`enableCodexUser`、`enableClaudeUser`、`enableClaudeProject`、`enablePiUser`、`enablePiProject`、`enableAgentsUser`、`enableAgentsProject`
- `disabledExtensions` 中带 `skill:<name>` 的条目
- `ignoredSkills`（排除；glob 模式）
- `includeSkills`（包含白名单；glob 模式；为空表示全部包含）

过滤顺序是：

1. 未被 `disabledExtensions` 禁用
2. 来源已启用
3. 未被忽略
4. 被包含（若提供了包含列表）

`agents` provider（`.agent[s]/skills`）是规范的 OMP 原生位置，并有自己的 `enableAgentsUser`/`enableAgentsProject` 开关——禁用 Claude/Codex/Pi **不会**关闭它。外部用户级 provider 通过 `enabledProviders` 选择加入；它们的项目根目录默认仍会加载。原生 OMP 来源以及注册在 `~/.omp/plugins` 下的 marketplace 插件默认也都会加载。对 `claude-plugins`，该选择加入只控制来自 Claude Code 自身用户注册表的插件。

### 冲突与重复处理

- 能力去重已经按名称保留每个 skill 的第一个（最高优先级 provider）
- `extensibility/skills.ts` 另外：
  - 按 `realpath` 对相同文件去重（symlink 安全）
  - 当后续 skill 名称冲突时发出冲突警告
  - 保留便捷的 `loadSkillsFromDir({ dir, source })` API，作为 `scanSkillsFromDir` 之上的薄适配层
- 自定义目录的 skill 在 provider skill 之后合并，并覆盖同名的默认路径 provider skill。多个自定义目录之间，同名的第一个 skill 胜出。

## 运行时使用行为

### 系统 prompt 暴露

系统 prompt 的构建（`src/system-prompt.ts`）如下使用被发现的 skill：

- 若 `read` 工具可用：
  - 在 prompt 中包含发现的 skill 列表，排除 `hide: true` 的 skill
- 否则：
  - 省略发现的列表

`hide: true` 不会禁用该 skill。隐藏的 skill 仍会被加载，并且在启用 skill 命令时仍可通过 `skill://<name>` 与 `/skill:<name>` 访问。

task 工具 subagent 通过正常的会话创建获得会话发现/提供的 skill 列表；没有按 task 固定 skill 的覆盖机制。

### 交互式 `/skill:<name>` 命令

若 `skills.enableSkillCommands` 为 true，交互模式为每个发现的 skill 注册一个斜杠命令。

`/skill:<name> [args]` 的行为：

- 识别传统的前置形式，以及嵌入普通 prose 中以空白分隔的 `/skill:<name>` token
- 对嵌入的 token，移除该 token 并把周围 prose 作为参数传入
- 当草稿以另一个斜杠命令或本地 bash/Python 执行符（sigil）开头时，不把嵌入 token 当作调用
- 直接从 `filePath` 读取 skill 文件
- 剥离 frontmatter
- 用 skill 名称、基础目录与可选用户参数包裹正文，然后作为自定义消息注入
- 投递模式遵循**提交键绑定**：
  - **Enter** → 流式期间在 `steer` 队列上调用该 skill（与自由文本 Enter 一致，后者同样会 steer），agent 不在流式时则作为普通空闲 prompt
  - **Ctrl+Enter**（`app.message.followUp`）→ 流式期间在 `followUp` 队列上调用该 skill，agent 不在流式时则作为普通空闲 prompt

没有任何 flag、模式选择器或 frontmatter 旋钮可以覆盖投递模式——键绑定本身_就是_选择，与流式期间自由文本的路由一致。两条提交路径都经由 `input-controller.ts` 中的 `#invokeSkillCommand` 分派，后者委托给 `src/modes/skill-command.ts` 中的 `invokeSkillCommandFromText`。

被调用的 skill 内容按调用种类区分，每种都有自己的 prompt 模板（位于 `src/prompts/skills/`，由 `src/extensibility/skills.ts` 中的 `buildSkillPromptMessage` 渲染）：

- **用户调用**（`user-invocation.md`，供 `/skill:<name>` 使用）：消息开头声明用户调用了该 skill，嵌入 skill 正文，并附上 skill 目录（`[Skill directory: <baseDir>]`），指示相对该目录解析 skill 的相对路径（scripts、templates），外加可选的 `User: <args>`。
- **自动加载**（`autoload.md`）：一种仅含来源信息的最小格式——正文后接 `Skill: <path>` 与可选的 `User: <args>`——用于 subagent 自动注入通过 `autoloadSkills` agent frontmatter 字段声明的 skill；这些隐藏消息不得声称用户调用了它们。

## `skill://` URL 行为

`src/internal-urls/skill-protocol.ts` 支持：

- `skill://<name>` → 解析为该 skill 的 `SKILL.md`
- `skill://<name>/<relative-path>` → 在该 skill 目录内解析

```text
skill:// URL resolution

skill://pdf
  -> <pdf-base>/SKILL.md

skill://pdf/references/tables.md
  -> <pdf-base>/references/tables.md

Guards:
- reject absolute paths
- reject `..` traversal
- reject any resolved path escaping <pdf-base>
```

解析细节：

- skill 名称必须完全匹配
- 相对路径会做 URL 解码
- 绝对路径被拒绝
- 路径穿越（`..`）被拒绝
- 解析后的路径必须保持在 `baseDir` 内
- 缺失文件返回显式的 `File not found` 错误

内容类型：

- `.md` => `text/markdown`
- 其他一切 => `text/plain`

对缺失的资源不执行回退搜索。

## Skills 与 AGENTS.md、命令、工具、hooks 的对比

### Skills 与 AGENTS.md

- **Skills**：具名、可选的 capability pack，由任务上下文选择或被显式请求
- **AGENTS.md/context files**：作为 context-file 能力加载并按层级/深度规则合并的持久化指令文件

`src/discovery/agents-md.ts` 从 `cwd` 向上遍历祖先目录，以发现独立的 `AGENTS.md` 文件。对于嵌套在用户 home 目录下的仓库，它会继续向上经过外层工作区目录，直到（但不包括）home 目录。若 home 之下没有仓库根目录，home 边界仍被包含在内。否则它在仓库根目录处停止；若 home 之外不知仓库根目录，则在文件系统根目录处停止。隐藏的属主目录中的文件会被跳过。

### Skills 与斜杠命令

- **Skills**：模型可读的知识/工作流内容
- **Slash commands**：由用户调用的命令入口点
- `/skill:<name>` 是一个注入 skill 文本的便捷包装；它不改变 skill 发现的语义

### Skills 与自定义工具

- **Skills**：通过 prompt context 与 `read` 加载的文档/工作流内容
- **Custom tools**：模型可调用、带 schema 与运行时副作用的可执行工具 API

### Skills 与 hooks

- **Skills**：被动内容
- **Hooks**：事件驱动的运行时拦截器，可在执行期间阻止/修改行为

## 与发现逻辑相关的实用编写指导

- 每个 skill 放在自己的目录：`<skills-root>/<skill-name>/SKILL.md`
- 始终包含显式的 `name` 与 `description` frontmatter
- 把被引用的资源放在同一 skill 目录下，并用 `skill://<name>/...` 访问
- 对于嵌套分类（`team/domain/skill`），把 `skills.customDirectories` 指向嵌套的父目录；扫描本身保持非递归
- 避免跨来源出现重复的 skill 名称；第一个匹配项按 provider 优先级胜出
