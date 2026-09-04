# Extension

在 `packages/coding-agent` 中编写运行时 extension 的主要指南。

本文档覆盖当前的 extension 运行时，位于：

- `src/extensibility/extensions/types.ts`
- `src/extensibility/extensions/runner.ts`
- `src/extensibility/extensions/wrapper.ts`
- `src/extensibility/extensions/index.ts`
- `src/modes/controllers/extension-ui-controller.ts`

发现路径与文件系统加载规则见 [`extension-loading.md`](./extension-loading.md)。

打包的面向用户 extension CLI/功能见 [`user-facing-packages.md`](./user-facing-packages.md)。

## Extension 是什么

Extension 是一个导出默认工厂的 TS/JS 模块。工厂可以同步初始化或返回 promise：

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI) {
  // register handlers/tools/commands/renderers
}
```

Extension 可以在一个模块中组合以下所有内容：

- 事件处理器（`pi.on(...)`）
- LLM 可调用工具（`pi.registerTool(...)`）
- slash 命令（`pi.registerCommand(...)`）
- 键盘快捷键和 flag
- 自定义消息渲染
- 会话/消息注入 API（`sendMessage`、`sendUserMessage`、`appendEntry`）

## 运行时模型

1. 导入 extension 并运行其工厂函数。
2. 在该加载阶段，注册方法有效；运行时 action 方法尚未初始化。
3. `ExtensionRunner.initialize(...)` 为活跃模式接线可用的 action/上下文。
4. 会话/agent/工具生命周期事件被发射给处理器。
5. 每次工具执行都被 extension 拦截包装（`tool_call` / `tool_result`）。

```text
Extension lifecycle (simplified)

load paths
   │
   ▼
import module + run factory (registration only)
   │
   ▼
ExtensionRunner.initialize(mode/session/tool registry)
   │
   ├─ emit session/agent events to handlers
   ├─ wrap tool execution (tool_call/tool_result)
   └─ expose runtime actions (sendMessage, setActiveTools, ...)
```

来自 `loader.ts` 的重要约束：

- 在 extension 加载期间调用 `pi.sendMessage()` 之类的 action 方法会抛出 `ExtensionRuntimeNotInitializedError`
- 先注册；从事件/命令/工具中执行运行时行为

## 快速上手

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const z = pi.zod;

  pi.setLabel("Safety + Utilities");

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(`Extension loaded in ${ctx.cwd}`, "info");
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
      return { block: true, reason: "Blocked by extension policy" };
    }
  });

  pi.registerTool({
    name: "hello_extension",
    label: "Hello Extension",
    description: "Return a greeting",
    parameters: z.object({ name: z.string() }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      return {
        content: [{ type: "text", text: `Hello, ${params.name}` }],
        details: { greeted: params.name },
      };
    },
  });

  pi.registerCommand("hello-ext", {
    description: "Show queue state",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`pending=${ctx.hasPendingMessages()}`, "info");
    },
  });
}
```

## Extension API 表面

## 1) 注册与 action（`ExtensionAPI`）

核心方法：

- `on(event, handler)`
- `registerTool`, `registerCommand`, `registerShortcut`, `registerFlag`
- `registerMessageRenderer`, `registerAssistantThinkingRenderer`
- `registerComposerShape`
- `setLabel`, `getFlag`
- `sendMessage`, `sendUserMessage`, `appendEntry`, `exec`
- `getActiveTools`, `getAllTools`, `setActiveTools`
- `getCommands`
- `getSessionName`, `setSessionName`
- `setModel`, `getThinkingLevel`, `setThinkingLevel`
- `getServiceTiers`, `setServiceTier`
- `registerProvider`
- `registerFileWriteFallback`, `registerFileDeleteFallback`
- `events`（共享事件总线）

`getServiceTiers()` 返回会话活跃的 per-family tier map 的分离快照。`setServiceTier(family, tier)` 为后续请求更改一个 family；传 `undefined` 清除该会话覆盖。OpenAI 接受 `auto`、`default`、`flex`、`scale` 或 `priority`；Anthropic 接受 `priority`；Google 接受 `flex` 或 `priority`。响应流式进行期间所做的更改不影响该在途请求。

### Provider 注册

`pi.registerProvider(name, config)` 可以包含一个可选的 `usage` 字段，其中含有从
`@oh-my-pi/pi-ai` 导入的 `UsageProvider`。其 `fetchUsage` 实现接收
规范化凭据并返回规范化的 `UsageReport`；结果随后由宿主的 AuthStorage 缓存、历史和用量显示处理，与内置 provider
用量一样。

