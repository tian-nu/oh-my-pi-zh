# Eval 工具的 Python 后端

本文档描述 `packages/coding-agent` 中的 Python 执行栈，
涵盖工具行为、runner 生命周期、环境处理、执行语义、输出渲染、支持的 magics 以及运维层面的失败模式。

## 范围与关键文件

- 工具入口：`src/tools/eval.ts`
- 会话/单次调用的内核编排：`src/eval/py/executor.ts`
- 子进程内核客户端：`src/eval/py/kernel.ts`
- Python 包装器 / NDJSON server：`src/eval/py/runner.py`
- 注入到每个内核的 prelude 助手：`src/eval/py/prelude.py`
- 宿主侧子 agent 助手桥接：`src/eval/agent-bridge.ts`
- MIME bundle 渲染器（文本 + 结构化输出）：`src/eval/py/display.ts`
- 交互模式下用户触发 Python 运行的渲染器：`src/modes/components/eval-execution.ts`
- 运行时/环境变量过滤与 Python 解析：`src/eval/py/runtime.ts`

## eval 的 Python 后端是什么

`eval` 工具每次调用执行一个 Python cell，运行在一个常驻的 `python` 子进程中，通过 stdin/stdout 通信 NDJSON。不需要 Jupyter gateway，也不需要额外的 pip 依赖。捆绑的 runner 使用 Python 3.10 语法（`str | None`），因此实际要求是 Python 3.10+。富 `display()` 输出（PIL、pandas、plotly、matplotlib 图形）之所以可用，是因为包装器实现了 MIME-bundle 分发。

当前工具输入：

```ts
{
  language: "py";
  code: string;
  title?: string;
  timeout?: number; // seconds; default 30, 0 disables, otherwise clamped to 1..3600
  reset?: boolean;  // wipe the Python kernel before this call
}
```

会话级 wire schema 只列出已启用的运行时（"py" 和 "js"）。Python 和 JavaScript 默认开启。该工具在会话内是 `concurrency = "exclusive"`，因此调用不会重叠。状态在同一语言运行时的多次调用之间持久保留。

## 内核生命周期

每个 Python 内核是一个单独的子进程：`<resolved-python> -u <runner.py>`。runner 随宿主二进制捆绑（Bun text import），按脚本哈希一次性写入 OS 临时目录下的 `omp-python-runner` 缓存，并在后续 spawn 中复用。

内核启动序列：

1. 可用性检查（`checkPythonKernelAvailability`）——验证能解析并运行一个 Python 解释器。
2. 以过滤后的 env 和 `cwd` spawn `python -u runner.py`。
3. 发送一个 init 请求，执行 `os.chdir(cwd)`、注入 env 条目，并把 `cwd` 加入 `sys.path`。
4. 执行 `PYTHON_PRELUDE`（幂等——每个进程只初始化一次）。

内核关闭：

- 通过 stdin 发送 `{"type": "exit"}`。
- 在 `SHUTDOWN_GRACE_MS` 预算内等待进程退出。
- 如果进程未及时退出，升级到 `SIGTERM`，最终 `SIGKILL`。

## Wire 协议（NDJSON，host ↔ runner）

每行一个 JSON 对象，UTF-8，以 `\n` 结尾。

Host → runner：

```jsonc
{"id": "<reqId>", "code": "<source>", "silent": false, "storeHistory": true, "cwd": "<optional>", "env": {"KEY": "VAL"}}
{"type": "exit"}
```

Runner → host：

```jsonc
{"type": "started",  "id": "<reqId>"}
{"type": "stdout",   "id": "<reqId>", "data": "..."}
{"type": "stderr",   "id": "<reqId>", "data": "..."}
{"type": "display",  "id": "<reqId>", "bundle": {<mime>: <value>}}
{"type": "result",   "id": "<reqId>", "bundle": {<mime>: <value>}}
{"type": "error",    "id": "<reqId>", "ename": "...", "evalue": "...", "traceback": ["..."]}
{"type": "done",     "id": "<reqId>", "status": "ok"|"error", "executionCount": N, "cancelled": false}
```

prelude 发出的状态事件（例如 `_emit_status("find", count=…)`）通过 `application/x-omp-status` 装入 display bundle，使现有的 TUI 状态渲染器继续工作。

## Magics

runner 的源码转换器在解析前将 IPython 风格的 magics 重写为普通 Python 调用。支持的集合：

