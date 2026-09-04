# CLI 参考

`omp` 的调用方式为：

```sh
omp [command] [flags] [messages...]
```

当第一个非 flag 参数**不是**已注册的子命令时，`omp` 路由到默认的 [`launch`](#launch-the-default-command) 命令，并将
参数视为初始 prompt。因此 `omp "fix the build"` 会以该消息启动会话，
而 `omp models` 运行 `models` 子命令。

运行时帮助同样可用：

- `omp --help` 列出面向用户的子命令和常见 launch flag。
- `omp <command> --help` 打印该命令的公开 flag 和示例。

本页是共享 **launch 表面**（`omp` / `omp launch` 接受的
flag）和所有顶层**子命令**的合并参考。
各子命令的 flag（例如 `omp auth-broker --json`）由每个命令的 `--help` 文档说明。

## Launch（默认命令）

`omp` 和 `omp launch` 启动编码会话。位置参数成为初始
消息：

```sh
# Interactive session
omp

# Interactive session with an initial prompt
omp "List all .ts files in src/"

# Attach files/images to the initial message (prefix with @)
omp @prompt.md @image.png "What color is the sky?"

# Non-interactive: process the prompt and exit (headless / print mode)
omp -p "List all .ts files in src/"

# Continue the previous session
omp --continue "What did we discuss?"
```

参数处理：

- `@<path>` 将文件或图像附加到初始消息。
- 非 TTY 的 stdin 自动读取为初始 prompt；不要添加 `-` 标记。
- `--` 结束 flag 解析；其后的所有内容都是字面消息文本，即使它
  看起来像 flag。

### Launch flag

#### 会话与工作区

| Flag | 说明 |
| --- | --- |
| `--cwd <dir>` | 启动所在目录（覆盖 launch cwd）。 |
| `--add-dir <dir>` | 在工作目录之外添加工作区目录（可重复）。 |
| `--allow-home` | 允许在 `~` 中启动而不自动切换到临时目录。 |
| `--profile <name>` | 为认证、会话、设置和缓存使用隔离的 profile。 |
| `--alias <name>` | 为所选 profile 创建 shell 快捷方式并退出。 |
| `--config <file>` | 为本次运行加载额外的 `config.yml` 风格覆盖层（可重复）。 |
| `--session-dir <dir>` | 会话存储与查找目录。 |
| `--no-session` | 不保存会话（临时）。 |

#### 会话历史

| Flag | 说明 |
| --- | --- |
| `--continue`, `-c` | 继续上一个会话。 |
| `--resume [id]`, `-r`, `--session [id]` | 按 ID 前缀或路径恢复会话，无值时打开选择器。 |
| `--fork <session>` | 将已保存的会话（按 ID 前缀或路径）fork 到新会话。见 [session operations](./session-operations-export-share-fork-resume.md)。 |
| `--from-claude` | 将 Claude Code 会话导入 OMP。 |
| `--from-codex` | 将 Codex 会话导入 OMP。 |
| `--export <session>` | 将会话文件导出为 HTML 并退出。 |
| `--no-title` | 禁用标题自动生成（等价于 `PI_NO_TITLE` [环境变量](./environment-variables.md)）。 |

#### 模型选择

| Flag | 说明 |
| --- | --- |
| `--model <id-or-role>` | 要使用的模型或已配置角色（角色：`slow` 或 `@slow`；模糊模型匹配：`opus`、`gpt-5.2` 或 `openai/gpt-5.2`）。 |
| `--smol <id>` | 用于轻量任务的 smol/快速模型（或 `PI_SMOL_MODEL`）。 |
| `--slow <id>` | 用于深入分析的 slow/推理模型（或 `PI_SLOW_MODEL`）。 |
| `--plan <id>` | 用于架构规划的 plan 模型（或 `PI_PLAN_MODEL`）。 |
| `--models <a,b,c>` | 用于 `Ctrl+P` 循环切换的逗号分隔模型模式。 |
| `--provider <name>` | 要使用的 provider（旧版；推荐 `--model`）。 |
| `--api-key <key>` | API key（默认取环境变量）。 |
| `--provider-session-id <id>` | 复用指定的 provider 侧会话 id，以保持连续性和缓存作用域。 |
| `--prompt-cache-key <key>` | 覆盖本会话的 provider prompt-cache key。 |
| `--service-tier <tier>` | 本会话的 OpenAI service tier（`none` 省略 `service_tier`）。 |

模型解析见 [providers](./providers.md) 和 [models](./models.md)。

#### Thinking 与推理

| Flag | 说明 |
| --- | --- |
| `--thinking <level>` | 设置 thinking 级别：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` 或 `auto`。 |
| `--hide-thinking` | 在 TUI 输出中隐藏 thinking 块（仅显示；不禁用模型 thinking）。 |
| `--print-thoughts` | 在 print 模式文本输出中包含 thinking 块。 |
| `--external-thinking` | 在禁用受支持的 GPT/Claude/Gemini 推理的同时使用私有 scratchpad。风险自负：provider 已将此请求形态标记为滥用。 |

#### Prewalk 与 plan 模式

| Flag | 说明 |
| --- | --- |
| `--prewalk` | 在计划的 todo 列表存在后，首次 edit/write 时切换到快速/廉价模型（默认关；见 `prewalk.enabled`）。 |
| `--no-prewalk` | 即使设置了 `prewalk.enabled` 也禁用 prewalk。 |
| `--prewalk-into <id>` | prewalk 的目标模型（默认 `smol` 角色）。 |
| `--plan-yolo` | 启动时强制只读 plan 模式，在模型的首次 resolve 调用时自动批准计划，然后切换到 `--plan-yolo-into` 去实现。 |
| `--plan-yolo-into <id>` | plan-yolo 执行的目标模型（默认 `smol` 角色）。 |

#### 工具、审批与运行时

| Flag | 说明 |
| --- | --- |
| `--tools <a,b,c>` | 要启用的工具的逗号分隔列表（默认：全部）。 |
| `--no-tools` | 禁用所有内置工具。 |
| `--no-lsp` | 禁用 LSP 工具、格式化和诊断。 |
| `--no-pty` | 禁用基于 PTY 的交互式 bash 执行。 |
| `--approval-mode <mode>` | 为本会话覆盖 `tools.approvalMode`（`always-ask`、`write` 或 `yolo`）。见 [approval mode](./approval-mode.md)。 |
| `--auto-approve`, `--yolo` | 自动批准所有工具调用（跳过审批提示）。 |
| `--advisor` | 启用 advisor 运行时（被动评审每个回合并注入笔记）。见 [advisor / watchdog](./advisor-watchdog.md)。 |
| `--max-time <duration>` | 在该时长后停止会话（例如 `600`、`10m`、`1h`）。 |

#### Extension、hook、skill 与 rule

| Flag | 说明 |
| --- | --- |
| `--extension <path>`, `-e <path>` | 加载 extension（可重复）。见 [extensions](./extensions.md)。 |
| `--hook <path>` | 加载 hook/extension 文件（可重复）。见 [hooks](./hooks.md)。 |
| `--trusted-extension <abs-path>` | 从绝对路径加载可信 extension（可重复；不能与 `--extension`/`-e`/`--hook` 组合）。 |
| `--plugin-dir <dir>` | 添加本地插件目录到发现范围（可重复）。 |
| `--no-extensions` | 禁用 extension 发现（显式 `-e` 路径仍有效）。 |
| `--skills <globs>` | 过滤 [skills](./skills.md) 的逗号分隔 glob 模式（例如 `git-*,docker`）。 |
| `--no-skills` | 禁用 skills 发现与加载。 |
| `--no-rules` | 禁用 rules 发现与加载。见 [context files](./context-files.md)。 |

#### 系统 prompt

| Flag | 说明 |
| --- | --- |
| `--system-prompt <text\|file>` | 系统 prompt（默认：编码助手 prompt）。见 [system prompt customization](./system-prompt-customization.md)。 |
| `--append-system-prompt <text\|file>` | 将文本或文件内容追加到系统 prompt。 |

#### 输出模式

| Flag | 说明 |
| --- | --- |
| `--mode <mode>` | 输出/传输模式：`text`（默认）、`json`、`rpc`、`acp` 或 `rpc-ui`。见 [output modes](#output-modes---mode)。 |

#### 信息

| Flag | 说明 |
| --- | --- |
| `--help`, `-h` | 显示 `omp` 或子命令的帮助并退出。 |
| `--version`, `-v` | 打印已安装版本并退出。 |

### 无头 / print 模式

`--print` / `-p` 以非交互方式运行 `omp`：处理 prompt，将结果
流式输出到 stdout，然后退出而不进入 TUI。这是脚本化
和自动化的入口。

```sh
# Print the answer and exit
omp -p "Summarize the changes in the last commit"

# Include the model's thinking blocks in the printed text
omp -p --print-thoughts "Explain your reasoning for this refactor"

# Machine-readable output for pipelines
omp -p --mode json "List every TODO in src/" > todos.json

# Pipe a prompt via stdin
echo "review this diff" | omp -p
```

无头运行的相关 flag：

- `--print-thoughts` — 在打印的文本输出中包含 thinking 块。
- `--mode json` — 输出结构化事件而非渲染文本。
- `--no-title` — 跳过标题自动生成（也是 `PI_NO_TITLE`）。
- `--max-time <duration>` — 限制运行时长。

[advisor / watchdog](./advisor-watchdog.md#headless-runs) 文档描述
启用 advisor 运行时时 print 模式的处置语义。

### 输出模式（`--mode`）

| 模式 | 说明 |
| --- | --- |
| `text` | 默认。渲染文本输出（交互时为 TUI，`--print` 下为纯文本）。 |
| `json` | 结构化 JSON 事件流，供无头/机器消费。 |
| `rpc` | 基于 stdio 的 JSON-RPC 服务器。见 [RPC](./rpc.md)。 |
| `rpc-ui` | 启用 UI extension 事件的 RPC 传输。 |
| `acp` | 基于 stdio 的 Agent Client Protocol 服务器。等价于 [`acp`](#subcommands) 子命令；见 [approval mode → ACP sessions](./approval-mode.md#acp-sessions)。 |

## 子命令

运行 `omp <command> --help` 查看各命令自身的 flag 与示例。

| 命令 | 用途 | 另见 |
| --- | --- | --- |
| `launch` | 启动编码会话（默认命令）。 | [Launch flags](#launch-flags) |
| `acp` | 将 Oh My Pi 作为基于 stdio 的 ACP（Agent Client Protocol）服务器运行。 | [approval mode](./approval-mode.md#acp-sessions) |
| `auth-broker` | 管理 omp auth-broker（凭据保险库）。 | [auth broker / gateway](./auth-broker-gateway.md) |
| `auth-gateway` | 运行由所配置 broker 支撑的 auth-gateway 正向代理。 | [auth broker / gateway](./auth-broker-gateway.md) |
| `agents` | 管理内置任务 agent。 | [task agent discovery](./task-agent-discovery.md) |
| `bench` | 对模型做基准测试：在 chat、prefill、生成和 prompt-cache 工作负载上测量 TTFT/prefill 与解码吞吐的 p50/p95，以实时仪表盘呈现（`--prefill-bytes` 设定合成 prefill 输入大小）。 | |
| `browser-relay` | 运行 Eval 浏览器 API 用来操控你自己 Chrome 标签页的本地 CDP relay。 | [computer use](./computer-use.md) |
| `cleanse` | 用带权重的并行 subagent 检测并修复项目诊断。 | |
| `commit` | 生成提交信息并更新 changelog。 | |
| `completions` | 打印 shell 补全脚本（bash、zsh 或 fish）。 | |
| `compress` | 将文本文件改写为稠密的 prompt 寄存器，并报告丢弃了什么。 | |
| `config` | 管理配置设置。 | [config usage](./config-usage.md), [settings](./settings.md) |
| `dry-balance` | 跨随机会话 id 对 OAuth 账户均衡做 dry-run。 | |
| `gc` | 运行存储垃圾回收。 | |
| `grep` | 从 CLI 测试 grep 工具。（[`grep` tool](./tools/grep.md) 是单独的 agent 工具。） | |
| `gallery` | 在流式、进行中、成功和失败状态下预览工具渲染器。 | |
| `git` | 交互式全屏 git UI：分屏 diff 查看器、暂存侧边栏和提交编写器。 | |
| `grievances` | 查看、清理或推送已报告的工具问题（auto-QA grievances）。 | |
| `if-bench` | 对指令遵循与工作记忆做基准测试：一条带猫声指令、贯穿 prompt 的 glyph 数组动作缓存线程。 | |
| `images`, `img` | 检查、诊断、探测和清理图像发布后端。 | |
| `install` | 安装或链接 extension 包（`plugin install` / `plugin link` 的别名）。 | [extensions](./extensions.md) |
| `join` | 加入共享 collab 会话（同 `/join`）。 | [collab](./collab.md) |
| `models` | 列出、搜索和刷新可用模型。 | [models](./models.md) |
| `plugin` | 管理插件（安装、卸载、列出等）。 | [extensions](./extensions.md), [marketplace](./marketplace.md) |
| `ps` | 列出并控制 daemon 监管的后台进程（日志、停止、杀死、重启）。 | |
| `say` | 用本地 TTS 引擎合成文本并通过扬声器播放。 | [tts tool](./tools/tts.md) |
| `share` | 通过加密链接分享已保存的会话（同 `/share` slash 命令）。 | [session operations](./session-operations-export-share-fork-resume.md) |
| `setup` | 运行引导设置，或为可选功能安装依赖。 | |
| `shell` | 交互式 shell 控制台。 | |
| `read` | 显示 read 工具对某路径、URL 或内部 URI 会返回什么。（[`read` tool](./tools/read.md) 是单独的 agent 工具。） | |
| `render` | 经生产 transcript 管线绘制会话的整个线程（带重绘计时）。 | |
| `ssh` | 管理 SSH 主机配置。 | |
| `stats` | 查看使用统计。 | |
| `update` | 检查并安装更新；`--canary`/`--stable` 切换发布通道。 | |
| `usage` | 显示每个已认证账户的 provider 用量限额；`usage clients` 按客户端细分 token 消耗（带 `--days`），`usage invalidate` 丢弃缓存的报告。 | |
| `tiny-models` | 下载微型本地模型（会话标题 + memory）。 | [local models](./local-models.md) |
| `token` | 获取某 provider 的 API key 或 OAuth token。 | [secrets](./secrets.md) |
| `ttsr` | 检查和测试 Time-Traveling Stream Rules（TTSR）。（覆盖 CLI 命令；[TTSR feature](./ttsr-injection-lifecycle.md) 单独成文。） | |
| `worktree`, `wt` | 列出或清理 agent 管理的 git worktree（`~/.omp/wt`）。 | |
| `search`, `q` | 从 CLI 测试 web search provider。 | [web_search tool](./tools/web_search.md) |

> `install`、`join`、`browser-relay`、`auth-gateway` 和 `tiny-models` 也可
> 通过相关机制触达（`plugin` 命令、`/join` slash 命令
> 等等）。表中按各项在
> `packages/coding-agent/src/cli-commands.ts` 中的注册方式列出。
