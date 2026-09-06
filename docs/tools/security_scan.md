# security_scan

> 规划并运行 OMP 原生安全审查，校验已存储的发现，并显式地与 Codex Security 云端扫描交互。

## 可用性与前置条件

- `security.enabled` 默认为 `false`。禁用时，`security_scan` 会从可用工具集中移除，`security://` 读取会以启用提示消息失败。可在 **Settings → Tools → Security** 中启用，或设置 `security.enabled = true`。
- 该工具可被发现、使用严格 schema，并被归类为 `exec`。
- 原生 `preflight` 需要一个 Git 仓库、一个活动模型、会话的模型与认证注册表，以及活动模型 provider 的已存储 OAuth 凭据。仅 API key 的认证不被接受。
- 若存在多个 OAuth 账号且没有一个处于活动状态，请传入 `credential_id`；只有一个账号时会自动选中。不可变计划会固定凭据行以及所记录的账号/工作区身份。执行与令牌刷新始终停留在该行，而不会轮换到其他账号。
- 云端操作需要一个 `openai-codex` ChatGPT OAuth 凭据。它们调用 ChatGPT 的 Codex Security 云端控制面，而非公开 OpenAI API，并且绝不会作为原生扫描的回退。

## 源码

- 公共工具与 schema：`packages/coding-agent/src/tools/security-scan.ts`
- 面向模型的 prompt：`packages/coding-agent/src/prompts/tools/security-scan.md`
- 原生规划与时效性：`packages/coding-agent/src/security/preflight.ts`
- 后台执行：`packages/coding-agent/src/security/coordinator.ts`
- 仅用于发布的扫描工具：`packages/coding-agent/src/security/publication.ts`
- 规范化存储与输出文件：`packages/coding-agent/src/security/store.ts`
- 云端客户端/导入：`packages/coding-agent/src/security/cloud.ts`
- 只读资源：`packages/coding-agent/src/internal-urls/security-protocol.ts`

## 输入

| 字段 | 类型 | 使用方 | 描述 |
| --- | --- | --- | --- |
| `action` | `"preflight" \| "start" \| "status" \| "cancel" \| "validate" \| "cloud_scans" \| "cloud_start" \| "cloud_status" \| "cloud_pull"` | 全部 | 必需的分发选择器。 |
| `plan_id` | `string` | `start` | `preflight` 返回的计划 ID。 |
| `operation_id` | `string` | `status`, `cancel` | `start` 返回的操作 ID。 |
| `target_kind` | `"repository" \| "scoped_path" \| "ref_diff" \| "working_tree"` | `preflight` | 默认为 `repository`。 |
| `include_paths` | `string[]` | `preflight` | 纳入不可变范围的、相对于仓库的路径。`scoped_path` 要求至少一个非空值。 |
| `exclude_paths` | `string[]` | `preflight` | 从范围中移除的、相对于仓库的路径。排除优先于包含。 |
| `base_revision` | `string` | `preflight` with `ref_diff` | 与 `head_revision` 成对必需；在 preflight 期间解析为某个 commit。 |
| `head_revision` | `string` | `preflight` with `ref_diff` | 与 `base_revision` 成对必需；在 preflight 期间解析为某个 commit。 |
| `knowledge_base_paths` | `string[]` | `preflight` | 相对于仓库根解析、经规范化并按 SHA-256 与大小固定的文件。 |
| `output_root` | `string` | `preflight` | 可选的外部结果目录。它必须位于仓库之外、是规范路径、非符号链接，并且为空（除非 `archive_existing=true`）。 |
| `archive_existing` | `boolean` | `preflight` | 默认为 `false`。允许在开始执行时把非空输出目录重命名为 `<output_root>.archive-<scan-id>`。 |
| `credential_id` | positive integer | 原生 `preflight`；每个云端操作 | 固定一条 OAuth 凭据。原生扫描为活动模型 provider 选择它；云端操作为 `openai-codex` 选择它。 |
| `scan_id` | `string` | `validate` | 包含该发现的已存储扫描。 |
| `finding_id` | `string` | `validate` | 要更新的已存储发现。 |
| `validation_status` | `"unvalidated" \| "validated" \| "rejected" \| "partial" \| "error"` | `validate` | 新的校验状态。 |
| `validation_summary` | `string` | `validate` | 必需且非空的校验说明。 |
| `validation_evidence` | `{label: string, explanation: string}[]` | `validate` | 作为校验证据追加的可选证据；label 必须非空。 |
| `cloud_configuration_id` | `string` | `cloud_status`, `cloud_pull` | Codex Security 云端配置 ID。 |
| `repository_id` | `string` | `cloud_start` | 必需的云端仓库标识符。 |
| `repository_url` | `string` | `cloud_start` | 必需的云端仓库 URL。 |
| `environment_id` | `string` | `cloud_start` | 必需的云端环境标识符。 |
| `lookback_days` | positive integer or `"all"` | `cloud_start` | 默认为 `30`；`"all"` 会发送无限制的回溯。 |

