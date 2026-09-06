# 任务 agent 的发现与选择

本文档描述 task 子系统如何发现 agent 定义、合并多个来源，并在执行时解析所请求的 agent。

它涵盖当前已实现的运行时行为，包括优先级、无效定义处理，以及可能使 agent 实际上不可用的 spawn/深度约束。

## 实现文件

- [`src/task/discovery.ts`](../packages/coding-agent/src/task/discovery.ts)
- [`src/task/agents.ts`](../packages/coding-agent/src/task/agents.ts)
- [`src/task/types.ts`](../packages/coding-agent/src/task/types.ts)
- [`src/task/index.ts`](../packages/coding-agent/src/task/index.ts)
- [`src/task/structured-subagent.ts`](../packages/coding-agent/src/task/structured-subagent.ts)
- [`src/task/spawn-policy.ts`](../packages/coding-agent/src/task/spawn-policy.ts)
- [`src/task/commands.ts`](../packages/coding-agent/src/task/commands.ts)
- [`src/prompts/agents/task.md`](../packages/coding-agent/src/prompts/agents/task.md)
- [`src/prompts/tools/task.md`](../packages/coding-agent/src/prompts/tools/task.md)
- [`src/discovery/helpers.ts`](../packages/coding-agent/src/discovery/helpers.ts)
- [`src/discovery/omp-extension-roots.ts`](../packages/coding-agent/src/discovery/omp-extension-roots.ts)
- [`src/config.ts`](../packages/coding-agent/src/config.ts)
- [`src/task/executor.ts`](../packages/coding-agent/src/task/executor.ts)

---

## Agent 定义结构

任务 agent 归一化为 `AgentDefinition`（`src/task/types.ts`）：

- 必填：`name`、`description`、`systemPrompt`
- 可选：`tools`、`spawns`、带优先级的 `model` 列表、`thinkingLevel`、`output`、`blocking`、`autoloadSkills`、`readSummarize`、`prewalk`、`advisor`
- `source`：`"bundled" | "user" | "project"`（扩展 agent 按其扩展根的项目/用户层级打标）
- 可选 `filePath`

解析来自 frontmatter，经由 `parseAgentFields()`（`src/discovery/helpers.ts`）：

- 缺少 `name` 或 `description` => 无效（`null`），调用方按解析失败处理
- `tools` 接受 CSV 或数组；若提供，会自动加入 `yield`
- `spawns` 接受 `*`、CSV 或数组
- 向后兼容行为：若缺少 `spawns` 但 `tools` 包含 `task`，则 `spawns` 变为 `*`
- `output` 作为不透明 schema 数据透传
- `read-summarize: false`（归一化为 `readSummarize`）强制 subagent 的 `read` 工具返回逐字文件内容而非结构化摘要——`runSubprocess` 将其作为 `read.summarize.enabled: false` 覆盖应用到 subagent 的隔离设置上（`src/task/executor.ts`）。`scout` 出厂即禁用该功能。字段缺失时默认启用。
- `model` 接受一个 selector、CSV 或数组。角色别名展开后按顺序尝试各条目。
- `thinking-level` / `thinking` 选择 agent 配置的 effort。当 `task.enableEffort`（默认 `false`）将其暴露出来时，task item 的粗粒度 `effort`（`lo`、`med`、`hi`）在启动时优先。OMP 会把这个提示映射到所选模型最低、中间或最高的受支持 effort，然后钳制到 `task.maxEffort`（默认 `max`）。该上限会跨重试回退的模型切换保留。若所选模型在上限或以下没有受支持的 effort，spawn 失败；没有可控 effort 面的模型则回退到其正常 selector。
- `blocking: true` 使父级等待该 agent，即使在启用异步 task 执行时也是如此
- `autoloadSkills` 指定来自父会话的 skill，在第一条子 prompt 之前注入；未知名称会被忽略
- `prewalk: true` 让 subagent 以其解析到的模型启动，并在第一次 edit/write 时交接给默认 prewalk 目标（`smol` 角色），与会话级 `--prewalk` 完全一致；字符串值（如 `prewalk: "@smol"` 或 `prewalk: "openai/gpt-5-mini"`）选择自定义目标。`task.agentPrewalk` 设置记录（agent 名 → `"on"` / `"off"` / pattern，从 `/agents` hub 通过其 prewalk strip 按 agent 配置）会覆盖 frontmatter。解析发生在 `runSubprocess`（`src/task/executor.ts`）。不可用的目标会被跳过而不是让 spawn 失败。已解析的目标只有在模型钳制后其模型身份与生效的 thinking 模式/级别都匹配起始选择时才会被跳过；同模型的 effort 降级是真正的交接，仍会在第一次 edit/write 时武装并切换。
- `advisor: true` 为该 agent 派生的会话配对一个 advisor，运行 `advisor` 角色解析到的模型；字符串值（如 `advisor: "deepseek/deepseek-v4-flash"` 或 `advisor: "@smol:high"`）设置显式的 advisor 模型 pattern（可选 `:level` 后缀），作为派生会话的 `modelRoles.advisor` 应用。`task.agentAdvisor` 设置记录（agent 名 → `"on"` / `"off"` / pattern，从 `/agents` hub 通过其 advisor strip 按 agent 配置）会覆盖 frontmatter。解析发生在 `runSubprocess`（`src/task/executor.ts`）；subagent 默认无 advisor，生效的选择加入会持久化在 `session_init` 中，以便冷复活时恢复。

