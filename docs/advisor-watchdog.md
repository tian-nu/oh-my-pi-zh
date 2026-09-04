# Advisor、WATCHDOG.md 与 WATCHDOG.yml

advisor 子系统为一个会话挂载一个或多个可选的审查模型。每个 advisor 审查主 agent transcript 的更新，可以用自己的工具检查工作区，并向主会话注入精简的建议。

advisor 不批准操作，也不直接修改主会话状态。其默认调查工具集为 `read`、`grep` 和 `glob`，但 `WATCHDOG.yml` 名单条目可以授予任何内置工具——包括 `edit`、`write`、`bash`、`eval` 等带修改性的工具。这些工具在隔离的 advisor `ToolSession` 中运行，但遵循会话的正常 approval mode 和逐工具策略；只有在 advisor 模型和工作区可信时才授予（见 [工具与隔离](#工具与隔离)）。

## 实现文件

- [`src/advisor/runtime.ts`](../packages/coding-agent/src/advisor/runtime.ts)
- [`src/advisor/advise-tool.ts`](../packages/coding-agent/src/advisor/advise-tool.ts)
- [`src/advisor/emission-guard.ts`](../packages/coding-agent/src/advisor/emission-guard.ts)
- [`src/advisor/watchdog.ts`](../packages/coding-agent/src/advisor/watchdog.ts)
- [`src/advisor/config.ts`](../packages/coding-agent/src/advisor/config.ts)
- [`src/advisor/transcript-recorder.ts`](../packages/coding-agent/src/advisor/transcript-recorder.ts)
- [`src/prompts/advisor/system.md`](../packages/coding-agent/src/prompts/advisor/system.md)
- [`src/prompts/advisor/advise-tool.md`](../packages/coding-agent/src/prompts/advisor/advise-tool.md)
- [`src/session/session-advisors.ts`](../packages/coding-agent/src/session/session-advisors.ts)
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`src/slash-commands/builtin-registry.ts`](../packages/coding-agent/src/slash-commands/builtin-registry.ts)
- [`src/config/settings-schema.ts`](../packages/coding-agent/src/config/settings-schema.ts)

---

## 启用 advisor

该子系统要求 `advisor.enabled: true`。模型选择随后取决于名单：

- 未发现任何 `WATCHDOG.yml` advisor 条目时，OMP 创建遗留/默认 advisor，并从 `modelRoles.advisor` 解析其模型。
- 有名单时，每个启用的条目优先使用其显式 `model`，否则使用 `modelRoles.advisor`。无法解析的条目报告为 `no_model`，但不影响其他条目运行。
- `advisors[].enabled: false` 使条目以暂停状态保持可见，但不构建其运行时。

示例：

```yaml
modelRoles:
  advisor: anthropic/claude-sonnet-4-5:medium

advisor:
  enabled: true
```

模型选择器使用正常的角色/模型解析，包括带 provider 前缀的 id、规范 id、回退列表和可选的 thinking 后缀。

`tier.advisor` 控制所有 advisor 的服务层级。默认为 `none`（标准处理）；`inherit` 跟随主 agent 当前的按 family 层级，包括 `/fast` 变更。具体取值（`auto`、`default`、`flex`、`scale`、`priority`）仅在 advisor 模型的 provider family 支持时才应用。

### 无头运行

使用 `--advisor` 可在单个 print 模式进程中启用 advisor，而不持久化 `advisor.enabled`：

```sh
omp -p --advisor "Review this task."
```

主 prompt 运行期间，advisor 的关注点和阻塞项会继续引导该实时 turn。最终 prompt 结束后，print 模式会保留迟到的 advisor 备注，不启动隐藏的主 turn，并在释放会话前最多等待十分钟以完成最终审查。错误退出使用 30 秒的排空预算，让失败的自动化能终止。任一截止时间到期时，OMP 会记录将被释放操作放弃的审查；已完成的审查保留其 transcript 和 token/成本用量。

Slash 命令：