```ts
pi.registerProvider("my-provider", {
  baseUrl: "https://api.example.com/v1",
  api: "openai-completions",
  usage: {
    id: "my-provider",
    async fetchUsage(params, { fetch }) {
      const response = await fetch("https://api.example.com/usage", {
        headers: { Authorization: `Bearer ${params.credential.apiKey}` },
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as { used: number; limit: number };
      return {
        provider: "my-provider",
        fetchedAt: Date.now(),
        limits: [
          {
            id: "requests",
            label: "Requests",
            scope: { provider: "my-provider" },
            amount: { used: payload.used, limit: payload.limit, unit: "requests" },
          },
        ],
      };
    },
  },
});
```

只要该 extension 注册保持活跃，extension 的 usage provider 就会覆盖同名内置 provider。`pi.unregisterProvider(name)`（以及
extension 源码清理）只移除该运行时覆盖，恢复内置
或已配置的用量解析器。

Extension 注册的 provider（`registerProvider`）可以提供 `fetchDynamicModels` 做运行时模型发现；这些请求被硬性限制在 15 秒超时（`model-provider-discovery.ts` 中的 `RUNTIME_DYNAMIC_MODEL_FETCH_TIMEOUT_MS`），使挂起的端点无法阻塞发现。

在交互模式中，`input` 处理器在内置的首条消息自动标题检查之前运行。从 `input` 中调用 `await pi.setSessionName(...)` 的 extension 可以设置持久化的会话名，并阻止默认的自动生成标题对该会话运行。

另有暴露：

- `pi.logger`
- `pi.arktype`（omptype 的 `type(...)` schema builder）
- `pi.zod`（omptype 支撑的 Zod 兼容 builder）
- `pi.typebox`（旧版 TypeBox 兼容 shim）
- `pi.pi`（包导出）

### 消息投递语义

`pi.sendMessage(message, options)` 支持：

- `deliverAs: "steer"`（默认）—— 中断当前运行
- `deliverAs: "followUp"` —— 排队等当前运行结束后执行
- `deliverAs: "nextTurn"` —— 存储，在下一个用户 prompt 时注入
- `deliverAs: "aside"` —— 在下一个 agent 步边界注入而不中断当前工具批次；空闲时启动一个回合（忽略 `triggerTurn`；plan 模式将其并入上下文）
- `triggerTurn: true` —— 空闲时启动回合（`deliverAs: "nextTurn"` 也遵循：空闲时立即提示；流式期间排队的消息调度一次内部续行）

`pi.sendUserMessage(content, { deliverAs })` 总是经 prompt 流程。省略 `deliverAs` 时，空闲则启动一个正常 prompt；流式期间，省略 `deliverAs` 将消息排队为 steer。设 `deliverAs: "followUp"` 等待当前运行结束。设 `deliverAs: "aside"` 在运行进行中于下一个步边界注入 prompt（空闲发送照常启动回合）。

传给 `pi.sendMessage` 的负载在投递前被规范化（`session/messages.ts` 中的 `normalizeCustomMessagePayload`）：非对象负载被强制转换为默认 custom 类型下的字符串内容，缺失的 `customType`/`attribution` 字段被补默认值，无效内容坍缩为空字符串 —— 格式错误的负载不再持久化会导致后续会话 resume 崩溃的条目。

## 2) 处理器上下文（`ExtensionContext`）

处理器和工具 `execute` 接收带以下内容的 `ctx`：

- `ui`
- `hasUI`
- `cwd`
- `sessionManager`（只读）
- `modelRegistry`, `model`
- `models`（只读模型查询 —— 见下文）
- `localProtocolOptions`（可选的调用会话 `local://` 根映射，供外部工具桥使用）
- `getContextUsage()`
- `getAsyncJobSnapshot()` 返回当前会话的只读异步作业快照，无会话拥有该上下文时返回 `null`
- `compact(...)`
- `isIdle()`, `hasPendingMessages()`, `abort()`
- `shutdown()`
- `getSystemPrompt()`
- `memory`（可选的结构化 memory 运行时 —— 跨所配置后端的状态/搜索/保存）
- `setInterval(fn, ms, ...args)` / `setTimeout(fn, ms, ...args)` / `clearTimer(timer)` — 托管定时器（见下文）

### 后台工作（`ctx.setInterval` / `ctx.setTimeout`）