## 基于角色的自定义 agent

OMP 从 `~/.omp/agent/agents/*.md` 发现用户 agent，从 `.omp/agents/*.md` 发现项目 agent。

在 frontmatter 中给 agent 一个角色别名，然后按名称派发它。对模型路由而言，task 派发只设置 `agent`；它不设置 worker model：

`~/.omp/agent/agents/reviewer.md`：

```md
---
name: reviewer
description: Review a change for correctness.
model: "@review"
---

Review the assigned change and report concrete findings.
```

在 `~/.omp/agent/config.yml` 中设置角色映射：

```yaml
modelRoles:
  review: openai/gpt-5.4:high
```

`@review` 通过 `modelRoles.review` 解析。每个 `modelRoles.<role>` 值存储一个具体的模型 selector，并可追加 `:high` 这样的 thinking 后缀（`src/config/model-resolver.ts`）。更改该映射会影响后续的 task 解析，而无需编辑 agent 定义。Task/eval preflight 在重新发现 agent 之前会重新加载当前的 global、project 与显式 overlay 设置，因此活动会话期间新增的 agent 文件及其角色别名会从一份刷新的配置状态中解析。

对于一次派发，设置 agent 名称与任务：

```json
{
  "context": "Review the current change in this repository.",
  "tasks": [
    { "agent": "reviewer", "task": "Report concrete correctness findings." }
  ]
}
```

`/model` 的 Roles 视图可以分配并持久化 `review`、`fast`、`good` 这样的自定义角色映射。只更改活动或默认的会话选择不会重新映射这些角色。

## 观察运行中的 agent

派发后按 `Alt+A` 打开 [Agent Hub](./agent-hub.md)。其实时名单会显示每个任务 agent 的状态、当前活动、模型、年龄与用量。选择一个 agent 以阅读其 transcript 并直接引导它；停驻（parked）的 agent 可以在同一视图中复活。

### `vibe_spawn` 的 tier 路由

`vibe_spawn` 把 `fast` 映射到内置 `sonic`，把 `good` 映射到内置 `task`。两者都会在其内置 agent 模型默认值之前先经 `task.agentModelOverrides` 解析（`src/vibe/runtime.ts`、`src/task/agents.ts`）。

把这些 tier 经由角色路由：在 `task.agentModelOverrides` 中保留别名，只在 `modelRoles` 中放具体 selector：

```yaml
task:
  agentModelOverrides:
    sonic: "@fast_worker"
    task: "@good_worker"
modelRoles:
  fast_worker: openai/gpt-5-mini
  good_worker: openai/gpt-5.4:high
```

`vibe_spawn` 的 `cli` 仍是 `fast` 或 `good`；要更改 worker model 请更新 `modelRoles`。

## 内置 agent

内置 agent 在构建时通过文本导入嵌入（`src/task/agents.ts`）。

`EMBEDDED_AGENT_DEFS` 定义：

