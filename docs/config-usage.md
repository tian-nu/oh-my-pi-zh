# 配置发现与解析

本文档描述 coding-agent 目前如何解析配置：扫描哪些根目录、优先级如何工作，以及解析后的配置如何被 settings、skills、hooks、tools 和 extensions 消费。

## 范围

主要实现：

- `packages/coding-agent/src/config.ts`
- `packages/coding-agent/src/config/config-file.ts`（从 `config.ts` 重新导出）
- `packages/coding-agent/src/config/settings.ts`
- `packages/coding-agent/src/config/settings-schema.ts`
- `packages/coding-agent/src/discovery/builtin.ts`
- `packages/coding-agent/src/discovery/helpers.ts`

关键集成点：

- `packages/coding-agent/src/capability/index.ts`
- `packages/coding-agent/src/discovery/index.ts`
- `packages/coding-agent/src/extensibility/skills.ts`
- `packages/coding-agent/src/extensibility/hooks/loader.ts`
- `packages/coding-agent/src/extensibility/custom-tools/loader.ts`
- `packages/coding-agent/src/extensibility/extensions/loader.ts`

---

## 解析流程（可视化）

```text
          Generic helper order (`config.ts`)
┌───────────────────────────────────────┐
│ 1) ~/.omp/agent, ~/.claude, ...       │
│ 2) <cwd>/.omp, <cwd>/.claude, ...     │
└───────────────────────────────────────┘
                    │
                    ▼
        capability providers enumerate items
 (native provider scans project .omp before user .omp;
  other providers have their own loading rules)
                    │
                    ▼
      provider priority sort + capability dedup
                    │
                    ▼
          subsystem-specific consumption
   (settings, skills, hooks, tools, extensions)
```

## 1) 配置根目录与来源顺序

## 规范根目录

`src/config.ts` 定义了固定的来源优先级列表：

1. `.omp`（原生）
2. `.claude`
3. `.codex`
4. `.gemini`

用户级基础目录：

- OMP 原生：`~/<PI_CONFIG_DIR>/agent`（通常是 `~/.omp/agent`；命名 profile 会改变此路径，见下文）
- `~/.claude`
- `~/.codex`
- `~/.gemini`

项目级基础目录：

- `<cwd>/.omp`
- `<cwd>/.claude`
- `<cwd>/.codex`
- `<cwd>/.gemini`

`CONFIG_DIR_NAME` 为 `.omp`（`packages/utils/src/dirs.ts`）。`PI_CONFIG_DIR` 改变通用 helper 使用的 OMP 用户根目录。`PI_CODING_AGENT_DIR` 则不同：对于默认 profile，它会改变 `getAgentDir()` 的消费者（如原生发现、settings 和运行时状态），但**不会**改变通用 `getConfigDirs()` / `findConfigFile()` 的 OMP 基础目录。命名 profile 会忽略 `PI_CODING_AGENT_DIR`。

## Profiles

命名 profile（`omp --profile <name>`、`OMP_PROFILE` 或旧版回退 `PI_PROFILE`）会重定位 OMP 用户基础目录。只要 `OMP_PROFILE` 有定义（包括显式为空时）它就优先；`default`、空值或纯空白会选择默认 profile。当某个 profile 处于活动状态时，本文中写作 `~/.omp/agent/...` 的每个 OMP 原生用户级路径通常都解析为 `~/.omp/profiles/<name>/agent/...`。`--alias <command>` 本身不会选择 profile：与 `--profile` 搭配时，它为该 profile 创建一个 shell 快捷方式。

这种重定位在原生 provider（`builtin.ts`）与通用 `config.ts` helper 之间是一致的，因此覆盖 slash commands、rules、prompts、instructions、hooks、tools、extensions、settings、skills 和 MCP，以及顶层的 `SYSTEM.md` / `RULES.md` / `AGENTS.md` 文件和运行时状态（sessions、blobs、`agent.db`）。一个 profile 只能看到自己的 OMP 配置，永远不会看到默认 profile 的 agent 配置。

