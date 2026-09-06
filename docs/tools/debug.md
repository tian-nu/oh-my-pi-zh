# debug

> 驱动一个 DAP 调试会话；相邻的调试 UI 代码复用同一子系统处理日志、原始 SSE 捕获、报告、性能剖析与系统诊断。

## 源码位置
- 入口：`packages/coding-agent/src/tools/debug.ts`
- 面向模型的提示词：`packages/coding-agent/src/prompts/tools/debug.md`
- 主要协同文件：
  - `packages/coding-agent/src/dap/session.ts` — 会话生命周期、断点/状态缓存
  - `packages/coding-agent/src/dap/client.ts` — adapter 进程/socket 传输、DAP 消息循环
  - `packages/coding-agent/src/dap/config.ts` — adapter 解析与自动选择
  - `packages/coding-agent/src/dap/defaults.json` — 内置 adapter 定义
  - `packages/coding-agent/src/dap/types.ts` — request/response/capability 形状
  - `packages/coding-agent/src/tools/tool-timeouts.ts` — 按工具的超时钳制
  - `packages/coding-agent/src/debug/index.ts` — 交互式 debug 选择器菜单
  - `packages/coding-agent/src/debug/log-viewer.ts` — 最近日志 TUI 查看器
  - `packages/coding-agent/src/debug/raw-sse.ts` — 原始 SSE TUI 查看器
  - `packages/coding-agent/src/debug/raw-sse-buffer.ts` — 有界的 SSE 捕获缓冲区
  - `packages/coding-agent/src/debug/remote-debugger.ts` — 一次性 JavaScriptCore 远程 inspector socket
  - `packages/coding-agent/src/debug/profiler.ts` — CPU/堆剖析辅助函数
  - `packages/coding-agent/src/debug/report-bundle.ts` — `.tar.gz` 报告打包、日志来源、缓存清理
  - `packages/coding-agent/src/debug/system-info.ts` — 系统快照收集与 env 脱敏
  - `packages/coding-agent/src/debug/terminal-info.ts` — 终端状态收集/格式化
  - `packages/coding-agent/src/debug/protocol-probe.ts` — 终端协议探测面板与示例图片

## 输入

