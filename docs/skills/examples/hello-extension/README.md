# hello-extension

一个最小的 `oh-my-pi` 扩展，演示两种最常见的编写模式：订阅 `session_start` 在加载时发出通知，以及注册一个向会话中发送问候消息的 `/hello` slash 命令。它刻意保持精简 — 可作为你自己扩展的复制粘贴起点。

## 安装

**方式 A — 放入用户扩展目录：**

```
cp -r . ~/.omp/agent/extensions/hello-extension
```

重启 `omp`。你会立即看到启动通知。

使用 `omp --profile <name>` 时，请改用 `~/.omp/profiles/<name>/agent/extensions/hello-extension`。`PI_CODING_AGENT_DIR` 同样会改变 agent 目录。

**方式 B — 在设置的 `extensions` 数组中指向它：**

```yaml
# ~/.omp/agent/config.yml
extensions:
  - /path/to/hello-extension
```

**方式 C — 通过 CLI 标志一次性加载：**

```
omp --extension ./hello-extension
```

## 用法

加载后，在 omp 提示符中输入 `/hello` 或 `/hello Ada`。该命令会向会话发送一条可见的问候自定义消息，并显示 "Message sent!" 通知。

## 演示内容

- 接收 `ExtensionAPI` 的默认导出工厂函数
- `pi.on("session_start", ...)` — 会话生命周期钩子
- `pi.registerCommand(...)` — slash 命令注册
- `ctx.ui.notify(...)` — 面向用户的通知
- 带 `omp.extensions` manifest 字段的 `package.json`
