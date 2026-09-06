# Hooks

本文档描述 `packages/coding-agent/src/extensibility/hooks/*` 中的**当前 hook 子系统代码**。

## 运行时的当前状态

默认 CLI 运行时初始化的是 **extension runner** 路径。当前启动流程中：

- `--hook` 被视为 `--extension` 的别名（CLI 路径合并进 `additionalExtensionPaths`）
- 通过 `hookCapability` 发现的 JS/TS hook 工厂（例如 `.omp/hooks/pre/*.ts`）作为 extension 模块加载，因此其 `pi.on(...)` handler 绑定到运行时事件总线
- 工具由 `ExtensionToolWrapper` 包装，而非 `HookToolWrapper`
- 上下文变换与生命周期发射走 `ExtensionRunner`

因此本文件记录的是旧版 hook 子系统实现本身（types/loader/runner/wrapper），外加已发现的 hook 路径被 extension runner 加载时仍会接受的工厂形态。

## 关键文件

- `packages/coding-agent/src/extensibility/hooks/types.ts` — hook 上下文、事件类型与结果契约
- `packages/coding-agent/src/extensibility/hooks/loader.ts` — 模块加载与 hook 发现桥接
- `packages/coding-agent/src/extensibility/hooks/runner.ts` — 事件分发、命令查找、错误信号
- `packages/coding-agent/src/extensibility/hooks/tool-wrapper.ts` — 工具 pre/post 拦截包装器
- `packages/coding-agent/src/extensibility/hooks/index.ts` — 导出/再导出

## hook 模块是什么

hook 模块必须默认导出一个工厂：

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function hook(pi: HookAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (
      event.toolName === "bash" &&
      String(event.input.command ?? "").includes("rm -rf")
    ) {
      return { block: true, reason: "blocked by policy" };
    }
  });
}
```

工厂可以：

- 用 `pi.on(...)` 注册事件 handler
- 用 `pi.sendMessage(...)` 发送持久化的自定义消息
- 用 `pi.appendEntry(...)` 持久化非 LLM 状态
- 通过 `pi.registerCommand(...)` 注册 slash 命令
- 通过 `pi.registerMessageRenderer(...)` 注册自定义消息渲染器
- 通过 `pi.exec(...)` 运行 shell 命令，并经 `pi.logger` 记录日志
- 使用注入的、与 Zod 兼容的构建器 `pi.zod`、原生 omptype 构建器 `pi.arktype`、旧版 `pi.typebox`，以及经 `pi.pi` 暴露的包导出

## 发现与加载

默认会话会加载由 `hookCapability` 发现、经 extension runner 载入的 JS/TS hook 工厂。`discoverExtensionPaths(configuredPaths, cwd)` 会：

1. 从能力注册表加载原生 extension 模块
2. 从 hook 能力注册表加载可导入的 `.ts`/`.js` hook 工厂
3. 追加插件 extension 入口点
4. 追加显式配置的路径

旧版 `discoverAndLoadHooks(configuredPaths, cwd)` 辅助函数仍然存在，它：

1. 从能力注册表加载发现的 hook（`loadCapability("hooks")`）
2. 追加显式配置的路径（按绝对路径去重）
3. 调用 `loadHooks(allPaths, cwd)`

`loadHooks` 随后导入每个路径，并期望一个 `default` 函数。

### 路径解析

`loader.ts` 这样解析 hook 路径：

- 绝对路径：按原样使用
- `~` 路径：展开
- 相对路径：按 `cwd` 解析

## 事件表面

hook 事件在 `types.ts` 中强类型定义。

### 会话事件

- `session_start`
- `session_before_switch` → 可返回 `{ cancel?: boolean }`
- `session_switch`
- `session_before_branch` → 可返回 `{ cancel?: boolean; skipConversationRestore?: boolean }`
- `session_branch`
- `session_before_compact` → 可返回 `{ cancel?: boolean; compaction?: CompactionResult }`
- `session.compacting` → 可返回 `{ context?: string[]; prompt?: string; preserveData?: Record<string, unknown> }`
- `session_compact`
- `session_before_tree` → 可返回 `{ cancel?: boolean; summary?: { summary: string; details?: unknown } }`
- `session_tree`
- `session_shutdown`

### Agent/上下文事件

- `context` → 可返回 `{ messages?: Message[] }`
- `before_agent_start` → 可返回 `{ message?: { customType; content; display; details; attribution } }`
- `agent_start`
- `agent_end`
- `turn_start`
- `turn_end`
- `auto_compaction_start`
- `auto_compaction_end`
- `auto_retry_start`
- `auto_retry_end`
- `ttsr_triggered`
- `todo_reminder`

### 工具事件（模型调用前/后）

- `tool_call`（执行前）→ 可返回 `{ block?: boolean; reason?: string; input?: Record<string, unknown> }`。返回 `input` 的非阻塞 handler 会替换工具实际执行的参数（原始执行输入，而非规范化后的 `event.input` 视图）；当 `block` 为 true 时被忽略。
- `tool_result`（执行后）→ 可返回 `{ content?; details?; isError? }`

这就是 hook 子系统核心的 pre/post 拦截模型。`browser.open(...)` 这类 Eval prelude 调用、直接的 `BrowserTab` 辅助函数、`tab.run(...)`、直接的 `computer` 辅助函数以及 `computer.run(fnOrCode, options)` 都是宿主桥接调用，不是 AgentTool 调用，因此不会发出 `tool_call` 或 `tool_result`。

```text
Hook tool interception flow

