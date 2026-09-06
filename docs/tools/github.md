# github

> 调度 GitHub CLI 操作，用于仓库、仓库文件、拉取请求、搜索以及 Actions 运行观察。

## 源码位置
- 入口：`packages/coding-agent/src/tools/gh.ts`
- 面向模型的提示词：`packages/coding-agent/src/prompts/tools/github.md`
- 主要协同文件：
  - `packages/coding-agent/src/tools/gh-format.ts` — 为摘要缩短提交 SHA。
  - `packages/coding-agent/src/tools/gh-renderer.ts` — TUI 渲染，尤其是 `run_watch` 的实时/结果视图。
  - `packages/coding-agent/src/utils/github.ts` — `gh` 进程包装（`github.run/json/text()`）、非交互式环境、命令截止时间、受限的输出捕获。
  - `packages/coding-agent/src/tools/gh-common.ts` — 共享辅助函数、当前仓库解析、结果构建。
  - `packages/coding-agent/src/utils/repo-lock.ts` — 按仓库的写入串行化（`withRepoLock`）。
  - `@oh-my-pi/pi-natives/vcs` — git 操作（`vcs.git()` / `vcs.requireGit()`：分支/worktree/配置/推送）。
  - `packages/utils/src/dirs.ts` — 专用 PR worktree 的基目录。
  - `packages/coding-agent/src/sdk.ts` — 会话工件分配钩子。
  - `packages/coding-agent/src/session/artifacts.ts` — 工件文件名格式 `<id>.<toolType>.log`。

## 可用性与批准

- `github.enabled` 默认为 `false`；使用前请在 **设置 → 工具** 中启用 GitHub CLI 工具。
- 该工具可被发现且为严格 schema，并且仅在 `PATH` 上存在 `gh` 时创建。身份验证由 CLI 在操作运行时检查。
- `repo_view`、`file_read`、每个 `search_*` 操作以及 `run_watch` 请求读取批准。`pr_create`、`pr_checkout` 与 `pr_push` 请求执行批准。

## 输入