不读取某些字段的操作会忽略未使用的可选字段。

## 输出与执行模型

每个操作都会返回一个文本内容块，外加包含 `action` 及下文所述操作专属对象的结构化 `details`。工具本身不流式输出部分参数或进度更新。`start` 会立即返回一个已排队的操作；它单独注册的 OMP job 汇报进度，调用方用 `status` 获取持久的操作状态。

## 操作参考

### `preflight`

`preflight` 解析并持久化一个不可变计划，然后返回：

```text
Security plan <plan-id> is ready. Fingerprint: <fingerprint>. Start it with action=start and plan_id=<plan-id>.
```

`details` 为 `{ action: "preflight", plan: { id, fingerprint } }`。

计划固定以下内容：

- 规范化的仓库根目录与归一化后的 include/exclude 范围；
- 目标快照；
- 已解析的 ref-diff 修订与 diff 摘要（如适用）；
- 活动的 provider/model 与可选的思考级别；
- 确切的 OAuth 凭据及所记录的账号/工作区身份；
- knowledge-base 文件标识；
- 输出策略；
- security 设置快照以及 coordinator prompt/工作流的指纹。

对 `repository`、`scoped_path` 与 `working_tree`，目标摘要覆盖范围内的已跟踪/未跟踪文件路径与内容、可执行位、符号链接目标以及当前 HEAD（或 `unborn`）。`ref_diff` 则对已解析的 base/head commit 及其原始 tree diff 取指纹。范围路径必须相对于仓库、必须存在并解析到仓库内部，且会被归一化、去重与排序。

若省略 `output_root`，preflight 会在项目的 OMP security 状态下分配一个私有唯一目录。若调用方提供的输出目录不存在，preflight 期间会创建它；其父目录必须已有规范化身份。非空目录要求 `archive_existing=true`。

### `start`

`start` 加载已存储的计划，并根据当前目标、security 设置、knowledge base、输出策略与工作流重新计算指纹。不匹配时会以如下信息失败：

```text
Security scan plan is stale: expected <old>, got <new>. Run security preflight again.
```

成功时，它在注册后台工作后立即返回：

```text
Security scan <scan-id> started as <operation-id>.
```

`details.operation` 包含 `operationId`、`planId`、`scanId`、`phase`、时间戳、`findingCount`，并在可用时包含 `jobId`、`sessionFile` 或 `error`。

操作的阶段为：

```text
queued → preparing → reviewing → publishing → completed
```

终态备选为 `partial`、`cancelled` 与 `failed`。coordinator 会创建一个受限且自动批准的扫描会话，只带只读的仓库检查工具、只读 LSP 与 `security-reviewer` 任务 worker。扩展发现、MCP 与 IRC 被禁用。模型回退与账号轮换被禁用。

对 `ref_diff`，执行会在固定的 head 修订上创建分离的临时 worktree，并向审查会话提供固定的 diff；清理时会移除该 worktree。其他 target 类型直接审查仓库根目录。

### `status`

需要 `operation_id`。它返回：

```text
Security scan <scan-id>: <phase>; <count> finding(s).
```

完整的操作快照在 `details.operation` 中。终态操作会跨会话从项目存储中恢复。进程重启会把已持久化的 `running` 或 `planned` 扫描标记为 `failed`（消息为 `Security scan was interrupted by a process restart`），并清理 ref-diff target 的 worktree。未知 ID 会抛出 `Unknown security operation: <id>`。

### `cancel`

需要 `operation_id`。运行中的异步任务会经由 job manager 取消；否则 coordinator 会中止其本地控制器与扫描会话。结果二选一：

```text
Cancellation requested for <operation-id>.
No running operation <operation-id>.
```

`details.cancelled` 报告请求是否被接受；操作存在时还会包含 `details.operation`。已处于终态或未知的操作返回 `false`。

### `validate`

需要 `scan_id`、`finding_id`、`validation_status` 与非空的 `validation_summary`。它更新规范化存储的发现，并可选地追加生成的校验证据记录：

```text
Finding <finding-id> validation is now <status>.
```

`details.finding` 包含发现 ID 与校验状态。扫描/发现缺失或必需字段缺失会直接失败，而不会新建发现。

### `cloud_scans`

列出所选 ChatGPT 账号可见的每一个分页配置。每行包含配置 ID、当前步骤、仓库 ID、环境 ID 与仓库 URL。若一个都没有，工具会如实说明。结构化配置在 `details.cloudConfigurations` 中返回。

### `cloud_start`

需要 `repository_id`、`repository_url` 与 `environment_id`。它创建启用的 Codex Security 云端扫描配置，并消耗该账号独立的云端扫描配额。`lookback_days` 默认为 `30`。

文本会指明配置与仓库。`details.cloudScan` 包含 `{ id, repositoryUrl }`。

### `cloud_status`

需要 `cloud_configuration_id`。它报告当前步骤与已完成/待处理的 commit 数量。`details.cloudStats` 还包含失败的 commit、按严重级别统计的发现数量，以及服务暴露的任何最后扫描 commit/时间戳。