| Magic                             | Effect                                                                                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `%pip <args>`                     | `python -m pip <args>` with live streaming output. Newly installed packages are evicted from `sys.modules` so the next `import` picks up the fresh install. |
| `%cd <path>`                      | `os.chdir(path)` (with `~` expansion); emits status event.                                                                                                  |
| `%pwd`                            | Returns `os.getcwd()`.                                                                                                                                      |
| `%ls [path]`                      | Returns `sorted(os.listdir(path))`.                                                                                                                         |
| `%env [KEY[=VAL]]`                | List, read, or set env vars (matches prelude `env()` semantics).                                                                                            |
| `%set_env KEY VALUE`              | Set `os.environ[KEY]`.                                                                                                                                      |
| `%time <expr>` / `%timeit <expr>` | Time the expression; emits status event with elapsed ms.                                                                                                    |
| `%who` / `%whos`                  | List user-namespace names.                                                                                                                                  |
| `%reset`                          | Clear user globals and re-inject prelude.                                                                                                                   |
| `%load <path>`                    | Read a file into a fresh cell and execute.                                                                                                                  |
| `%run <path>`                     | `runpy.run_path` and merge globals back.                                                                                                                    |
| `%%bash`                          | Run the cell body via `bash`. The only registered shell cell magic — `%%sh` does not exist, and unregistered names raise `Cell magic function '%%<name>' not found`. |
| `%%capture [name]`                | Run body with stdout/stderr captured into `name`.                                                                                                           |
| `%%timeit`                        | Time the cell body.                                                                                                                                         |
| `%%writefile <path>`              | Write body to file.                                                                                                                                         |
| `!cmd` / `var = !cmd`             | Run command via subprocess shell; returns an SList-style result with `.n` / `.s` helpers.                                                                   |
| `var = %name args`                | Assignment forms work for line magics and `!cmd`.                                                                                                           |

未知的 magic 名称会在 cell 内抛出 `NameError: UsageError: ...`。

## 会话持久化语义

`python.kernelMode` 控制常驻内核的复用：

- `session`（默认）
  - 以命名空间化的 eval 会话 id 加上规范化的 cwd 和解释器为键复用内核会话。
  - 多个 owner 可共享该键对应的同一个常驻内核。
  - 通过工具发起的调用是独占的，因此工具调用不会重叠。
  - 已死掉的常驻子进程会在执行前被替换。
  - 如果子进程在执行期间死亡，会被替换且该调用重试一次。
- `per-call`
  - 每次调用 spawn 一个全新的子进程。
  - 调用结束后关闭子进程。
  - 跨调用不保留状态。

### eval 调用间的状态

每次工具调用包含一个 cell。Python 调用顺序执行（因为工具是独占的），后续调用在 `session` 模式下复用选定的常驻内核。

如果某个 cell 失败，错误发生前完成的定义和修改可能仍留在内核内存中。`reset: true` 只在该调用之前重置选定的语言运行时；其他语言运行时不受影响。

## 环境变量过滤与运行时解析

启动 runner 之前会先过滤环境：

- 允许列表包含核心变量，如 `PATH`、`HOME`、locale 变量、`VIRTUAL_ENV`、`PYTHONPATH` 等。
- 允许的前缀：`LC_`、`XDG_`、`PI_`
- 拒绝列表会剥离常见的 API key（OpenAI/Anthropic/Gemini 等）

运行时选择顺序（当 `python.interpreter` 设置指定了显式可执行文件时完全跳过）：

1. 活动/已定位的 venv（`VIRTUAL_ENV`，然后 `CONDA_PREFIX`，然后 `<cwd>/.venv`、`<cwd>/venv`）
2. 托管 venv `~/.omp/python-env`
3. PATH 上的 `python` 或 `python3`

选定 venv 后，其 bin/Scripts 路径会被前置到 `PATH`。

runner 还会收到 `PYTHONUNBUFFERED=1` 和 `PYTHONIOENCODING=utf-8`，以便流式输出及时到达宿主。

## 工具可用性与模式选择

后端设置 `eval.py` / `eval.js` 默认为 `true`。可选的布尔环境标志 `PI_PY` 和 `PI_JS` 各自独立覆盖对应设置。`eval.tools.enabled` 也默认为 `true`；关闭它会移除 `tools` spawn 字段和内核定义工具的指引。

工具的会话级 schema 只列出已启用的运行时。如果 Python preflight 失败而另一个运行时已启用，`eval` 对该运行时仍可用，`py` 调用会报告 Python 后端可用性错误并附上已启用的替代项。

Python prelude 助手包含 `agent(prompt, *, agent=None, label=None, schema=None, schema_mode=None, isolated=None, apply=None, merge=None, tools=None)`，它注册一个后台子 agent 任务并返回一个 `AgentHandle`（`.id`、`.handle` = `agent://<id>`、`.status`、`.done()`、`.wait(timeout=None)`、`.send()`、`.cancel()`、`.output()`，可 await）。`completion(...)` 同样返回一个 `CompletionHandle`。`wait(handles, timeout=None, raise_errors=True)` 按输入顺序对 handles 做屏障等待。`workpool(...)` 返回一个 `WorkPool`（`push`、`status`、`peek`、`close`）；其名称是与 `hub wait` 一起使用的聚合异步任务 id。`tool.<name>(args)` 是一个协程（`await tool.read({...})`）；当 `eval.tools.enabled` 开启时，`@tool` 将内核本地函数注册为子 agent 可用的工具（schema 由类型注解推断）。