| 命令                 | 效果                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `/advisor`           | 为本会话切换 advisor 子系统（会话级覆盖；不修改持久化的 `advisor.enabled`）。                                                            |
| `/advisor on`        | 为本会话启用已配置/默认的 advisor 运行时。会话级；不写入配置。                                                                          |
| `/advisor off`       | 为本会话禁用 advisor 子系统并停止其运行时。会话级；不写入配置。                                                                          |
| `/advisor status`    | 显示每个 advisor 的运行时状态、模型、上下文用量、token 用量和成本。                                                                      |
| `/advisor dump`      | 将精简 transcript（有名单时为所有活跃 advisor）复制到剪贴板。                                                                            |
| `/advisor dump raw`  | 复制完整 dump，包括 system prompt、工具、thinking 和调用。                                                                               |
| `/advisor configure` | 打开交互式 TUI 编辑器编辑项目级或用户级 `WATCHDOG.yml`。非 TUI 命令宿主会报告该编辑器仅限 TUI。                                          |

若子系统已启用但没有任何遗留/默认或名单模型可解析，status 会将已配置的 advisor 报告为 inactive/`no_model`。

## advisor 看到什么

每次主更新时，`AdvisorRuntime` 只接收自上次更新以来的新 transcript 增量。增量渲染包含 reasoning、工具意图、被监听角色的标记以及展开的主约束上下文，因此 advisor 既能审查 assistant 的推理，也能审查用户可见文本、工具调用和工具结果。绑定 provider 的消息和工具参数/结果在到达 advisor 模型之前会经过会话的 secret 混淆器。

大多数隐藏的 `custom` 消息在增量中折叠为一行摘要。主 agent 注入的约束上下文（`plan-mode-context` 和 `plan-mode-reference`）则被逐字渲染在 XML 转义的 `<primary-context kind="…">` 包裹中，重复副本会被去重。advisor 还会在 `<project-context>` system-prompt 块中收到主 agent 发现的项目上下文文件（`AGENTS.md` 及相关长期指令）。如果会话 cwd 在 Git 之外且恰好有一个直接子仓库，额外的 watchdog 块会告诉 advisor 哪个子仓库是活跃项目。

已注入主 transcript 的 advisor 消息会在下次渲染增量前被过滤掉。这防止 advisor 递归审查自己的建议。

主 transcript 被重写时，advisor 运行时会重置：

- compaction
- 会话切换/恢复
- 分支/fork 式历史替换
- advisor 自身上下文放不下时的 context-maintenance 重新播种

重置会清空 advisor 私有的内存 transcript 并回退其游标。下一次 advisor 更新会重放当前有界的主 transcript，而不是从重写前的过时上下文继续。

会话中途启用 advisor 时，游标播种为当前主 transcript 的长度。这避免了第一次启用 turn 时重放整个旧对话。

## 工具与隔离

advisor 是一个完整的 agent，拥有自己的 `Agent` 实例和一个独立的 `ToolSession`，其 id 以 `-advisor` 为后缀。它不共享主 agent 的文件快照、已读行跟踪、冲突状态或摘要缓存。

每个 advisor 都有 `advise` 工具用于向主 transcript 提交备注。省略 `tools` 时，其调查性授权为：

- `read`
- `grep`
- `glob`

`WATCHDOG.yml` 名单条目可以从会话实际构建的内置工具中选择任意子集（返回 `null` 的工厂——如不可用的 `lsp`——则不存在）。显式的空 `tools: []` 不授予任何调查工具；`advise` 仍可用。仅含未知名称的列表会被丢弃并警告，当前会回退到默认子集。可授予的名称包括 `edit`、`write`、`bash`、`eval`、`debug`、`ast_edit`、`task`、`hub` 等带修改性的工具以及 memory 工具。已启用的 browser/computer 前奏通过 `eval` 触达，不作为工具授予。

advisor 工具基于隔离的 advisor `ToolSession` 构建，并包裹 `ExtensionToolWrapper`，因此 `tools.approvalMode`、逐工具审批策略和 `autoApprove` 的适用方式与 registry 工具完全相同。Cursor 的服务端 exec bridge 使用相同的审批上下文，并且只有在存在对应 advisor 授权时才暴露 delete/edit/search 能力。

`advise` 工具接受一条备注和可选的严重级别：

| 严重级别        | 送达方式                                                                                                                                                             | 预期用途                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 省略 / `nit`    | 非打断性旁注，在下个步骤边界批量进入主 transcript。                                                                                                                    | 清理、简化、低风险边界情况。                                                  |
| `concern`       | 在下方送达约束允许时，发送打断性 steering 消息。迟到的终局答案 `concern` 则保留为可见卡片。                                                                            | 实质性风险、方向可能错误、缺少约束、幻觉 API。                                 |
| `blocker`       | 在下方送达约束允许时，发送打断性 steering 消息。与 `concern` 不同，仅有终局答案并不能阻止它触发 turn。                                                                | 继续下去明显会浪费工作量或产出损坏的输出。                                     |