Extension **在进程内无隔离运行**。抛出异常的裸 `setInterval`/`setTimeout`/分离 promise 回调运行在处理器分发的 try/catch 之外，表现为进程级 `uncaughtException`，且全局事后分析处理器将其视为致命 —— **整个会话被拆除**，而不只是出问题的 extension。

任何周期性或延迟的后台工作请使用 `ctx.setInterval` / `ctx.setTimeout`。它们镜像平台签名，但：

- 以与处理器分发相同的隔离运行回调 —— 同步抛出或被拒绝的 promise 被记录并经 extension 错误通道报告，会话继续运行；
- 返回一个可传给 `ctx.clearTimer(handle)` 的句柄；
- 被 `unref`（自身绝不保持进程存活），并在 `session_shutdown` 时自动清除。

```ts
pi.on("session_start", async (_event, ctx) => {
  const timer = ctx.setInterval(() => {
    // A throw here is contained — it will not crash the session.
    ctx.ui.notify("tick", "info");
  }, 60_000);
  // Optional: clear it yourself; otherwise it is cleared on shutdown.
  pi.on("session_shutdown", () => ctx.clearTimer(timer));
});
```

如果改用裸 `setInterval`/`setTimeout` 或分离 promise，则由你负责隔离：将回调体包在你自己的 `try/catch` 中（未处理的抛出会拖垮会话），并在 `session_shutdown` 时清除定时器。

### 模型选择（`ctx.models`）

`ctx.models` 是一个只读门面，以与核心相同的方式挑选和比较模型：

- `list()` — 本会话已认证可用的模型。
- `current()` — 活跃的会话模型（惰性读取，因此反映 `/model` 切换）。
- `resolve(spec)` — 模型字符串（`provider/id`、裸 id）或角色别名（`@slow`、已配置角色）→ `Model`，遵循与 `--model` 相同的基于设置的别名和匹配偏好。无匹配时返回 `undefined`。
- `family(model)` — 用于"同 family？"检查的不透明谱系 token（Claude 点版本共享一个 token；Claude 与 GPT 不同）。只比较它；不要持久化它（词表会跟踪新发布）。

```ts
// Pick a model from a different family than the current one (e.g. a cross-family reviewer).
const current = ctx.models.current();
const contrasting = ctx.models
  .list()
  .find((m) => current && ctx.models.family(m) !== ctx.models.family(current));
```

## 3) 命令上下文（`ExtensionCommandContext`）

命令处理器额外获得：

- `waitForIdle()`
- `newSession(...)`
- `switchSession(...)`
- `branch(entryId)`
- `navigateTree(targetId, { summarize })`
- `reload()`

会话控制流程请使用命令上下文；这些方法被有意与通用事件处理器分开。

## 事件表面（当前名称与行为）

规范的事件联合与负载类型在 `types.ts` 中。

### 会话生命周期

- `session_start`
- `session_before_switch` / `session_switch`
- `session_before_branch` / `session_branch`
- `session_before_compact` / `session.compacting` / `session_compact`
- `session_before_tree` / `session_tree`
- `session_shutdown`

可取消的前置事件：

- `session_before_switch` → `{ cancel?: boolean }`
- `session_before_branch` → `{ cancel?: boolean; skipConversationRestore?: boolean }`
- `session_before_compact` → `{ cancel?: boolean; compaction?: CompactionResult }`
- `session_before_tree` → `{ cancel?: boolean; summary?: { summary: string; details?: unknown } }`

### Prompt 与回合生命周期

- `input`
- `before_agent_start`
- `before_provider_request`（可替换 provider 请求负载 —— 替换由每个触发该 hook 的 provider 应用，即除不触发它的 `devin-agent` 外的所有 provider）
- `after_provider_response`
- `context`
- `agent_start` / `agent_end` — agent 循环生命周期通知；`agent_end` 仍然仅是通知
- `session_stop` — 主会话停止 hook，在落定前被 await；可以 `{ continue: true, additionalContext }` 或 `{ decision: "block", reason }` 继续；连续续行上限 8 次，从不对 task/subagent 会话触发，并推迟到 agent 拥有的后台作业完全空闲（`session/agent-session.ts` 中的 `#hasPendingAsyncWake`）
- `turn_start` / `turn_end`
- `message_start` / `message_update` / `message_end` — 生命周期通知；`message_end` 接收分离的消息快照，因此 extension 需要更改 provider 上下文时应使用 `tool_result` 或 `context`

### 工具生命周期