runner 在 cell 请求之外还接受 `{"type": "tool", "id", "op": "describe"|"call", ...}` 请求。它由一个专用守护线程（POSIX；Windows 上在 cell 之间）针对内核的 `__omp_tools__` 注册表提供服务，以 `application/json` display bundle（`{ok, tools, missing}` 或 `{ok, value}`）回复，并将抛出异常的工具报告为 `error` 帧而不影响正在运行的 cell。调用方契约见 `docs/tools/eval.md`。

## 执行流程与取消/超时

### Cell 超时

`timeout` 单位为秒，默认 30。`0` 禁用 cell 超时；非零值会被钳制到 `1..3600` 秒，并在传给 `IdleTimeout` 之前再受正值 `tools.maxTimeout` 上限约束。当宿主侧对 `agent()` / `completion()` handle 的 `wait()` 正在进行时，超时被挂起：这些调用通过 `withBridgeTimeoutPause` 发出引用计数的 pause/resume 事件，控制权返回时开始新的超时窗口。

pause/resume 事件是挂起预算的唯一机制。计算、`stdout`/`stderr`、`log()`/`phase()` 以及普通工具调用都计入预算。工具通过 `AbortSignal.any(...)` 组合调用方、会话和看门狗的中止信号；后端不会设置一个相互竞争的期限。

### 内核执行取消

中止/超时时：

- 宿主向 runner 子进程发送 `kill("SIGINT")`。
- runner 的执行期信号处理器在用户代码内抛出 `KeyboardInterrupt`。
- 结果包含 `cancelled=true`；内核超时会附注 `eval cell timed out after <n>s; kernel interrupted but remains running. Reset the kernel via { reset: true } if state appears corrupted.`
- 在请求之间，runner 为 SIGINT 安装 `SIG_IGN`，使一次杂散的取消不会拆掉内核。

如果 runner 在中断后 5 秒内未发出 `done`（`INTERRUPT_ESCALATION_MS`——例如卡在持有 GIL 的 C 代码中），宿主会关闭子进程（按 `exit` → `SIGTERM` → `SIGKILL` 升级），该 cell 被标注为内核被杀，内核在下一次调用时重建。

### stdin 行为

不支持交互式 stdin。runner 不转发 `input()` 提示；调用 `input()` 的用户代码会阻塞直至取消。

## 输出捕获与渲染

### 捕获的输出类别

来自 runner 帧：

- `stdout` / `stderr` → 纯文本块
- `display` / `result` → 富 display 处理（MIME bundle）
- `error` → traceback 文本
- `display` 内的 `application/x-omp-status` MIME → 结构化状态事件

Display MIME 优先级：

1. `text/markdown`
2. `text/plain`
3. `text/html`（转换为基本 markdown）

另外作为结构化输出捕获：

- `application/json` → JSON 树数据
- `image/png` / `image/jpeg` → 图像载荷
- `application/x-omp-status` → 状态事件

### Matplotlib

runner 将 `MPLBACKEND=Agg` 设为环境默认，使图形离屏渲染。每个 cell 结束后，遍历 `pyplot.get_fignums()`；每个 figure 被保存为 PNG，作为 `image/png` display 发出，然后关闭。

### 存储与截断

输出通过 `OutputSink` 流式传输，并可能持久化到 artifact 存储。工具结果可包含截断元数据和用于恢复完整输出的 `artifact://<id>`。

### 渲染器行为

- 工具渲染器（`eval-render.ts`，从 `eval.ts` 再导出）：
  - 显示带每 cell 状态的代码 cell 块
  - 折叠预览默认 10 行
  - 对工具结果中保留的所有输出支持展开模式
- 交互式渲染器（`eval-execution.ts`）：
  - 用于 TUI 中用户触发的 Python 执行
  - 折叠预览默认 20 行
  - 出于显示安全考虑，将过长的单行钳制到 4000 字符
  - 显示取消/错误/截断通知

## 运维排障

- **Python 后端不可用** —— 检查 `eval.py`、`PI_PY`，以及 `python`/`python3` 是否在 PATH 上。如果另一个后端已启用，使用其声明的语言 token。
- **PATH 上没有 Python** —— 安装系统 Python 3.10+，或在 `~/.omp/python-env` 放置一个兼容的 venv。`omp setup python --check` 会报告解析到的解释器。
- **执行挂起后超时** —— 对确实耗时的任务增大 `timeout`，或设为 `0` 禁用看门狗。对卡住的原生代码，取消会先发送 `SIGINT` 再升级；会话模式下若内核被强制杀死，会在下一个请求时重建。
- **Python 代码中的 stdin/input 提示** —— 不支持 `input()`；请以编程方式传递数据。
- **工作目录错误** —— Python 在会话 cwd 中运行。可在常驻内核内使用 `%cd` 或 `os.chdir()` 切换。

## 相关环境变量

- `PI_PY` / `PI_JS` —— 每个后端的暴露覆盖
- `PI_PYTHON_SKIP_CHECK=1` —— 跳过 Python preflight/预热检查
- `PI_PYTHON_INTEGRATION=1` —— 启用会 spawn 真实 Python 的受限集成测试
- `PI_PYTHON_IPC_TRACE=1` —— 记录与 runner 子进程交换的 NDJSON 帧
