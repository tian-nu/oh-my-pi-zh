---
name: authoring-hooks
description: 创建新的 omp hook 时使用。涵盖 HookAPI、事件目录、阻止/覆盖工具调用，以及上下文修改。
---

# 编写 Hook

Hook 是伴随 agent 循环运行的事件驱动拦截器。最适合处理横切关注点：安全策略、密钥脱敏、上下文裁剪、审计日志。hook 模块通过 `pi.on(event, handler)` 注册处理器，可以阻止工具执行、覆盖工具输出，或在每次 LLM 调用前重写消息上下文。

> **与 extension 的关系：** hook 子系统（`HookAPI`）是旧版 API。extension 运行器现在能完成 hook 的所有功能，且支持更多。`ExtensionAPI` 支持 hook 的事件模型，外加仅 extension 可用的事件。新项目请使用 `ExtensionAPI`；只有在维护现有 hook 模块时才使用 `HookAPI`。

## 工厂函数签名

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function myHook(omp: HookAPI): void {
  omp.on("tool_call", async (event, ctx) => {
    // intercept every tool call
  });
}
```

默认导出必须是一个函数（不能是类）。它接收一个 `HookAPI` 实例，并应在工厂执行期间注册处理器；加载器会等待返回的 promise，因此接受异步初始化。

或者，使用 `ExtensionAPI`（推荐）：

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => { /* ... */ });
}
```

## 事件目录

### 工具生命周期

| 事件 | 触发时机 | 可返回 |
|---|---|---|
| `tool_call` | 每次工具执行前 | `{ block?: boolean; reason?: string; input?: Record<string, unknown> }` |
| `tool_result` | 每次工具执行后 | `{ content?; details?; isError?: boolean }` |

### 会话生命周期

| 事件 | 触发时机 | 可返回 |
|---|---|---|
| `session_start` | 初始会话加载时 | — |
| `session_before_switch` | 会话切换前 | `{ cancel?: boolean }` |
| `session_switch` | 会话切换后 | — |
| `session_before_branch` | 会话分叉前 | `{ cancel?: boolean; skipConversationRestore?: boolean }` |
| `session_branch` | 会话分叉后 | — |
| `session_before_compact` | 压缩前 | `{ cancel?: boolean; compaction?: CompactionResult }` |
| `session.compacting` | 压缩进行中（注入上下文） | `{ context?: string[]; prompt?: string; preserveData?: Record<string, unknown> }` |
| `session_compact` | 压缩后 | — |
| `session_before_tree` | 树导航前 | `{ cancel?: boolean; summary?: { summary: string; details?: unknown } }` |
| `session_tree` | 树导航后 | — |
| `session_shutdown` | 会话关闭时 | — |

### Agent/轮次生命周期

| 事件 | 触发时机 | 可返回 |
|---|---|---|
| `before_agent_start` | agent 开始一轮之前 | `{ message?: { customType; content; display; details; attribution? } }` |
| `agent_start` | agent 流式输出开始 | — |
| `agent_end` | agent 流式输出结束 | — |
| `turn_start` | 用户→agent 轮次开始 | — |
| `turn_end` | 用户→agent 轮次结束 | — |
| `context` | 每次 LLM API 调用前 | `{ messages?: Message[] }` |
| `auto_compaction_start` | 自动压缩开始 | — |
| `auto_compaction_end` | 自动压缩结束 | — |
| `auto_retry_start` | 自动重试开始 | — |
| `auto_retry_end` | 自动重试结束 | — |
| `ttsr_triggered` | TTSR（过短响应）触发 | — |
| `todo_reminder` | todo 提醒触发 | — |

仅 extension 可用的事件，如 `tool_execution_start`、`tool_execution_update`、`tool_execution_end`、`input`、`user_bash` 和 `user_python`，需要 `ExtensionAPI`。

## 工具执行前阻止契约

从 `tool_call` 处理器返回 `{ block: true, reason: "..." }` 以阻止执行：

```ts
omp.on("tool_call", async (event, ctx) => {
  if (event.toolName === "bash") {
    const cmd = String(event.input.command ?? "");
    if (/\brm\s+-rf\s+\//.test(cmd)) {
      return { block: true, reason: "Refusing to delete root filesystem" };
    }
  }
});
```

契约：

- 如果**任何**处理器返回 `{ block: true }`，执行立即停止。
- `reason` 会成为 LLM 看到的工具错误文本。
- 如果处理器**抛出异常**，工具同样被阻止（fail-closed）。
- 最后一个非阻止返回生效；第一个 `block: true` 会短路。
- 非阻止处理器可以返回 `input` 来替换传给工具的原始参数。处理器看不到更早的 input 修订。
- 诸如 `browser.open(...)`、直接的 `BrowserTab` 辅助方法、`tab.run(...)`、直接的 `computer` 辅助方法以及 `computer.run(fnOrCode, options)` 之类的 eval 前奏调用不属于工具调用，不会触发这些 hook。

## 工具执行后覆盖契约

从 `tool_result` 处理器返回 `{ content, details, isError }` 以修改 LLM 看到的内容：

```ts
omp.on("tool_result", async (event, ctx) => {
  if (event.toolName === "read" && !event.isError) {
    const redacted = event.content.map(chunk => {
      if (chunk.type !== "text") return chunk;
      return {
        ...chunk,
        text: chunk.text.replace(/(?:sk|pk)-[a-zA-Z0-9]{20,}/g, "[REDACTED_API_KEY]"),
      };
    });
    return { content: redacted };
  }
});
```

