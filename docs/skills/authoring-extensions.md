---
name: authoring-extensions
description: 创建新的 omp extension 时使用。涵盖 ExtensionAPI、工厂函数签名、工具/命令/事件注册，以及本地开发测试。
---

# 编写 Extension

Extension 是为 `oh-my-pi` 添加能力的主要方式。一个扩展模块可以在一个 TypeScript 文件中同时注册 LLM 可调用的工具、用户可调用的 slash 命令，以及在整个会话生命周期中运行的事件处理器。它的默认工厂函数可以同步初始化，也可以返回 promise。

## 最小可用的 extension

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("My extension loaded!", "info");
  });
}
```

这已经是一个可运行的扩展。把它放入 `~/.omp/agent/extensions/hello.ts` 并重启 omp 即可看到通知。

## 完整示例

下面的扩展注册了一个 slash 命令、一个工具和一个会话启动钩子：

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI) {
  const z = pi.zod;

  // Runs once when the session loads
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(`Session ready in ${ctx.cwd}`, "info");
  });

  // Slash command: /greet
  pi.registerCommand("greet", {
    description: "Send a greeting into the conversation",
    handler: async (args, ctx) => {
      const name = args.trim() || "world";
      pi.sendMessage(
        {
          customType: "greeting",
          content: `Hello, ${name}!`,
          display: true,
          attribution: "user",
        },
        { triggerTurn: false }
      );
      ctx.ui.notify(`Greeted ${name}`, "info");
    },
  });

  // LLM-callable tool
  pi.registerTool({
    name: "word_count",
    label: "Word Count",
    description: "Count the words in a string",
    parameters: z.object({
      text: z.string().describe("Text to count"),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const count = params.text.split(/\s+/).filter(Boolean).length;
      return {
        content: [{ type: "text", text: String(count) }],
        details: { count },
      };
    },
  });
}
```

## 发现路径

omp 从以下来源加载扩展模块：

1. 通过能力系统发现的 `.omp` 原生位置：
   - `<cwd>/.omp/extensions/`
   - `~/.omp/agent/extensions/`
   - `.omp/settings.json#extensions` 或 `~/.omp/agent/settings.json#extensions` 中列出的旧版扩展路径
2. `~/.omp/plugins/node_modules` 或项目插件根目录下已启用的已安装插件 — 包括 npm、marketplace 和 `omp plugin link` 安装 — 通过它们的 `omp.extensions`/`pi.extensions` manifest。
3. CLI 传入的显式配置路径（`omp --extension ./my-ext.ts`，也支持 `-e`；`--hook` 被视为别名）以及配置中 `extensions:` 设置传入的路径。

运行时按解析后的绝对路径去重 — 先看到者优先。

用户目录是当前活动 profile 的 agent 目录：默认为 `~/.omp/agent`，而 `omp --profile <name>` 使用 `~/.omp/profiles/<name>/agent`（`PI_CODING_AGENT_DIR` 可覆盖它）。

当路径指向目录时，omp 按以下顺序解析入口点：

1. 带 `omp.extensions`（或旧版 `pi.extensions`）字段的 `package.json`
2. `index.ts`
3. `index.js`

扫描 `extensions/` 目录时，omp 还会加载直接的 `*.ts`/`*.js` 文件，以及包含 `index.ts`、`index.js` 或 manifest 的一级子目录。

扩展包还可以捆绑同级的capability目录。当包通过 `extensions:` 或 `--extension`/`-e` 加载时，`omp-plugins` provider 会发现它的 `skills/`、`hooks/pre|post/`、`tools/`、`commands/`、`rules/`、`prompts/` 和 `.mcp.json`。

## package.json manifest

要将扩展打包为可安装的插件，请在 `package.json` 中添加 `omp` 字段：

```json
{
  "name": "my-omp-extension",
  "omp": {
    "extensions": ["./src/main.ts"]
  }
}
```

为了向后兼容，也接受旧版 `pi` 键：

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

支持多个入口点：

```json
{
  "omp": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

已安装插件的 manifest 条目可以是 `.ts`、`.js`、`.mjs` 或 `.cjs`；指向目录的 manifest 条目会解析 `index.ts`、`index.js`、`index.mjs` 或 `index.cjs`。原生/配置的扩展目录的自动扫描仍然仅限于 `.ts` 和 `.js`。

## 注册命令

```ts
pi.registerCommand("my-cmd", {
  description: "What the command does",
  handler: async (args, ctx) => {
    // args: everything the user typed after /my-cmd
    // ctx: ExtensionCommandContext — includes ctx.ui, ctx.cwd, session controls
    ctx.ui.notify("Running!", "info");
    await ctx.waitForIdle();
    await ctx.newSession();
  },
});
```

`ExtensionCommandContext` 的会话控制方法（只能从命令中安全调用）：

| 方法 | 效果 |
|---|---|
| `waitForIdle()` | 等待 agent 完成流式输出 |
| `newSession(opts?)` | 打开一个新会话 |
| `switchSession(path)` | 切换到已有的会话文件 |
| `branch(entryId)` | 从指定的历史条目分叉 |
| `navigateTree(id, opts?)` | 跳转到会话树中的另一个位置 |
| `reload()` | 重载会话运行时 |
| `compact(opts?)` | 压缩当前上下文 |

## 注册工具

工具由 LLM 调用。参数定义可以使用注入的
Zod 兼容的 omptype 构建器；`pi.arktype` 和向后兼容的
`pi.typebox` 也可用：

```ts
const z = pi.zod;