- `tool_call`（执行前，可阻止，或修订工具的执行 `input`；对模型发起的调用，它在 agent 循环的参数准备时触发，因此修订会被重新验证并被并发调度、执行事件、持久化的 assistant 消息和审批门同样看到）
- `tool_result`（执行后，可修补 content/details/isError）
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`（可观测性）
- `tool_approval_requested` / `tool_approval_resolved`（可观测性；仅当工具需要审批且注册了审批处理器时由 `wrapper.ts` 发出）

`tool_result` 是中间件风格：处理器按 extension 顺序运行，且每个都能看到先前的修改。

### 可靠性/运行时信号

- `auto_compaction_start` / `auto_compaction_end`
- `auto_retry_start` / `auto_retry_end`
- `ttsr_triggered`
- `todo_reminder`
- `goal_updated`
- `credential_disabled`

### MCP 通知

- `mcp_notification` — 从已连接 MCP 服务器收到的每个 JSON-RPC 通知都会触发，在管理器自身对已知列表/更新方法（`notifications/tools/list_changed`、`notifications/resources/list_changed`、`notifications/resources/updated`、`notifications/prompts/list_changed`）的处理之后。未知或服务器自定义方法同样投递。负载：`{ server: string; method: string; params: unknown }`。多个 extension 可订阅；抛出异常的处理器不会阻止其他处理器触发。在任何监听器附加之前收到的通知被缓冲（有界 FIFO，上限 100，丢弃最旧）并倾倒给第一个订阅者 —— 因此即使 extension 在 MCP 发现之后才绑定，启动期的帧也不会丢失。

把支持推送的 MCP 桥接为会话 steer：

```ts
pi.on("mcp_notification", (event) => {
  if (event.server !== "peer-bus") return;
  if (event.method !== "notifications/peer_message") return;
  const params = event.params as { from: string; text: string };
  pi.sendUserMessage(`[from ${params.from}] ${params.text}`, {
    deliverAs: "steer",
  });
});
```

运行时先处理 JSON-RPC 传输和它自己的列表/更新刷新；处理器随后运行，可以经 `pi.sendMessage` / `pi.sendUserMessage` 注入回合中的 steer。

### 用户命令拦截

- `user_bash`（以 `{ result }` 覆盖）
- `user_python`（以 `{ result }` 覆盖）

### `resources_discover`

`resources_discover` 存在于 extension 类型和 `ExtensionRunner` 中。
当前运行时说明：`ExtensionRunner.emitResourcesDiscover(...)` 已实现，但当前代码库中没有调用它的 `AgentSession` 调用点。

## 工具编写细节

`registerTool` 使用 `types.ts` 中的 `ToolDefinition`。其 `parameters` 字段接受 omptype schema；注入的 TypeBox 兼容 shim 对旧版 extension 仍然可用。

当前 `execute` 签名：

```ts
execute(
	toolCallId,
	params,
	signal,
	onUpdate,
	ctx,
): Promise<AgentToolResult>
```

### 委托给原生内置（`ctx.invokeTool`）

重新注册内置名称的工具（例如包装 `write` 以添加日志或策略检查）可以
运行原始工具而不是重新实现它。当你的注册工具遮蔽某个内置工具时，传给 `execute` 的 `ctx`
携带：

```ts
ctx.invokeTool?<TDetails>(
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal; onUpdate?: AgentToolUpdateCallback },
): Promise<AgentToolResult<TDetails>>
```

它运行与你的工具同名的**原生**内置工具（委托仅限同名工具，因此它
无法到达任意目标或越过已为本调用授予的审批），并
返回其结果，包括原生工具自身的副作用和内部记账。它
仅在该名称存在原生内置时出现 —— 对不遮蔽任何内置工具的
全新工具，`ctx.invokeTool` 为 `undefined`。原生调用不再过审批门，因为它就是你
已获批的同一个工具，且委托深度有守卫防止意外的自我递归。

模板：

```ts
const z = pi.zod;

pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "...",
  parameters: z.object({}),
  hidden: false,
  defaultInactive: false,
  deferrable: false,
  async execute(_id, _params, signal, onUpdate, ctx) {
    if (signal?.aborted) {
      return { content: [{ type: "text", text: "Cancelled" }] };
    }
    onUpdate?.({ content: [{ type: "text", text: "Working..." }] });
    return { content: [{ type: "text", text: "Done" }], details: {} };
  },
  onSession(event, ctx) {
    // reason: start|switch|branch|tree|shutdown
  },
  renderCall(args, options, theme) {
    // optional TUI render
  },
  renderResult(result, options, theme, args) {
    // optional TUI render
  },
});
```

一旦注册表在 `sdk.ts` 中被包装，`tool_call`/`tool_result` 就拦截所有工具，包括内置和 extension/自定义工具。`ToolDefinition` 还支持可选的 `hidden`、`defaultInactive`、`loadMode`（默认 `"discoverable"`，或 `"essential"`）、`deferrable`、`approval`（默认 `"exec"`）、`strict`、`mcpServerName`、`mcpToolName`、`renderCall` 和 `renderResult` 字段。

### 文件写入回退（`registerFileWriteFallback`）

`write`、`edit` 和 `apply_patch` 通过一个共享原语
（`file ? file.write(content) : Bun.write(dst, content)`）对普通文件
路径执行真实的字节写入。当该原语因权限错误失败
（`EPERM`/`EACCES`/`EROFS` —— 其他所有错误，如
`EISDIR`，不受影响）时，coding agent 在放弃之前会咨询经
`pi.registerFileWriteFallback` 注册的处理器：

```ts
import type { FileWriteFallbackHandler } from "@oh-my-pi/pi-coding-agent";

const writeThroughBroker: FileWriteFallbackHandler = async (req, ctx) => {
  // req: { dst: string; content: string; cause: unknown }
  const ok = await myPrivilegedWriter.write(req.dst, req.content);
  return ok;
};