| 字段 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `op` | `"repo_view" \| "file_read" \| "pr_create" \| "pr_checkout" \| "pr_push" \| "search_issues" \| "search_prs" \| "search_code" \| "search_commits" \| "search_repos" \| "run_watch"` | 是 | 分发选择器。`GithubTool.execute()` 只根据此字段进行分支。 |
| `repo` | `string` | 否 | `[host/]owner/repo` 覆盖。host 前缀仅在它与 `gh` 默认使用的 host（github.com；设置 `GH_HOST` 后为其值）一致时才可省略；任何其他 host 上的仓库（包括 `GH_HOST` 指向企业实例时的 github.com）都必须带限定，否则 `gh` 会把请求发往其默认 host。当标识参数已经是完整的 GitHub URL 时忽略此字段。对于 `search_issues`/`search_prs`/`search_code`/`search_commits`，省略时默认为当前检出的仓库（当查询已包含 `repo:`/`org:`/`user:`/`owner:` 限定符，或当前仓库解析失败时跳过默认值）。当 `gh` 无法从当前检出推断出仓库上下文时，实际使用中此字段必需。 |
| `branch` | `string` | 否 | 供 `repo_view`、`file_read`、`pr_push` 与 `run_watch` 使用。`file_read` 省略 ref 以使用仓库的默认分支；`run_watch` 在省略 `run` 时回退到当前 git 分支；`pr_push` 回退到当前分支。 |
| `path` | `string` | 否 | `file_read` 必需。GitHub 仓库中相对于仓库根目录的文件路径；前导 `/` 会被拒绝。 |
| `pr` | `string \| string[]` | 否 | 供 `pr_checkout` 使用。每项可以是 PR 编号、分支名或 GitHub PR URL。数组形式支持批处理。省略表示当前分支的 PR。 |
| `force` | `boolean` | 否 | 仅 `pr_checkout` 使用。默认为 `false`；允许把已有的 `pr-<number>` 本地分支重置到 PR 的 head 提交。 |
| `forceWithLease` | `boolean` | 否 | 仅 `pr_push` 使用；透传给 git push。 |
| `title` | `string` | 否 | 仅 `pr_create` 使用。除非 `fill` 为 `true`，否则必需。 |
| `body` | `string` | 否 | 仅 `pr_create` 使用。与 `fill` 互斥。为空/省略的 body 会变成 `--body ""` 以抑制交互式编辑器。非空 body 会写入临时文件并以 `--body-file` 传递。 |
| `base` | `string` | 否 | 仅 `pr_create` 使用；以 `--base` 传递。 |
| `head` | `string` | 否 | 仅 `pr_create` 使用；以 `--head` 传递。 |
| `draft` | `boolean` | 否 | 仅 `pr_create` 使用。默认为 `false`。 |
| `fill` | `boolean` | 否 | 仅 `pr_create` 使用。默认为 `false`。与 `title` 和 `body` 互斥。 |
| `reviewer` | `string[]` | 否 | 仅 `pr_create` 使用；每个条目变成一个 `--reviewer`。 |
| `assignee` | `string[]` | 否 | 仅 `pr_create` 使用；每个条目变成一个 `--assignee`。 |
| `label` | `string[]` | 否 | 仅 `pr_create` 使用；每个条目变成一个 `--label`。 |
| `query` | `string` | 否 | 所有 `search_*` 操作使用。本地校验只对 `search_code` 要求必填；其他搜索操作会把它与可选的日期/repo/类型限定符组合后把结果发送给 GitHub。 |
| `since` | `string` | 否 | `search_issues`、`search_prs`、`search_commits` 与 `search_repos` 的下界日期。接受相对时长（`3d`、`12h`、`2w`、`2mo`、`1y`）、`YYYY-MM-DD` 或 ISO 日期时间。`search_code` 拒绝此字段。 |
| `until` | `string` | 否 | `search_issues`、`search_prs`、`search_commits` 与 `search_repos` 的上界日期。格式与 `since` 相同。`search_code` 拒绝此字段。 |
| `dateField` | `"created" \| "updated"` | 否 | issue/PR/仓库搜索的日期限定字段。默认为 `created`；仓库搜索会把 `updated` 映射为 GitHub 的 `pushed:` 限定符。提交搜索忽略此字段，它总是使用 `committer-date:`。 |
| `limit` | `number` | 否 | 所有 `search_*` 操作使用。默认为 `10`，向下取整，上限钳制为 `50`，且必须 `> 0`。 |
| `run` | `string` | 否 | 仅 `run_watch` 使用。必须是数字形式的 run ID 或完整的 GitHub Actions run URL。 |
| `tail` | `number` | 否 | 仅 `run_watch` 使用。默认为 `15`，向下取整，上限钳制为 `200`，且必须 `> 0`。 |

## 输出
该工具返回单个文本结果，由 `packages/coding-agent/src/tools/gh-common.ts` 中的 `buildTextResult()` 构建。

- `content`：单个文本块。多条目操作会用空行与 `---` 分隔符连接各节。
- `sourceUrl`：当已知规范 URL 时，为仓库/文件/PR/run 结果设置。
- `details`：供 TUI 渲染器使用的可选结构化元数据。
  - 公共字段：`artifactId`、`repo`、`branch`、`worktreePath`、`remote`、`remoteBranch`、`headSha`、`runId`、`runIds`、`status`、`conclusion`、`failedJobs`。
  - `pr_checkout` 增加 `checkouts: GhPrCheckoutSummary[]`。
  - `run_watch` 增加 `watch: GhRunWatchViewDetails`，它驱动 `packages/coding-agent/src/tools/gh-renderer.ts` 中的自定义实时/结果渲染器。
- 工件尾部：当存在 `artifactId` 时，文本正文会追加一行，形如 `Full failed-job logs: artifact://<id>`。
  - `run_watch` 通过 `session.allocateOutputArtifact("github")` 分配工件；因此持久化会话会把失败日志正文保存为 `<artifact-dir>/<id>.github.log`。

`run_watch` 是唯一的流式操作。它在轮询期间发出 `onUpdate` 快照，然后返回一个最终文本结果。