### `cloud_pull`

需要 `cloud_configuration_id`。它获取配置、状态与所有归属的发现详情，将它们转换为 OMP 的规范化 schema，生成报告与 SARIF，并持久化为一个已完成的导入扫描。

导入采用 fail-closed：除非当前项目拥有 `origin` 远程、且其归一化仓库身份与云端配置 URL 匹配，否则导入失败。由于发现 API 不暴露覆盖收据，云端覆盖情况记录为 `unknown`。`details.importedScan` 包含新的扫描 ID 与发现数量。

## 原生发布与持久化

`security_publish` 是一个内部、严格、写入层级的工具，只在受限的原生扫描会话内可用；它不是普通的调用方操作。coordinator 要求扫描 agent 带以下内容调用它一次：

- 去重后的发现，含 rule、标题、摘要、严重级别、置信度、类别、至少一个范围内的位置、可选的证据/修复建议/CWE 与校验状态；
- 如实汇报覆盖完整性、已审查的面、排除项、延期工作与未决问题；
- 最终的 Markdown 报告。

发布会拒绝绝对路径、向上遍历父目录的路径或范围外的发现与证据路径。规范指纹相同的重复发现会被去重。第二次成功的发布调用会失败。若扫描会话未发布就结束，扫描会持久化为 `partial`；即使后续指标/输出刷新失败，成功发布仍保持为 `completed`。

规范化状态是私有的，并按项目键控，存放于 OMP 的 security 状态根目录下。一个已完成的原生输出目录包含：

- `scan.json` — 公开的扫描 manifest，最后写入以作为提交标记；
- `findings.json`;
- `report.md`;
- `results.sarif`;
- `provenance.json` — 已脱敏的私有元数据。

在非 Windows 平台上，目录被加固为模式 `0700`，文件为 `0600`。

## 读取结果

`security://` 命名空间不可变，且按项目作用域划分：

| URL | 结果 |
| --- | --- |
| `security://` | 命名空间索引。 |
| `security://scans` | 已存储的扫描列表。 |
| `security://scans/<scan-id>` | 扫描摘要与子资源索引。 |
| `security://scans/<scan-id>/manifest` | 公开的 manifest JSON，含计划。 |
| `security://scans/<scan-id>/findings` | 发现列表。 |
| `security://scans/<scan-id>/findings/<finding-id>` | 渲染后的发现、位置、证据与修复建议。 |
| `security://scans/<scan-id>/coverage` | 覆盖情况 JSON。 |
| `security://scans/<scan-id>/report` | Markdown 报告（若存在）。 |
| `security://scans/<scan-id>/sarif` | SARIF JSON（若存在）。 |
| `security://scans/<scan-id>/provenance` | 已脱敏的 provenance JSON。 |

变更请使用 `security_scan` 操作或显式的 security 命令；URI 读取从不校验、导入、取消或以其他方式修改状态。

## 示例

规划并启动一次仓库扫描：

```json
{"action":"preflight","target_kind":"repository","exclude_paths":["vendor","dist"]}
```

```json
{"action":"start","plan_id":"secplan_<id>"}
```

规划一次带外部输出目录的精确修订 diff：

```json
{
  "action": "preflight",
  "target_kind": "ref_diff",
  "base_revision": "origin/main",
  "head_revision": "HEAD",
  "output_root": "/tmp/omp-security-review"
}
```

校验一个发现：

```json
{
  "action": "validate",
  "scan_id": "secscan_<id>",
  "finding_id": "secfinding_<id>",
  "validation_status": "validated",
  "validation_summary": "Reproduced with an untrusted archive entry.",
  "validation_evidence": [
    {"label":"Reproduction","explanation":"The entry writes outside the extraction root."}
  ]
}
```

显式启动并在之后导入一次云端扫描：

```json
{
  "action": "cloud_start",
  "repository_id": "repo_<id>",
  "repository_url": "https://github.com/owner/repo",
  "environment_id": "env_<id>",
  "lookback_days": 30,
  "credential_id": 7
}
```

```json
{"action":"cloud_pull","cloud_configuration_id":"scan_<id>","credential_id":7}
```

## 错误与约束

- 每个操作都会先复查 `security.enabled`；禁用时直接执行会抛出 `Security is disabled. Enable security.enabled before using security_scan.`。
- 必需字符串会被去除首尾空白并拒绝空值。ArkType 会拒绝无效的枚举值、非正数的 credential/lookback ID 与格式错误的校验证据。
- 原生扫描会拒绝缺失的 Git 上下文、未知 ref、越界/不存在的范围路径、无效的 knowledge-base 文件、不安全的输出目录、未知/过期的计划、不可用的固定模型、OAuth 身份变更与不可用的固定凭据。
- 云端请求在 HTTP 401 时强制刷新并重试一次，之后失败。其他非成功响应会报告状态与端点。
- `cloud_pull` 在导入前校验仓库身份与配置归属。
- 取消是协作式的。只有后台运行处理了中止并持久化其终态包之后，操作才会到达终态 `cancelled`。
