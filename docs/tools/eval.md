# eval

> 在常驻的 language runtime 中执行一个 Python 或 JavaScript cell。一次工具调用就是一个 cell；状态在后续调用中保留。

> **注意：** 不要为了临时代码而通过 `bash` 去 shell 调用 `python -c`、`bun -e` 或 `node -e`。`eval` 提供常驻状态、结构化的 `display()` 捕获、工具/子 agent 桥接、流式输出、取消与工件托底的截断。

## 源码
- 入口与动态 schema：`packages/coding-agent/src/tools/eval.ts`
- 后端启用：`packages/coding-agent/src/tools/eval-backends.ts`
- 面向模型的 prompt：`packages/coding-agent/src/prompts/tools/eval.md`
- Code Mode 传输（Codex `code_mode_only` 会话把非必需工具降级为 eval 桥接）：`packages/coding-agent/src/tools/eval-format/code-mode-declarations.ts`、prompt `packages/coding-agent/src/prompts/tools/eval-code-mode.md`
- 共享契约：`packages/coding-agent/src/eval/backend.ts`、`types.ts`、`executor-base.ts`、`kernel-base.ts`
- 宿主桥接：`packages/coding-agent/src/eval/agent-bridge.ts`、`completion-bridge.ts`、`concurrency-bridge.ts`、`budget-bridge.ts`
- JavaScript：`packages/coding-agent/src/eval/js/`
- Python：`packages/coding-agent/src/eval/py/`
- 输出/截断：`packages/coding-agent/src/session/streaming-output.ts`
- Python 内部实现：`docs/python-repl.md`

## 输入

params 对象就是一个 cell。没有 `cells` 数组、头解析器、语言嗅探或隐式回退。把增量步骤拆成独立的工具调用；每种语言各自保留自己的状态。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `language` | `"py" \| "js"` | 是 | 显式的后端 token。通常活动的 schema 只包含已启用的运行时。 |
| `code` | `string` | 是 | cell 正文，原样执行。 |
| `title` | `string` | 否 | 简短的 transcript 标签。 |
| `timeout` | `number` | 否 | 运行时工作超时（秒）。默认 30；`0` 禁用 cell 超时。非零值按工具超时策略（`TOOL_TIMEOUTS.eval`：1–3600 秒）与 `tools.maxTimeout` 钳制。 |
| `reset` | `boolean` | 否 | 执行前重建该语言的常驻运行时。其他语言运行时不受影响。默认 `false`。 |

三个调用串联的示例：

```json
{"language":"py","title":"imports","code":"import json\nfrom pathlib import Path"}
```

```json
{"language":"py","title":"load config","code":"data = json.loads(read('package.json'))\ndisplay(data)"}
```

```json
{"language":"py","title":"reuse state","code":"display(sorted(data['dependencies']))"}
```

## 后端可用性

`resolveEvalBackends(...)` 把设置与环境覆盖组合起来：

| Token | 运行时 | 设置/默认值 | 环境变量覆盖 | 额外前提条件 |
| --- | --- | --- | --- | --- |
| `py` | 常驻的 IPython 风格 Python 内核 | `eval.py=true` | `PI_PY` | 可用的已配置 Python 解释器/内核 |
| `js` | 常驻的 Bun worker VM | `eval.js=true` | `PI_JS` | 捆绑的 JS 运行时 |

当至少一个运行时启用时，被禁用的运行时会从会话级 wire schema 与模型 prompt 中移除。请求不可用的运行时会抛出 `ToolError`；该工具从不替换为另一种语言。`eval.tools.enabled=true`（默认）独立控制内核定义的工具与 `tools` 子 agent 字段是否被宣传与可用。

## 输出

`execute()` 返回一个文本内容块，外加任意图像块。`onUpdate` 在运行期间流式输出活动 cell 的输出与 details。

- 文本为 stdout/stderr，加上模型可见的 JSON `display()` 值与图像尺寸说明。
- 仅图像的成功报告 `(displayed N image(s); no text output)`；无可见输出的 cell 报告 `(no output)`。
- 非零的后端退出会追加 `Command exited with code N`，把 cell 标记为 `error`，并设置 `details.isError`。
- 取消返回已捕获的输出或 `Command aborted`，并带 `details.isError=true`。

`EvalToolDetails`：