tool_call handlers
   │
   ├─ any { block: true }? ── yes ──> throw (tool blocked)
   │
   └─ no
      │
      ▼
   execute underlying tool
      │
      ├─ success ──> tool_result handlers can override { content, details }
      │
      └─ error   ──> emit tool_result(isError=true) then rethrow original error
```

## 执行模型与变更语义

### 1) 执行前：`tool_call`

`HookToolWrapper.execute()` 在工具执行前发出 `tool_call`。

- 若任何 handler 返回 `{ block: true }`，执行停止
- 若 handler 抛出，wrapper 故障关闭（fail closed）并阻止执行
- 返回的 `reason` 成为抛出的错误文本

### 2) 工具执行

未被阻止时，底层工具正常执行。

### 3) 执行后：`tool_result`

成功后，wrapper 发出带以下内容的 `tool_result`：

- `toolName`、`toolCallId`、`input`
- `content`
- `details`
- `isError: false`

若 handler 返回覆盖：

- `content` 可替换结果内容
- `details` 可替换结果 details

工具失败时，wrapper 发出带 `isError: true` 与错误文本内容的 `tool_result`，然后重新抛出原始错误。

### hook 能变更什么

- 通过 `context` 变更单次调用的 LLM 上下文（`messages` 替换链）
- 通过从 `tool_call` 返回 `input` 变更原始工具执行参数
- 在成功的工具调用上变更工具输出 content/details（`tool_result` 路径）
- 通过 `before_agent_start` 注入 agent 启动前的消息
- 通过 `session_before_*` 与 `session.compacting` 变更取消/自定义压缩/树行为

### 本实现中 hook 不能变更什么

- 工具错误抛出后的执行延续（错误路径会重新抛出）
- wrapper 行为中的最终成功/错误状态（返回的 `isError` 有类型但未被 `HookToolWrapper` 应用）

## 顺序与冲突行为

### 发现层面顺序

能力 provider 按优先级排序（高者在前）。按能力键去重，先到者生效。

对 `hooks` 而言，能力键是 `${type}:${tool}:${name}`。来自低优先级 provider 的被遮蔽重复项会被标记，并从生效的发现列表中排除。

### 加载顺序

`discoverAndLoadHooks` 构建扁平 `allPaths` 列表（按解析后的绝对路径去重），随后 `loadHooks` 按该顺序迭代。
每个发现目录内的文件顺序取决于 `readdir` 的输出；hook 加载器不做额外排序。

### 运行时 handler 顺序

在 `HookRunner` 内部，顺序按注册序列确定：

1. hooks 数组顺序
2. 每个 hook/事件的 handler 注册顺序

按事件类型的冲突行为：

- `tool_call`：最后返回的结果胜出，除非有 handler 阻止；首个 block 会短路。返回的 `input`（执行参数覆盖）遵循同样的最后胜出规则；handler 之间互不可见对方的修订
- `tool_result`：最后返回的覆盖胜出（无短路）
- `context`：链式；每个 handler 接收前一个 handler 的消息输出
- `before_agent_start`：保留首个返回的消息；之后的消息被忽略
- `session_before_*`：跟踪最新的返回结果；`cancel: true` 立即短路
- `session.compacting`：最新返回的结果胜出

命令/渲染器冲突：

- `getCommand(name)` 返回跨 hooks 的首个匹配（先加载者胜出）
- `getMessageRenderer(customType)` 返回首个匹配
- `getRegisteredCommands()` 返回所有命令（不去重）

## UI 交互（`HookContext.ui`）

`HookUIContext` 包括：

- `select`、`confirm`、`input`、`editor`
- `notify`
- `setStatus`
- `custom`
- `setEditorText`、`getEditorText`
- `theme` getter

`ctx` 包括 `hasUI`、`cwd`、`sessionManager`、`modelRegistry`、当前 `model`、`isIdle()`、`abort()` 与 `hasQueuedMessages()`。

无 UI 运行时，默认的无操作上下文行为是：

- `select/input/editor` 返回 `undefined`
- `confirm` 返回 `false`
- `notify`、`setStatus`、`setEditorText` 为无操作
- `getEditorText` 返回 `""`

### 状态行行为

经 `ctx.ui.setStatus(key, text)` 设置的 hook 状态文本会：

- 按 key 存储
- 按 key 名排序
- 净化（剥离 ANSI/VT 转义序列；控制字符映射为空格；连续空格合并；去除首尾空白）
- 拼接并按宽度截断以显示

## 错误传播与回退

### 加载时

- 非法模块或缺少默认导出 → 记入 `LoadHooksResult.errors`
- 其他 hooks 继续加载

### 事件时

`HookRunner.emit(...)` 会为大多数事件捕获 handler 错误，并向监听者发出 `HookError`（`hookPath`、`event`、`error`），然后继续。

`emitToolCall(...)` 更严格：handler 错误在那里不会被吞掉，而是传播给调用方。在 `HookToolWrapper` 中，这会阻止该工具调用（fail-safe）。

## 真实 API 示例

### 阻止不安全的 bash 命令

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function (pi: HookAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const cmd = String(event.input.command ?? "");
    if (!cmd.includes("rm -rf")) return;

    if (!ctx.hasUI) return { block: true, reason: "rm -rf blocked (no UI)" };
    const ok = await ctx.ui.confirm("Dangerous command", `Allow: ${cmd}`);
    if (!ok) return { block: true, reason: "user denied command" };
  });
}
```