被接受的备注以 XML 转义的 `<advisory>` 元素渲染进主 transcript。具名名单 advisor 会附加 `advisor` 属性：

```text
<advisory advisor="Architecture" severity="concern" guidance="weigh, don't blindly obey">
note text
</advisory>
```

当你刻意打断 agent（Esc，或来自 collab、ACP、RPC、SDK 或扩展的取消）时，advisor 会停止自动恢复它。运行停止期间提出的打断性 `concern`/`blocker` 会记录为可见的 advisor 卡片而不是重启 turn；你打断时已在途的 concern 也以同样方式保留，而不是驱动一次意外的 resume。建议会在你下次恢复时重新进入上下文——新消息、`.`/`c` continue 快捷键，或一次 steer/follow-up。

agent 自行发起的正常 yield 与刻意打断的处理不同，但也并非一概"总是 steering 并恢复"。循环状态和已完成的 turn 首先决定常规送达路径：

- **循环仍在流式输出时**（备注在 yield 之前、或在你已驱动的 resume 期间提出），备注通常会 steer 进入实时 turn。
- **循环已 yield 并进入空闲后**，送达取决于 turn 如何结束：
  - 如果主 agent 的结尾是**没有排队工作的终局文本答案**，迟到的 `concern` 会保留为可见卡片，而不是唤醒 agent 重述一个已完成的 turn（#4840）——它会在下次恢复时重新进入上下文（新消息、`.`/`c`，或 steer/follow-up），与打断情况完全一致。`blocker` 是例外：它通常会 steer 触发一个 turn，因为它意味着 agent 交付了损坏或未经执行的工作，必须先被确认才能视为 turn 完成（#5628）。
  - 否则（agent 在工作中途 yield，没有终局答案），空闲时的 `concern`/`blocker` 通常会触发一个新 turn，使建议被立即执行。

两个会话/客户端约束仍可能保留一条常规路径为 steering 的备注：

- **Plan 模式：** 每个本应送达的 advisor steer 都保留为可见卡片，即使主循环正在流式输出，因为只有用户驱动的 turn 才会收敛到 ask/resolve。
- **带 deferred agent-initiated turns 的 ACP：** 当 `deferAgentInitiatedTurns` 启用且 bridge 尚未允许 agent 发起的 turn 时，空闲的本应 steer 会被保留，因为客户端无法把触发的 turn 表示为忙碌。在主循环已流式输出期间提出的建议仍可 steer 进入该实时 turn。

因此，advisor 可以 steering 并恢复 agent 自行结束的运行，**前提是该运行仍在进行或在工作中途 yield，且当前模式/客户端允许 steering**。当 steering 被阻止时，备注要么保留为卡片（上述终局答案、plan 模式和 deferred-ACP 情况），要么降级为非打断性旁注（下文的 `advisor.immuneTurns` 冷却）；无论哪种，它都等待下个步骤边界或 resume，而不是唤醒 agent。

`advisor.immuneTurns` 限制打断频率。advisor 通过 steering 通道成功送达一次 `concern` 或 `blocker` 后，后续的 concern/blocker 会作为非打断性旁注路由，直到完成配置数量的主 turn。默认为 `3`。`nit` 备注不受影响，且在用户打断 auto-resume 抑制生效期间提出的建议仍会被保留，而不会重启已停止的运行。

当 advisor 更新仍在审查进行中的工作时，`AdviseTool` 会扣留 `nit` 和 `concern` 调用；只有 `blocker` 可以打断未完成的工作。该工具还会抑制同一空白归一化备注在相同或更低严重级别上的重复，同时允许真正的升级（`nit` → `concern` → `blocker`）。

### 发送守卫

每个 advisor 在 `AdviseTool` 到 YieldQueue/steer 通道的路径上都有自己的 `AdvisorEmissionGuard`（`src/advisor/emission-guard.ts`）。它执行 system prompt 中"每次更新至多一条被接受的备注"以及不重复的规则：