| 字段 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `action` | `"launch" \| "attach" \| "set_breakpoint" \| "remove_breakpoint" \| "set_instruction_breakpoint" \| "remove_instruction_breakpoint" \| "data_breakpoint_info" \| "set_data_breakpoint" \| "remove_data_breakpoint" \| "continue" \| "step_over" \| "step_in" \| "step_out" \| "pause" \| "evaluate" \| "stack_trace" \| "threads" \| "scopes" \| "variables" \| "disassemble" \| "read_memory" \| "write_memory" \| "modules" \| "loaded_sources" \| "custom_request" \| "output" \| "terminate" \| "sessions"` | 是 | `packages/coding-agent/src/tools/debug.ts` 中工具 switch 的分发键。 |
| `program` | `string` | 否 | 启动目标路径。`launch` 必需。提供了 `cwd` 时相对它解析，否则相对会话 cwd 解析。 |
| `args` | `string[]` | 否 | `launch` 的程序 argv。 |
| `adapter` | `string` | 否 | 显式 adapter 名称。否则由 `selectLaunchAdapter()` / `selectAttachAdapter()` 从 `packages/coding-agent/src/dap/config.ts` 自动选择。 |
| `cwd` | `string` | 否 | launch/attach 的工作目录。默认为会话 cwd。 |
| `file` | `string` | 否 | 源断点的源文件路径。 |
| `line` | `number` | 否 | 源断点的源代码行。 |
| `function` | `string` | 否 | 函数断点名称。提供时，断点操作走函数路径并忽略 `file`/`line`；schema 并不拒绝两种形式同时出现。 |
| `name` | `string` | 否 | 数据断点信息的目标名称。`data_breakpoint_info` 必需。 |
| `condition` | `string` | 否 | 源/函数/指令/数据断点的条件表达式。 |
| `hit_condition` | `string` | 否 | 指令/数据断点的命中次数条件。 |
| `expression` | `string` | 否 | 表达式或原始调试器命令。`evaluate` 必需。 |
| `context` | `string` | 否 | 求值上下文。默认为 `"repl"`。作为 DAP evaluate context 透传。 |
| `frame_id` | `number` | 否 | `evaluate`、`scopes`、`data_breakpoint_info` 的帧选择器。省略时，`scopes` 与 `evaluate` 默认使用当前停住的帧。 |
| `scope_id` | `number` | 否 | 来自某个 scope 的 variables 引用。`variables` 接受；也用作 `data_breakpoint_info` 的回退 variables 引用。 |
| `variable_ref` | `number` | 否 | `variables` 的 variables 引用；与 `scope_id` 同时存在时优先于它。 |
| `pid` | `number` | 否 | `attach` 的本地进程 id。仅在未选择显式 adapter 时才需要与 `port` 一起提供。 |
| `port` | `number` | 否 | 远程 attach 端口。若未强制指定 adapter，在提供 `port` 时 attach 优先选择 `debugpy`。 |
| `host` | `string` | 否 | `attach` 的远程 attach 主机。 |
| `levels` | `number` | 否 | `stack_trace` 的最大栈帧数。 |
| `memory_reference` | `string` | 否 | `disassemble`、`read_memory`、`write_memory` 的内存引用/地址。提供时 `disassemble` 使用它；否则若 adapter 提供了当前停止位置的指令指针引用，则回退到它。 |
| `instruction_reference` | `string` | 否 | 指令断点引用；指令断点操作必需。`disassemble` 不使用。 |
| `instruction_count` | `number` | 否 | `disassemble` 必需。 |
| `instruction_offset` | `number` | 否 | `disassemble` 的指令偏移。 |
| `count` | `number` | 否 | `read_memory` 的字节数。该操作必需。 |
| `data` | `string` | 否 | `write_memory` 的 Base64 负载。该操作必需。 |
| `data_id` | `string` | 否 | 数据断点 id。`set_data_breakpoint` / `remove_data_breakpoint` 必需。 |
| `access_type` | `"read" \| "write" \| "readWrite"` | 否 | `set_data_breakpoint` 的访问过滤器。 |
| `command` | `string` | 否 | 自定义 DAP 请求命令。`custom_request` 必需。 |
| `arguments` | `Record<string, unknown>` | 否 | `custom_request` 的自定义 DAP 请求体。 |
| `offset` | `number` | 否 | 指令断点、反汇编、内存读取、内存写入的偏移。 |
| `resolve_symbols` | `boolean` | 否 | `disassemble` 的符号解析标志。 |
| `allow_partial` | `boolean` | 否 | `write_memory` 的部分写入许可。 |
| `start_module` | `number` | 否 | `modules` 的模块分页起始索引。 |
| `module_count` | `number` | 否 | `modules` 的模块分页数量。 |
| `timeout` | `number` | 否 | 每次请求的秒数，默认 `30`；`clampTimeout("debug", ...)` 先应用正的 `tools.maxTimeout` 上限，再应用工具的 `5..300` 范围（因此 5 秒下限仍优先于更低的全局上限）。 |

### 各 action 的具体要求
- `launch`：`program`
- `attach`：`pid` 或 `port`，除非显式 adapter 提供其 attach 参数
- `set_breakpoint` / `remove_breakpoint`：`function`，或 `file` + `line`
- `set_instruction_breakpoint` / `remove_instruction_breakpoint`：`instruction_reference`
- `data_breakpoint_info`：`name`
- `set_data_breakpoint` / `remove_data_breakpoint`：`data_id`
- `evaluate`：`expression`
- `variables`：`variable_ref` 或 `scope_id`
- `disassemble`：capability `supportsDisassembleRequest`，外加 `instruction_count`，以及 `memory_reference` 或带 `instructionPointerReference` 的当前停止位置
- `read_memory`：capability `supportsReadMemoryRequest`，外加 `memory_reference` 与 `count`
- `write_memory`：capability `supportsWriteMemoryRequest`，外加 `memory_reference` 与 `data`
- `modules`：capability `supportsModulesRequest`
- `loaded_sources`：capability `supportsLoadedSourcesRequest`
- `custom_request`：`command`

### 交互式选择器取值
`packages/coding-agent/src/debug/index.ts` 还暴露一个仅 UI 的固定选择器，取值为 `open-artifacts`、`performance`、`work`、`dump`、`memory`、`logs`、`system`、`terminal`、`protocols`、`raw-sse`、`remote-debugger`、`transcript`、`clear-cache`。这些不能通过 `debugSchema` 由模型调用；它们是本地 TUI 菜单路由。

