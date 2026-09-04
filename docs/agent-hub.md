# Agent Hub

Agent Hub 是一个交互式 TUI，用于查看和控制与当前会话关联的 subagent。它集成了实时名单、每个 agent 的活动和用量、transcript 访问、steering、revive 和 kill 控制。主 agent 不会列出，因为它的对话就是当前的会话视图。

会话恢复时，Hub 还会从当前会话的持久化产物中发现停驻（parked）的 subagent。Advisor transcript 文件以只读行的形式出现。

## 打开 Hub

| 输入           | 行为                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------- |
| `Alt+A`        | 通过 `app.agents.hub` 打开或关闭 Agent Hub。即使名单为空也会打开。                              |
| `Ctrl+S`       | 通过旧有的 `app.session.observe` 动作打开或关闭同一个 Hub。                                    |
| 双击 `←`       | 当当前会话有可显示的 agent 时，在空的主会话编辑器中打开 Hub。                                   |

运行 `/hotkeys` 查看当前生效的组合键。可以在 `~/.omp/agent/keybindings.yml` 中重新映射这两个动作：

```yaml
app.agents.hub: Alt+A
app.session.observe: Ctrl+S
```

双击 `←` 手势不是键绑定动作。聚焦于某个 subagent 时，双击 `←` 返回主会话而不是打开 Hub。

## 名单与检查器

名单根据会话的 agent registry 和进度事件更新。其响应式行显示：

- 状态（`running`、`idle`、`parked` 或 `aborted`）、agent 身份、父 agent 和未读 IRC 数；
- 模型角色、解析后的模型以及距上次活动的时间；
- 分配的任务或当前活动；
- 成本、活跃时间或耗时跨度、请求数、工具调用数和 token 数。

表头汇总所有已计量 agent 的状态和用量。按 `t` 可在稳定的平面名单与父/子树视图之间切换。

在宽终端上，选中 agent 的检查器显示在名单旁边。在窄终端上，按 `Tab` 用检查器替换名单。检查器额外显示：

- 当前工具及其参数、最近的意图和重试状态；
- 上下文窗口使用情况（可用时）；
- 父子谱系；
- 输出和 patch 路径，以及隔离 worktree 的分支元数据（存在时）。

指标取决于该 agent 可用的进度或持久化用量数据。缺失数据显示为 `usage —` 而非估算值。

### 名单控制

| 按键或输入                  | 动作                                                                           |
| --------------------------- | ---------------------------------------------------------------------------- |
| `j` / `k`、`↑` / `↓`、滚轮   | 选择一个 agent。                                                              |
| `Enter` 或点击              | 打开选中的 agent。                                                            |
| `t`                         | 在平面与父/子视图之间切换。                                                    |
| `Tab`                       | 在窄终端上切换检查器。                                                        |
| `PageUp` / `PageDown`       | 滚动已打开的检查器。                                                          |
| `r`                         | 复活（revive）选中的停驻 agent。                                               |
| `x`                         | 必要时中止运行中的 turn，然后杀死并释放选中的 agent。                          |
| `Esc`                       | 窄终端上先关闭检查器，再关闭 Hub。                                             |

只有 `parked` 状态的 agent 可以复活。`x` 立即生效；仅在确定要丢弃该 agent 实例时使用。

## 读取并引导 subagent

对于普通的本地 subagent，按 `Enter` 或点击会让主 TUI 聚焦到该 agent 的会话并关闭 Hub。聚焦停驻的 agent 会将其复活。此后 transcript、状态栏和编辑器都属于该 subagent：

1. 阅读其实时 transcript 和工具活动。
2. 输入消息并按 `Enter`，以引导运行中的 turn 或提示空闲的 agent。
3. 在编辑器为空时按 `Esc`，或双击 `←`，返回主会话。

Steering 使用普通的 prompt 路径，因此消息和响应会写入 subagent 的持久化会话历史。聚焦 subagent 时，`Esc` 返回主会话；它不会中断 subagent。

没有本地可聚焦会话的上下文则改用 Hub 的全屏 transcript 查看器，包括 collab 来宾和 advisor 行。查看器增量追踪基于文件的 transcript，并且仅当选中的 agent 可以接收消息时才提供输入行。在那里发送消息的语义相同：停驻则复活，运行中则引导，空闲则提示。

## 持久化 agent 与 advisor

为某个持久化会话打开 Hub 时，会扫描该会话的产物树。历史 subagent JSONL 文件变成停驻行；被杀死的 agent 的墓碑记录使其保持 aborted 状态。嵌套的 subagent 保留其父子谱系。输出和 patch 产物会附加到对应的检查器行。

Advisor transcript 文件（`__advisor*.jsonl`）以 `advisor` 类型的行出现在其所属会话之下。它们是可观测性记录，而非同级 agent：

- 可以打开并跟踪其 transcript；
- 不能向其发送消息；
- 不能复活；
- 不能杀死。

这些限制同样适用于控制宿主 Hub 的 collab 来宾。

## 相关界面

Agent Hub 是面向人类的实时会话视图。相邻的命令和内部 URL 服务于更窄的用途：

- `/jobs` 打印运行中和最近完成的异步工具任务快照。它不能替代按 agent 的 transcript 或控制视图。
- `history://<id>` 为 coding agent 提供运行中或停驻 subagent 的精简 transcript。
- `agent://<id>` 解析 subagent 保存的最终输出产物；它不是实时 transcript。
- `hub` `list` 向 coding agent 暴露同级名单，`hub` `send` 以编程方式引导普通 subagent 或对其进行追问。向停驻的 subagent 发送消息会将其复活。

Advisor 行被有意排除在面向 agent 的 `hub`、`history://` 和 `agent://` 同级工作流之外。

另见 [Task Agent Discovery and Selection](./task-agent-discovery.md)、[Collaboration](./collab.md) 和 [Advisor, WATCHDOG.md, and WATCHDOG.yml](./advisor-watchdog.md)。