1. **归一化。** 小写化、NFKC、把所有非字母数字字符序列折叠为一个空格，再去首尾空白。`"Stop."`、`"*Stop*"` 和 `"  stop  "` 的 key 都是 `stop`。
2. **无实质内容短语过滤。** 没有具体理由的短语——`stop`、`done`、`complete`、`no issue continue`、`lgtm`、`nothing to add` 等——会被抑制。
3. **精确文本去重。** 本 advisor 本会话已接受的任何归一化备注都会被丢弃。FIFO 历史最多保留 4096 条。
4. **每次更新限速。** 每个 advisor 模型 `prompt()` 周期至多接受一条备注。被抑制的噪音不消耗配额。

守卫级抑制对模型不可见，因为 `AdviseTool` 已返回 `Recorded.`。工具更早的同级或更低级重复检查则有意以 `Duplicate advice ignored.` 可见；进行中的非 blocker 返回 `Recorded.` 且不路由。

守卫的完整状态——去重历史和每次更新门——在每次 advisor 重置（compaction、会话切换、`/new`）时清空，因此重新播种的审查者可以针对重写后的 transcript 重新提出它之前提出过的问题。

## 使用 `advisor.syncBacklog` 的有界追赶

`advisor.syncBacklog` 不是锁步的 turn 执行。它是 advisor 落后时主 agent 的有界追赶延迟。

允许的取值：

- `off` —— 永不等待 advisor 追赶
- `1`
- `3`
- `5`

主 turn 结束时：

1. 主 turn 增量进入 advisor 队列
2. advisor 排空循环在后台启动或继续
3. 若 `advisor.syncBacklog` 非 `off`，主 agent 仅在 advisor 积压达到或超过配置阈值时等待
4. 等待上限 30 秒
5. 若 advisor 追赶到阈值以下，主 agent 立即继续
6. 若到达上限，主 agent 无论如何继续

实际解读：

- `off` 偏向最大化主 agent 吞吐。
- `1` 是最接近同步审查的模式：每个入队的 advisor 增量之后，主 agent 最多等 30 秒让积压归零。
- `3` 和 `5` 允许主 agent 暂停前有更多 advisor 滞后。

advisor 失败不会永久卡住主 agent。宿主首先尝试其凭据/回退恢复。可重试的失败最多尝试三次，然后该积压被丢弃；连续三轮丢弃积压会停止运行时，直到显式重置；永久性的请求拒绝可在一轮后就使其停止。配额/用量限制失败会暂停 advisor 并保留其批次，直到 `/advisor` 重建它、配置重新加载、新会话开始或进程重启。advisor 一旦处于失败状态，追赶等待者立即被释放。

不安全的 Advisor 输出走单独的隔离路径，而非上述三次尝试的请求重试策略。在工具分发前，运行时会隔离一个请求 Advisor 不可用的非 bridge 工具的 turn。当检测到仅输出的破坏性 shell 指令，或在破坏性 shell、指令覆盖、拒绝指令、账户删除声明这几类仅输出危险类别中至少命中三类时，生成的文本/建议也会被隔离。新的指令覆盖与输入中引用的破坏性命令配对同样符合条件。整个 Advisor turn——包括其中的任何建议——会在分发前被丢弃。

第一次连续隔离会静默重置并使用最新待处理上下文重新播种 Advisor。第二次连续隔离会发出一条去重的宿主警告，丢弃受影响的批次，并重置 Advisor 上下文以打破循环。任何成功的 Advisor turn 都会重置隔离计数器。

## WATCHDOG.md

`WATCHDOG.md` 是 advisor 专属的指导。它附加在 advisor system prompt 之后；不会注入主 agent 的正常上下文，行为也不像 `AGENTS.md`、`RULES.md` 或其他上下文文件。

用它写审查优先级：advisor 应关注的风险、项目特有的陷阱、危险的 API、架构边界，以及对审查者有用但对主执行者来说过于嘈杂的质量标准。

示例：

```markdown
# Watchdog notes

Especially watch for:

- Changes that bypass the durable queue in `src/jobs/`.
- UI renderer paths that display unsanitized tool output.
- New worker spawns that do not re-enter the CLI host.
```

### 发现位置

`discoverWatchdogFiles(cwd, agentDir)` 从以下位置加载每个可读的候选文件：

1. 用户级：`<active agent dir>/WATCHDOG.md`（默认 `~/.omp/agent/WATCHDOG.md`；可通过 `PI_CODING_AGENT_DIR` 重定位）
2. 项目级：从 `cwd` 向上遍历到 git 仓库根目录，未找到仓库根则到主目录：
   - `<dir>/WATCHDOG.md`
   - `<dir>/.omp/WATCHDOG.md`