Keybindings 是唯一的例外：命名 profile 会将默认 profile 的 `~/.omp/agent/keybindings.*` 合并到自己的 `~/.omp/profiles/<name>/agent/keybindings.*` 之下，profile 文件按单个绑定覆盖默认文件（[#4867](https://github.com/can1357/oh-my-pi/issues/4867)）。Keybindings 描述的是用户面前的终端/键盘，不会随活动 profile 改变，因此用户级重映射在每个 profile 中都继续生效，除非 profile 显式覆盖。继承的文件对 profile 进程是只读的——默认 profile 文件的旧格式迁移只在默认 profile 自身运行时发生。

在 macOS 和 Linux 上，已存在的 `$XDG_DATA_HOME/omp`、`$XDG_STATE_HOME/omp` 或 `$XDG_CACHE_HOME/omp` 可以重定位对应的 data、state 或 cache 路径。对于命名 profile，OMP 只在某个 XDG 类别下已存在 `omp/profiles/<name>` 时才使用该类别；否则该类别仍位于 `~/.omp/profiles/<name>` 之下。在依赖 XDG 路径之前请先运行 `omp config init-xdg`。

其他来源基础目录不按 profile 划分作用域，在所有 profile 下加载方式相同：外部工具基础目录（`~/.claude`、`~/.codex`、`~/.gemini`）属于那些工具，项目级基础目录（`<cwd>/.omp`、`<cwd>/.claude` 等）则与工作目录绑定。在本文档中，除非明确讨论环境变量覆盖或 XDG 路径，请将 `~/.omp/agent` 理解为活动 profile 的 agent 目录的简写。

## 重要约束

`src/config.ts` 中的通用 helper **不会**将 `.pi` 纳入来源发现顺序。

---

## 2) 核心发现 helper（`src/config.ts`）

## `getConfigDirs(subpath, options)`

返回有序条目：

- 用户级条目在前（按来源优先级）
- 然后是项目级条目（按同样的来源优先级）

选项：

- `user`（默认 `true`）
- `project`（默认 `true`）
- `cwd`（默认 `getProjectDir()`）
- `existingOnly`（默认 `false`）

此 API 用于基于目录的配置查找（commands、hooks、tools、agents 等）。

## `findConfigFile(subpath, options)` / `findConfigFileWithMeta(...)`

跨有序基础目录搜索第一个存在的文件，返回第一个匹配（仅路径或路径+元数据）。

## `findAllNearestProjectConfigDirs(subpath, cwd)`

向上遍历父目录，返回**每个来源基础目录最近的已存在目录**（`.omp`、`.claude`、`.codex`、`.gemini`），然后按来源优先级排序结果。

当项目配置应从祖先目录继承时（monorepo/嵌套 workspace 行为）使用此函数。

---

## 3) 文件配置包装器（`src/config/config-file.ts` 中的 `ConfigFile<T>`，从 `src/config.ts` 重新导出）

`ConfigFile<T>` 是单个配置文件的 schema 校验加载器。

支持的格式：

- `.yml` / `.yaml`
- `.json` / `.jsonc`

行为：

- 用提供的 omptype schema 校验解析后的数据。
- 缓存加载结果，直到调用 `invalidate()`。
- 通过 `tryLoad()` 返回三态结果：
  - `ok`
  - `not-found`
  - `error`（带 schema/解析上下文的 `ConfigError`）

仍支持旧版迁移：

- 如果目标路径是 `.yml`/`.yaml`，同级的 `.json` 会被自动迁移一次（`migrateJsonToYml`）。

---

## 4) Settings 解析模型（`src/config/settings.ts`）

运行时 settings 模型是分层的：

1. 全局 settings：`~/.omp/agent/config.yml` 与 `config.yaml` 中第一个存在的文件
2. 项目 settings：通过 settings capability 发现（来自各 provider 的 `settings.json` 和 `config.yml`）
3. 配置 overlay：`PI_CONFIG_FILES`（平台路径列表），随后是重复的 `omp --config <path>` 文件；全部按 `config.yml` 风格的 YAML 加载，仅对本进程生效
4. 运行时覆盖：内存中，不持久化
5. Schema 默认值：来自 `SETTINGS_SCHEMA`

生效优先级：

`defaults <- global <- project <- PI_CONFIG_FILES overlays <- --config overlays <- runtime overrides`

在任一 overlay 列表内，后面的文件覆盖前面的文件。overlay 路径相对于活动项目目录解析（在 `~` 展开之后）。

写入行为：

- `settings.set(...)` 写入**全局**层（启动时选定的全局 YAML 文件）并排队后台保存。
- 项目 settings 与配置 overlay 从 settings API 角度是只读的。

### Settings 加载失败

- 缺失的全局/项目 YAML 视为空配置。
- 无效的全局或原生项目 YAML 会在文件锁下被移动到唯一的 `.broken-<timestamp>-<pid>-<uuid>` 同级文件，然后启动失败并给出原路径和备份路径。不可读的文件不会移动而是直接失败。
- 每个 `PI_CONFIG_FILES` / `--config` overlay 都是严格模式：文件缺失、无效 YAML 和非映射文档根都是硬错误。overlay 文件不会被隔离。

## 仍然生效的迁移行为

启动时，如果全局 `config.yml` 和 `config.yaml` 都不存在：

1. 从 `~/.omp/agent/settings.json` 迁移（成功后重命名为 `.bak`）
2. 与 `agent.db` 中的旧版 DB settings 合并（冲突时 DB 值胜出）
3. 将合并结果写入 `config.yml`

`#migrateRawSettings` 中的字段级迁移：

- `queueMode` -> `steeringMode`
- `ask.timeout` 毫秒 -> 秒（当旧值看起来像毫秒时，`> 1000`）
- 旧版扁平 `theme: "..."` -> `theme.dark/theme.light` 结构

---

## 5) Capability/发现集成

大多数非核心配置加载都经过 capability registry（`src/capability/index.ts` + `src/discovery/index.ts`）。

## Provider 排序

Provider 按数值优先级排序（高者在前）。完整集合：

- 原生 OMP（`builtin.ts`）：`100`
- OMP 插件（`omp-plugins`）：`90`
- Claude：`80`
- Agent Plugins 标准（`agent-plugins`）：`75`
- Codex / agents / Claude plugins marketplace：`70`
- Gemini：`60`
- OpenCode：`55`
- Cursor / Windsurf：`50`
- Cline：`40`
- GitHub Copilot：`30`
- VS Code：`20`
- agents-md（`AGENTS.md` 文件）：`10`
- mcp-json / ssh-json：`5`
- 内置默认规则（`builtin-defaults`）：`1`

```text
Provider precedence (higher wins)

native (.omp)           priority 100
omp-plugins             priority  90
claude                  priority  80
agent-plugins           priority  75
codex / agents /
  claude-plugins        priority  70
gemini                  priority  60
opencode                priority  55
cursor / windsurf       priority  50
cline                   priority  40
github                  priority  30
vscode                  priority  20
agents-md               priority  10
mcp-json / ssh-json     priority   5
builtin-defaults        priority   1
```

## 去重语义

各 capability 定义了 `key(item)`：

- 相同 key => 第一个条目胜出（优先级更高/更早加载的条目）
- 无 key（`undefined`）=> 不去重，保留全部条目

相关 key：

- skills：`name`
- tools：`name`
- hooks：`${type}:${tool}:${name}`
- extension modules：`name`
- extensions：`name`
- settings：不去重（保留全部条目）

---

## 6) 原生 `.omp` provider 行为（`packages/coding-agent/src/discovery/builtin.ts`）

原生 provider（`id: native`）从以下位置读取原生配置：

- 项目：`<cwd>/.omp/...`
- 用户：`~/.omp/agent/...`

### 目录准入规则

- Slash commands、目录 rules、prompts、instructions、hooks、tools、extensions、extension modules 和 settings 只有在项目/用户根目录存在且非空时才使用该根目录。
- Skills 会扫描从当前工作目录到仓库根目录/home 边界的每个祖先的 `<ancestor>/.omp/skills`，外加 `~/.omp/agent/skills`，不要求根 `.omp` 目录本身非空。
- `SYSTEM.md`、`RULES.md` 和 `.omp/AGENTS.md` 直接读取用户级文件，项目文件则使用最近的非空祖先 `.omp` 目录。`RULES.md` 成为始终应用的 sticky rule。完整 `SYSTEM.md` / `APPEND_SYSTEM.md` 契约见 [`docs/system-prompt-customization.md`](./system-prompt-customization.md)。
- MCP 不使用非空根准入 helper。它直接读取项目 `.omp/mcp.json` 然后 `.omp/.mcp.json`，随后是用户 `mcp.json` 然后 `.mcp.json`。

### 按作用域加载

- Skills：`<ancestor>/.omp/skills/*/SKILL.md` 和 `~/.omp/agent/skills/*/SKILL.md`
- Slash commands：`commands/*.md`
- Rules：`rules/*.{md,mdc}` 加顶层 `RULES.md`
- Prompts：`prompts/*.md`
- Instructions：`instructions/*.md`
- Hooks：`hooks/pre/*`、`hooks/post/*`
- Tools：`tools/*.{json,md,ts,js,sh,bash,py}` 和 `tools/<name>/index.ts`
- Extension modules：在 `extensions/` 下发现（+ 旧版 `settings.json.extensions` 字符串数组）
- Extensions：`extensions/<name>/gemini-extension.json`
- Settings capability：先 `settings.json`，再 `config.yml`
- 上下文文件：`.omp/AGENTS.md`；独立的祖先 `AGENTS.md` 文件由低优先级的 `agents-md` provider 单独加载

### 最近项目查找的细微差别

对于 `SYSTEM.md`、`RULES.md` 和 `.omp/AGENTS.md`，原生 provider 会向上查找到最近的非空项目 `.omp` 目录。

## 7) 各主要子系统如何消费配置

## Settings 子系统

- `Settings.init()` 按上述优先级加载全局 YAML 文件、发现的项目 settings、`PI_CONFIG_FILES` / `--config` overlay 和运行时覆盖。
- 只有 `level === "project"` 的 capability 条目会合并进项目层。

### 会话标题 prompt 覆盖

在任意通用配置基础目录中创建 `TITLE_SYSTEM.md`：

```text
# ~/.omp/agent/TITLE_SYSTEM.md
Generate a session name using lowercase `<type>:<primary-objective>`.
```

- 缺失 `TITLE_SYSTEM.md` 时保留内置标题 prompt。
- 发现逻辑先检查当前项目目录基础（`<cwd>/.omp`、`.claude`、`.codex`、`.gemini`），再按通用 helper 顺序检查用户基础。与原生 `SYSTEM.md` 不同，项目标题发现**不会**向上遍历祖先目录。
- 该覆盖只替换自动会话标题生成的 system prompt；正常的 `SYSTEM.md` / `APPEND_SYSTEM.md` prompt 定制不受影响。
- 在线路径要求标题模型将标题包在 `<title>...</title>` 中并从文本中宽松解析（纯句子、截断/未闭合标签、或散落的 `{"title": "..."}` JSON 回显都仍然可用）。`TITLE_SYSTEM.md` 覆盖会在其后追加包入 `<title>` 的指令。本地 tiny-title 路径保留 `<title>...</title>` 的 prefill/stop 包装，并将此文件用作其 system turn。

## Skills 子系统

- `extensibility/skills.ts` 通过 `loadCapability(skillCapability.id, { cwd })` 加载。
- 应用来源开关与过滤器（`ignoredSkills`、`includeSkills`、自定义目录）。
- 旧版命名的开关仍然存在（`skills.enablePiUser`、`skills.enablePiProject`），但它们控制的是原生 provider（`provider === "native"`）。

## Hooks 子系统

- `discoverAndLoadHooks()` 从 hook capability + 显式配置路径解析 hook 路径。
- 然后通过 Bun import 加载模块。

## Tools 子系统

- `discoverAndLoadCustomTools()` 从 tool capability + 插件工具路径 + 显式配置路径解析工具路径。
- 声明式 `.md/.json` 工具文件只是元数据；可执行加载需要代码模块。

## Extensions 子系统

- `discoverAndLoadExtensions()` 加载原生 extension-module capability 条目、JS/TS hook 工厂、已安装插件入口点以及显式配置路径。
- 环境 extension-module capability 发现被显式限制为 `provider: "native"`；此步骤不扫描外部 provider。

---

## 8) 可依赖的优先级规则

使用这个心智模型：

1. `config.ts` 的来源目录排序决定候选路径顺序。
2. Capability provider 优先级决定跨 provider 的先后。
3. Capability key 去重决定冲突行为（有 key 的 capability 先到先得）。
4. 子系统特定的合并逻辑可能进一步改变生效优先级（尤其是 settings）。

### Settings 专属注意事项

Settings capability 条目不去重；`Settings.#loadProjectSettings()` 按返回顺序深度合并项目条目，后面的条目覆盖前面的。Provider 按优先级从高到低访问，这意味着低优先级 provider 的 settings 可以覆盖高优先级的 settings。在原生 provider 内部，项目 `config.yml` 跟在 `settings.json` 之后并覆盖它。然后原生 `.omp/config.yml` 的模型角色会被重新应用为权威的项目模型角色层。

---

## 9) 仍然存在的旧版/兼容行为

- 针对以 YAML 为目标的文件的 `ConfigFile` JSON -> YAML 迁移。
- Settings 从 `settings.json` 和 `agent.db` 到 `config.yml` 的迁移。
- 字段级迁移涵盖重命名/移除的设置和值形态变化，包括 `queueMode`、changelog settings、`ask.timeout`、扁平 `theme`、已退役的 image-tool 设置、任务 isolation/eager 设置、已移除的 edit 与 compaction 模式、`inlineToolDescriptors`、状态栏 segment、provider/搜索设置、memories/hindsight 设置以及嵌套叶子重命名。完整最新列表见 `Settings.#migrateRawSettings()`。
- 旧版设置名 `skills.enablePiUser` / `skills.enablePiProject` 仍是原生 skill 来源的有效开关。

如果这些兼容路径在代码中被移除，请立即更新本文档；当前仍有若干运行时行为依赖它们。