## 输出
该 agent 工具从 `packages/coding-agent/src/tools/debug.ts` 返回标准 `toolResult()` 负载：
- `content`：单个文本块。每个 action 都渲染人类可读的文本；`content` 中没有结构化 JSON 块。
- `details.action`：回显的 action。
- `details.success`：总是初始化为 `true`；失败通过在返回结果前抛出而呈现。
- `details.snapshot`：对于操作或创建会话的 action 存在，使用 `packages/coding-agent/src/dap/types.ts` 的 `DapSessionSummary`。
- 特定 action 的 `details` 字段：
  - `launch` / `attach`：`adapter`
  - 断点 action：`breakpoints`、`functionBreakpoints`、`instructionBreakpoints`、`dataBreakpoints`
  - `data_breakpoint_info`：`dataBreakpointInfo`
  - `continue` / `step_*`：`state`、`timedOut`
  - `threads`：`threads`
  - `stack_trace`：`stackFrames`
  - `scopes`：`scopes`
  - `variables`：`variables`
  - `evaluate`：`evaluation`
  - `disassemble`：`disassembly`
  - `read_memory`：`memoryAddress`、`memoryData`、`unreadableBytes`
  - `write_memory`：`bytesWritten`
  - `modules`：`modules`
  - `loaded_sources`：`sources`
  - `custom_request`：`customBody`
  - `output`：`output`
  - `sessions`：`sessions`

流式/UI 行为：
- 可发现工具的渲染器合并调用与结果（`mergeCallAndResult: true`），以内联方式渲染，并在参数/结果仍在组装时启用动画化的部分结果呈现。
- `debug.ts` 本身不通过 `_onUpdate` 发出进度更新；执行结果投递是单次的。
- 批准对 action 敏感：只读 action（`output`、`threads`、`stack_trace`、`scopes`、`variables`、`disassemble`、`read_memory`、`loaded_sources`、`modules`、`sessions`）请求读取批准；其余所有 action 请求执行批准。
- 交互式选择器由 UI 驱动而非模型驱动。它切换 TUI 组件、向聊天窗格追加状态行、在外部查看器中打开文件、写入归档/临时文件，或启动进程级 JavaScriptCore inspector socket。

模型工具结果之外的旁路工件：
- `createReportBundle()` 在报告目录下写入 `omp-report-<timestamp>.tar.gz`，并把文件系统路径返回给 UI 处理器。
- `#handleWorkReport()` 在打开前写入 `/tmp/work-profile-<Date.now()>.svg`。
- `RawSseViewerComponent` 与 `DebugLogViewerComponent` 可以把捕获的文本复制到剪贴板。

## 流程

1. 工具注册是有条件的：`packages/coding-agent/src/tools/debug.ts` 中的 `DebugTool.createIf()` 在 `session.settings.get("debug.enabled")` 不为 true（默认 `true`）时返回 `null`。`packages/coding-agent/src/tools/index.ts` 接线该工厂，并在工具过滤中重新检查同一设置。
2. `DebugTool.execute()` 通过 `clampTimeout("debug", params.timeout)` 钳制 `params.timeout`：在工具的 5 秒下限与 300 秒上限之前先应用可选的正 `tools.maxTimeout` 上限，并把调用方的 `AbortSignal` 与 `AbortSignal.timeout(...)` 组合。
3. `launch` 解析 cwd/program 路径，把目标归类为文件/目录/缺失，拒绝目录（除非所选 adapter 设置了 `acceptsDirectoryProgram`），并委托给 `dapSessionManager.launch()`。`attach` 解析 cwd 并选择一个 adapter；仅在没有显式 adapter 时才要求 `pid` 或 `port`。
4. `DapSessionManager.launch()` / `.attach()` 强制单一根会话，通过 `DapClient.spawn()` 启动 adapter，注册监听器，发送 `initialize`，缓存 capabilities，订阅整棵树范围的 stop 事件，发送 `launch`/`attach`，然后完成 `initialized` → `configurationDone` 握手。
5. `DapClient.spawn()` 以 `NON_INTERACTIVE_ENV` 分离地启动 adapter。`stdio` 使用 adapter 管道；`socket` 在 Linux 上使用 Unix socket，在其他平台由 adapter 回调到本地 TCP 监听器；`tcp` 在 adapter 参数中替换 `${port}`，启动其本地服务器然后连接。子会话通过 `DapClient.connect()` 复用根 `tcp` 服务器。
6. `packages/coding-agent/src/dap/session.ts` 中的 `#registerSession()` 安装反向请求处理器：
   - `runInTerminal`：通过 `ptree.spawn()` 分离地启动请求的 debuggee 命令，返回 `{ processId }`
   - `startDebugging`：把子 DAP client 连接到根 TCP 服务器，转发请求的 `launch`/`attach` 配置，在 `configurationDone` 之前绑定根断点，并递归安装同样的处理器
   - 事件：`output`、`initialized`、`stopped`、`continued`、`exited` 与 `terminated` 更新缓存的会话状态；停住的子会话成为活动目标