- `cells`：单元素 `EvalCellResult[]`，含 `index`、`title?`、`code`、后端 `language`、`output`、`status`、`durationMs?`、`exitCode?`、`statusEvents?` 与 `hasMarkdown?`。
- `language`：所用的后端；`languages`：不同后端的列表。它们保留历史的多 cell 兼容形态，但一次当前调用只有一个后端。
- `jsonOutputs`：通过结构化 display 捕获的值。
- `images`：图像到达时出现在实时更新中；最终图像是 content blocks。
- `statusEvents`：去重后的辅助函数/工具状态事件。
- `notice`：可选的后端说明。
- `meta`：由 `toolResult(...)` 提供的输出截断/工件元数据。
- `async`：cell 作为异步任务被自动后台化时出现（`{ state, jobId, type: "eval" }`）。
- `isError`：后端失败或取消时设置。

渲染器把调用与结果内联合并，按声明的语言做语法高亮，特殊渲染 markdown 与 JSON 树，并显示超时/截断元数据。`session.allocateOutputArtifact?.("eval")` 为溢出的输出提供托底；`meta` 中的 `artifact://...` 可取得完整捕获。

## 执行流程

1. `EvalTool` 从已启用的语言构建会话专属 schema。它是 essential、strict、`approval="exec"`，并且在一个 agent 会话内 `concurrency="exclusive"`。
2. `execute()` 把 `py/js` 映射到 `python/js`，解析可用性，并把单个输入包装进渲染器兼容的内部 cell 列表。
3. 它从 `session.getEvalSessionId?.()` 或 `defaultEvalSessionId(session)` 取得常驻 executor id，分配输出 sink/工件，并通过 `trackEvalExecution?.(...)` 登记本次运行。
4. 超时默认 30 秒。`0` 不创建看门狗。否则 `IdleTimeout` 与工具及会话的中止信号组合。
5. 等待 `agent()` 与 `completion()` 句柄时会发出 pause/resume 状态操作：在这些宿主桥接中消耗的时间不计入 cell 的运行时工作预算。计算、输出、状态辅助函数与普通 `tool.*` 调用会计入。
6. 所选后端收到 cwd、常驻会话 id、会话文件、内核 owner、reset 标志、回调与取消信号。
7. 输出块流式进入工件感知的 `OutputSink` 与实时尾部。富 display 被分成 JSON、图像、markdown 与状态通道。
8. 成功、非零退出与取消组装成上面的结果形态。即使执行失败，输出 sink 也会被收尾。

## 自动后台化

启用 `eval.autoBackground.enabled`（默认 `false`）时，超过 `eval.autoBackground.thresholdMs`（默认 60000 ms）的 cell 会转成托管的异步任务，而不是阻塞当前回合：

- 工具按 `resolveAutoBackgroundWaitMs(thresholdMs, clampedCellTimeoutMs)` 前台等待：阈值会向下钳制到 cell 自身钳制后的超时再减去 1 秒缓冲，使期限到期内联解决，而不是在触发前片刻转入后台。因此调高 `timeout` 不会把前台执行延长到阈值之外。阈值为 `0` 时立即后台化。
- 后台化时，工具返回实时输出尾部加 `Backgrounded as job <id>; result will be delivered automatically.`，并带 `details.async = { state: "running", jobId, type: "eval" }`。任务完成稍后像后台化的 bash 命令一样送达。
- 等待期间到达排队的用户/对等消息（steer）会立即把 cell 转入后台（“Backgrounded early to handle an incoming message; the cell keeps running.”）。
- 在异步任务管理器的运行中任务容量已满时，工具会落入普通前台执行，而不是失败。
- 失败、取消或超时的 cell 会报告为失败的后台任务（出错执行会重新进入任务管理器的失败路径），绝不会静默显示成功。

## 运行时行为

### JavaScript (`js`)

- 常驻 worker VM 以 `js:${sessionId}` 为键；`reset` 重建 VM，对共享该会话 id 的并发用户有破坏性。
- 在 Bun 下运行，暴露包括 `Bun`、`Buffer`、`fetch`、`process`、`require`、`createRequire`、`fs` 与 Web Crypto 在内的宿主全局。
- 顶层 `await` 与裸 `return` 通过异步包装可用。
- 静态顶层导入与动态导入经由本地模块加载器重写。cell 之间本地文件系统导入会做缓存破坏；裸包与 scheme/URL 导入保留正常的缓存身份。
- 等待区域可与共享该 executor 的其他会话交错；同步代码仍会阻塞 worker 的事件循环。

### Python (`py`)

- 常驻内核以 `python:${sessionId}`、规范化 cwd 与解释器为键。`python.kernelMode="per-call"` 则每次调用创建并关闭一个新内核。
- runner 使用一个持久的 asyncio 事件循环，因此顶层 `await` 可用；`asyncio.run(...)` 在那里非法。
- MIME 帧支持 status、PNG、JSON、markdown、纯文本，以及 HTML 到 markdown 的转换。
- 交互式 stdin 会被拒绝，报 `Kernel requested stdin; interactive input is not supported.`。
- 同步块使用带复制 ContextVars 的默认 executor；Python 字节码仍在 GIL 上竞争。