契约：

- 处理器按注册顺序运行。对于 `HookAPI`，每个处理器接收的是原始工具结果事件，最后一个返回的覆盖生效。
- `content` 替换 LLM 看到的完整 content 数组。
- `details` 替换结构化的 details 对象。
- `isError` 存在于共享结果类型上，但 `HookToolWrapper` 不会将其传播到成功的工具结果中；工具失败时，原始错误会在所有处理器完成后重新抛出。
- 工具失败时，`tool_result` 仍会以 `isError: true` 触发。

## 上下文修改契约

从 `context` 处理器返回 `{ messages: [...] }` 以在每次 LLM API 调用前重写消息列表：

```ts
omp.on("context", async (event, ctx) => {
  // Remove debug-only custom messages from LLM context
  const filtered = event.messages.filter(
    msg => !(msg.role === "custom" && msg.customType === "debug-only")
  );
  return { messages: filtered };
});
```

契约：

- `event.messages` 是当前累积的列表。
- 处理器按顺序运行；每个处理器接收前一个处理器的输出。
- 返回 `undefined`（或不返回）则消息原样通过。

## 三个完整示例

### 1. rm-rf 阻止器

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function rmRfBlocker(omp: HookAPI): void {
  omp.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    const cmd = String(event.input.command ?? "");
    if (!/\brm\s+-rf\s+\//.test(cmd)) return;

    // Allow if user explicitly confirms (interactive mode only)
    if (ctx.hasUI) {
      const allow = await ctx.ui.confirm(
        "Dangerous command",
        `This command deletes from root:\n${cmd}\n\nProceed?`
      );
      if (allow) return;
    }

    return { block: true, reason: "rm -rf / blocked by safety policy" };
  });
}
```

### 2. API 密钥脱敏器

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

// Common API-key shapes. Not exhaustive — providers using bespoke formats
// (Anthropic `sk-ant-…`, JWT-style bearers, gateway-specific prefixes, etc.)
// need their own entries.
const SECRET_PATTERNS = [
  /\b(sk|pk)-[a-zA-Z0-9]{20,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\bghp_[a-zA-Z0-9]{36}\b/g,
  // Zhipu / GLM Coding Plan: `<id>.<secret>` (no `sk-` prefix).
  /\b[a-zA-Z0-9]{16,}\.[a-zA-Z0-9]{16,}\b/g,
  /\b[a-zA-Z0-9_-]{20,}\s*=\s*["']?[a-zA-Z0-9._/+=-]{20,}["']?/g,
];

export default function apiKeyRedactor(omp: HookAPI): void {
  omp.on("tool_result", async (event) => {
    if (event.isError) return;

    let changed = false;
    const redacted = event.content.map(chunk => {
      if (chunk.type !== "text") return chunk;
      let text = chunk.text;
      for (const pattern of SECRET_PATTERNS) {
        const next = text.replace(pattern, "[REDACTED]");
        if (next !== text) { changed = true; text = next; }
      }
      return { ...chunk, text };
    });

    if (changed) return { content: redacted };
  });
}
```

### 3. 上下文过滤器

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function contextFilter(omp: HookAPI): void {
  omp.on("context", async (event) => {
    const MAX_TOOL_OUTPUT_CHARS = 8_000;

    const trimmed = event.messages.map(msg => {
      // Truncate very large tool results to keep context manageable
      if (msg.role !== "toolResult") return msg;
      const content = msg.content.map(chunk => {
        if (chunk.type !== "text" || chunk.text.length <= MAX_TOOL_OUTPUT_CHARS) return chunk;
        return {
          ...chunk,
          text: chunk.text.slice(0, MAX_TOOL_OUTPUT_CHARS) + "\n[... truncated by context-filter hook]",
        };
      });
      return { ...msg, content };
    });

    return { messages: trimmed };
  });
}
```

## hook 上下文中的 UI 方法

`ctx.ui` 是一个 `HookUIContext`。可用方法：

| 方法 | 说明 |
|---|---|
| `notify(message, type?)` | 显示应用内通知 |
| `setStatus(key, text)` | 设置底部状态文本（按 key 组织，按 key 排序） |
| `select(title, options)` | 显示选择对话框 |
| `confirm(title, message)` | 显示是/否对话框 |
| `input(title, placeholder?)` | 显示文本输入对话框 |
| `editor(title, prefill?, { signal }?, { promptStyle }?)` | 显示多行编辑器 |
| `setEditorText(text)` | 设置输入编辑器内容 |
| `getEditorText()` | 获取当前输入编辑器内容 |
| `custom(factory)` | 渲染自定义 TUI 组件 |
| `theme` | 当前主题对象 |

当希望 Enter 提交、Shift+Enter 插入换行时，将 `{ promptStyle: true }` 作为第四个参数传入。hook 编辑器的默认行为是 Enter 为换行，通过 `app.message.followUp` 组合键（`Ctrl+Q` 或 `Ctrl+Enter`）提交。

在 headless/print/subagent 模式下 `ctx.hasUI` 为 `false` — 交互式调用务必加保护。

## 延伸阅读

- `docs/hooks.md` — hook 子系统内部实现、顺序规则、错误传播
- `docs/extensions.md` — `ExtensionAPI`（`HookAPI` 的超集）
- `docs/skills/examples/safety-hook/` — 完整的可运行示例