7. 操作性 action（`set_breakpoint`、`evaluate`、`threads`、`read_memory`、`custom_request` 及类似操作）调用 `dapSessionManager` 的方法。大多数经由 `#sendRequestWithConfig()`，它先按需发送 `configurationDone`，然后发送 DAP 请求并刷新活动会话及其祖先。
8. 断点 action 在活动的根/子树上同步所需的断点集合。新子会话在它们的 `configurationDone` 请求之前收到这些集合。
9. `continue` 与三个 step action 清除缓存的停止状态，在发送 DAP 请求前订阅会话树中任何位置的 stop/termination 事件，然后 `#awaitStopOutcome()` 返回活动子会话的停止位置，或报告目标在超时后仍在运行。
10. `pause` 发送 DAP `pause`，必要时等待 stopped 事件；若程序已停止则复用缓存的停止状态。
11. 当调用方省略 id 且缓存状态可用时，`stack_trace`、`scopes`、`variables` 与 `evaluate` 默认使用当前停住的子会话/线程/帧。
12. `output` 从活动 `DapSession` 读取内存中的输出环。`terminate` 从根向下遍历每个子会话，发送尽力而为的 `terminate`/`disconnect`，即使某个 adapter 超时也会处置整棵树。
13. `sessions` 读取管理器的当前映射并格式化根与子摘要。只能存在一棵根树；adapter 递归请求的子会话以 `parentSessionId` / `childSessionIds` 跟踪。
14. `packages/coding-agent/src/debug/index.ts` 中的交互式选择器构建固定取值的 `SelectList`，并把每一项分发到对应处理器：
   - `performance`：`startCpuProfile()`，等待 Enter/Escape，停止剖析，用 `getWorkProfile(30)` 读取 30 秒 work profile，然后通过 `createReportBundle()` 打包
   - `work`：读取 `getWorkProfile(30)`，写入临时 SVG，在外部打开
   - `dump`：立即创建报告包
   - `memory`：强制 GC，调用 `Bun.generateHeapSnapshot("v8")`，然后打包
   - `logs`：构建 `DebugLogSource` 并挂载 `DebugLogViewerComponent`
   - `raw-sse`：从会话解析 `RawSseDebugBuffer` 并挂载 `RawSseViewerComponent`
   - `remote-debugger`：复用或启动回环 JavaScriptCore `RemoteInspectorServer` socket 并显示其 host/port；Bun API 是进程级的，没有停止操作
   - `system`：调用 `collectSystemInfo()` 并把 `formatSystemInfo()` 渲染进聊天窗格
   - `terminal`：`collectTerminalState()` + `formatTerminalState()` 渲染进聊天窗格
   - `protocols`：触发一次测试性桌面通知（除非被抑制），然后用示例图片挂载 `ProtocolProbeComponent`
   - `open-artifacts`：打开当前会话的工件目录（若存在）
   - `transcript`：委托给 `ctx.handleDebugTranscriptCommand()`
   - `clear-cache`：显示确认，然后用 `clearArtifactCache()` 移除超过 30 天的工件目录

## 模式 / 变体
- **可用性门控**
  - `debug.enabled` 为 false 时工具隐藏；该设置默认为 `true`。工具使用可发现加载与排他并发。
- **Adapter 选择**
  - 内置 adapter id 为 `gdb`、`lldb-dap`、`codelldb`、`debugpy`、`dlv`、`js-debug-adapter`、`netcoredbg`、`kotlin-debug-adapter`、`rdbg`、`php-debug-adapter`、`bash-debug-adapter`、`dart-debug-adapter`、`flutter-debug-adapter` 与 `elixir-ls-debugger`。自动选择只考虑其配置命令可解析的 adapter；显式选择已配置但不可用的 adapter 会产生特定于 adapter 的安装/配置错误。
  - `launch`：显式 `adapter` 优先；否则 `selectLaunchAdapter()` 按扩展名匹配、根标记匹配，再按对无扩展二进制优先原生调试器（`gdb`、`lldb-dap`）的顺序对可用 adapter 排序。
  - `attach`：显式 `adapter` 优先；否则远程 `port` 优先选择 `debugpy`，然后是原生调试器，再是第一个可用 adapter。