## 流程
1. `GithubTool.createIf()` 仅在 `github.available()` 于 `PATH` 上找到 `gh` 时才暴露该工具。
2. `GithubTool.execute()` 用 `untilAborted()` 包装分发，并依据 `params.op` 进行分支。
3. 每个操作都会在 `packages/coding-agent/src/tools/gh.ts` 内本地规范化可选的字符串、数组、布尔值与数字上限。
4. CLI 执行经由 `packages/coding-agent/src/utils/github.ts` 中的 `github.run/json/text()`：
   - 在非交互式环境下用 `Bun.spawn()` 启动 `gh ...`，带 5 分钟截止时间（`GH_COMMAND_TIMEOUT_MS`）与 8 MiB 的输出捕获上限；
   - 除非 `trimOutput: false`，否则裁剪 stdout/stderr；
   - 把常见的认证/仓库上下文失败映射为面向工具的 `ToolError` 消息；
   - `json()` 会拒绝空或无效的 JSON。
   - 当前检出解析会运行 `gh repo view --json url -q .url` 并保留 host：在 github.com 上结果是 `owner/repo`，在其他 host 上是 `host/owner/repo`。`gh` 会把不带 host 的 `--repo` 解析到 `GH_HOST`（默认为 github.com），因此正是该前缀让企业检出不会落到 github.com。`gh api` 的端点路径从不携带 host，所以按仓库限定（repo-scoped）的 API 调用会去掉该前缀并改为传 `--hostname`；GitHub 搜索限定符也如此处理（`repo:owner/repo` 外加 `--hostname`）。
   - 由完整 URL 指定的 host（一次 `pr://<host>/…` 读取、一个 PR/issue/run URL 参数）会原样保留，包括 `github.com`，因此 `GH_HOST` 无法重定向该请求。缓存行会去掉命名 `gh` 默认 host 的前缀——`github.com/owner/repo` 与 `owner/repo` 通常共享同一行；而在 `GH_HOST` 下，显式的 `github.com/` 形式会保留自己的行，因为此时裸形式指的是已配置的实例。
5. 读取类操作（`repo_view`、`file_read`、`search_*`）获取仓库数据并返回文本或格式化的类 Markdown 摘要。`file_read` 使用带 raw-media accept 头的 GitHub contents API，并把响应字节按文本保留。单个 issue 与单个 PR 视图已移出该工具，现在通过 `issue://` / `pr://` 内部 URL 方案解析，它们共享同一个 SQLite 缓存。
6. PR diff 已移出该工具。`pr://<N>/diff` 列出变更文件，`pr://<N>/diff/<i>` 切出单个文件，`pr://<N>/diff/all` 返回完整统一 diff——参见 `docs/tools/read.md`。三种变体通过 `pr-diff` 缓存行共享同一次 `gh pr diff` 调用。
7. `pr_checkout` 先解析 PR 元数据，然后在任何 git 变更前进入 `withRepoLock()`（`packages/coding-agent/src/utils/repo-lock.ts`），这样针对同一主仓库的并行 checkout 调用不会在共享的 `.git` 状态上竞争。
8. `pr_push` 从 git 分支配置读回 PR head 元数据，推导 refspec，用 `repository.push()`（`@oh-my-pi/pi-natives/vcs`）推送，然后通过 `invalidateAllForNumber()` 使被推送 PR 的已缓存 `pr://` 行失效，这样下一次 `pr://` 读取能反映该推送。
9. `pr_create` 只启动一次子进程，然后尽力重新读取创建出的 PR 以获得更丰富的摘要。
10. `run_watch` 选择 run 模式（提供了 `run`）或 commit 模式（省略 `run`），前 1 分钟每 3 秒轮询一次 GitHub Actions API，之后每 15 秒一次，发出流式更新，并可能在返回前保存完整的失败日志工件。
11. 最终文本经由 `toolResult().text(...)`；若 `session.allocateOutputArtifact()` 返回槽位，失败日志文本会用 `Bun.write()` 持久化。

## 模式 / 变体

### `repo_view`

| 方面 | 值 |
| --- | --- |
| 必需字段 | `op` |
| 可选字段 | `repo`、`branch` |
| `gh` 命令 | `gh repo view [<repo>] [--branch <branch>] --json <GH_REPO_FIELDS>` |
| 批处理 | 无 |
| 输出 | `# <owner/repo>` 标题、描述、URL、默认分支、请求的分支、可见性、权限、主要语言、star 数、fork 数、归档/fork 标志、更新时间戳、主页、topics。`sourceUrl = data.url`。 |

若省略 `repo`，则使用 `gh` 的仓库解析逻辑。

### `file_read`

