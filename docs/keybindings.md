# 按键绑定

在 `omp` 会话内运行 `/hotkeys` 可查看当前构建生效的按键组合。该列表会反映从磁盘加载的任何重映射，以及 extensions 添加的任何绑定。

## 自定义按键绑定

用户重映射位于 `~/.omp/agent/keybindings.yml`。该文件是一个 YAML 映射：键为 keybinding action ID，值为单个组合键字符串或组合键字符串数组。它不会从 `~/.omp/agent/config.yml` 读取，也没有嵌套的 `keybindings` 对象。

使用命名 profile 时，先加载默认 profile 的 agent 目录中的绑定，活动 profile 的 `keybindings.yml` 再逐 action 覆盖它们。被继承的文件在该 profile 启动期间是只读的。

```yaml
app.model.cycleForward: Ctrl+P
app.model.selectTemporary: Alt+P
app.plan.toggle: Alt+Shift+P
```

组合键名称不区分大小写，并使用 UI 中显示的同一记法，例如 `Ctrl+P`、`Alt+Shift+P`、`Shift+Enter` 与 `Ctrl+Backspace`。

把某个 action 设为空数组即可禁用它：

```yaml
app.history.search: []
```

## 常用 action ID

| Action ID                    | Default                                                               | 含义                                                                                                                                                                              |
| ---------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.model.cycleForward`     | `Ctrl+P`                                                              | 向前轮换角色模型                                                                                                                                                                  |
| `app.model.cycleBackward`    | `Shift+Ctrl+P`                                                        | 向后轮换角色模型                                                                                                                                                                  |
| `app.model.selectTemporary`  | `Alt+P`                                                               | 为本会话临时挑选一个模型                                                                                                                                                          |
| `app.model.select`           | `Alt+M`                                                               | 打开模型选择器并设置角色                                                                                                                                                          |
| `app.plan.toggle`            | `Alt+Shift+P`                                                         | 切换 plan 模式                                                                                                                                                                    |
| `app.history.search`         | `Ctrl+R`                                                              | 搜索 prompt 历史                                                                                                                                                                  |
| `app.tools.expand`           | `Ctrl+O`                                                              | 切换工具输出展开                                                                                                                                                                  |
| `app.tools.toggleVisibility` | `Ctrl+Shift+O`                                                        | 显示或隐藏工具活动                                                                                                                                                                |
| `app.thinking.toggle`        | `Ctrl+T`                                                              | 切换思考块可见性                                                                                                                                                                  |
| `app.thinking.cycle`         | `Shift+Tab`                                                           | 循环切换思考级别                                                                                                                                                                  |
| `app.editor.external`        | `Ctrl+G`                                                              | 在 `$VISUAL` / `$EDITOR` 中编辑草稿                                                                                                                                               |
| `app.message.followUp`       | `Ctrl+Q`, `Ctrl+Enter`                                                | 排队一条后续消息                                                                                                                                                                  |
| `app.message.dequeue`        | `Alt+Up`, `Shift+Up`                                                  | 把排队消息退回编辑器                                                                                                                                                              |
| `app.retry`                  | `Alt+R`                                                               | 重试最近一次失败的 assistant turn                                                                                                                                                 |
| `app.display.reset`          | `Alt+L`                                                               | 重置终端显示                                                                                                                                                                      |
| `app.clipboard.copyLine`     | `Alt+Shift+L`                                                         | 复制当前行                                                                                                                                                                        |
| `app.clipboard.copyPrompt`   | `Alt+Shift+C`                                                         | 复制整个 prompt                                                                                                                                                                   |
| `app.clipboard.pasteTextRaw` | `Ctrl+Shift+V`, `Alt+Shift+V`                                         | 粘贴剪贴板文本而不折叠                                                                                                                                                            |
| `app.clipboard.pasteImage`   | Linux: `Ctrl+V`; macOS: `Ctrl+V`, `Cmd+V`; Windows: `Ctrl+V`, `Alt+V` | 从剪贴板粘贴（优先图像，文本回退）                                                                                                                                                |
| `app.stt.toggle`             | Unbound (hold `Space`)                                                | 切换语音转文字。默认没有按键组合——按住空格录制（按住说话），松开转写；可在此绑定组合键，作为按一下切换的替代方式                                                                  |
| `app.live.toggle`            | `Ctrl+L`                                                              | 启动或停止实时语音模式（与 `/live` 相同）                                                                                                                                         |
| `app.agents.hub`             | `Alt+A`                                                               | [打开 Agent Hub](./agent-hub.md)                                                                                                                                                  |

在 Windows Terminal 中，`Ctrl+V` 可能在 `omp` 看到它之前就被终端的粘贴命令处理掉；当剪贴板图像粘贴看起来无效时，请使用 `Alt+V` 回退。当剪贴板中没有图像时，`app.clipboard.pasteImage` 会改贴剪贴板文本，因此只投递这一个组合键的主机（配置为转发 `Ctrl+V` 时 VS Code 的集成终端、通过 `Win+V` 的 Windows 剪贴板历史）对两种负载类型都能工作。Windows Terminal 还会吞掉 `Ctrl+Enter`，因此 `app.message.followUp` 组合键也绑定了 `Ctrl+Q`——GitHub Copilot CLI 使用的同一个组合键——该组合键也用于提交 agent 仪表盘的新 agent 描述与 hook 编辑器 prompt。若你现有的 `keybindings.yml` 已把 `Ctrl+Q` 分配给其他 action，该用户重映射优先，follow-up 保留 `Ctrl+Enter`，除非你显式绑定 `app.message.followUp`。

实现 OSC 5522 增强粘贴的终端可以直接把剪贴板 MIME 数据发送给 `omp`；图像粘贴会以 `[Image #N]` 形式附加，而 text/plain 粘贴事件保持普通粘贴行为。当 OSC 5522 不可用时，bracketed paste 仍能处理文本；并且当从 `omp` 宿主可读取该文件时，粘贴的单个图像文件路径会被作为图像加载。

加载 `keybindings.yml` 时，旧的、不带命名空间的 action 名会被迁移，但新文档与新配置应使用上面带命名空间的 action ID。现有的 `keybindings.json` 文件仍会被接受并迁移为 `keybindings.yml`；`keybindings.yaml` 也接受。