pi.registerFileWriteFallback(writeThroughBroker);
```

处理器按注册顺序运行；第一个解析为 `true` 的即视为字节已持久落盘，原生工具继续执行，就像自己的
写入已成功一样 —— 包括在真实
目标路径下记录其文件快照，因此之后对该路径的 hashline `edit` 继续工作。抛出异常的处理器被记录并跳过，改用下一个 —— 按处理器粒度，因此同一 extension 稍后注册的
处理器仍会运行；如果每个处理器都返回 `false`（或没有注册任何处理器），原始错误原样重新抛出。它面向的宿主是把 agent 嵌入在一个禁止直接文件系统写入但暴露特权写入通道的沙箱中。

`req.dst` 是**符号链接解析后**的目标，不是工具被给到的路径。
内核跟随最后一级之上的每个组件，因此 `ws/link -> /elsewhere` 链接下的 `ws/link/file`
落在 `ws` 之外却仍看似在工作区内，
而你的处理器中的前缀允许列表会在这个看似无害的路径上放行。对写入，最后一级
组件也被跟随，因此它也被解析；对删除则不是，因为 `unlink` 移除的是链接本身而非它指向的对象（因此删除的
`req.dst` 本身可能命名一个链接）。把 `req.dst` 当作权威，不要从其他任何东西重新推导目标。当无法确定真实目标时 —— 末级链接悬空，或存在本进程无法解析的祖先 —— 完全不会咨询任何
处理器，原始错误被重新抛出，因为没有可交给特权写入器的目标。

当目标位于宿主允许范围之外时，有两个细节很重要：

- **父目录缺失。** `Bun.write` 自行创建缺失的父目录，而当被拒绝的操作正是那次 `mkdir` 时，它报告的是后续
  `open()` 的 `ENOENT` 而非拒绝本身。agent 会显式重做 `mkdir` 以取回真实的 errno，因此这仍会到达处理器 —— 且
  `req.cause` 被设为 `mkdir` 拒绝。此时 `req.dst` 的父目录尚不存在，创建它是处理器的责任。真正可创建或无效父目录导致的 `ENOENT` 不会被转移。（`apply_patch` 在写入前作为单独步骤创建
  父目录；注册了回退时，那次 `mkdir` 容忍拒绝，因此写入仍会到达处理器。）
- **hashline `MV`。** `edit` 的移动直接写其目标，而不经
  LSP 透传。它被路由到相同的处理器，源 unlink 走下方的删除缝，因此移出你无法写入的目录也能完成。

这不是对 agent 能做的每次写入的拦截。来自以下表面的
权限错误照旧呈现，不咨询任何处理器：

- `write` 到归档成员（`foo.zip:entry`）或 SQLite 行。两者都不是对 `dst` 的
  字节写入：归档改写读取整个归档、替换一个
  条目、写临时文件并重命名覆盖原文件，落盘的是整个
  二进制容器而非工具收到的字符串；SQLite 写入是数据库引擎内部的
  行操作，根本没有字节负载。代理任何一方都需要与"这些字节属于这个路径"不同的请求形状。
- ACP 桥的 `writeTextFile`，它把写入交给远程客户端。
- `lsp` 工具自己的写入：应用 workspace edit 或 code action，以及
  Biome 格式化器，它写入缓冲区后 shell 出 `biome format
  --write` —— 进程内的缝无法触及的子进程写入。

### 文件删除回退（`registerFileDeleteFallback`）

删除文件与写入文件是不同的原语，它有自己的缝：

```ts
pi.registerFileDeleteFallback(async (req, ctx) => {
  // req: { dst; cause; confirmedFile; sessionId } — no `content`.
  return await myPrivilegedWriter.unlink(req.dst);
});
```

它覆盖 `edit` 的 `REM`、hashline `MV` 的源侧，以及 `apply_patch` 的
删除操作，并遵循与写入缝相同的规则：相同的权限码、第一个
`true` 胜出、抛出异常的处理器被跳过、无一成功则重新抛出原始错误，且没有注册处理器时什么都不会发生。两个区别：

- **`ENOENT` 永远不被转移。**unlink 的路径上不会创建任何东西，因此
  缺失的文件确实缺失 —— `REM` 将其变为 not-found 错误。
- **处理器必须 unlink，绝不递归移除。**对目录的 `unlink` 在 macOS 上报告
  `EPERM`，仅凭错误码无法与沙箱拒绝区分，因此该缝会 `lstat` 目标并拒绝转移目录。但当目标自身的元数据位于拒绝 unlink 的同一边界之后时 ——
  这是沙箱的常见情况 —— 该检查无法解析，`req.dst` 随后可能是
  目录。只有当缝明确确定目标是普通常规文件时 `req.confirmedFile` 才为 `true`；符号链接也报告 `false`，因为 unlink 链接没问题但解析它会作用于完全不同的东西。递归移除 `req.dst` 或先 realpath 它的特权
  辅助器，会远远超出一个只移除单个文件的工具所要求的范围。

**注册删除与注册写入被刻意分开。**写入处理器将 `req.content` 代理到 `req.dst`；如果删除请求到达它，缺失的内容会诱导代理一次空写入并*截断*本应被移除的
文件。因此只写的处理器永远不会看到删除。

两条生命周期约束，同时适用于两个缝：

- **在 extension 加载期间注册**（从默认工厂），与其他
  `register*` 调用一样。处理器在 `ExtensionRunner.initialize` 运行时安装；
  届时什么都没注册的 extension 被完全跳过，因此之后
  的首次注册永远不会生效。处理器收到的 `ctx` 按每次调用构建，而非安装时捕获，因此 `ctx.cwd` 和 `ctx.hasUI` 描述的是变更被拒绝时会话的当时状态 —— 工作区变更（`/move`）反映在下一次请求中，而非固定在加载时。
- **注册表是进程级的。**一个进程可以托管多个会话（subagent
  拥有自己的 runner），因此处理器可能被进程中任何会话的被拒
  写入或删除咨询 —— 不只是注册它的那个 extension 的会话。
  这是有意的：以受限工具 spawn 的 subagent 不加载自己的 extension，而在其顶层会话注册一次的宿主仍期望其
  subagent 的写入被代理。`req.sessionId` 命名发起变更的会话（非来自工具调用时为 `undefined`），
  `ctx.sessionManager.getSessionId()` 命名处理器自己的会话 —— 比较它们以按会话
  做决策。提示之前最重要：`ctx.ui` 属于处理器的会话，而未必是正被询问的那个。处理器在 `session_shutdown` 时被移除。

什么都不注册时，这一切都不启用：原语完全照
以前一样运行，不执行任何额外系统调用。

## UI 集成点

`ctx.ui` 实现 `ExtensionUIContext` 接口。支持因模式而异。

### 交互模式（`extension-ui-controller.ts`）

支持：

- 对话框：`select`、`confirm`、`input`、`editor`
- 输入编辑：`setEditorText`、`getEditorText`、`pasteToEditor`、`editor`
- 自动补全堆叠：`addAutocompleteProvider(factory)` 包装内置的编辑器 provider（工厂按注册顺序应用，并在每次 slash 命令刷新时重新应用）
- 终端标题与工作消息（`setTitle`、`setWorkingMessage`）
- 通知/状态/编辑器文本/终端输入/自定义覆盖层
- 按名称列出/加载主题（`setTheme` 支持字符串名称）
- 工具展开切换

该控制器中当前为 no-op 的方法：

- `setFooter`
- `setHeader`

`setEditorComponent` 接线到活跃编辑器（`ctx.setEditorComponent(factory)`）。`setWidget` 经 `setHookWidget(...)` 在编辑器上方或下方渲染真实组件（`placement: "aboveEditor" | "belowEditor"`；字符串数组内容上限 10 行）。`setEditorText` 和 `pasteToEditor` 在修改编辑器后调度一次重绘，因此 prompt 变更不会在屏幕上留下陈旧内容。

### RPC 模式（`rpc-mode.ts`）

`ctx.ui` 由 RPC `extension_ui_request` 事件支撑：

- 对话框方法（`select`、`confirm`、`input`、`editor`）与客户端响应往返
- 即发即弃方法发出请求（`notify`、`setStatus`、字符串数组的 `setWidget`、`setEditorText`；`setTitle` 仅在 `PI_RPC_EMIT_TITLE=1` 时发出）

RPC 实现中不支持/no-op：

- `onTerminalInput`
- `custom`
- `setFooter`, `setHeader`, `setEditorComponent`, `addAutocompleteProvider`
- `setWorkingMessage`
- 主题切换/加载（`setTheme` 返回失败）
- 工具展开控制无效

### Print/无头/subagent 路径

runner 初始化时未提供 UI 上下文时，`ctx.hasUI` 为 `false`，方法为 no-op/返回默认值。

### ACP 模式

ACP 安装一个经 elicitation 桥接的 UI 上下文（`acp-agent.ts` 中的 `createAcpExtensionUiContext`）。`ctx.hasUI` 在 `select`/`confirm`/`input`/`editor` 往返期间为 `true`（作为 ACP elicitation；客户端缺少 `elicitation.form` 能力时返回默认值）。非 elicitation 表面（组件、主题、终端输入、自动补全堆叠）为 stub no-op。

## 会话与状态模式

对持久化的 extension 状态：

1. 用 `pi.appendEntry("com.example.my-extension.state", data)` 持久化。`customType` 命名空间是全局的：使用带包名或反向域限定的值，避开 [`custom` session-entry reference](./session.md#custom) 中核心保留的值。
2. 在 `session_start`、`session_branch`、`session_tree` 时从 `ctx.sessionManager.getBranch()` 重建状态。
3. 当状态需要从工具结果历史中可见/可重建时，保持工具结果 `details` 结构化。

重建模式示例：

```ts
pi.on("session_start", async (_event, ctx) => {
  let latest;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (
      entry.type === "custom" &&
      entry.customType === "com.example.my-extension.state"
    ) {
      latest = entry.data;
    }
  }
  // restore from latest
});
```

## 渲染 extension 点

## Composer 形状渲染器

`registerComposerShape` 向**Appearance → Composer Shape**添加一个 extension 拥有的输入编辑器布局。从 extension 工厂注册；渲染器被活跃编辑器及其设置预览使用。

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ComposerStyle } from "@oh-my-pi/pi-tui";

const dockStyle: ComposerStyle = {
  id: "acme-dock",
  sideBorders: false,
  verticalChrome: 1,
  statusAttachment: "none",
  bottomBar: "full",
  bottomBarGap: true,
  defaultPromptGutter: "❯ ",

  defaultPaddingX: () => 0,
  sideChromeWidth: () => 0,
  renderTop: ({ box, width, borderColor }) =>
    borderColor(box.horizontal.repeat(width)),
  renderRow: ({ gutter, text, pad }) => [gutter + text + pad],
  renderBottom: () => undefined,
};

export default function (pi: ExtensionAPI) {
  pi.registerComposerShape({
    label: "Acme Dock",
    description: "Prompt below a single rule",
    style: dockStyle,
  });
}
```