| 方面 | 值 |
| --- | --- |
| 必需字段 | `op`、`path` |
| 可选字段 | `repo`、`branch` |
| `gh` 命令 | `gh api /repos/<repo>/contents/<encoded-path> --method GET -H "Accept: application/vnd.github.raw+json" [-f ref=<branch>]` |
| 批处理 | 无 |
| 输出 | contents API 原样返回的文件内容（`trimOutput: false`）。`sourceUrl` 指向 `https://github.com/<repo>/blob/<branch-or-HEAD>/<encoded-path>`；`details` 包含解析后的 `repo` 与可选的 `branch`。 |

`repo` 默认为当前检出的 GitHub 仓库。省略 `branch` 时向 GitHub 请求该仓库的默认分支。每个路径段独立地进行 URL 编码。该操作拒绝空路径或以 `/` 开头的路径；GitHub 报告的缺失文件、目录与无效 ref 会经由常规 CLI 错误映射处理。面向模型的提示词要求对 GitHub 仓库中托管的文件使用本操作，而不是 `curl` 或 `wget`。

单个 issue 与单个 PR 读取位于 `issue://<N>` / `pr://<N>` URL 方案中（参见 `docs/tools/read.md`）。它们共享 `~/.omp/cache/github-cache.db`（可用 `OMP_GITHUB_CACHE_DB` 覆盖）以及 `github.cache.softTtlSec` / `github.cache.hardTtlSec` / `github.cache.enabled` 设置。缓存保留渲染后的 Markdown 以及 `gh` 返回的原始 JSON 负载，包括私有正文、评论、评审与评审评论（启用评论时）；缓存行按本地 GitHub 凭据指纹限定范围。根级与仓库级读取（`issue://`、`pr://owner/repo`）会为浏览发出实时的 `gh issue list` / `gh pr list`；查询参数 `state`、`limit`、`author`、`label` 会透传给 `gh`（`issue://` 接受 `state=open|closed|all`；`pr://` 还接受 `merged`）。PR diff 也在同一缓存下，位于 `pr://<N>/diff[/…]`：列表、完整 diff 与单文件切片共享同一个按仓库与 PR 编号为键的 `pr-diff` 行。

### `pr_create`

| 方面 | 值 |
| --- | --- |
| 必需字段 | `op`，外加 `fill=true` 或 `title` 二者之一 |
| 可选字段 | `repo`、`title`、`body`、`base`、`head`、`draft`、`fill`、`reviewer[]`、`assignee[]`、`label[]` |
| `gh` 命令 | `gh pr create ...`，flag 由提供的字段拼装 |
| 批处理 | 无 |
| 输出 | `# Created Pull Request ...` 摘要，含 URL、状态、draft 标志、base/head、作者、创建时间、标签与可选 body。`sourceUrl` 为创建出的 PR URL。 |

分支：
- `fill && (title || body !== undefined)` 会抛出异常。
- 非空 `body` 会写入 `os.tmpdir()` 下名为 `gh-pr-body-*` 的临时目录，以 `--body-file` 传递，然后在 `finally` 中删除。
- 创建后，工具会解析返回的 URL 并尽力运行 `gh pr view <number> --repo <repo> --json <GH_PR_FIELDS_NO_COMMENTS>`；此处的失败会被吞掉。

### `pr_checkout`

| 方面 | 值 |
| --- | --- |
| 必需字段 | `op` |
| 可选字段 | `repo`、`pr`、`force` |
| `gh` 命令 | 对每个请求的 PR：`gh pr view [<pr>] [--repo <repo>] --json <GH_PR_CHECKOUT_FIELDS>`；跨仓库 PR 还可能会调用 `gh repo view <headRepository> --json <GH_REPO_CLONE_FIELDS>`。 |
| 批处理 | 支持。`pr` 可以是 `string[]`；每个 PR 并行解析，但 git 变更由 `withRepoLock()` 按主仓库串行化。 |
| 输出 | 单个 PR：checkout/worktree 摘要，外加 `details.repo`、`details.branch`、`details.worktreePath`、`details.remote`、`details.remoteBranch`、`details.checkouts`。批量：`# <n> Pull Request Worktrees (...)`，外加每个 PR 一节与聚合的 `details.checkouts`。部分失败时标题变为 `# <n>/<total> Pull Request Worktrees checked out (<k> failed)`，末尾带 `## Failed` 列表。 |