- **自定义 adapter 配置**
  - 可以用 `dap.json`、`.dap.json`、`dap.yaml`、`.dap.yaml`、`dap.yml` 或 `.dap.yml` 添加或覆盖调试 adapter。
  - 搜索顺序与 LSP 配置一致：项目根、项目配置目录（`.omp/`、`.claude/`、`.codex/`、`.gemini/`）、用户配置目录（`~/.omp/agent/`、`~/.claude/`、`~/.codex/`、`~/.gemini/`）、插件根，然后是 home 根回退。文件按从最低到最高的优先级合并。
  - 配置形状可以是 `{ "adapters": { ... } }`，也可以是顶层 adapter 映射。
  - Adapter 字段：
    - `command`：可执行文件名称或路径。必需。
    - `args`：adapter argv。
    - `languages`：显示/过滤元数据。
    - `fileTypes`：用于 launch 自动选择的小写文件扩展名。
    - `rootMarkers`：用于对项目 adapter 排序的文件/目录。
    - `launchDefaults`：在所选 program/cwd/args 之前合并的默认 DAP launch 参数。
    - `attachDefaults`：默认 DAP attach 参数。显式 adapter 可以在没有 PID 或端口的情况下 attach；由它的 adapter 校验这些参数。
    - `connectMode`：`"stdio"`（默认）、`"socket"`（Delve 风格的平台相关 socket/回调）或 `"tcp"`（启动带 `${port}` 替换进 `args` 的本地 DAP 服务器）。
    - `acceptsDirectoryProgram`：对 `dlv` 等能启动包/项目目录的 adapter 设为 `true`。

示例 `.omp/dap.json`：

```json
{
  "adapters": {
    "custom-jvm": {
      "command": "kotlin-debug-adapter",
      "args": ["--stdio"],
      "languages": ["java", "kotlin"],
      "fileTypes": [".java", ".kt", ".kts"],
      "rootMarkers": ["pom.xml", "build.gradle", "build.gradle.kts"],
      "launchDefaults": {
        "request": "launch",
        "projectRoot": "."
      },
      "attachDefaults": {
        "request": "attach",
        "host": "127.0.0.1"
      }
    }
  }
}
```

OpenOCD 远程目标的 GDB 示例：

```json
{
  "adapters": {
    "pico-openocd": {
      "command": "gdb",
      "args": [
        "-q",
        "-ex",
        "file zig-out/firmware/gc9a01-test.elf",
        "-i",
        "dap"
      ],
      "attachDefaults": {
        "target": ":3334"
      }
    }
  }
}
```
- **传输**
  - `stdio`：直接的 adapter `stdin`/`stdout` 分帧。
  - `socket`：Linux 上的 Unix 域 socket；macOS/其他平台上是 adapter 回调到本地 TCP 监听器。
  - `tcp`：预留回环端口，把它替换进 adapter 参数中的 `${port}`，等待 adapter 开始监听，然后连接。已解析的 JavaScript/TypeScript adapter 使用这种方式，递归 `startDebugging` 子会话也必需它。
- **DAP agent 工具 action**
  - `launch` — 启动 adapter、初始化会话、可能停于入口；返回格式化的会话快照与 `details.adapter`。
  - `attach` — 连接到活动进程或远程端口；输出形状与 `launch` 相同。
  - `set_breakpoint` — 添加/更新源或函数断点；返回该目标的当前断点列表。
  - `remove_breakpoint` — 移除源或函数断点；返回剩余断点列表。
  - `set_instruction_breakpoint` / `remove_instruction_breakpoint` — 需要 `supportsInstructionBreakpoints`；返回当前指令断点列表。
  - `data_breakpoint_info` — 需要 `supportsDataBreakpoints`；向 adapter 请求 `name` 的 `dataId`、访问类型与描述。
  - `set_data_breakpoint` / `remove_data_breakpoint` — 需要 `supportsDataBreakpoints`；返回缓存的数据断点列表。
  - `continue` / `step_over` / `step_in` / `step_out` — 返回描述执行是停止、终止还是继续运行的文本，外加 `details.state` 与 `details.timedOut`。
  - `pause` — 中断运行中的目标并返回停止快照。
  - `evaluate` — adapter 表达式求值；上下文默认为 `repl`。
  - `stack_trace` — 获取已解析线程的帧。
  - `threads` — 获取当前线程。
  - `scopes` — 显式 `frame_id` 或当前停止帧的帧作用域。
  - `variables` — `variable_ref` 或 `scope_id` 的变量。
  - `disassemble` — 需要 `supportsDisassembleRequest`；围绕 `memory_reference` 反汇编，或未提供内存引用时围绕当前停止的指令指针反汇编。
  - `read_memory` — 需要 `supportsReadMemoryRequest`；返回地址、base64 数据与不可读字节数。
  - `write_memory` — 需要 `supportsWriteMemoryRequest`；写入 base64 数据并报告写入字节数。
  - `modules` — 需要 `supportsModulesRequest`；可通过 `start_module` / `module_count` 分页。
  - `loaded_sources` — 需要 `supportsLoadedSourcesRequest`；返回已加载的源描述符。
  - `custom_request` — 用任意参数发送任意 DAP 请求名。
  - `output` — 从会话缓存转储捕获的 stdout/stderr/console 文本。
  - `terminate` — 断开并处置活动会话；没有活动会话时返回 `No debug session to terminate.`。
  - `sessions` — 列出所有缓存的会话摘要。