### 在执行后对工具输出脱敏

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function (pi: HookAPI): void {
  pi.on("tool_result", async (event) => {
    if (event.toolName !== "read" || event.isError) return;

    const redacted = event.content.map((chunk) => {
      if (chunk.type !== "text") return chunk;
      return {
        ...chunk,
        text: chunk.text.replaceAll(/API_KEY=\S+/g, "API_KEY=[REDACTED]"),
      };
    });

    return { content: redacted };
  });
}
```

### 每次 LLM 调用修改模型上下文

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function (pi: HookAPI): void {
  pi.on("context", async (event) => {
    const filtered = event.messages.filter(
      (msg) => !(msg.role === "custom" && msg.customType === "debug-only"),
    );
    return { messages: filtered };
  });
}
```

### 用命令安全的上下文方法注册 slash 命令

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function (pi: HookAPI): void {
  pi.registerCommand("handoff", {
    description: "Create a new session with setup message",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      await ctx.newSession({
        parentSession: ctx.sessionManager.getSessionFile(),
        setup: async (sm) => {
          sm.appendMessage({
            role: "user",
            content: [
              { type: "text", text: "Continue from prior session summary." },
            ],
            timestamp: Date.now(),
          });
        },
      });
    },
  });
}
```

## 导出表面

`packages/coding-agent/src/extensibility/hooks/index.ts` 与包子路径 `@oh-my-pi/pi-coding-agent/extensibility/hooks` 导出：

- 加载 API（`discoverAndLoadHooks`、`loadHooks`）
- runner 与 wrapper（`HookRunner`、`HookToolWrapper`）
- 所有 hook 类型
- `execCommand` 再导出

包根（`@oh-my-pi/pi-coding-agent`）不会重新导出 `HookAPI`；请从 hooks 子路径导入旧版 hook 类型。