Worktree 与元数据行为：
- 本地分支名总是 `pr-<number>`。
- Worktree 路径为 `getWorktreeDir("<number>-<repo-hash>")` = `path.join(getWorktreesDir(), "<number>-<repo-hash>")`，其中 `<number>` 是 PR 编号，`<repo-hash>` 是 `hashPath(primaryRepoRoot)`（主仓库根目录的 7 位十六进制摘要）。`getWorktreesDir()` 按以下顺序解析基目录：有效的 `OMP_WORKTREE_DIR`、已生效的 `worktree.base` 设置，然后是 profile/XDG 感知的数据根默认值（通常为 `~/.omp/wt`）。两种覆盖都会展开前导 `~` 且必须解析为绝对路径；无效的相对值会被忽略并继续向下解析。当结果路径已被 git 注册或已存在于磁盘上时，`resolveAvailableWorktreePath()` 会追加 `-2`/`-3`… 后缀。
- 已有 worktree 的检测通过 `repository.worktrees()`（`@oh-my-pi/pi-natives/vcs`）按分支 ref `refs/heads/pr-<number>` 进行。
- 新建 worktree 会在确认路径既未被注册也不存在于磁盘后调用 `repository.worktreeAdd(finalWorktreePath, localBranch, false, signal)`。
- 同仓库 PR 的 remote 为 `origin`。跨仓库 PR 时，工具会解析 head 仓库的 clone URL，尽可能复用 URL 相同的已有 remote，否则创建 `fork-<owner>` / `fork-<owner>-<n>`。
- 分支推送元数据会通过 `git config` 持久化到仓库共享的 `.git/config` 中，键为：
  - `branch.pr-<number>.remote`
  - `branch.pr-<number>.merge`
  - `branch.pr-<number>.pushRemote`
  - `branch.pr-<number>.ompPrHeadRef`
  - `branch.pr-<number>.ompPrUrl`
  - `branch.pr-<number>.ompPrIsCrossRepository`
  - `branch.pr-<number>.ompPrMaintainerCanModify`
- 若 `refs/heads/pr-<number>` 已存在于不同提交上，checkout 会失败，除非 `force=true`；此时 `repository.createBranch(..., force=true)` 会把它重置到已获取的 PR head。
- 若已存在匹配的 worktree，工具会复用它并报告 `reused: true`。

### `pr_push`

| 方面 | 值 |
| --- | --- |
| 必需字段 | `op` |
| 可选字段 | `branch`、`forceWithLease` |
| `gh` 命令 | 无。此路径使用 git，而不是 `gh`。 |
| 批处理 | 无 |
| 输出 | `# Pushed Pull Request Branch` 摘要，含本地分支、remote、remote 分支、remote URL、PR URL 与 force-with-lease 标志。已知时 `sourceUrl = prUrl`。 |

推送目标解析会读取 `pr_checkout` 写入的 `branch.<name>.ompPrHeadRef`、`pushRemote`/`remote`、`ompPrUrl`、`ompPrMaintainerCanModify` 与 `ompPrIsCrossRepository` git-config 键。若当前检出的分支与目标分支匹配，源 ref 为 `HEAD`；否则推送 `refs/heads/<branch>`。refspec 为 `HEAD:refs/heads/<headRef>` 或 `refs/heads/<branch>:refs/heads/<headRef>`。

### `search_issues`

| 方面 | 值 |
| --- | --- |
| 必需字段 | `op` |
| 可选字段 | `repo`、`query`、`limit`、`since`、`until`、`dateField` |
| `gh` 命令 | `gh api -X GET /search/issues -f q="<query> [date qualifier] [repo:<repo>] is:issue" -F per_page=<limit>` |
| 批处理 | 无 |
| 输出 | `# GitHub issues search`、回显的 query、可选的 repo、结果数量，然后每个 issue 一条：repo/state/author/labels/时间戳/URL。 |

省略 `repo` 时，会通过 `resolveSearchRepoScope()` 默认为当前检出的 `owner/repo`。当组合出的查询已包含前导的 `repo:`/`org:`/`user:`/`owner:` 限定符，或 `gh repo view` 无法解析当前检出（例如不在 github remote 中）时，会抑制该默认值。

### `search_prs`