与原生上下文文件不同，watchdog 发现不会停在最近的项目文件。多个项目 watchdog 文件可以一起加载。

隐藏的所有者目录中的候选会被忽略，除非文件位于 `.omp` 目录内。这避免意外拾取无关的点目录约定，同时仍允许 `.omp/WATCHDOG.md`。

### `@` 导入

`WATCHDOG.md` 内容使用与上下文文件相同的 `@` 导入辅助函数展开：

- 相对导入从导入文件所在目录解析
- `~/` 从用户主目录解析
- 围栏代码块和 inline code 中的导入保持字面量
- 循环导入被跳过
- 缺失或不可读的导入保留原始 `@path` 文本

### Prompt 顺序

加载的 watchdog 块按如下排序：

1. 用户级 `WATCHDOG.md`
2. 项目级文件，从更远的祖先向下到 `cwd`

每个文件附加到 advisor system prompt 时形如：

```xml
Especially pay attention to:
<attention>
...expanded watchdog content...
</attention>
```

较晚的项目文件位于 advisor prompt 更靠后的位置，因此更窄的目录指导比宽泛的祖先指导更突出。

## WATCHDOG.yml

`WATCHDOG.yml`（或 `WATCHDOG.yaml`）是 advisor 名单。`WATCHDOG.md` 提供审查优先级，`WATCHDOG.yml` 则声明 advisor 本身——每个名称一个条目，各自拥有启用标志、模型、工具授权和专门化 prompt。交互式的 `/advisor configure` 覆盖层就地编辑此文件。解析失败或 schema 校验失败的文件会被记录并跳过，避免一个坏的项目配置毁掉整个会话。

示例：

```yaml
instructions: |
  Everyone: prefer diffs that keep tests unified.

advisors:
  - name: Architecture
    enabled: true
    model: anthropic/claude-sonnet-4-5:medium
    tools: [read, grep, glob]
    instructions: |
      Watch cross-module coupling and public-API growth.

  - name: Fixer
    enabled: false
    model: anthropic/claude-sonnet-4-5:high
    tools: [read, grep, glob, edit, bash]
    instructions: |
      You may edit and run tests to prove a fix locally, then advise.
```

字段：

- `instructions`（顶层）：共享 prompt，与 `WATCHDOG.md` 一起前置到每个 advisor 的 system prompt。跨所有发现的 `WATCHDOG.yml` 文件拼接。
- `advisors[].name`：人类可读标签；用于会话 id 及其 `__advisor.<slug>.jsonl` 文件名的 slug 化。跨文件重复的 slug 按 `WATCHDOG.md` 发现的同一特异性规则解析（项目叶子 > 项目祖先 > 用户）。
- `advisors[].enabled`：可选的按 advisor 开关，默认 `true`。`false` 使该 advisor 在 status/配置中以暂停状态保持可见。
- `advisors[].model`：可选的模型选择器，带可选 `:level` thinking 后缀（如 `x-ai/grok-code-fast:high`）。省略 → advisor 使用 `modelRoles.advisor`。
- `advisors[].tools`：可选的要授予的内置工具名列表。省略 → 默认的 `read`/`grep`/`glob` 子集；显式 `[]` → 无调查工具。接受 [`BUILTIN_TOOL_NAMES`](../packages/coding-agent/src/tools/builtin-names.ts) 中的任何名称，包括带修改性的工具。旧别名（`search`→`grep`、`find`→`glob`）会被归一化。未知名称被丢弃并警告；若这导致非空输入没有任何有效名称，实现当前将其视为省略并使用默认子集。
- `advisors[].instructions`：该 advisor 的专门化说明，附加在共享基线之后。两个 instruction 字段都像 `WATCHDOG.md` 一样展开 `@path` 导入。

### 发现位置

`WATCHDOG.yml`/`WATCHDOG.yaml` 与 `WATCHDOG.md` 共享相同的用户 + 项目搜索路径：用户级 `<active agent dir>/WATCHDOG.yml`，加上从 `cwd` 向上遍历到仓库根（未找到仓库根则到主目录）途中遇到的每个 `WATCHDOG.yml`/`.omp/WATCHDOG.yml`。所有发现的文件一起加载；更具体的文件（项目叶子 > 项目祖先 > 用户）替换具有相同 advisor slug 的较早条目。