- **交互式选择器路由（仅 UI）**
  - `logs` — 把今天的日志尾与可选的更早每日日志文件载入 `DebugLogViewerComponent`；支持复制、范围选择、pid 过滤、加载更早日志。
  - `raw-sse` — 基于会话 `RawSseDebugBuffer` 的实时视图；支持尾部跟随、滚动、全选复制。
  - `remote-debugger` — 在 `127.0.0.1` 与自动预留端口上启动或复用进程级 JavaScriptCore WebKit inspector；它是实验性的、不能被停止/重新绑定，且需要兼容的 Safari/WebKit inspector 客户端。
  - `performance` — CPU profile + 30 秒 work profile + 报告包。
  - `memory` — 堆快照 + 报告包。
  - `dump` — 不带剖析器工件的报告包。
  - `work` — 独立的 work-profile flamegraph 导出/打开。
  - `system` — 格式化的 OS/arch/CPU/内存/版本/cwd/shell/终端转储。
  - `terminal` — 格式化的终端子协议/几何/回滚状态转储。
  - `protocols` — 终端协议测试：桌面通知副作用外加采样特殊协议的探测面板。
  - `open-artifacts` / `transcript` / `clear-cache` — 打开工件目录、导出 transcript、修剪工件缓存。

## 副作用
- 文件系统
  - 相对会话 cwd 解析 program/file/cwd 路径。
  - 报告创建写入 `.tar.gz` 包，并可能读取会话 JSONL、工件文件、子代理会话 JSONL 与日志文件。
  - Work-profile 导出写入 `/tmp/work-profile-<timestamp>.svg`。
  - 日志来源从日志目录读取每日日志文件。
  - 工件缓存清理移除超过截止时间的会话工件目录。
  - `resolveRawSseDebugBuffer()` 在存在时复用 owner 上的显式 `rawSseDebugBuffer` 属性，否则在私有 `Symbol("debug.rawSseBuffer")` 键下缓存缓冲区（owner 不可扩展时静默跳过）。
- 网络
  - socket/TCP 模式 adapter 绑定或连接本地 socket；远程 attach 可能经由 adapter 连接到远程调试端口。
  - 仅 UI 的 `remote-debugger` 路由在随机预留的 `127.0.0.1` TCP 端口上打开进程级 JavaScriptCore inspector。它探测 socket 的就绪状态，且没有停止操作。
- 子进程 / 原生绑定
  - 分离地启动调试器 adapter（`gdb`、`lldb-dap`、`python -m debugpy.adapter`、`dlv` 以及来自 `defaults.json` 的其他适配器）。
  - 反向 DAP `runInTerminal` 请求通过 `ptree.spawn()` 分离地启动 debuggee。
  - `getWorkProfile(30)` 来自 `@oh-my-pi/pi-natives`。
  - CPU 剖析使用 `node:inspector/promises`；堆快照使用 `Bun.generateHeapSnapshot("v8")`；原始/日志查看器通过 `@oh-my-pi/pi-utils` 的 `sanitizeText()` 净化文本。
  - `openPath()` 为工件目录与 SVG 启动 OS 默认文件/浏览器处理器。
  - 日志/原始 SSE 查看器可以调用 `copyToClipboard()`。
- 会话状态（transcript、memory、jobs、checkpoints、registries）
  - `DapSessionManager` 在内存中保留会话摘要、断点、线程、栈帧、停止位置、输出捕获、capabilities 与最后使用时间戳。
  - 活动会话 id 对单例 `dapSessionManager` 是全局的。
  - `RawSseDebugBuffer` 按 owner/会话存储最近的 SSE 事件。
  - `remote-debugger.ts` 缓存活动 inspector 端点并合并并发的启动；底层的 Bun inspector 对进程是单向的。
  - 该工具是 `exclusive` 的；并发的 debug 工具调用会被调度器阻塞。
- 用户可见的提示 / 交互式 UI
  - Debug 选择器在删除缓存前显示确认。
  - 性能剖析在剖析停止前临时劫持编辑器的 Enter/Escape 处理器。
  - 日志/原始 SSE 查看器用自定义组件替换编辑器窗格。
- 后台工作 / 取消
  - 每个 DAP 请求都接受 `AbortSignal`；超时与调用方取消中止活动请求，而不是整个会话生命周期。
  - `DapSessionManager` 每 30 秒运行一次后台清理循环。
  - 原始 SSE 查看器订阅缓冲区更新直到关闭。