## Prelude 辅助函数

所有启用的运行时都会在语言允许的范围内暴露等价辅助函数：

- `display(value)`、`print(...)`
- `read(path, offset?, limit?)`、`write(path, content)`、`env(...)`、`output(...)`
- `tool.<name>(args)` 用于普通会话工具调用（两个运行时中都是异步的：`await tool.read({...})`）
- `@tool` / `tool(fn, {...})` 为子 agent 定义内核本地工具（`eval.tools.enabled`，默认开）
- `completion(...)`、`agent(...)`、`wait(...)`、`workpool(...)`
- `log(message)`、`phase(title)`、`budget`

JS 辅助函数是异步的；Python 文件辅助函数是同步的，而 `tool.<name>()` 是协程。`read()` 把非 `local://` scheme 委托给已注册的 read 工具，经注入的根解析 `local://`，并读取相对于 cwd 的常规路径。`write()` 接受常规与 `local://` 路径，但拒绝其他协议 URL。

`display()` 按后端捕获 JSON 兼容结构、图像、markdown 或文本。

### `completion()`

一次无状态、无工具的一次性模型调用，立即返回 `CompletionHandle`：

- JS：`completion(prompt, { model?, system?, schema? })`；Python：带 `model`、`system`、`schema` 的关键字形式。
- `model`：`"smol"`、`"default"` 或 `"slow"` 档位；默认是活动/默认档位。
- `schema`：为合成 `respond` 工具提供的 JSON Schema；`.wait()` 随后返回解析后的数据。
- 无法解析的档位与无效参数会让调用本身失败；凭据缺失、错误/中止停止、空输出与无效结构化输出从 `.wait()` 浮现。
- Handle 是进程本地的、由调用 agent 持有，并在落定 30 分钟后（或 owner 会话结束时）被驱逐。

### `agent()`

注册一个后台子 agent 任务并立即返回 `AgentHandle`：

- JS：`await agent(prompt, { agent?, label?, schema?, schemaMode?, isolated?, apply?, merge?, tools? })`；Python 用关键字参数（`schema_mode`）。
- 预检（spawn 策略、未知 agent、`task.maxRecursionDepth`、硬性回合预算、plan 模式隔离控制、未知 `tools` 名称）同步地让调用失败；执行失败从 `.wait()` 浮现。
- `agent` 默认来自当前 spawn 策略；所选 agent 的 frontmatter model 与设置始终生效（没有逐调用 `model`）。`schema` 覆盖 agent/会话 schema；`schemaMode`/`schema_mode` 选择 `permissive` 或 `strict`。
- `isolated` 请求隔离。`apply` 控制捕获的变更是否被整合；`merge=false` 选择 patch 模式，而常规设置控制 branch 模式。
- `tools`：子 agent 可调用的内核定义工具（见下文）名称；每次调用都在调用方内核内执行。
- Handle 接口：`.id`、`.agent`、`.handle`（`agent://<id>`）、`.status`、`.done()`、`.wait(timeout?)`、`.send(message)`、`.cancel()`、`.output()`。Python handle 可 await；JavaScript 用 `await handle.wait()`。
- 该任务是由调用 agent 持有的常规异步任务：未等待的结果会像后台化的 `task` 一样自动送达，而 `wait()` 消费这次送达以免重放。Eval 子 agent 保持存活（可经 `hub`/`history://` 寻址），并且**不共享**调用方的 eval executor（`shareEvalSession=false`）。

### `wait()`

`wait(handles, timeout=None, raise_errors=True)`（JS：`wait(handles, { timeout, raiseErrors })`）阻塞到列出的每个 agent/completion 句柄都落定，并按输入顺序返回它们的值。`timeout` 后仍在运行的句柄抛出 `TimeoutError`；失败或取消的句柄抛出其错误，或——在 `raise_errors=False` 时——在其槽位中作为错误对象返回。等待会暂停 cell 看门狗，并把外部中止推迟到等待解除；中止会取消被等待的句柄。

### `workpool()`

`workpool(agent=None, name=None, context=None, tools=None)` 创建由存活的 `task.maxConcurrency` 约束的 keep-alive 子 agent 池：