| 方面 | 值 |
| --- | --- |
| 必需字段 | `op` |
| 可选字段 | `repo`、`query`、`limit`、`since`、`until`、`dateField` |
| `gh` 命令 | `gh api -X GET /search/issues -f q="<query> [date qualifier] [repo:<repo>] is:pr" -F per_page=<limit>` |
| 批处理 | 无 |
| 输出 | 与 `search_issues` 结构相同，标记为拉取请求。 |

`repo` 与 `search_issues` 一样，默认取当前检出的 `owner/repo`。

### `search_code`

| 方面 | 值 |
| --- | --- |
| 必需字段 | `op`、`query` |
| 可选字段 | `repo`、`limit` |
| `gh` 命令 | `gh api -X GET /search/code -f q="<query> [repo:<repo>]" -F per_page=<limit> -H "Accept: application/vnd.github.text-match+json"` |
| 批处理 | 无 |
| 输出 | `# GitHub code search`、结果数量，然后每个匹配一条：路径、repo、短提交 SHA、URL，以及存在时的首行规范化 text-match 片段。 |

`repo` 与 `search_issues` 一样，默认取当前检出的 `owner/repo`。此操作会显式拒绝 `since` 与 `until`，因为 GitHub 代码搜索没有受支持的日期限定符。

### `search_commits`

| 方面 | 值 |
| --- | --- |
| 必需字段 | `op` |
| 可选字段 | `repo`、`query`、`limit`、`since`、`until`、`dateField`（接受但忽略；提交搜索使用 `committer-date`） |
| `gh` 命令 | `gh api -X GET /search/commits -f q="<query> [committer-date qualifier] [repo:<repo>]" -F per_page=<limit>` |
| 批处理 | 无 |
| 输出 | `# GitHub commits search`、结果数量，然后每个提交一条：短 SHA + 提交信息首行、repo、作者、日期、URL。 |

`repo` 与 `search_issues` 一样，默认取当前检出的 `owner/repo`。

### `search_repos`

| 方面 | 值 |
| --- | --- |
| 必需字段 | `op` |
| 可选字段 | `query`、`limit`、`since`、`until`、`dateField` |
| `gh` 命令 | `gh api -X GET /search/repositories -f q="<query> [date qualifier]" -F per_page=<limit>` |
| 批处理 | 无 |
| 输出 | `# GitHub repositories search`、结果数量，然后每个仓库一条：描述首行、语言、star 数、fork 数、未关闭 issue 数、可见性、归档/fork 标志、更新时间、URL。 |

此操作有意不使用 `repo`。若 `query`、`since` 与 `until` 都省略，工具会发送空的 GitHub 仓库搜索查询，GitHub API 可能会拒绝它。

### `run_watch`

| 方面 | 值 |
| --- | --- |
| 必需字段 | `op` |
| 可选字段 | `repo`、`branch`、`run`、`tail` |
| `gh` 命令 | 仓库解析：当 `repo` 与 run URL 的仓库都缺失时，执行 `gh repo view --json url -q .url`。单 run 模式使用 `gh api --method GET /repos/<repo>/actions/runs/<runId>` 与 `gh api --method GET /repos/<repo>/actions/runs/<runId>/jobs`。commit 模式使用 `gh api --method GET /repos/<repo>/branches/<branch>`、`gh api --method GET /repos/<repo>/actions/runs`、`gh api --method GET /repos/<repo>/actions/runs/<runId>/jobs`，并对失败作业使用 `gh api /repos/<repo>/actions/jobs/<jobId>/logs`。 |
| 批处理 | 仅在 commit 模式下隐式批处理：同一提交的所有 workflow run 一起跟踪。 |
| 输出 | 通过 `onUpdate` 输出流式 watch 快照，然后给出最终文本报告。失败时，追加 `Full failed-job logs: artifact://<id>` 并设置 `details.artifactId`。 |

