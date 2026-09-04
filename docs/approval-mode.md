# 工具审批模式

工具审批有三个输入：

1. **工具声明** — 每个工具可以声明一个 `approval` 级别：
   - `read`：读取数据或仅更新 UI 会话元数据。
   - `write`：修改工作区/会话状态，但不执行任意代码。
   - `exec`：执行代码、调用 shell、驱动浏览器、派生 agent 或进行类似的大范围操作。
2. **工具策略** — 对象形式的声明可以设置 `policy: allow | deny | prompt`，可选 `override` 和原因。用于依赖参数的安全/模式规则。
3. **用户策略** — `tools.approval.<toolName>: allow | deny | prompt` 覆盖当前模式，但不能绕过工具自身的 deny/prompt 策略或非 yolo 的安全覆盖。

没有 `approval` 声明的工具，以及格式错误的审批决策，都被视为 `exec`。这是未知自定义工具的安全默认值。MCP server 工具声明为 `write`。

## 模式

通过 `tools.approvalMode` 配置：

| Mode             | Auto-approves           | Prompts for     |
| ---------------- | ----------------------- | --------------- |
| `always-ask`     | `read`                  | `write`, `exec` |
| `write`          | `read`, `write`         | `exec`          |
| `yolo` (default) | `read`, `write`, `exec` | none            |

`--auto-approve` 和 `--yolo` 为会话强制 `tools.approvalMode: yolo`。

## 用户覆盖

`tools.approval` 在所有模式下都被遵循：

```yaml
tools:
  approvalMode: write
  approval:
    bash: prompt
    read: allow
    mcp__filesystem_delete: deny
```