pi.registerTool({
  name: "search_notes",           // snake_case, unique
  label: "Search Notes",          // human-readable label for TUI
  description: "Full-text search through project notes",
  parameters: z.object({
    query: z.string().describe("Search query"),
    limit: z.number().default(10).optional().describe("Max results"),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    if (signal?.aborted) {
      return { content: [{ type: "text", text: "Cancelled" }] };
    }
    onUpdate?.({ content: [{ type: "text", text: "Searching..." }] });
    // ... do work ...
    return {
      content: [{ type: "text", text: `Found N results for "${params.query}"` }],
      details: { query: params.query, count: 0 },
    };
  },
});
```

工具定义还可以设置 `loadMode: "essential" | "discoverable"`（默认 `"discoverable"`）、`approval: "read" | "write" | "exec"`（默认 `"exec"`），以及控制 provider 结构化输出语法的 `strict`。

## 订阅事件

```ts
pi.on("tool_call", async (event, ctx) => {
  // event.toolName, event.input, event.toolCallId
  if (event.toolName !== "bash") return;

  const command = String((event.input as { command?: unknown }).command ?? "");
  if (command.includes("rm -rf /")) {
    return { block: true, reason: "Blocked by safety policy" };
  }
});

pi.on("turn_end", async (_event, ctx) => {
  ctx.ui.setStatus("tokens", `~${ctx.getContextUsage()?.tokens ?? "?"} tokens`);
});

pi.on("session_stop", async (event) => {
  if (event.stop_hook_active) return;
  return { continue: true, additionalContext: `Review final status after turn ${event.turn_id}.` };
});
```

完整事件目录见[扩展编写指南](../extensions.md)。

## Extension 与 hook — 何时用哪个

| 需求 | 使用 |
|---|---|
| 在一个模块中组合工具 + 命令 + 事件 | **Extension**（`ExtensionAPI`） |
| 纯事件拦截（策略、脱敏） | **Extension** 或 **Hook**（两者皆可；推荐 extension） |
| 已存在旧版 hook 模块 | **Hook**（`HookAPI`，来自 `@oh-my-pi/pi-coding-agent/extensibility/hooks`） |
| 注册 provider、快捷键或 CLI 标志 | **仅 Extension** |
| 以 marketplace 插件形式发布 | **Extension**（使用 `package.json` manifest） |

Extension 是 hook 的严格超集。新的编写应使用 `ExtensionAPI`。

## 调试

omp 将结构化日志写入当前活动状态根目录的 `logs/` 目录（默认 `~/.omp/logs/`；debug 级别始终开启，且不会向控制台写入任何内容，否则会破坏 TUI）。每个文件名都包含进程 ID。跟踪今天的默认 profile 日志以查看扩展加载诊断信息：

```
tail -f ~/.omp/logs/omp.$(date +%F).*.log
```

加载失败的扩展会连同路径和错误一起记录。已加载的扩展也可以通过 `pi.logger` 输出自己的调试日志。

要按名称临时禁用某个扩展模块而不删除文件：

```yaml
# ~/.omp/agent/config.yml
disabledExtensions:
  - extension-module:my-ext
```

派生名称是文件名主干（对于 `index.ts` 之类的条目则是目录名）：`/path/to/my-ext.ts` → `my-ext`。

## 重要约束

- **加载期间不要调用运行时动作。** 如果在模块求值期间（会话尚未激活时）同步调用 `pi.sendMessage()` 之类的方法，会抛出 `ExtensionRuntimeNotInitializedError`。加载期间只注册处理器/工具/命令；运行时动作只能在事件处理器、工具或命令中执行。
- **`tool_call` 错误采取 fail-closed 策略。** 如果 `tool_call` 处理器抛出异常，该工具会被阻止。
- **自行调度的回调在同进程内运行，没有隔离。** 原生 `setInterval`/`setTimeout`/分离 promise 的回调若抛出异常，会逃出处理器分发的 try/catch 并导致整个会话崩溃（`uncaughtException`）。后台工作请使用 `ctx.setInterval` / `ctx.setTimeout` — 它们会捕获回调异常，并在 `session_shutdown` 时自动清除。使用原生定时器时必须自行添加 `try/catch` 和清理逻辑。
- **命令名称不得与内置命令冲突。** 冲突的命令会被跳过并记录诊断日志。
- **保留快捷键会被忽略**（`ctrl+c`、`ctrl+d`、`ctrl+z`、`ctrl+k`、`ctrl+p`、`ctrl+l`、`ctrl+o`、`ctrl+t`、`ctrl+g`、`ctrl+q`、`alt+m`、`shift+tab`、`shift+ctrl+p`、`alt+enter`、`escape`、`enter`）。

## 延伸阅读

- `docs/extensions.md` — 运行时内部实现与完整 API 参考
- `docs/extension-loading.md` — 详细的路径解析规则
- `docs/hooks.md` — hook 子系统内部实现
- `docs/skills/examples/hello-extension/` — 完整的可运行示例