Watch 流程：
- `run` 解析接受十进制 run ID 或完整的 run URL。两者都给出时，URL 的仓库必须与显式 `repo` 匹配。
- 轮询间隔在 watch 前 `60` 秒（`RUN_WATCH_FAST_WINDOW_MS`）内为 `3` 秒（`RUN_WATCH_INTERVAL_DEFAULT`），之后为 `15` 秒（`RUN_WATCH_INTERVAL_SLOW`）。触发限流的轮询错误会按慢速间隔退避，最多连续重试 `5` 次（`RUN_WATCH_MAX_POLL_FAILURES`）。commit 模式若在 `90` 秒后仍无任何 run 出现，会给出明确消息后放弃（`RUN_WATCH_NO_RUNS_GIVE_UP_MS`）。
- 失败宽限期固定为 5 秒（`RUN_WATCH_GRACE_DEFAULT`）。当完成前出现任何失败作业时，工具会发出提示、等待一次、重新获取状态，然后收集日志，以便把并发的失败也包含进来。
- 失败作业日志通过 `github.run()`（而非 `json()`）用 `gh api /repos/<repo>/actions/jobs/<jobId>/logs` 获取。非零退出会把 `available: false` 留在结果中，而不是让整个 watch 失败。
- 内联结果只包含每个失败作业的最后 `tail` 行。保存的工件包含完整日志（`mode: "full"`）。
- commit 模式下成功会被有意二次确认：一旦所有已知 run 都成功，工具会再等待一个轮询间隔，并且只有当 run ID 集合不变时才判定成功。这可以避免在同一提交的较晚 workflow run 出现之前过早返回。
- `details.watch` 驱动 `packages/coding-agent/src/tools/gh-renderer.ts` 中的专用渲染器；非 watch 结果回退到通用文本渲染。

## 副作用
- 文件系统
  - `pr_create` 可能在 `os.tmpdir()` 下创建名为 `gh-pr-body-*` 的临时目录，写入 `body.md`，然后在 `finally` 中删除该目录。
  - `pr_checkout` 可能在 `OMP_WORKTREE_DIR`、然后是 `worktree.base`、再是 profile/XDG 感知的默认值（通常为 `~/.omp/wt`）所选定的基目录下创建名为 `<pr-number>-<repo-hash>` 的 worktree 目录，并在其中添加 git worktree。
  - `run_watch` 可能写入包含完整失败作业日志的会话工件。
- 网络
  - 除 `pr_push` 外，每个操作都会启动 `gh` 子进程，由它与 GitHub API 通信。
  - `pr_push` 使用 git 网络传输到已配置的 remote。
- 子进程 / 原生绑定
  - 所有 `gh` 调用都使用 `Bun.spawn(["gh", ...args])`。
  - `pr_checkout` 与 `pr_push` 还会通过 `@oh-my-pi/pi-natives/vcs`（`vcs.requireGit()`）调用 git 操作，并由 `packages/coding-agent/src/utils/repo-lock.ts` 中的 `withRepoLock()` 串行化。
- 会话状态（transcript、memory、jobs、checkpoints、registries）
  - 当持久化失败作业日志时，`run_watch` 会消耗 `session.allocateOutputArtifact()`。
  - 返回的 `details` 对象携带 run/checkouts 元数据，供渲染器/UI 使用。
- 用户可见的提示 / 交互式 UI
  - 对 `pr_create`，通过强制使用 `--body-file` 或 `--body ""` 抑制 `gh` 的交互式编辑器回退。
  - `gh-renderer` 为所有操作提供紧凑标题，并为 `run_watch` 提供自定义实时 watch 视图。
- 后台工作 / 取消
  - `run_watch` 循环直到成功/失败，并在轮询之间使用 `scheduler.wait()`。
  - `GithubTool.execute()` 用 `untilAborted()` 包装；`github.run()` 会把中止信号转发进 `Bun.spawn()`。

