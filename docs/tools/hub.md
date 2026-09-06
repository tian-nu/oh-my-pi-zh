# hub

> 单一的 agent 协调表面：经进程级全局邮箱总线的 peer 消息、后台 job 控制，以及对共享长运行进程的监督。

由原先的 `irc`、`job` 与 `launch` 工具合并而来；每个 op 族保留其原有行为与渲染。

## 来源
- 入口：`packages/coding-agent/src/tools/hub/index.ts`（schema、`HubTool`、统一的 `wait`、renderer 分发）
- Messaging 部分：`packages/coding-agent/src/tools/hub/messaging.ts`
- Jobs 部分：`packages/coding-agent/src/tools/hub/jobs.ts`
- Launch 部分：`packages/coding-agent/src/tools/hub/launch.ts`
- 共享类型：`packages/coding-agent/src/tools/hub/types.ts`
- 面向模型的 prompt：`packages/coding-agent/src/prompts/tools/hub.md`
- 主要协作方：
  - `packages/coding-agent/src/irc/bus.ts` — 进程级全局 `IrcBus`：按 agent 的邮箱、投递、waiter 匹配。
  - `packages/coding-agent/src/registry/agent-registry.ts` — 进程级全局 agent 目录与状态。
  - `packages/coding-agent/src/registry/agent-lifecycle.ts` — 直接发送时唤醒已停驻的接收方。
  - `packages/coding-agent/src/session/agent-session.ts` — `deliverIrcMessage(...)`：接收方侧的注入与唤醒回合。
  - `packages/coding-agent/src/async/job-manager.ts` — job 注册表、取消、投递抑制、smart poll 阶梯。
  - `packages/coding-agent/src/launch/client.ts` / `broker.ts` / `presence.ts` / `protocol.ts` — 进程监督 broker。
  - `packages/coding-agent/src/config/settings-schema.ts` — `irc.timeoutMs`、`async.pollWaitDuration`、`launch.enabled`。

## 输入

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `op` | `"send" \| "wait" \| "inbox" \| "list" \| "jobs" \| "cancel" \| "start" \| "ps" \| "logs" \| "stop" \| "restart" \| "describe"` | 是 | 操作。 |
| `to` | `string` | `send` (peer) | 接收方 agent id；广播用 `"all"`。与 `name` 互斥。 |
| `message` | `string` | `send` (peer) | 消息正文。trim 后为空会被拒绝。 |
| `replyTo` | `string` | 否 | `send`：正在回复的消息 id。 |
| `await` | `boolean` | 否 | Peer `send`：投递后阻塞，直到收到该 peer 的下一条消息。与 `to: "all"` 一起使用时无效。 |
| `from` | `string` | 否 | `wait`：只接受来自该 agent id 的消息（纯消息等待）。 |
| `ids` | `string[]` | 否 | `wait`：要监视的 job id（省略 = 所有运行中的 job）；`cancel`：要终止的 job id（必填）。 |
| `timeoutMs` | `number` | 否 | 带 `await` 的 peer `send`，以及消息/job `wait`：毫秒数；`0` 表示无限等待。回复/纯消息等待默认取 `irc.timeoutMs`，监视 job 时默认取 poll 窗口。 |
| `peek` | `boolean` | 否 | `inbox`：把消息留在进程级全局总线邮箱中。注意：当前实现仍会把已缓存在活动接收方会话上的消息排入此结果。 |
| `name` | `string` | 进程 op | 稳定的、项目作用域的 launch 名称（1-48 字符）。在 `send`/`wait` 上时，它会把该 op 路由到进程 broker。 |
| `application`, `args`, `env`, `cwd`, `pty`, `ready`, `restart`, `persist`, `detached` | — | `start` | Launch 规格，与原先 `launch` 工具一致。 |
| `lines`, `head`, `grep`, `follow`, `cursor` | — | `logs` | 日志窗口控制，未变。 |
| `for`, `pattern` | — | `wait` (name) | 进程生命周期条件 / 输出正则。 |
| `text`, `enter`, `keys`, `signal` | — | `send` (name) | 进程 stdin / 终端按键 / 信号。 |
| `timeout` | `number` | 否 | `logs`/`stop`/带 `name` 的 `wait`：秒；默认 30（stop 为 5）。 |