- `.push(*items)` 返回 item id（`<pool>#<seq>`）。某个 item 会交给上下文占用最低的空闲 worker；池中有余量时派生新 worker；或轮询排队到忙碌的 worker 上，并在该 worker 回合结束时作为一批移交。`eval.workpool.freshAgents=true` 则在有空闲容量时排队给新 agent，因此每个 item 都有新上下文，也不会发生后续批处理。
- worker 通过 `yield({ key: <1-based number>, data: {...} })` 或 `yield({ key, error })` 单独提交每批 item；每个响应点名剩余的 keys，最后一个 key 自动结束该回合。
- 池名同时是它的聚合异步任务 id 与标签。它的第一次完全排空即落定并关闭池；下一阶段请新建命名池。聚合结果自动送达一次，内部批次任务则被消费。
- 完全卡住？离开 eval，用 `{ op: "wait", ids: [pool.name] }` 调用 `hub`；反复发出直到落定。没有 `pool.wait()`，因此内核保持空闲以服务 `@tool` 调用。
- `.status()` 报告 worker/item 数量与上下文占用；`.peek()` 返回不消费的 `{ batches, pending }` 快照；`.close()` 丢弃仍排队的 item。池是进程本地的；重启后它们的 worker 仍是可通过 `hub` 触达的停驻 keep-alive agent。

### 内核定义的工具（`@tool` / `tool(fn)`）

启用 `eval.tools.enabled`（默认开）时，cell 可以把一个函数变成其他 agent 可调用的工具：

- Python：`@tool` / `@tool(name=..., description=...)`；JSON Schema 从类型注解（`str`、`int`、`float`、`bool`、`list[...]`、`dict[...]`、`Literal`、`Optional`、`Annotated[T, "description"]`）与默认值推断；仅位置参数会被拒绝。异步函数会被 await。
- JS：`tool(fn, { name?, description?, parameters? })`；`fn` 接收一个 args 对象。
- `tool.defined()` 列出名称；`tool.undefine(name)` 移除一个。重新定义即替换。
- 消费方：`task` item 的 `tools`、`agent(tools=...)`、`workpool(tools=...)`。宿主对照常驻 Python 与 JS 内核解析名称（两者都定义同名是错误），并把每个名称作为子会话的 essential 自定义工具暴露。调用在专用 runner 线程（Python）或 worker 的运行上下文内（JS）执行，因此阻塞在 `wait()` 中的父 cell 仍可服务它们。抛异常的工具会把错误报告给调用方；内核继续运行。未运行的内核则返回错误结果。
- 未知名称同步地让 `task`/`agent()` 调用失败；plan 模式完全拒绝 `tools`。

## 副作用与取消

- Prelude 辅助函数可读写文件并调用任意已注册工具；JS 暴露可联网的 `fetch`。
- Python 使用通过帧化本地 IPC 通信的常驻子进程内核。JavaScript 使用 worker VM。
- 常驻运行时没有心跳或空闲定时器；它们一直存活到 reset、owner 处置（`EvalRunner.disposeKernels()` 按 `kernelOwnerId` 调用 `disposeKernelSessionsByOwner` 与 `disposeVmContextsByOwner`，位于 `packages/coding-agent/src/session/eval-runner.ts`）或进程退出。
- 需要时取消是有破坏性的：JS 终止其 worker；托管内核会被中断，并可能升级到关闭。reset 同样对共享该后端会话的并发工作有破坏性。
- Eval 驱动的 `agent()` 子级保持注册为 keep-alive agent；owner 拆除会取消它们的任务、释放 completion handle，并关闭 owner 的 work pool。

## 限制与错误

- 默认超时：30 秒；`0` 禁用。非零超时经 `clampTimeout("eval", ..., tools.maxTimeout)` 钳制。
- 输出 sink 默认窗口：50 KiB（`DEFAULT_MAX_BYTES`）；实时尾部：100 KiB；截断辅助函数以 3000 行为上限。
- 每个进入模型可见文本的 JSON display 值以 8000 字符为上限；完整结构化值保留在 `jsonOutputs` 中。
- Transcript 预览默认 10 行。
- Eval 子 agent 生成遵循 `task.maxRecursionDepth`（默认 `2`；负值允许无限深度）。辅助函数扇出使用 `task.maxConcurrency`（默认 32，`0` 无界）。
- 畸形参数是 schema 错误；不可用/被禁用的后端与缺失会话是 `ToolError`。
- 运行时异常变成带非零退出的后端输出。交互式 stdin 是错误。输出截断不会让调用失败。
- 死掉的常驻托管内核可被替换，其 executor 会重试该调用一次。

## 备注

- 一次调用就是一个 cell。用独立调用利用持久性，只重跑失败的那一步。
- 状态按语言隔离；重置 Python 不会重置 JS。
- 当前 schema token 只有 `py` 与 `js`；长语言名是渲染器/批准格式化的别名，不是 wire 值。
- 原先的多 cell `cells` 载荷、`*** Cell` 解析器、嗅探回退与受限的 `eval.lark` 语法均已移除。
- 父级与普通 task 子 agent 可以共享继承来的 eval executor id；eval 自己的 `agent()` 创建的子级明确不共享。