## 限制与上限
- 搜索结果默认：`10`（`packages/coding-agent/src/tools/gh-search.ts` 中的 `SEARCH_LIMIT_DEFAULT`）。
- 搜索结果上限：`50`（`SEARCH_LIMIT_MAX`）。
- `pr://` 视图内的 PR 文件预览：仅前 `50` 个文件（`gh-search.ts` 中的 `FILE_PREVIEW_LIMIT`）。对于在 GitHub 20,000 行限制处被拒绝的聚合 diff，`pr://<N>/diff` 获取器会回退到分页文件 API（每页 `100` 个文件，最多 `3000` 个文件）；二进制或单个超大补丁仍会列出，并带不可用补丁标记。
- Run-watch 轮询间隔：前 `60s` 为 `3s`，之后为 `15s`（`RUN_WATCH_INTERVAL_DEFAULT`、`RUN_WATCH_FAST_WINDOW_MS`、`RUN_WATCH_INTERVAL_SLOW`）；commit 模式无 run 时 `90s` 后放弃（`RUN_WATCH_NO_RUNS_GIVE_UP_MS`）；最多容忍 `5` 次连续的限流轮询失败（`RUN_WATCH_MAX_POLL_FAILURES`）。
- Run-watch 失败宽限期：`5s`（`RUN_WATCH_GRACE_DEFAULT`）。
- Run-watch 失败日志尾部默认：`15` 行（`RUN_WATCH_TAIL_DEFAULT`）。
- Run-watch 失败日志尾部上限：`200` 行（`RUN_WATCH_TAIL_MAX`）。
- PR 评审评论页大小：`100`（`REVIEW_COMMENTS_PAGE_SIZE`）。
- Actions 作业页大小：`100`（`RUN_JOBS_PAGE_SIZE`）。
- 搜索与 tail 的数字输入用 `Math.floor()` 向下取整，钳制到上限，并在非有限或 `<= 0` 时被拒绝。
- `pr_checkout` 批量的扇出在工具代码中不受限；所有请求的 PR 都用 `Promise.allSettled()` 启动，因此单个失败会呈现为部分结果，而不是中止整个批次。

## 错误
- 未安装 `gh` 时，工具的创建会被整体跳过。
- 执行时缺失 `gh`，`github.run()` 会抛出 `ToolError("GitHub CLI (gh) is not installed...")`。
- `github.text()/json()` 会把常见失败映射为面向模型的消息：
  - 未认证 → `GitHub CLI is not authenticated. Run \`gh auth login\`.`
  - 缺少仓库上下文且没有显式 `repo` → `GitHub repository context is unavailable. Pass \`repo\` explicitly or run the tool inside a GitHub checkout.`
  - 否则为 stderr/stdout 文本，或回退 `GitHub CLI command failed: gh ...`
- 空 stdout 或无效 JSON 时，`json()` 也会抛出异常。
- 本地校验错误会抛出 `ToolError`，包括：
  - 缺少按操作必需的字段（`file_read` 缺 `path`、`search_code` 缺 `query`、`title` 除非 `fill=true`）
  - 无效的数字 `limit` / `tail`
  - 无效的 `since` / `until` 日期边界
  - 无效的 `run` 格式
  - `fill` 与 `title` 或 `body` 同时出现
  - checkout、push 或 watch 缺少 git 仓库 / 分支 / HEAD 上下文
  - 在没有 `ompPrHeadRef` 元数据的分支上执行 `pr_push`
  - 没有 `force` 时 worktree 路径或分支冲突
  - `file_read` 路径为绝对路径（前导 `/`）
- `run_watch` 特殊处理失败作业日志获取：日志内容缺失不会让 watch 失败；它会把该日志标记为 `available: false` 并打印 `Log tail unavailable.` / `Full log unavailable.`。
- `pr_create` 只吞掉创建后尽力执行的 `gh pr view` 刷新；创建步骤本身仍会正常失败。

## 备注
- 当标识参数已是完整的 GitHub URL 时，`appendRepoFlag()` 有意跳过 `--repo`；这让 `gh` 能从 URL 推导出 repo/编号。
- `normalizePrIdentifierList()` 也接受 `reviewer`、`assignee` 与 `label` 数组；该辅助函数的名字比其调用方的用途更宽。
- `pr_push` 依赖 `pr_checkout` 已先为该本地分支运行过；没有其他的元数据来源。
- `pr_checkout` 把推送元数据存在分支配置中，而不是 worktree 目录里。复用同一个 `pr-<number>` 分支会复用这些配置键。
- worktree 写入串行化以主仓库根目录为键，而不是当前 worktree 路径，因为 git worktree 共享 `.git/config`、`packed-refs`、commit-graph 与 worktree 元数据文件。
- `search_repos` 是唯一从不转发 `repo` 的搜索操作；仓库范围必须在查询本身中表达。
- `run_watch` 在 commit 模式下的成功意味着“所有观察到的 run 都成功，且一个轮询周期后没有出现新的 run”，而不仅仅是“最近一次轮询看起来正常”。
- 除非结果视图被展开，否则 TUI 渲染器会折叠失败的日志预览；底层文本结果仍包含同样的尾部行以及任何工件引用。