## 限制与上限
- 工具超时钳制：`packages/coding-agent/src/tools/tool-timeouts.ts` 中 `default=30`、`min=5`、`max=300`。
- 每次请求的 DAP 默认超时：`packages/coding-agent/src/dap/client.ts` 中的 `DEFAULT_REQUEST_TIMEOUT_MS = 30_000`。
- 单一活动会话：由 `packages/coding-agent/src/dap/session.ts` 中的 `#ensureLaunchSlot()` 强制。
- 空闲会话清理：`IDLE_TIMEOUT_MS = 10 * 60 * 1000`，每 `CLEANUP_INTERVAL_MS = 30 * 1000` 检查一次。
- Adapter 存活心跳：`HEARTBEAT_INTERVAL_MS = 5 * 1000`。
- 输出捕获上限：`MAX_OUTPUT_BYTES = 128 * 1024`；整块从前面丢弃（然后前块被字节切片以恰好保留上限），并记录 `outputTruncated`。
- launch/attach 后的初始停止捕获超时：`STOP_CAPTURE_TIMEOUT_MS = 5_000`。
- socket 模式 adapter 就绪超时：`waitForCondition()` 中 `10_000` ms，以及 `packages/coding-agent/src/dap/client.ts` 中的 TCP 连接超时逻辑。
- `packages/coding-agent/src/debug/raw-sse-buffer.ts` 中的原始 SSE 缓冲区上限：
  - `MAX_RAW_SSE_EVENTS = 1_000`
  - `MAX_RAW_SSE_CHARS = 512_000`
  - 每个事件 `MAX_RAW_SSE_EVENT_CHARS = 64_000`；超预算事件先压缩 `tools` schema（保留名称、省略 schema/description），然后做头+尾裁剪，保留首尾部分并在中间放 `: omp-debug-elided chars=...` 注释、末尾放 `: omp-debug-truncated originalChars=...` 标记
- `packages/coding-agent/src/debug/log-viewer.ts` 中的日志查看器窗口：
  - `INITIAL_LOG_CHUNK = 50`
  - `LOAD_OLDER_CHUNK = 50`
- `packages/coding-agent/src/debug/report-bundle.ts` 中的报告/日志摄取上限：
  - 交互式日志读取 `MAX_LOG_LINES = 5000`
  - 尾读上限 `MAX_LOG_BYTES = 2 * 1024 * 1024`
  - 报告包只包含最后 `1000` 行日志
  - 子代理会话纳入上限为最近 `10` 个 JSONL 文件
- `packages/coding-agent/src/debug/index.ts` 中的交互式剖析窗口：performance 与 work 报告都请求 `getWorkProfile(30)`。
- 工件缓存修剪默认：`clearArtifactCache()` 与选择器确认文本中为 `30` 天。

## 错误
- `packages/coding-agent/src/tools/debug.ts` 中的参数校验抛出带明确消息的 `ToolError`，例如：
  - `program is required for launch`
  - 未选择显式 adapter 时的 `attach requires pid or port`
  - `set_breakpoint requires file+line or function`
  - `variables requires variable_ref or scope_id`
  - `instruction_count is required for disassemble`
  - `disassemble requires memory_reference unless the current stop location has an instruction pointer reference`
  - `memory_reference is required for read_memory`
  - `count is required for read_memory`
  - `data is required for write_memory`
  - 所选 adapter 未设置 `acceptsDirectoryProgram` 时的 `launch program resolves to a directory: <path>...`
  - `command is required for custom_request`
- Adapter 选择失败抛出 `No debugger adapter available. Installed adapters: ...`。
- 受 capability 门控的 action 从 `requireCapability(...)` 抛出，例如 `Current adapter does not support memory reads`。
- 无会话与状态错误来自 `DapSessionManager`，例如 `No active debug session. Launch or attach first.`、`No active stack frame. Run stack_trace first or supply frame_id.`、`Debugger reported no threads.`
- 启动第二个活动会话抛出 `Debug session <id> is still active. Terminate it before launching another.`
- DAP 传输/请求失败呈现为 `DapClient` 抛出的错误：
  - `DAP request <command> timed out after <ms>ms`
  - `DAP event <event> timed out after <ms>ms`
  - `DAP adapter <name> is not running`
  - `DAP adapter exited (code N): <stderr>` 或 `DAP adapter exited unexpectedly (code N)`
  - DAP 请求失败时的 adapter 响应 `message`
- `continue` / `step_*` 在目标超过超时仍继续运行时故意不致命：它们返回 `details.timedOut = true` 与 `state: "running"` 而不是抛出。
- `terminate` 在发送 `terminate`/`disconnect` 时抑制 adapter 错误；它仍会在可能时处置 client 并返回最后一份摘要。
- 交互式选择器处理器报告 UI 错误而不是抛出：
  - 剖析器启动/停止、报告打包、日志读取、系统信息收集、缓存清理、工件打开与远程 inspector 启动使用 `ctx.showError(...)` / `ctx.showWarning(...)`
  - 空日志与空工件缓存是警告/状态消息，不是失败
  - 日志/原始 SSE 查看器中的复制失败变成 UI 中的状态/错误文本