- 来自 prompt 文件的 `scout`、`reviewer`、`security-reviewer`
- 来自共享 `task.md` 正文加注入的 frontmatter 的 `task` 与 `sonic`；没有内置 agent 设置 `prewalk`——通用 `task` agent 的交接由 `task.prewalk` 设置（默认 off）武装，或按 agent 通过 `/agents` / `task.agentPrewalk` / 用户 agent frontmatter 武装

加载路径：

1. `loadBundledAgents()` 用 `parseAgent(..., "bundled", "fatal")` 解析嵌入的 markdown
2. 结果缓存在内存中（`bundledAgentsCache`）
3. `clearBundledAgentsCache()` 是仅测试用的缓存重置

由于内置解析使用 `level: "fatal"`，畸形的内置 frontmatter 会抛出异常并可能使整个发现失败。

## 文件系统与插件发现

`discoverAgents(cwd, home)`（`src/task/discovery.ts`）在追加内置定义之前，先合并来自 OMP 原生根、OMP 扩展包与 Claude marketplace 插件根的 agent。`.claude/agents`、`.codex/agents`、`.gemini/agents` 这类直接跨 harness 的根被有意跳过——它们的 frontmatter schema 不是 OMP 任务 agent 契约（`TASK_AGENT_CONFIG_SOURCE = ".omp"` 会过滤原生 config-dir 列表）。

### 发现输入与优先级

1. 最近的来自 `findAllNearestProjectConfigDirs("agents", cwd)` 的项目 `.omp/agents` 目录（只取第一个命中的 `.omp`）
2. 来自 `getConfigDirs("agents", { project: false })` 的用户 `.omp/agents` 目录（只取第一个命中的 `.omp`）
3. `listOmpExtensionRoots(...)` 返回的每个已启用 OMP 扩展包的 `<extension-root>/agents`，顺序如下：
   - CLI `--extension` 根
   - 项目 `extensions:` 设置
   - 用户 `extensions:` 设置
   - 已安装的 npm/link 插件
4. 带 `agents/` 子目录的 Claude marketplace 插件根（`listClaudePluginRoots(home, cwd)`）——仅在 `isProviderEnabled("claude-plugins")` 时；项目作用域插件排在用户作用域之前
5. 内置 agent（`loadBundledAgents()`）

当 `omp-plugins` capability provider 被禁用时，OMP 扩展包表面即被禁用。Marketplace 根被排除在 `listOmpExtensionRoots` 之外，只通过单独门控的 Claude-plugin 路径进入。

## 合并与冲突规则

发现按精确的 `agent.name` 做 first-wins 去重：

- 一个 `Set<string>` 跟踪已见过的名称。
- 已加载的 agent 按目录顺序展平，仅当名称未见时才保留。
- 内置 agent 用同一个集合过滤，仅当仍然未见时才加入。

含义：

- 项目 `.omp` 覆盖用户 `.omp`。
- 更早的扩展根覆盖更晚的扩展根、Claude marketplace 插件与内置 agent。
- 非内置 agent 覆盖同名的内置 agent。
- 名称匹配区分大小写（`Task` 与 `task` 不同）。
- 在同一目录内，markdown 文件在去重前按文件名字典序读取。

## 无效/缺失 agent 文件行为

按目录（`loadAgentsFromDir`）：

- 不可读/缺失的目录：按空处理（`readdir(...).catch(() => [])`）
- 文件读取或解析失败：记录警告，跳过该文件
- 解析路径使用 `parseAgent(..., level: "warn")`

Frontmatter 失败行为来自 `parseFrontmatter`：

- `warn` 级别的解析错误会记录警告
- 解析器回退到简单的 `key: value` 行解析器
- 若仍缺少必填字段，`parseAgentFields` 失败，随后抛出 `AgentParsingError` 并由调用方捕获（跳过该文件）

净效果：一个坏的自定义 agent 文件不会中止对其他文件的发现。

## Agent 查找与选择

查找是精确名称的线性搜索：

- `getAgent(agents, name)` => `agents.find(a => a.name === name)`
- 不受限的会话把省略的 `agent` 字段默认为 `task`
- 受限制的父级 `spawns` 列表把省略的 `agent` 字段默认为列出的第一个 agent

`resolveEffectiveSubagentPolicy()` 由 task 与 eval 支撑的 subagent 启动共享。在分配 artifacts 之前它会：