## Op 族与分发
- **Messaging** — `send`（带 `to`）、`inbox`、`list`，以及带 `from` 的 `wait`。即发即忘（fire-and-forget）的发送会返回投递回执（`injected`/`woken`/`revived`/`failed`）；直接发送可唤醒已停驻的 agent，而广播只针对可见的活动 peer，不会唤醒每一个停驻 agent。`await: true` 会在投递后等待一条回复。繁忙且禁用异步执行的接收方可能会自动回复，而不是让等待中的发送方干等。
- **Jobs** — `wait`（裸用或带 `ids`）、`cancel`、`jobs`。Owner 作用域的可见性、watch/unwatch 的投递抑制、返回的完成结果上的 `acknowledgeDeliveries`、等待期间的 500 ms `onUpdate` 快照，以及 `async.pollWaitDuration` 的固定/smart 等待窗口。`jobs` 即原先的 job 列表快照，外加没有运行中 job 条目的运行中子 agent 名册。
- **Processes** — `start`、`ps`、`logs`、`stop`、`restart`、`describe`，以及携带 `name` 时的 `send`/`wait`。行为与原先 `launch` 工具完全一致；`ps` 即 broker 的 `list`。见下方 launch 相关章节。

同时带 `to` 与 `name` 的 `send` 因歧义而被拒绝。`wait` 按目标路由：`name` → 进程等待；否则为统一的协调等待。

## 统一的 `wait`
单一阻塞原语。它解析 job 腿（显式 `ids`、按 owner 作用域并静默过滤，或调用方拥有的每个运行中 job），并在会话可以向 peer 发消息时停驻一个总线 waiter，然后竞争：
- 每个受监视运行中 job 的 `job.promise`，
- 第一条匹配的入站消息（给出 `from` 时按其过滤），
- 等待窗口 — 若传入显式 `timeoutMs`（`0` = 无窗口），否则在 `smart` 下取 `manager.nextPollWaitMs(...)`，或取固定的 `async.pollWaitDuration`，
- 工具调用中止信号。

结果：
- 消息胜出（即使与 job 几乎同时完成：被总线 waiter 消费的消息绝不会丢失）→ 消息像原先的 `irc wait` 一样原样返回（`details.waited`），job 继续运行；它们的结果仍会自行投递。
- 某个 job 落定或窗口耗尽 → 生成与原先 `job` poll 完全一致的 job 快照（`details.jobs`，含 `## Completed` / `## Still Running` 小节）。全为运行中的快照会被标记为 `useless`，并渲染成一个可被替换的等待帧，由下一次 `hub` 调用取代。
- 没有任何 job 腿：退化为带 peer 存活性检测的纯消息等待（受 `irc.timeoutMs` 限制）；若也没有运行中的 peer，则立即返回 `No running background jobs to wait for.`（存在时还会附带无 job 的运行中 agent 名册）。
- 显式 `ids` 匹配不到任何可见对象 → 返回 `No matching jobs found for IDs: ...` 并附每个 id 的 agent 提示（`history://<id>`），绝不会挂起。
- 会话上已缓存的消息会在监视任何东西之前就满足这次等待。

Smart 阶梯记账（`recordPollWaitEnd`）只在确实使用了 smart 窗口（没有显式 `timeoutMs`）时才运行。

## 输出
- Messaging 与 job 结果：单个文本块外加 `details: CoordinationDetails` — `{ op, from?, to?, receipts?, waited?, inbox?, peers?, jobs?, cancelled?, agents? }`。除 job op 的 details 现在携带 `op`（`"wait" | "cancel" | "jobs"`）外，形状与原工具一致。
- 进程结果：`details: LaunchToolDetails` — `{ op, daemon?, daemons?, cursor?, timedOut?, state?, terminalRows?, matched?, spec? }`，与原先 `launch` 工具一致（内部 `ps` 存的是 broker op `list`）。
- 流式：监视 job 的等待每 500 ms 用新快照发出一次 `onUpdate`；其余均为 single-shot。

## 可用性
- 该工具始终注册（`loadMode: "essential"`）。
- Messaging op 需要 `AgentRegistry` 与调用方 agent id；否则返回 `Peer messaging is unavailable in this session.`（`isIrcEnabled` 仍门控 peer 名册的 prompt 小节：对每个子 agent 以及任何仍能派生子 agent 的会话都为 true）。
- Job op 需要 `session.asyncJobManager`；否则返回 `Async execution is disabled; no background jobs are available.`
- 进程 op 需要 `launch.enabled`；否则返回 `Process supervision is disabled (launch.enabled=false).`

## 审批
`hubApproval`（按调用）：`start`、`stop`、`restart` 以及发给进程的 `send` 为 `exec`；其余一切 — messaging、job 控制、`ps`/`logs`/`describe`/`wait` — 为 `read`。

## 启动与就绪（进程）
`application` 与 `args` 是分开的字段，因此调用方不需要 shell 引号：