- 报告包辅助函数对许多文件读取有意尽力而为：缺失的会话文件、缺失的工件目录、不可读的工件文件、缺失的日志目录、不可访问的缓存目录与缺失的子代理文件都会被静默跳过。
- `collectSystemInfo()` 对 CPU 探测尽力而为；那里的失败回退为 `Unknown CPU`。
- 远程 inspector 启动拒绝已被占用的端口，且若所选回环 socket 在其探测截止时间内不可达则失败。UI 把它报告为 `Failed to start remote debugger: ...`。

## 备注
- `packages/coding-agent/src/prompts/tools/debug.md` 告诉模型只支持一个活动根会话。adapter 请求的子会话属于该根树。
- 默认的 JavaScript/TypeScript adapter 在 TCP 上运行 vscode-js-debug 的 `dapDebugServer.js`。用下列任一方式安装；第一种与最后一种会被 `packages/coding-agent/src/dap/config.ts` 中的 `resolveJsDebugServerPath()` 自动发现。（不要尝试 `npm i -g js-debug-adapter`——它会 404；`js-debug-adapter` 是 omp 的 adapter id，不是 npm 包。）
  - Release tarball，解压后使 `dapDebugServer.js` 落在 `~/.local/opt/js-debug/src/dapDebugServer.js`：
    ```sh
    curl -sL -o js-debug-dap.tar.gz \
      https://github.com/microsoft/vscode-js-debug/releases/download/v1.117.0/js-debug-dap-v1.117.0.tar.gz
    mkdir -p ~/.local/opt && tar -xzf js-debug-dap.tar.gz -C ~/.local/opt
    ```
    把 `v1.117.0` 换成 [releases 页面](https://github.com/microsoft/vscode-js-debug/releases) 上的最新 tag。
  - 其他任何位置通过 `JS_DEBUG_DAP_SERVER=<path-to-dapDebugServer.js>`。
  - 使用 Mason 的 Neovim 用户：`:MasonInstall js-debug-adapter` → 发现于 `~/.local/share/nvim/mason/packages/js-debug-adapter/js-debug/src/dapDebugServer.js`。
- adapter 在 `PATH` 上有 `node` 时由它运行，否则由 omp 宿主（Bun）运行；`resolveDefaultJsDebugAdapter()` 回退到 `process.execPath`，因此纯 Bun 环境也受支持。
- `configurationDone` 在根与子 launch/attach 握手中自动发送，若初始握手未完成则在稍后的请求前惰性发送。
- `startDebugging` 反向请求在同一 TCP 服务器上创建递归子会话；停住的子会话成为线程级 action 的目标。
- `output` 只暴露活动会话合并后的 `output` 事件流；该工具不区分 stdout、stderr 与 console 类别。
- 会话摘要暴露 `needsConfigurationDone`、`parentSessionId` 与 `childSessionIds`。
- 源断点文件路径在缓存与跨树同步前用 `path.resolve()` 规范化。
- `evaluate` 默认为 `repl`，因此当 adapter 支持原始调试器命令时工具可以转发它们。
- `disassemble` 先从 `memory_reference` 解析目标，然后取当前停止会话的 `instructionPointerReference`；两者都不存在时抛出。
- `RawSseDebugBuffer.recordEvent()` 在有界保留之前递增 `totalEvents`。因此快照显示的保留记录数可能少于观测到的事件总数。
- 原始 SSE 缓冲区的监听器失败会被吞掉，这样查看器 bug 不会破坏捕获。
- `createDebugLogSource()` 按最新优先遍历每日日志文件，但 `loadOlderLogs()` 在拼接前反转每个请求的切片，使较早的块按时间顺序前置。
- `clearArtifactCache()` 按目录 mtime 删除目录，而不是按单个文件的年龄。
- `addDirectoryToArchive()` 用 `Bun.file(...).text()` 以文本方式读取工件文件。二进制工件内容不会在报告包中逐字节保留。
- 工具渲染器为 TUI 预览截断显示输出，但底层文本结果仍包含完整返回字符串。
- 仅 UI 的 JavaScriptCore 远程调试器在启动后是幂等的，并且无法停止，因为 `bun:jsc` 不返回句柄。它只绑定到 `127.0.0.1`；回环就绪探测决定成功与否，因为即使 socket 已启动，Bun 也可能在 macOS 上抛出虚假的 bind 错误。