## Subagents

Subagent 默认在无 advisor 下运行；advisor 以**按 agent**方式启用，而非全局开关：

- Agent 定义 frontmatter 的 `advisor`: `true` 使用为 `advisor` 角色解析的模型为该 agent 派生的会话提供建议；字符串值（如 `advisor: "deepseek/deepseek-v4-flash"` 或 `advisor: "@smol:high"`）设置显式的 advisor 模型模式，可带可选 `:level` thinking 后缀。
- `task.agentAdvisor` 设置记录（agent 名 → `"on"` / `"off"` / 模型模式）覆盖 frontmatter，可在 `/agents` hub 中按 agent 配置：在某个 agent 上按 Enter 打开其属性行；advisor 条提供开/关、模型浏览器选择或原始模式。

旧的 `advisor.subagents: true` 设置迁移为 `task.agentAdvisor: { task: "on" }`——内置通用 `task` agent 保留其 advisor，其他 agent 默认无 advisor。

被建议的 subagent 会话使用相同的设置/模型角色解析构建自己的 advisor 子系统（显式模式落在被派生会话的 `modelRoles.advisor` 上），然后针对该 subagent 会话的 `cwd` 和 agent 目录重新运行 `WATCHDOG.md` 和 `WATCHDOG.yml` 发现。subagent advisor 与 subagent 主工具会话保持隔离，方式与主 advisor 与主 agent 隔离相同。

## 成本与上下文行为

advisor 用量是独立的模型用量。`/advisor status` 从 advisor agent 自身的 transcript 报告 advisor token 数和成本。

advisor 拥有自己的只追加上下文。每次 advisor prompt 之前，`AgentSession` 估算 incoming tokens，并可能维护 advisor 上下文：

1. 若已启用且存在更大的兼容模型，尝试模型级上下文升级
2. 若升级放不下足够上下文，压缩 advisor 自身的消息历史
3. 若压缩没有候选或仍放不下，从当前有界主 transcript 重新播种

advisor 的实时上下文在内存中且只追加；会话运行期间保留，供 `/advisor dump` 检查，并被独立地升级/压缩/重新播种（如上）。它不是主持久化 transcript 的替代品。

## Transcript 持久化与可观测性

advisor 是拥有自己模型用量的被动审查者，因此——与 task subagent 一样——每个定稿的 advisor turn 都追加到所属会话产物目录内的 JSONL：

- 遗留/默认 advisor：`<session>/__advisor.jsonl`
- 具名 advisor：`<session>/__advisor.<slug>.jsonl`
- subagent advisor（frontmatter `advisor` / `task.agentAdvisor`）：`<session>/<SubId>/__advisor[.<slug>].jsonl`

路径由所属会话文件派生（而非共享产物根目录），因此每个主/subagent advisor 写入不同的文件。保留的 `__advisor` 词干不会与 task subagent id 冲突。

为什么用文件：

- **用量归因。** `omp stats` 递归扫描每个会话文件夹，因此 advisor assistant turn（连同其用量/成本）像其他 subagent 一样归因到同一项目/会话。advisor 的"session update" prompt 被持久化为 `synthetic`、归因于 agent 的用户消息，因此不会夸大用户消息指标。
- **可观测性。** [Agent Hub](./agent-hub.md) 打开时发现遗留和具名的 `__advisor*.jsonl` 文件，并在其所属会话下以只读 `advisor` 类型的 transcript 显示。

文件跟随会话切换：在 `/new`、resume/switch 和 branch 时，记录器在下一次 advisor turn 时于新会话路径重新打开；在 `/drop` 删除旧产物目录前，记录器馈送被分离并排空，排队中的写入无法重建已删除的文件。磁盘上的日志只追加，独立于内存上下文——重新播种和 compaction 从不截断它。

advisor 永远不是同级 agent。`advisor` 类型的 registry 引用被排除在所有面向 agent 的界面之外——`hub` 同级名单和广播目标、subagent 同级 prompt，以及 `history://` 索引/查找/补全——且不能被发消息（`hub` send 和 collab chat 拒绝它），也不能[从 Agent Hub 复活或杀死](./agent-hub.md#persisted-agents-and-advisors)，collab 亦然。无论授予了什么工具，它都不能作为同级被寻址。
