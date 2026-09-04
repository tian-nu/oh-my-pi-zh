# 自主记忆（Autonomous Memory）

Oh My Pi 支持五种记忆模式。记忆默认关闭；通过 `/settings` 或 `config.yml` 选择一个后端：

| `memory.backend` | 存储与行为                                                             | 指南                                                    |
| ---------------- | ---------------------------------------------------------------------- | ------------------------------------------------------- |
| `off`            | 无记忆后端                                                             | —                                                       |
| `local`          | 从持久化会话生成的项目级摘要与经验教训                                  | 本页                                                    |
| `hindsight`      | 远程、按 bank 划分作用域的 Hindsight 记忆                               | [Hindsight](#hindsight-remote-backend)                  |
| `mnemopi`        | 本地 Mnemopi SQLite 记忆                                               | [Mnemopi memory backend](./mnemosyne-memory-backend.md) |
| `sharpshooter`   | 带摩擦门槛的项目决策文件（架构/产品/风格），后台整合                     | —                                                       |

启用本地摘要流水线：

```yaml
memory:
  backend: local
```

## 用法

### 会注入什么

会话启动时，如果当前项目存在已整合的摘要或手动捕获的经验教训，它们会作为 **Memory Guidance** 块注入系统 prompt。摘要与经验教训共享 `memories.summaryInjectionTokenLimit`。

- 将记忆视为启发式上下文——对流程和历史决策有用，但对当前仓库状态不具有权威性。
- 当记忆改变了计划时，引用记忆工件路径，并在行动前结合当前仓库的证据。
- 当记忆与仓库状态或用户指令冲突时，优先相信后者；将冲突的记忆视为过期。

### 读取记忆工件

agent 可以通过 `read` 工具使用 `memory://` URL 直接读取记忆文件：

| URL                                    | 内容                                 |
| -------------------------------------- | ------------------------------------ |
| `memory://root`                        | 启动时注入的紧凑摘要                 |
| `memory://root/MEMORY.md`              | 完整长期记忆文档                     |
| `memory://root/learned.md`             | `learn` 工具捕获的经验教训           |
| `memory://root/skills/<name>/SKILL.md` | 生成的技能 playbook                  |
| `memory://<memory-id>`                 | 完整的 Mnemopi 记忆行（working 或 episodic），带 YAML frontmatter 元数据头；仅在 `memory.backend` 为 `mnemopi` 时可用 |

`memory://<memory-id>` 形式返回完整存储行而非被裁剪的召回预览（超出预览上限的召回内容以尾随 `…` 结尾）；agent 被指示在任何 `memory_edit update` 之前先读取它。

### `/memory` slash 命令

| 子命令                | 效果                                                      |
| --------------------- | --------------------------------------------------------- |
| `view`                | 显示当前后端注入的载荷                                     |
| `stats`               | 显示后端特有的记忆统计（如支持）                           |
| `diagnose`            | 显示后端特有的诊断信息（如支持）                           |
| `queue`               | 显示等待整合的待处理记忆增量                               |
| `sync`                | 立即运行记忆整合                                           |
| `clear` / `reset`     | 删除活动后端的记忆数据/工件                                 |
| `enqueue` / `rebuild` | 强制活动后端执行整合/保留工作                               |
| `mm …`                | Hindsight 心智模型维护（`list`/`show`/`refresh`/`history`/`seed`/`delete`/`reload`）；ACP 模式下不支持 |

### 捕获经验教训

启用 `autolearn.enabled` 以使 `learn` 工具可用：

```yaml
autolearn:
  enabled: true
```

在本地后端激活时，`learn` 将显式的持久经验教训保存到项目的 `learned.md`。条目按最新在前排列、去重、脱敏秘密信息、上限 100 条，并从下一个会话开始注入；`learn` 调用不会改变活动会话的 prompt-cache 前缀。每条经验教训内容上限 2,000 字符，可选上下文上限 400 字符。结构化记忆搜索、`recall`、`retain`、`reflect` 和 `memory_edit` 在本地后端不可用。

## 工作原理

本地摘要记忆由一个在启动时运行的后台流水线构建；`/memory enqueue` 标记整合工作，由下次启动接手。子代理以及未持久化到会话文件的会话会跳过该流水线。

**阶段 1 — 逐会话提取：** 对每个自上次处理以来发生变化的过往会话，模型读取会话历史并提取持久信号：技术决策、约束、已解决的失败、重复出现的工作流。太新、太旧、当前活跃或超出配置的扫描/年龄限制的会话会被跳过。每次提取为该会话产出一个原始记忆块和一段简短梗概。

**阶段 2 — 整合：** 提取完成后，第二轮模型处理读取所有逐会话提取内容并产出三个写入磁盘的生成物：

- `MEMORY.md` — 一份经过整理的长期记忆文档
- `memory_summary.md` — 会话启动时注入的紧凑文本
- `skills/` — 可复用的流程 playbook，每个位于独立子目录

单独维护的 `learned.md` 不会被整合过程覆盖。

阶段 2 使用租约和心跳来防止多个进程同时启动时重复运行。先前运行遗留的过期 skill 目录会被自动清理。

整合输出在写入 `MEMORY.md`、`memory_summary.md` 或生成的 skills 之前，会针对常见秘密/令牌模式进行脱敏。

### 提取行为

记忆提取与整合行为由 `packages/coding-agent/src/prompts/memories/` 下的静态 prompt 文件驱动。

| 文件                      | 用途                                             | 变量                                        |
| ------------------------- | ------------------------------------------------ | ------------------------------------------- |
| `stage_one_system.md`     | 逐会话提取的系统 prompt                          | —                                           |
| `stage_one_input.md`      | 包装会话内容的 user-turn 模板                    | `{{thread_id}}`、`{{response_items_json}}`  |
| `consolidation_system.md` | 跨会话整合的系统 prompt                          | —                                           |
| `consolidation.md`        | 跨会话整合的 user-turn prompt                    | `{{raw_memories}}`、`{{rollout_summaries}}` |
| `read-path.md`            | 注入活动会话的记忆指引                           | `{{memory_summary}}`、`{{learned}}`         |

### 模型选择

记忆功能搭模型角色系统的便车。

| 阶段                    | 角色                                                                | 用途                             |
| ----------------------- | ------------------------------------------------------------------- | -------------------------------- |
| Phase 1（提取）         | `default`                                                           | 逐会话知识提取                   |
| Phase 2（整合）         | `smol`（回退到 `default`，然后是当前/注册表中的第一个模型）          | 跨会话综合                       |

如果请求的记忆角色未配置，记忆模型解析会回退到 `default` 角色，然后是活动会话模型，再是注册表中的第一个模型。

## 配置

| 设置                                  | 默认值  | 说明                                                                                                                                     |
| ------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.backend`                      | `off`   | 本流水线选择 `local`；未显式设置后端时，旧版 `memories.enabled: true` 会迁移为 `memory.backend: local`                                     |
| `memories.maxRolloutAgeDays`          | `30`    | 超过此年龄的会话不处理                                                                                                                    |
| `memories.minRolloutIdleHours`        | `12`    | 比此时间更近仍活跃的会话被跳过                                                                                                            |
| `memories.maxRolloutsPerStartup`      | `64`    | 单次启动处理的会话数量上限                                                                                                                |
| `memories.threadScanLimit`            | `300`   | 启动时扫描的最近会话记录数上限                                                                                                            |
| `memories.maxRawMemoriesForGlobal`    | `200`   | 提供给全局整合的逐会话提取数量上限                                                                                                        |
| `memories.stage1Concurrency`          | `8`     | 并发的逐会话提取任务数                                                                                                                    |
| `memories.stage1LeaseSeconds`         | `120`   | 提取任务租约时长                                                                                                                          |
| `memories.stage1RetryDelaySeconds`    | `120`   | 失败提取再次可认领前的延迟                                                                                                                |
| `memories.phase2LeaseSeconds`         | `180`   | 整合租约时长                                                                                                                              |
| `memories.phase2RetryDelaySeconds`    | `180`   | 整合失败重试前的延迟                                                                                                                      |
| `memories.phase2HeartbeatSeconds`     | `30`    | 整合租约心跳间隔                                                                                                                          |
| `memories.rolloutPayloadPercent`      | `0.7`   | 会话载荷可占所选模型上下文预算的比例                                                                                                      |
| `memories.phase1InputTokenLimit`      | `4000`  | 逐会话提取的输入上限                                                                                                                      |
| `memories.fallbackTokenLimit`         | `16000` | 模型未声明有限上下文窗口时使用的 token 预算                                                                                                |
| `memories.summaryInjectionTokenLimit` | `5000`  | 注入系统 prompt 的摘要与经验教训共享的近似 token 上限                                                                                      |

## Hindsight 远程后端

Hindsight 需要一个可访问的 [Hindsight](https://hindsight.vectorize.io/) 服务器。默认端点是 `http://localhost:8888`；当服务器需要认证时设置令牌：

```yaml
memory:
  backend: hindsight
hindsight:
  apiUrl: http://localhost:8888
  apiToken: ${HINDSIGHT_API_TOKEN}
```

`HINDSIGHT_*` 环境变量覆盖 `hindsight.*` 设置，后者又覆盖内置默认值。全部 18 个受支持的覆盖项、可接受的值、解析规则、优先级和默认值见[完整的 Hindsight 环境变量表](./environment-variables.md#hindsight-memory-backend)。

默认情况下，Hindsight 使用 `per-project-tagged` 作用域：写入进入一个带项目标签的共享 bank，召回则包含带项目标签和未打标签的全局记忆。`per-project` 将每个工作目录项目隔离在各自的 bank 中；`global` 使用一个共享 bank。显式的 `hindsight.bankId` 选择 bank 基础。bank ID、前缀或作用域的变更会重建主会话状态，使后续操作使用新作用域。

两种项目作用域模式以相同方式命名项目：取仓库的主检出根目录（因此同一仓库的每个链接 worktree 都解析为同一目录），然后将其 basename 小写。位于 `~/code/General` 的检出因此打标签为 `project:general`。标签按字面匹配，所以这个大小写折叠正是让一个仓库无论路径大小写如何都保持在同一记忆作用域的关键。

主会话在首个模型回合进行召回（`hindsight.autoRecall: true`），并默认每三个用户回合自动保留一次已完成的对话回合。`/memory enqueue` 刷新排队的工具保留并强制保留当前会话。在 agent 结束时，主状态会安排基于节奏的保留并清空保留队列；会话销毁在释放状态前排空该队列。请求失败和配置的超时会被记录，并保持编码会话可用。子代理为显式的 `recall`、`retain` 和 `reflect` 调用别名父级的 client、bank 和作用域，但不运行自己的自动召回或保留。

召回作为背景上下文注入，而非指令，且被召回的记忆在 compaction 期间也可作为额外上下文。选择 Hindsight 会暴露 `recall`、`retain` 和 `reflect`；`memory_edit` 不可用，因为上游 Hindsight 记忆不通过此后端编辑。

`/memory view`、`/memory stats`、`/memory diagnose` 和 `/memory enqueue` 通过活动的 Hindsight 状态操作。`/memory clear` 先清空待处理的保留，然后只清除本地会话状态和召回缓存。它**不会删除服务器端的 bank**；请用 Hindsight UI 或 API 删除该 bank。

## 关键文件

- `packages/coding-agent/src/memories/index.ts` — 流水线编排、注入、clear/enqueue 入口（`/memory` 命令经 `packages/coding-agent/src/memory-backend/local-backend.ts` 路由到此处）
- `packages/coding-agent/src/memories/storage.ts` — 基于 SQLite 的任务队列和会话注册表
- `packages/coding-agent/src/prompts/memories/` — 记忆 prompt 模板
- `packages/coding-agent/src/internal-urls/memory-protocol.ts` — `memory://` URL 处理器
