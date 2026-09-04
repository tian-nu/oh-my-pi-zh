# 自定义工具（Custom Tools）

自定义工具是模型可调用的函数，接入与内置工具相同的工具执行管线。

自定义工具是一个导出工厂函数的 TypeScript/JavaScript 模块。工厂接收一个宿主 API（`CustomToolAPI`），返回一个工具或工具数组。

## 这是什么（以及不是什么）

- **自定义工具**：模型在回合中可调用（`execute` + 参数 schema）。
- **Extension**：生命周期/事件框架，可注册工具并拦截/修改事件。
- **Hook**：经 extension runner 加载的旧版事件驱动拦截器 API。
- **Skill**：静态指导/上下文包，不是可执行的工具代码。

如果需要模型直接调用代码，使用自定义工具。

## 当前代码中的集成路径

有两种活跃的集成方式：

1. **SDK 提供的自定义工具**（`options.customTools`）
   - 在无限制的 SDK bootstrap 中，转换为 extension 工具定义，通过生成的 extension 注册，并始终包含在初始活跃工具集中。
   - 在受限会话（`restrictToolNames: true`）中，SDK 提供的自定义工具被排除，除非设置 `allowRestrictedCustomTools: true`；选择加入的工具仅当其名称也出现在 `toolNames` 中时才活跃。

2. **经 loader API 的文件系统发现模块**（`discoverAndLoadCustomTools` / `loadCustomTools`）
   - 作为库 API 暴露于 `packages/coding-agent/src/extensibility/custom-tools/loader.ts`。
   - 宿主代码可以调用它们从 config/provider/plugin 路径发现并加载工具模块。

```text
Model tool call flow

LLM tool call
   │
   ▼
Tool registry (built-ins + registered custom definitions)
   │
   ▼
CustomTool.execute(toolCallId, params, onUpdate, ctx, signal)
   │
   ├─ onUpdate(...)  -> streamed partial result
   └─ return result  -> final tool content/details
```

## 发现位置（loader API）

`discoverAndLoadCustomTools(configuredPaths, cwd, builtInToolNames)` 合并：

1. Capability providers（`toolCapability`），包括：
   - 原生 OMP 配置（`~/.omp/agent/tools`、`.omp/tools`）
   - Claude 配置（`~/.claude/tools`、`.claude/tools`）
   - Codex 配置（`~/.codex/tools`、`.codex/tools`）
   - Claude marketplace 插件缓存 provider
2. 已安装插件的 manifest（经插件加载器的 `~/.omp/plugins/node_modules/*`）
3. 传给 loader 的显式配置路径

### 重要行为

- 重复的解析路径被去重。
- 工具名冲突会对照内置工具和已加载的自定义工具被拒绝。
- `.md` 和 `.json` 文件被某些 provider 发现为工具元数据，但可执行模块加载器拒绝将它们作为可运行工具。
- 相对配置路径从 `cwd` 解析；`~` 会被展开。

## 模块契约

自定义工具模块必须导出一个函数（优先默认导出）：

```ts
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";

const factory: CustomToolFactory = (pi) => ({
  name: "repo_stats",
  label: "Repo Stats",
  description: "Counts tracked TypeScript files",
  parameters: pi.zod.object({
    glob: pi.zod.string().optional(),
  }),

  async execute(toolCallId, params, onUpdate, ctx, signal) {
    onUpdate?.({
      content: [{ type: "text", text: "Scanning files..." }],
      details: { phase: "scan" },
    });

    const result = await pi.exec(
      "git",
      ["ls-files", params.glob ?? "**/*.ts"],
      { signal, cwd: pi.cwd },
    );
    if (result.killed) {
      throw new Error("Scan was cancelled");
    }
    if (result.code !== 0) {
      throw new Error(result.stderr || "git ls-files failed");
    }

    const files = result.stdout.split("\n").filter(Boolean);
    return {
      content: [{ type: "text", text: `Found ${files.length} files` }],
      details: { count: files.length, sample: files.slice(0, 10) },
    };
  },

  onSession(event) {
    if (event.reason === "shutdown") {
      // cleanup resources if needed
    }
  },
});

export default factory;
```

参数 schema 可使用 Zod 兼容的 omptype builder（`pi.zod`）、原生 omptype builder（`pi.arktype`）或兼容旧版的 TypeBox shim（`pi.typebox`），并流经共享的验证/线上管线。

工厂返回类型：

- `CustomTool`
- `CustomTool[]`
- `Promise<CustomTool | CustomTool[]>`

## 传给工厂的 API 面（`CustomToolAPI`）

来自 `types.ts` 和 `loader.ts`：

- `cwd`：宿主工作目录
- `exec(command, args, options?)`：进程执行辅助函数
- `ui`：UI 上下文（无头模式下可为 no-op）
- `hasUI`：非交互流程中为 `false`
- `logger`：共享的文件 logger
- `arktype`：注入的 omptype `type(...)` builder
- `typebox`：旧版 TypeBox 风格 schema 的兼容 shim
- `pi`：注入的 `@oh-my-pi/pi-coding-agent` 导出
- `pushPendingAction(action)`：暂存一个预览 action，通过向 `xd://resolve` 或 `xd://reject` 写入纯文本原因来落定