`ComposerShapeDefinition` 包含：

- `label`：必需的选择器标签。
- `description`：可选的选择器详情。
- `style`：完整的 `ComposerStyle` 渲染契约。`style.id` 也是持久化的 `composer.shape` 值。

使用包限定、非空、修剪过的 `style.id`。内置 id（`box`、`claude`、`pi`、`borderless`、`rule`、`field` 和 `rail`）不能被替换。若 extension 不可用而其 id 仍被配置，编辑器回退到 `box`。

### `ComposerStyle` 布局元数据

- `sideBorders`：内容行是否拥有侧边 chrome。它控制光标预留、IME 布局和滚动条行为；不只是描述性的。
- `verticalChrome`：固定顶部/底部 chrome 行的确切数量（`0`、`1` 或 `2`），用于编辑器高度预算。
- `statusAttachment`：`"top-border"` 接收嵌入的状态量表，`"top-rule-chip"` 接收用于停靠在规则上的右侧状态组，`"none"` 将状态与编辑器 chrome 分离。
- `bottomBar`：编辑器下方的独立状态内容：`"none"`、`"left"` 或 `"full"`。
- `bottomBarGap`：是否用空行分隔编辑器与独立的底部状态栏。
- `defaultPromptGutter`：宿主未提供覆盖时使用的 prompt 文本。
- `defaultPaddingX(themePaddingX)`：为此样式选择的水平 padding。
- `sideChromeWidth(paddingX)`：内容行**每侧**消耗的可见单元格，包括 padding 和边框/rail 字形。