1. 原子地重新加载活动会话已持久化的 global、project 与显式 overlay 设置，同时保留运行时覆盖
2. 从父级 spawn 策略解析省略或显式的 agent 名称
3. 强制深度、阻止自递归与父级 spawn-policy 防护
4. 用 `discoverAgents(session.cwd)` 重新发现 agent 并执行精确查找
5. 检查 `task.disabledAgents`
6. 解析 plan 模式限制、输出 schema、模型策略与隔离策略

缺失的名称会以 `Unknown agent "...". Available: ...` 使 preflight 失败；不会运行任何子进程。

### 描述时发现 vs 执行时发现

`TaskTool.create()` 在构建面向模型的工具描述时，会按已解析的工作目录记忆化发现。执行时会重新发现 agent，因此如果 agent 或扩展文件在会话中途发生变化，运行时集合可能与更早的描述不同。阻塞行为在策略解析之后确定，而不是来自过期的描述时 agent 对象。

## 模型与结构化输出优先级

对于 task 派发，模型优先级为：

1. `task.agentModelOverrides[agentName]`
2. agent frontmatter 中带优先级的 `model` 列表
3. 父级的活动模型，然后是配置/默认模型回退

前两个来源中的角色别名都通过 `modelRoles` 展开。共享的 eval 桥还可以在设置覆盖之前提供调用局部的模型覆盖；task wire schema 不暴露该字段。

运行时输出 schema 优先级为：

1. task item 的显式 `outputSchema`
2. agent frontmatter 的 `output`
3. 父会话的 `outputSchema`

task item 的可选 `schemaMode` 覆盖父会话模式；默认为 `permissive`。

面向模型的 prompt（`src/prompts/tools/task.md`）把只读 agent 打标，并警告不要把推理外包给 `scout`/`sonic`。

## 命令发现交互

`src/task/commands.ts` 是工作流命令（而非 agent 定义）的并行基础设施，但它遵循同样的整体模式：

- 先从 capability provider 发现
- 按名称 first-wins 去重
- 若仍然未见则追加内置命令
- 通过 `getCommand` 精确名称查找

在 `src/task/index.ts` 中，命令辅助函数与 agent 发现辅助函数一起被重新导出。Agent 发现本身在运行时不依赖命令发现。

## 发现之外的可用性约束

一个 agent 可能可被发现，但因执行护栏而仍无法运行。

### 禁用 agent 设置

`resolveEffectiveSubagentPolicy()` 在解析 agent 后检查 `task.disabledAgents`。被禁用的名称使 preflight 失败，并在可用时列出已启用的替代项。

### 父级 spawn 策略

解析器检查 `session.getSessionSpawns()`：

- `"*"`（也含 `true`、`null` 或缺失）=> 允许任何；省略的 `agent` 默认为 `task`
- `""` 或 `false` => 全部拒绝
- CSV 列表 => 只允许列出的名称；省略的 `agent` 默认为其第一个名称

若被拒绝：`Cannot spawn '...'. Allowed: ...`。

### 阻止自递归的 env 防护

`PI_BLOCKED_AGENT`（或内部请求覆盖）在发现之前就拒绝尝试派生同一个被阻止的 agent。

### 递归深度门控

`task.maxRecursionDepth` 默认为 `2`；负值禁用该上限。共享策略在当前 task 深度已达上限时拒绝派生。当子级到达上限时，`runSubprocess` 还会从它的工具列表中移除 `task` 并把其 spawn 策略置空。

对于受限制的 agent 工具列表，`runSubprocess` 在声明了 `spawns` 且深度允许时会自动加入 `task`。它还会保留宿主的 `hub` 协作工具，除非会话显式限制工具名称。

## Plan 模式行为

当父级 plan 模式启用时，`resolveEffectiveSubagentPolicy()` 在启动子进程之前构建一个 `effectiveAgent`：

- 前置 plan 模式 subagent 系统 prompt
- 把工具限制为 `read`、`grep`、`glob` 与 `web_search`，若 agent 自己的工具列表声明了 `ast_grep` 则加上它
- 清空子级 spawns
- 清空 `prewalk`（只读探索不得接收 prewalk 的 plan/implement 提示）

Plan 模式还拒绝 per-spawn 的 isolation、apply 与 merge 控制。同一个 `effectiveAgent` 用于子进程启动、模型/thinking 覆盖与输出 schema 选择。