对 MCP 工具，以最终注册的精确名称作为策略键。常规形式为
`mcp__<sanitized_server>_<sanitized_tool>`。工具名中冗余的 `<server>_` 前缀会被移除，
因此 server `echo` 的工具 `echo_it` 注册为 `mcp__echo_it`。超过 64 字符的名称
会以确定性的哈希后缀截断；请使用最终截断后的名称，而不是未截断的模式。见
[MCP tool naming](./mcp-server-tool-authoring.md#naming-and-collision-domain)。

每次工具调用的解析：

1. 评估 `tool.approval(args)`；缺失/格式错误的决策默认为 `exec` 级别。
2. 工具声明的 `policy: deny` 总是拒绝。用户 `deny` 紧接着检查，同样总是拒绝。
3. 在 `yolo` 下，显式的工具 `allow`/`prompt` 策略胜出；否则有效的用户策略胜出，或调用被允许。仅有 `override` 标志不会在 `yolo` 下强制提示。
4. 在非 yolo 模式下，`override: true` 的决策只允许伴随的工具 `policy: allow`；其他所有非拒绝的情况都提示。
5. 没有 override 时，显式的工具 `allow`/`prompt` 策略胜出，然后有效的用户策略胜出。
6. 没有显式策略时，当前模式按级别自动批准或提示。

策略字符串会被 trim 并大小写归一化。无效的用户值被忽略。

## 安全覆盖

工具可以用对象形式的 approval 强制提示：

```ts
approval: { tier: "exec", override: true, reason: "Critical pattern detected" }
```

`bash` 对关键的破坏性模式使用此机制，例如 `rm -rf /`、fork 炸弹、远程拉取后执行、写入 `/etc/passwd` 以及主机关机命令。它还支持配置的 `bash.patterns` 规则：`deny` 是绝对的，`prompt` 强制提示，`allow` 显式允许以 `write` 级别匹配的调用。原因会显示在审批提示中。在 `yolo` 下，裸的关键 override 被忽略，但显式的工具/用户 `prompt` 或 `deny` 策略仍被强制执行。

`bash.patterns` 只参与 `bash` 工具的审批决策。`eval` 工具声明 `exec` 级别且可以通过子进程派生 shell，因此 `bash.patterns` 的 `deny` 规则不适用于通过 `eval` 运行的同一命令——在 `yolo` 下，该 `exec` 调用解析为 `allow`。要约束 `eval` 可触达的 shell，请在 `bash.patterns` 之外添加 `tools.approval.eval` 策略（`prompt` 或 `deny`）。

### 计算机安全

默认禁用的 Eval [`computer` API](./computer-use.md) 按调用选择其级别：

- 直接助手（`computer.windows()`、`win.screenshot()`、`win.ax()`、`el.bounds()`、`computer.clipboard.read()` 等）在调用的方法仅作检查时用 `read`，输入、聚焦、修改和 `clipboard.write` 用 `exec`；read 调用也在 worker 的只读防护下运行；
- `computer.run(fnOrCode, options)` 仅在 `read_only: true`（JavaScript 尾部选项或 Python 关键字参数）时用 `read`；`read_only: false`、字段缺失、参数畸形或任何其他值都用 `exec`。

审批提示在适用时显示 `read-only`，随后是解析出的 JavaScript（由标准格式化器截断到 2,000 字符）。对 `computer.run`，`read_only` 是由审批级别强制执行的信任声明，不是对脚本的静态分析。

另外，provider 发起的 computer-use 调用可能携带 `pendingSafetyChecks` 元数据。任何待处理的检查都会强制交互式提示，无论 yolo 还是每工具的 `allow`。提示会列出每个安全检查的代码、消息和脱敏/截断后的数据。没有交互式 UI 时，调用以 `pending provider safety checks but no interactive UI is available` 失败关闭。

工具审批不授权底层的现实世界操作。屏幕上的文本不可信，不能覆盖用户的直接指令。除非用户的直接消息已经授权，有后果的操作仍需要对确切目标、范围和值进行风险点确认。

## 每工具提示详情

工具可以用 `formatApprovalDetails(args)` 添加审批提示正文行。标准提示包括：

- `Allow tool: <name>`
- 未注解的 `mcp__...` 工具显示 `Origin: MCP server tool`
- 工具决策提供原因时显示 `Reason: <reason>`
- 工具特定的细节，如命令、路径、代码、浏览器操作或子 agent 分派

## 在工具上定义审批

内置和自定义工具共享相同的形态：

```ts
export type ToolTier = "read" | "write" | "exec";
export type ToolApprovalDecision =
  | ToolTier
  | {
      tier: ToolTier;
      reason?: string;
      override?: boolean;
      policy?: "allow" | "deny" | "prompt";
    };
export type ToolApproval = ToolApprovalDecision | ((args: unknown) => ToolApprovalDecision);

approval?: ToolApproval;
formatApprovalDetails?: (args: unknown) => string | string[] | undefined;
```

示例：

```ts
approval: "read";

approval: (args) => (LSP_READONLY_ACTIONS.has(args.action) ? "read" : "write");

approval: (args) =>
  isCritical(args.command)
    ? { tier: "exec", override: true, reason: "Critical pattern detected" }
    : "exec";

approval: (args) =>
  isForbidden(args)
    ? { tier: "exec", policy: "deny", reason: "Blocked by tool policy" }
    : "write";
```

## ACP 会话

ACP（`omp acp`）使用与正常 OMP 启动相同的设置解析器。全局 `~/.omp/agent/config.yml` 适用，适用于 ACP 会话 `cwd` 的项目配置适用，传给 ACP server 进程的任何 `--config <file>` 覆盖适用于该进程创建的会话。

要自动批准 ACP 工具调用，在全局或项目配置中设置模式：

```yaml
tools:
  approvalMode: yolo
```

或者以运行时覆盖或单进程配置覆盖启动 ACP server：

```bash
omp acp --yolo
omp acp --auto-approve
omp acp --approval-mode yolo
omp acp --config ./acp-yolo.yml   # file contains tools.approvalMode: yolo
```

优先级是正常的设置优先级：运行时标志（`--approval-mode`、`--auto-approve`、`--yolo`）覆盖 `--config` 覆盖，后者覆盖项目配置，再覆盖全局配置。ACP 目前没有定义 `session/new`、`session/load` 或 `session/resume` 的审批策略字段，因此需要每会话 yolo 的 ACP 客户端应使用上述某个标志或会话特定的 `--config` 覆盖启动单独的 `omp acp` 进程。

`tools.approvalMode: yolo` 在显式配置或由运行时标志提供时对 ACP 完全生效。它会跳过 OMP 的审批提示，也跳过对 `bash`、`edit`、`delete` 和 `move` 的 ACP 客户端权限门，除非 `tools.approval.<tool>` 是 `prompt` 或 `deny`。schema 默认值是 `yolo`，但默认配置的 ACP 会话仍保留客户端权限门；当客户端想要无人值守执行时，请显式设置 `tools.approvalMode: yolo`。

当需要 ACP 审批时，OMP 通过 ACP 客户端路由，而不是终端 TUI。客户端门控的 `bash`、`edit`、`delete` 和 `move` 调用使用 ACP `session/request_permission`；通用审批提示在客户端声明 `elicitation.form` 时使用 form elicitation。被拒绝、取消或不支持的提示会拒绝/取消工具调用；OMP 不会静默放行。

## 子 agent

子 agent 以 `tools.approvalMode: yolo` 无头运行，因此普通的按级别提示不会使其停滞。父级 `task` 审批是授权边界。用户的 `tools.approval.<tool>` 设置仍然权威：`deny` 阻止该工具，`allow` 允许它，而 `prompt` 在无头子 agent 中无法满足并拒绝该调用。