`renderTop` 和 `renderBottom` 返回一行带样式的终端行或 `undefined`。`renderRow` 返回一行或多行带样式的行。每个正常渲染的行必须恰好占据 `ctx.width` 个可见单元格；ANSI 转义序列宽度为零。保留提供的 `gutter`、`text` 和 `pad`，而不是重排或截断它们。

### 渲染器上下文

所有渲染方法接收 `width`、`paddingX`、主题的 `box` 字形，以及三个样式函数：

- `borderColor(text)`：普通的边框/规则颜色。
- `accentColor(text)`：用于定义形状的 rail 或端帽的稳定强调色。
- `surfaceColor(text)`：在装饰性输入中能幸存于嵌套 SGR 重置的 composer 背景填充。

`topBorder`（若存在）是已带样式的状态内容及其可见 `width`。顶部渲染器拥有其布局，且必须让最后一行达到 `ctx.width`。

`renderRow` 额外接收：

- `gutter`、`text` 和 `pad`：预渲染的内容片段。
- `isLastRow`：最后一个可见输入行。
- `cursorOverflow`：行尾光标从右侧 chrome 消耗的单元格。
- `imeSafeCursorTail`：省略光标之后的右侧单元格，使终端本地的 IME preedit 无法移动 chrome。
- `scrollbarThumb`：此行与编辑器滚动条滑块相交。

`packages/tui/src/components/composer/` 中的内置实现是带边框、规则、填充表面和 IME 安全布局的参考。

## 自定义消息渲染器

```ts
pi.registerMessageRenderer("my-type", (message, { expanded }, theme) => {
  // return pi-tui Component
});
```

显示自定义消息时被交互式渲染使用。

## Assistant thinking 渲染器

```ts
import { Container, Text } from "@oh-my-pi/pi-tui";

pi.registerAssistantThinkingRenderer((context, theme) => {
  const container = new Container();
  container.addChild(
    new Text(theme.fg("dim", `thinking chars: ${context.text.length}`), 1, 0),
  );
  return container;
});
```

被交互式渲染用于在每个可见的 assistant thinking 块下方添加仅显示的补充 UI。渲染器接收已可见的 thinking 文本、content/thinking 索引、主题，以及供异步渲染器使用的 `requestRender()` 回调。所有返回组件的已注册渲染器按注册顺序追加。渲染器不得变更消息；原始 thinking 块仍是 provider/会话的事实来源。

## 工具调用/结果渲染器

在 `registerTool` 定义上提供 `renderCall` / `renderResult`，即可在 TUI 中自定义工具可视化。

## 约束与陷阱

- 运行时 action 在 extension 加载期间不可用。
- `tool_call` 错误阻止执行（fail-closed）。
- 与内置命令冲突的命令名被跳过并给出诊断。
- 保留快捷键被忽略（`ctrl+c`、`ctrl+d`、`ctrl+z`、`ctrl+k`、`ctrl+p`、`ctrl+l`、`ctrl+o`、`ctrl+t`、`ctrl+g`、`ctrl+q`、`alt+m`、`shift+tab`、`shift+ctrl+p`、`alt+enter`、`escape`、`enter`）。
- 将 `ctx.reload()` 视为当前命令处理器帧的终结。

## Extension vs hooks vs custom-tools

选用正确的表面：

- **Extension**（`src/extensibility/extensions/*`）：统一系统（事件 + 工具 + 命令 + 渲染器 + provider 注册）。
- **Hook**（`src/extensibility/hooks/*`）：独立的旧版事件 API。
- **Custom-tool**（`src/extensibility/custom-tools/*`）：以工具为焦点的模块；与 extension 一起加载时会被适配，且仍经过 extension 拦截包装器。

如果你需要一个同时拥有策略、工具、命令 UX 和渲染的包，请使用 extension。