loader 以 no-op UI 上下文启动，要求宿主代码在真实 UI 就绪时调用 `setUIContext(...)`。如果运行时未提供 pending-action 存储，调用 `pushPendingAction` 会抛出 `Pending action store unavailable for custom tools in this runtime.`

## 执行契约与类型

`CustomTool.execute` 签名：

```ts
execute(toolCallId, params, onUpdate, ctx, signal);
```

- `params` 通过其 omptype 或 TypeBox schema 经 `Static<TParams>` 静态类型化。
- 运行时参数验证在 agent 循环中执行前发生。
- `onUpdate` 为 UI 流式输出部分结果。
- `ctx` 包含 `sessionManager`、`modelRegistry`、当前 `model`、`isIdle()`、`hasQueuedMessages()`、`abort()`，以及可选的 `settings`、`fetch`、`localProtocolOptions` 和 `autoApprove`。
- `signal` 承载取消信号，可能为 `undefined`。

会话 bootstrap 桥接将自定义工具转换为 extension `ToolDefinition`，并以正确的参数顺序转发调用。`CustomToolAdapter` 仍可供将自定义工具直接适配到 agent 工具接口的库消费者使用。

工具定义还可声明 `strict`、`hidden`、`loadMode`、`deferrable`、`mcpServerName`、`mcpToolName` 和 `approval`。省略 `loadMode` 时，自定义工具名默认为 `"discoverable"`，但规范的关键内置名称（`read`、`write`、`bash`、`edit`、`glob`、`computer`、`eval`、`task`、`hub`、`learn` 和 `manage_skill`）默认为 `"essential"`，以使包装器或重复注册不会降级它们。显式的 `loadMode` 总是胜出；用 `"essential"` 可让任何其他工具保持顶层。尽管公开的 `CustomTool` 类型也声明了 `formatApprovalDetails`，SDK/发现桥不会把该回调传播到已注册的工具定义中，因此它无法在常规集成路径上自定义审批详情。

## 工具如何暴露给模型

- 会话 bootstrap 将包含的 SDK 提供和发现的自定义工具包装为 extension 工具定义；库消费者也可直接使用 `CustomToolAdapter`。
- 它们按名称插入会话工具注册表。
- 在无限制的 SDK bootstrap 中，自定义和 extension 注册的工具被强制包含在初始活跃集中。受限会话排除 SDK 提供的自定义工具，除非设置 `allowRestrictedCustomTools: true`，且仅当选择加入的自定义工具名称出现在 `toolNames` 中时才暴露。
- CLI `--tools` 目前只验证内置工具名；自定义工具的包含经发现/注册路径和 SDK 选项处理。

## 渲染钩子

可选的渲染钩子：

- `renderCall(args, options, theme)`
- `renderResult(result, options, theme)`

常规 SDK 与文件系统发现路径将自定义工具包装为 extension。在这些路径上，`renderResult` 只接收上述三个参数；桥不转发原始工具参数。公开的 `CustomTool` 类型保留可选的第四个 `args` 参数，供直接使用 `CustomToolAdapter` 的消费者使用。

TUI 中的运行时行为：

- 若钩子存在，工具输出渲染在 `Box` 容器内。
- `renderResult` 的 `options` 参数接收 `{ expanded, isPartial, spinnerFrame? }`。
- 渲染器错误被捕获并记录；UI 回退到默认文本渲染。

## 会话/状态处理

可选的 `onSession(event, ctx)` 接收会话生命周期事件，包括：

- `start`, `switch`, `branch`, `tree`, `shutdown`
- `auto_compaction_start`, `auto_compaction_end`
- `auto_retry_start`, `auto_retry_end`
- `ttsr_triggered`, `todo_reminder`

当 branch/会话上下文变化时，使用 `ctx.sessionManager` 从历史重建状态。

## 失败与取消语义

### 同步/异步失败

- 在 `execute` 中抛出（或 promise 被拒绝）视为工具失败。
- Agent 运行时将失败转换为带 `isError: true` 和错误文本内容的工具结果消息。
- 使用 extension 包装器时，`tool_result` 处理器可进一步改写 content/details，甚至覆盖错误状态。

### 取消

- Agent 中止经 `AbortSignal` 传播到 `execute`。
- 将 `signal` 转发给子进程工作（`pi.exec(..., { signal })`) 以实现协作式取消。
- `ctx.abort()` 允许工具请求中止当前 agent 操作。

### onSession 错误

- `onSession` 错误被捕获并作为警告记录；不会使会话崩溃。

## 设计时应考虑的实际约束

- 工具名在活跃注册表中必须全局唯一。
- 在 `details` 中优先使用确定性的、符合 schema 形状的输出，供渲染器/状态重建使用。
- 用 `pi.hasUI` 守护 UI 使用。
- 把工具目录中的 `.md`/`.json` 视为元数据，而非可执行模块。
