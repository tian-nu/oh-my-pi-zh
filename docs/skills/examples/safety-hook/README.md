# safety-hook

一个演示 `tool_call` 阻止机制的 `oh-my-pi` 扩展。它拦截 `bash` 工具调用，当命令中包含空白符正常的 `rm -rf /` 时返回 `{ block: true, reason: "..." }`，阻止该工具执行。

## 演示内容

- `pi.on("tool_call", ...)` — 执行前拦截
- `return { block: true, reason: "..." }` — 阻止契约
- 对 bash 输入的正则守卫（`/\brm\s+-rf\s+\//`）

## 安装

```
cp -r . ~/.omp/agent/extensions/safety-hook
```

重启 `omp`。该 hook 对所有会话生效。

或一次性加载：

```
omp --extension ./safety-hook
```

## 工作原理

```
LLM calls bash tool
       │
       ▼
tool_call handlers run
       │
       ├─ command matches /\brm\s+-rf\s+\// ?
       │       yes → { block: true, reason: "..." }  ←  execution stops, reason sent to LLM
       │       no  → undefined                        ←  execution continues normally
       ▼
tool executes (if not blocked)
```

`reason` 文本就是 LLM 收到的工具错误内容，因此它能理解调用被拒绝的原因并尝试其他方案。