```json
{
  "op": "start",
  "name": "web",
  "application": "bun",
  "args": ["run", "dev"],
  "ready": { "log": "Local:.*http", "port": 5173, "timeout": 30 }
}
```

默认值：`cwd` = 会话目录，`args: []`、`env: {}`、`pty: true`、`restart: "no"`、`persist: false`、`detached: false`，就绪超时 30 秒。`detached: true` 隐含 `persist`、强制 `pty: false`，并禁用 stdin。`ready.log` 是对捕获输出的正则；`ready.port` 探测 `ready.host`（默认 `127.0.0.1`）上的 TCP；两者都存在时都必须通过。就绪超时会让进程继续运行并报告其状态。

名称在一个项目目录内稳定且唯一。活动中的名称必须先 stop 或 restart；启动一个已完成的名称会创建新的 launch，并轮转其先前的输出日志。

## 日志、输入与信号（进程）
```json
{"op":"logs","name":"web","grep":"error|warn","lines":50}
{"op":"logs","name":"web","follow":true,"cursor":1842,"timeout":30}
{"op":"send","name":"debugger","text":"breakpoint set --name main"}
{"op":"send","name":"debugger","keys":["CTRL_C"]}
```
每个 logs 结果都返回一个字节游标；`follow: true` 会一直等待，直到输出推进超过该游标、进程退出或超时到期。broker 保留一份 25 MiB 的当前日志外加一份轮转日志。按键：`ENTER`、`TAB`、`ESCAPE`、`CTRL_C`、`CTRL_D`、方向键。信号：`SIGINT`、`SIGTERM`、`SIGHUP`、`SIGQUIT`、`SIGKILL`。输入是所有项目客户端共享的同一条流。

## 跨实例生命周期（进程）
与原先 `launch` 工具一致：第一个进程 op 会在 `~/.omp/run/daemons/<project-hash>/` 下的私有 socket 上启动一个分离（detached）的 broker；项目中的每个 omp 实例共享名称、日志与状态。最后一个 omp 进程退出后，broker 会停止非持久化进程并退出。`persist: true` 选择退出最后客户端的拆除；重启策略（`no`/`on-failure`/`always`）使用有上限的指数退避，最长 30 秒。

## 限制与上限
- 邮箱：每个 agent 100 条消息（`MAILBOX_CAP`）；超出上限时丢弃最旧的。
- `irc.timeoutMs` 默认 `120_000`；`0` 表示禁用；负数/非有限值回退到默认值。
- Poll 窗口：`async.pollWaitDuration` — `5s`/`10s`/`30s`/`1m`/`5m`/`smart`（默认）；smart 阶梯 `[5s..5m]` 在连续等待中逐级爬升，60 秒未等待后重置。
- Job 保留 5 分钟；manager 的 max-running 回退值为 15；`async.maxJobs` 限制在 1..100。
- Launch 名称 1-48 字符；`ready.port` 1..65535；`logs`/`wait`/`stop` 超时上限一小时。

## 错误
- 大多数校验/可用性失败是以 `isError: true` 返回的文本结果：messaging 不可用、缺少 `to`/`message`、自我发送（`Cannot send a message to yourself.`）、`await` 配 `to:"all"`、同一次 send 带 `to`+`name`、`cancel` 缺少 `ids`，以及 launch 被禁用。异步被禁用的 `jobs`/`cancel` 响应是个例外：它返回 `Async execution is disabled; no background jobs are available.`，带空 job 列表且无 `isError` 标志。
- Launch 校验（缺少 `name`/`application`、`ready.port` 非法、不支持的键）会抛出 `ToolError`，与之前完全一样。
- `wait` 超时是正常结果（`waited: null` 或被标记为 `useless` 的全运行快照），绝不是错误。
- 按接收方的投递失败以 `failed` 回执呈现；只有在什么都没投递成功时 `send` 才是 `isError`。

## 备注
- IRC 总线、agent registry、job manager 与 launch broker 都是未改动的子系统；只是工具表面被合并了。
- 运行中的接收方仍会以不打断的旁注形式收到注入消息（`irc:incoming` 自定义消息、`prompts/system/irc-incoming.md`）；回复则是真实的回合。
- 向停驻的 agent 发消息会唤醒它 — 这是唯一的恢复原语；task 工具没有 `resume` 参数。
- TUI 渲染按族保留：消息卡片（`IRC ➤ / ⟵` 头部）、job 等待帧（可替换、带微光效果的行）与 launch 帧都渲染得与合并前的工具逐字节一致；`hub` renderer 只负责分发。
