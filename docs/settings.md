# 设置

`omp` 从内置默认值、持久化的全局配置文件、可选的项目本地配置、一次性 CLI overlay 以及内存中的运行时覆盖来解析设置。当一个仓库需要与全局默认值不同的 provider 集合、模型角色、工具策略、记忆后端或 UI 行为时，请使用项目设置——而无需改动机器级配置。

设置以纯 YAML 映射存储。每个键、它的类型、默认值与 enum 值都来自设置 schema。`omp config` 暴露完整的 schema；交互式 `/settings` 面板则暴露带 UI 元数据的 schema 条目。

- 模型/provider 凭据、`.env` 文件与解析 API 密钥的环境变量表见 [Providers](./providers.md)。
- `models.yml` 中的自定义模型定义见 [Models](./models.md)。
- 被发现进入 agent context 的指令文件（`AGENTS.md`、`.omp/` 等）见 [Context files](./context-files.md)。
- 完整的环境变量目录见 [Environment variables](./environment-variables.md)。
- 激活专用逐轮行为的 prompt 词见 [Magic keywords](./magic-keywords.md)。

## 设置存放位置

| 作用域             | 路径                                                  | 读取行为                                                                                                                            | 写入行为                                                                                                                                                                   |
| ----------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 全局            | `~/.omp/agent/config.yml`（或已有的 `config.yaml`） | 主要的持久化设置文件。`config.yml` 是规范的写入目标；已有的 `config.yaml` 会被就地加载并更新。 | `/settings`、`omp config set` 与 `omp config reset` 都写在这里。                                                                                                                |
| 全局（旧版）     | `~/.omp/agent/settings.json`                          | 仅当两个主 YAML 文件名都不存在时迁移进 `config.yml`（只迁移一次）。                                                            | 迁移后不再写入；原文件被重命名为 `settings.json.bak`。                                                                                                     |
| 项目           | `<cwd>/.omp/config.yml`（另加 `.omp/settings.json`）   | 当进程工作目录含有非空 `.omp/` 时加载。                                                                       | 设置命令不写任意项目键。当 `modelRoleStorage: project` 时，模型选择器的角色赋值只会更新这里的 `modelRoles`；其余键请手动编辑。 |
| 项目（旧版）    | `<cwd>/.omp/settings.json`                            | 仍然会被读取；项目 `config.yml` 会合并在其之上。                                                                                 | 设置命令不会写入。                                                                                                                                                |
| CLI overlay       | 通过 `--config <file>` 传入的任意文件                | 在全局与项目设置之后加载，仅对那一个进程生效。可重复。                                                              | 从不持久化。                                                                                                                                                                 |
| 运行时覆盖 | 仅存于内存                                        | 由专用 CLI 标志（`--model`、`--approval-mode` 等）与功能环境变量设置。                                                       | 从不持久化。                                                                                                                                                                 |

`PI_CODING_AGENT_DIR` 会重新定位 `~/.omp/agent` 基础目录。一旦设置，全局 `config.yml`、认证存储（`agent.db`）以及 agent 目录下的其他一切都会随之迁移。用 `omp config path` 打印当前活动的 agent 目录。

原生项目设置有意限定于进程工作目录的 `.omp/` 文件夹——设置发现**不会**向上遍历祖先目录寻找最近的 `.omp/`。其他发现 provider（Claude、Codex、Gemini、Cursor、OpenCode）也可以从其自身文件提供项目级设置；这些设置对 `omp` 设置命令是只读的，可按 provider id 关闭（见 [Provider and source disabling](#provider-and-source-disabling)）。

## 配置文件格式

规范的全局文件是位于 `config.yml` 的 YAML；`config.yaml` 作为兼容文件名被接受。用于其他文件（例如 `models.yml`）的通用配置加载器接受 `.yml`、`.yaml`、`.json` 与 `.jsonc`：

- 当请求 `.yml`/`.yaml` 路径而只存在同级的 `.json` 时，会自动迁移为 YAML（幂等，每进程一次）。
- `.json` 与 `.jsonc` 配置按原样读取，不做迁移。
- 顶层不是映射的设置 YAML 文件无效。在可写启动时，`omp` 会把无效的持久化设置文件移动到唯一命名的 `.broken-*` 备份，并以原始错误与备份路径退出。含裸数组/标量的 `--config` overlay 同样是硬错误，但不会被移动。

## 读取与写入设置

在会话内使用交互式 `/settings` 面板，或在 shell 中使用 `omp config` 命令。两者读取的都是合并后的有效设置。常规的持久化写入落在 **全局** 文件中；当 `modelRoleStorage: project` 时，模型选择器的角色变更除外（见 [Where writes go](#where-writes-go)）。

```bash
omp config list                 # all settings with current effective values
omp config list --json          # same, machine-readable
omp config get theme.dark       # one value
omp config get theme.dark --json
omp config set compaction.enabled false
omp config set defaultThinkingLevel medium
omp config reset steeringMode   # restore a key to its schema default
omp config path                 # print the active agent directory
```

希望正常启动时看到完整首次运行动画的用户，请设置 `startup.showSplash`：

```bash
omp config set startup.showSplash true
```

这只控制启动时的 splash 动画。它不会重新运行设置流程或改变设置状态，且 `startup.quiet: true` 仍会抑制包括 splash 在内的所有启动 chrome。

### 子命令

| 命令                        | 作用                                                                                                                                                                                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `omp config list`              | 按 tab 分组打印每个设置及其当前值与类型。`--json` 输出一个以设置路径为键的对象，包含 `{ value, type, description }`。配置的凭据字段在人类可读输出中被掩码为 `********`；在 JSON 中其 `value` 被省略并输出 `redacted: true`。 |
| `omp config get <key>`         | 打印单个键的有效值。未知键以非零退出。`--json` 输出 `{ key, value, type, description }`。这是显式的单键请求，因此凭据值不会被掩码。                                                                                         |
| `omp config set <key> <value>` | 按该键的 schema 类型解析 `<value>` 并写入全局主 YAML 文件。                                                                                                                                                                                                          |
| `omp config reset <key>`       | 把该键的 schema **默认值**写回全局 config（这会持久化默认值，而不是删除该键）。                                                                                                                                                                             |
| `omp config path`              | 打印当前活动的 agent 目录（遵循 `PI_CODING_AGENT_DIR`）。                                                                                                                                                                                                                                  |
| `omp config init-xdg`          | 在 Linux 与 macOS 上，在有效的 XDG data、state 与 cache 主目录下创建 `omp` 目录。它不会移动已有文件，也不会设置 XDG 环境变量。其他平台以非零退出。                                                                                       |

`omp config` 不带子命令、`--help` 或 `-h` 时列出设置。`--json` 标志可被 `list`、`get`、`set` 与 `reset` 接受。

### 值解析

`omp config set` 根据目标键的 schema 类型解析值字符串。字符串会先被修剪。

| 类型    | 可接受输入                                      | 说明                                                             |
| ------- | --------------------------------------------------- | ----------------------------------------------------------------- |
| boolean | `true`, `false`, `yes`, `no`, `on`, `off`, `1`, `0` | 不区分大小写。其他任何值都会被拒绝。                      |
| number  | 任意有限 JavaScript 数字                        | `Infinity`/`NaN` 会被拒绝。                                    |
| enum    | 该键允许的值之一                     | 必须完全匹配；错误会列出有效值。             |
| array   | 一个 JSON 数组                                        | 例如 `'["anthropic","openai"]'`。必须能解析且为数组。      |
| record  | 一个 JSON 对象                                       | 例如 `'{"bash":"prompt"}'`。必须能解析且为非数组对象。 |
| string  | 按给定值存储（已修剪）                           | 多词值以空格连接。                         |

键必须与真实的 schema 路径完全匹配。没有简写——设置 `theme.dark`，而不是 `theme`。

### 写入位置

`omp config set`、`omp config reset`、`/settings` 与常规的运行时设置变更都会写入活动 agent 目录下的全局主 YAML 文件。它们不会向 `<cwd>/.omp/config.yml` 写入任意键。唯一受支持的项目写入路径是当 `modelRoleStorage` 为 `project` 时的模型选择器角色赋值；它只更新 `<cwd>/.omp/config.yml` 下的该角色，缺失的项目角色会继续回退到全局角色。要创建其他任何项目本地覆盖，请直接编辑项目文件（见 [Project-local config](#project-local-config)）。保存经过防抖并在锁下重新读取文件，因此会话打开期间做出的外部编辑会被保留。

## 优先级

按从低到高的优先级，设置的有效值按如下方式构建：

```text
built-in defaults  <-  global config  <-  project config  <-  CLI overlays  <-  runtime overrides
```

按从高到低：

1. **运行时覆盖** — 应用于当前进程内存中的专用 CLI 标志与功能环境变量：`--model`、`--smol`、`--slow`、`--plan`、`--approval-mode`、`--auto-approve`/`--yolo`、`--hide-thinking`、`--advisor`、`--no-pty`、`--api-key` 以及 protocol-mode 默认值。从不持久化。
2. **CLI config overlay** — 每个 `--config <file>`；后加载的 overlay 文件覆盖先加载的。
3. **项目设置** — `<cwd>/.omp/settings.json`，然后是 `<cwd>/.omp/config.yml`（以及其他发现 provider 在项目级的贡献）。
4. **全局设置** — `~/.omp/agent/config.yml`。
5. **内置默认值** — 来自设置 schema。

在每一层都未设置的键，在读取时解析为其 schema 默认值。

### 环境变量覆盖

环境变量**不是**单一的设置层。每个环境变量由拥有该值的功能读取，通常作为单机覆盖或回退，且永远不会写回 `config.yml`。直接映射到某个设置的环境变量如下：

| 环境变量                 | 覆盖的设置           | 说明                                                                                             |
| ----------------------- | --------------------------- | ------------------------------------------------------------------------------------------------- |
| `PI_SMOL_MODEL`         | `modelRoles.smol`           | 也可作为 `--smol` 暴露。                                                                         |
| `PI_SLOW_MODEL`         | `modelRoles.slow`           | 也可作为 `--slow` 暴露。                                                                         |
| `PI_PLAN_MODEL`         | `modelRoles.plan`           | 也可作为 `--plan` 暴露。                                                                         |
| `PI_NO_PTY=1`           | （禁用 PTY bash）         | 等价于进程级 `--no-pty`。                                                         |
| `PI_PY`                 | `eval.py`                   | `PI_PY=0` 禁用 Python eval 后端。                                                       |
| `PI_JS`                 | `eval.js`                   | `PI_JS=0` 禁用 JavaScript eval 后端。                                                   |
| `PI_TINY_DEVICE`        | `providers.tinyModelDevice` | 本地 tiny 模型的 ONNX 执行 provider 或 `mlx` 后端。                                   |
| `PI_TINY_DTYPE`         | `providers.tinyModelDtype`  | 本地 tiny 模型的 ONNX 精度。                                                             |
| `OMP_AUTH_BROKER_URL`   | `auth.broker.url`           | 环境变量值优先于 config。                                                           |
| `OMP_AUTH_BROKER_TOKEN` | `auth.broker.token`         | 环境变量值优先于 config。                                                           |
| `PI_CODING_AGENT_DIR`   | （重定位 agent 目录）       | 移动 `config.yml`、`agent.db` 与整个 agent 基础目录。                                         |
| `PI_CONFIG_FILES`       | CLI config overlay         | 平台路径列表（Unix 用 `:`，Windows 用 `;`）；文件在 `--config` overlay 之前按顺序加载。 |

Provider API 密钥单独解析（存储的认证、OAuth、`models.yml`、环境与 `.env` 文件）；见 [Providers](./providers.md) 与完整的 [Environment variables](./environment-variables.md) 参考。

## 合并规则

各层通过深合并（deep merge）组合：

- **对象深合并** — 只存在于较低层的键会被保留；较高层存在的键会覆盖。
- **标量与数组整体替换** — 由较高优先级的层整体替换。较高层的数组不会追加到较低层的数组。

点号形式的设置路径请使用嵌套 YAML 映射：

```yaml
theme:
  dark: titanium
  light: light

tools:
  approvalMode: write
  approval:
    bash: prompt
    read: allow
```

### Bash 命令批准模式

`tools.approval` 是以工具名称为键的 record；`tools.approval.eval` 与 `tools.approval.computer` 等点号形式标识的是该 record 中的条目，而不是独立的 settings-schema 路径。每个条目设置该工具的默认策略。对于 bash，你可以用 `bash.patterns` 添加有序的命令规则；第一条匹配的规则生效。模式支持字面文本，外加作为通配符的 `*`。

```yaml
tools:
  approvalMode: write
  approval:
    bash: allow

bash:
  patterns:
    - match: "git *"
      approval: allow
    - match: "rm -rf *"
      approval: deny
    - match: "*"
      approval: allow
```

有效的规则批准值为 `allow`、`prompt` 与 `deny`。关键 bash 命令仍然需要确认，除非某条匹配规则显式拒绝它们；诸如 `match: "*"` 的宽泛 allow 规则不会绕过关键命令保护。

匹配是不对称的，因此规则的含义正如其字面所示：`deny` 与 `prompt` 规则在 glob 匹配整条命令**或复合行的任意单个段**（按 `&&`、`||`、`;`、`|`、单个 `&`、子 shell 与换行拆分）时触发，所以 `match: "rm -rf *"` 仍会拒绝 `cd /tmp && rm -rf build` 与 `sleep 1 & rm -rf build`。`allow` 规则必须匹配**整条**命令，并且绝不适用于复合行，因此像 `match: "git *"` 这样狭窄的 allow 无法为 `git status && rm -rf /` 背书。

`bash.patterns` 只约束 `bash` 工具。它不覆盖通过 `eval` 启动的 shell——eval 可通过子进程派生 shell——因此此处的 `deny` 规则会在同一命令经由 `eval` 运行时被绕过。要堵住这一路径，请同时添加 `tools.approval.eval` 策略（`prompt` 或 `deny`）；见 [Tool approval mode](./approval-mode.md)。

### Bash 拦截器模式

`bashInterceptor` 独立于 `bash.patterns`：它把 Bash 命令重定向到专用工具，而不是定义某条命令是否可以执行。请显式启用它，并用替换工具与面向模型的消息配置正则表达式模式：

```yaml
bashInterceptor:
  enabled: true
  patterns:
    - pattern: '^\s*(cat|head|tail)\s+'
      tool: read
      message: "Use the read tool instead."
```

被命名的替换工具必须在当前会话中可用，否则拦截器不会阻止 Bash 调用。关于权限策略与专用工具路由（包括复合命令行为与排序）的详细对比，见 [the Bash tool documentation](tools/bash.md#command-policy-and-dedicated-tool-routing)。

### 实例：全局 vs. 项目

```yaml
# ~/.omp/agent/config.yml
tools:
  approvalMode: write
  approval:
    bash: prompt
    read: allow
disabledProviders:
  - anthropic
  - openai
  - google

# <repo>/.omp/config.yml
tools:
  approval:
    bash: allow
disabledProviders:
  - groq
```

`<repo>` 内的有效设置：

```yaml
tools:
  approvalMode: write # kept from global (object deep-merge)
  approval:
    bash: allow # overridden by project
    read: allow # kept from global
disabledProviders:
  - groq # project array REPLACES the global array
```

数组替换是最常见的意外：项目的 `disabledProviders` 不会扩展全局列表——它成为该项目下的完整列表。`enabledModels`、`cycleOrder`、`extensions` 以及所有其他数组类型设置同理。

## 项目本地配置

当仓库需要自己的设置时，创建 `<repo>/.omp/config.yml`：

```yaml
# <repo>/.omp/config.yml
modelRoles:
  default: anthropic/claude-sonnet-4-5
  smol: openai/gpt-4.1-mini
  slow: anthropic/claude-opus-4-5:high

tools:
  approvalMode: write
  approval:
    bash: prompt

compaction:
  methodOrder: [snapcompact, remote, soft]
  thresholdPercent: 80

theme:
  dark: titanium
```

除非仓库策略允许，否则不要把密钥放进已提交的项目配置。凭据请优先使用环境变量、存储的认证、认证 broker（auth broker）或不被跟踪的 `--config` overlay。

### 一次性 overlay

使用 `--config` 创建不应持久化的临时层：

```bash
omp --config ./local/ci-settings.yml "check this failure"
omp --config ./base.yml --config ./experiment.yml "try this model"
```

`--config` 被默认启动命令、`acp` 与 `models` 接受。

wrapper 也可以把 `PI_CONFIG_FILES` 设置为平台分隔的路径列表（Unix 用 `:`，Windows 用 `;`）。环境 overlay 按所列顺序在显式 `--config` overlay 之前加载。

overlay 路径相对于进程工作目录解析（`~` 会被展开）。每个 overlay 必须能解析为 YAML 映射；缺失的文件、无效的 YAML 或顶层数组/标量都是硬错误——它**不会**静默回退到较低优先级的设置。

## 路径作用域数组

三个数组设置——`enabledModels`、`enabledProviders` 与 `disabledProviders`——除了裸字符串外还接受路径作用域的条目，因此一份全局 config 可以按目录表现不同：

```yaml
enabledModels:
  - claude-sonnet-4-5 # applies everywhere
  - path: ~/work/high-context
    models:
      - anthropic/claude-opus-4-5

disabledProviders:
  - ollama # applies everywhere
  - paths:
      - ~/projects/sensitive
      - ~/clients/acme
    providers:
      - anthropic
      - openai
```

裸字符串条目适用于任何地方。当当前工作目录**就是**所配置的路径或在它**之下**时，作用域条目生效。`~` 展开为主目录，相对路径在匹配前解析。

可接受的 **path** 键（可任意组合）：`path`、`paths`、`pathPrefix`、`pathPrefixes`。

可接受的 **value** 键：

- `models`（用于 `enabledModels`）或 `providers`（用于 `enabledProviders` 与 `disabledProviders`）
- `values` 或 `items`（用于任何设置）

只保留字符串值；格式错误的作用域条目会被忽略。路径作用域在层合并**之后**解析，因此它读取的是最终的有效数组。

## Provider 与来源禁用

`enabledProviders` 把外部的用户级配置来源纳入发现。其默认值为空，因此来自 Cursor、Codex、Claude、Claude marketplace 插件、Gemini、OpenCode、Windsurf 与 GitHub 的用户根在它们的 provider id 被列出（或列出 `*`/`all`）之前不会加载。项目根保持启用。原生 OMP 根——包括注册在 `~/.omp/plugins` 下的 marketplace 插件——不是外部的，不需要条目。

`disabledProviders` 是一个共享的 id 命名空间，在任何凭据检查之前门控两个不同的子系统：

| 条目类型        | 示例 id                                                                        | 作用                                                                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model providers   | `anthropic`, `openai`, `google`, `groq`, `ollama`, `openrouter`                    | 把这些后端从模型选择中移除，即使凭据可用。见 [Providers](./providers.md)。                                             |
| Discovery sources | `native`, `claude`, `codex`, `gemini`, `github`, `opencode`, `cursor`, `agents-md` | 阻止该来源贡献 context 文件、MCP server、命令、技能、hook、工具、prompt 或设置。见 [Context files](./context-files.md)。 |

大多数 provider 控制用例列出的是模型 provider id。禁用 `claude` 发现来源与禁用 `anthropic` 模型 provider 是不同的——前者停止 Claude 格式配置的发现，后者停止 Anthropic 模型后端。

由于数组是替换而非追加，设置 `disabledProviders` 的项目必须列出完整的期望集合：

```yaml
# ~/.omp/agent/config.yml
disabledProviders:
  - anthropic
  - openai

# <repo>/.omp/config.yml — inside this repo ONLY groq is disabled
disabledProviders:
  - groq
```

默认值是空数组（不禁用任何东西）。两个子系统的 provider id 与排序见 [Providers](./providers.md) 与 [Context files](./context-files.md)。

## 设置目录

下面的目录突出常用设置；它不是完整的 schema。`omp config list` 是每个键、当前值、类型与描述的权威参考。此处显示的默认值与 enum 值来自 schema。接受 env 或标志覆盖的设置会被注明；这些覆盖仅作用于进程，不会被持久化。

### 模型

`modelRoles`、`modelTags` 与 `cycleOrder` 共同定义你可以在其间切换的模型。角色值可以携带 thinking 后缀（`:minimal`、`:low`、`:medium`、`:high`、`:xhigh`、`:max`）。

```yaml
modelRoles:
  default: anthropic/claude-sonnet-4-5
  smol: openai/gpt-4.1-mini
  slow: anthropic/claude-opus-4-5:high
  vision: google/gemini-3.1-pro-preview
  plan: anthropic/claude-opus-4-5
  advisor: anthropic/claude-sonnet-4-5:medium

cycleOrder:
  - smol
  - default
  - slow

modelProviderOrder:
  - anthropic
  - openai

enabledModels:
  - claude-sonnet-4-5
```

| 键                    | 类型    | 默认值                     | 说明                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modelRoles`           | record  | `{}`                        | 角色名 -> 模型 id 的映射。内置角色：`default`、`smol`、`slow`、`vision`、`plan`、`commit`、`tiny`、`task`、`advisor`。`tiny` 角色为轻量级后台任务（标题、记忆、auto-thinking、意外停止）覆盖在线模型，否则为 `@smol`。逐角色的 env/标志只存在于 `--model`/`--smol`/`--slow`/`--plan`；advisor 用 `modelRoles.advisor` 配置。 |
| `modelRoleStorage`     | enum    | `global`                    | `global` 在活动的全局/profile config 中保存模型选择器的角色赋值；`project` 只把这些角色赋值保存到 `<cwd>/.omp/config.yml`。缺失的项目角色会回退到全局角色。                                                                                                                                                                                                     |
| `modelTags`            | record  | `{}`                        | 自定义角色/标签元数据；可以引入额外的角色。                                                                                                                                                                                                                                                                                                                                                        |
| `modelProviderOrder`   | array   | `[]`                        | 模型 id 有歧义时首选的 provider 顺序。                                                                                                                                                                                                                                                                                                                                                           |
| `cycleOrder`           | array   | `["smol","default","slow"]` | 模型切换器循环切换的角色。                                                                                                                                                                                                                                                                                                                                                                              |
| `enabledModels`        | array   | `[]`                        | 模型的允许列表；支持 [path-scoped entries](#path-scoped-arrays)。空表示所有可用模型。                                                                                                                                                                                                                                                                                                     |
| `enabledProviders`     | array   | `[]`                        | 要加载的外部用户级发现来源；支持路径作用域条目。见 [above](#provider-and-source-disabling)。                                                                                                                                                                                                                                                                                          |
| `disabledProviders`    | array   | `[]`                        | 被禁用的模型/发现 provider；支持路径作用域条目。见 [above](#provider-and-source-disabling)。                                                                                                                                                                                                                                                                                                   |
| `includeModelInPrompt` | boolean | `true`                      | 在系统提示中包含活动模型名称。                                                                                                                                                                                                                                                                                                                                                              |

`models.yml` schema 与自定义 provider 定义见 [Models](./models.md)。

### Advisor

advisor 是第二个模型，负责审查每个已完成的 turn 并可以把建议注入主会话。用 `modelRoles.advisor` 指定模型，然后通过 `advisor.enabled`、`/advisor on` 或带 `--advisor` 标志启动来启用它。

运行时行为、`WATCHDOG.md` 发现与有界的追赶（catch-up）语义见 [Advisor and WATCHDOG.md](./advisor-watchdog.md)。

| 键                   | 类型    | 默认值 | 说明                                                                                                                                                |
| --------------------- | ------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `advisor.enabled`     | boolean | `false` | 当 `modelRoles.advisor` 解析到可用模型时启用 advisor 运行时。                                                                 |
| `task.agentAdvisor`   | record  | `{}`    | 按 agent 的 subagent advisor：agent 名 → `"on"` / `"off"` / advisor 模型模式。覆盖 agent frontmatter 中的 `advisor`；从 `/agents` hub 配置。 |
| `advisor.syncBacklog` | enum    | `off`   | 有界的 advisor 追赶延迟：`off`、`1`、`3` 或 `5`。只有当 advisor 积压达到或超过阈值时，主 agent 才会最多等待 30 秒。 |
| `advisor.immuneTurns` | number  | `3`     | 在 `concern`/`blocker` 中断之后，把后续的 concern/blocker 作为非中断的旁注路由，持续到这么多完成的主 turn。            |

### Thinking

```yaml
defaultThinkingLevel: high
hideThinkingBlock: false
thinkingBudgets:
  minimal: 1024
  low: 2048
  medium: 8192
  high: 16384
  xhigh: 32768
  max: 32768
```

| 键                               | 类型    | 默认值 | 可选值                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------- | ------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaultThinkingLevel`            | enum    | `high`  | `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `auto`。每次运行可用 `--thinking` 覆盖。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `hideThinkingBlock`               | boolean | `false` | 在输出中隐藏 thinking 块。`--hide-thinking` 为本次运行设置它（仅影响显示）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `thinkingBudgets.minimal`         | number  | `1024`  | `minimal` 级别的 token 预算。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `thinkingBudgets.low`             | number  | `2048`  | `low` 的 token 预算。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `thinkingBudgets.medium`          | number  | `8192`  | `medium` 的 token 预算。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `thinkingBudgets.high`            | number  | `16384` | `high` 的 token 预算。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `thinkingBudgets.xhigh`           | number  | `32768` | `xhigh` 的 token 预算。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `thinkingBudgets.max`             | number  | `32768` | `max` 的 token 预算。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `providers.autoThinkingMaxEffort` | enum    | `xhigh` | `defaultThinkingLevel: auto` 可以解析出的最高 effort。`xhigh` 让分类器保持在高档之下的一档，因此只有 `ultrathink` 能达到 `max`；`max` 让分类器在暴露最高档的模型上计费最高档。无论哪种方式，本机端侧分类器都保持在 `xhigh` 封顶。这决定 `auto` _解析出_ 什么：模型阶梯在天花板之下没有任何档位时根本不会得到 auto 级别；而元数据要求显式 effort 的模型仍会从传输层收到其最低支持的 effort——在 `["max"]` 阶梯上那就是 `max`，因为该模型不接受其他任何值。 |

### 采样

`-1` 表示“使用 provider/模型默认值”——`omp` 不会发送该参数。

| 键                 | 类型   | 默认值   | 说明                                                                                                                                                                                                                                                                          |
| ------------------- | ------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `temperature`       | number | `-1`      | 采样温度。                                                                                                                                                                                                                                                          |
| `topP`              | number | `-1`      | 核采样（Nucleus sampling）。                                                                                                                                                                                                                                                              |
| `topK`              | number | `-1`      | Top-K 采样。                                                                                                                                                                                                                                                                |
| `minP`              | number | `-1`      | 最小概率截断。                                                                                                                                                                                                                                                    |
| `presencePenalty`   | number | `-1`      | 存在惩罚（presence penalty）。                                                                                                                                                                                                                                                              |
| `repetitionPenalty` | number | `-1`      | 重复惩罚（repetition penalty）。                                                                                                                                                                                                                                                            |
| `textVerbosity`     | enum   | `medium`  | `low`, `medium`, `high`。由 OpenAI Responses 与 Codex 传输层作为 response verbosity 发送。                                                                                                                                                                                  |
| `tier.openai`       | enum   | `none`    | `none`, `auto`, `default`, `flex`, `scale`, `priority`。作为 `service_tier` 发送给 OpenAI / OpenAI-Codex 与 OpenAI 系的 OpenRouter 模型。可用 `--service-tier <value>` 启动以对单个会话做 OpenAI 覆盖；该标志不会被持久化（`none` 省略 `service_tier`）。 |
| `tier.anthropic`    | enum   | `none`    | `none`, `priority`。`priority` 在受支持的直接 Claude 模型上实现快速模式（在 Bedrock/Vertex 与经 OpenRouter 时忽略）。                                                                                                                                            |
| `tier.google`       | enum   | `none`    | `none`, `flex`, `priority`。Gemini API 在请求体中发送它；Vertex 通过 header 发送 `priority`（`flex` 在 Vertex 上是 no-op）。                                                                                                                                                 |
| `tier.subagent`     | enum   | `inherit` | `inherit`, `none`, `auto`, `default`, `flex`, `scale`, `priority`。应用于所派生模型的 family；`inherit` 跟随主 agent。                                                                                                                                     |
| `tier.advisor`      | enum   | `none`    | `inherit`, `none`, `auto`, `default`, `flex`, `scale`, `priority`。应用于 advisor 模型的 family。                                                                                                                                                                      |
| `personality`       | enum   | `default` | `default`, `friendly`, `pragmatic`, `none`。用户级的 `<agent dir>/PERSONALITY.md` 替换所选预设的文本；`none` 仍会省略该块。见 [system-prompt-customization](./system-prompt-customization.md)。                                                  |

### Retry 与回退

```yaml
retry:
  enabled: true
  maxRetries: 10
  baseDelayMs: 500
  maxDelayMs: 300000
  modelFallback: true
  fallbackRevertPolicy: cooldown-expiry
  fallbackChains:
    # Any role without an explicit chain inherits the "default" chain.
    default:
      - anthropic/claude-opus-4-5
      - openai/gpt-5.5
      - google/gemini-3-pro
    # Per-role chains override the default (roles from `modelRoles`,
    # including custom roles). Selectors accept an optional thinking
    # suffix, e.g. openai/gpt-5.5:low.
    smol:
      - openai/gpt-5.5-mini
      - anthropic/claude-haiku-4-5
    # Model-selector keys (any key containing "/") attach the chain to the
    # model itself: it applies whenever that model is active, no matter
    # which role it is assigned to, and survives role reassignment.
    google/gemini-3-pro:
      - google-vertex/gemini-3-pro
    # A `provider/*` KEY covers every model of a provider — current or
    # future. A `provider/*` ENTRY keeps the failing model's id and swaps
    # the provider: google-antigravity/x -> google/x -> google-vertex/x.
    # Ids missing on the target provider are skipped (near-miss ids resolve
    # fuzzily); exact model keys override the wildcard for a specific model.
    google-antigravity/*:
      - google/*
      - google-vertex/*

providers:
  anthropic:
    serverSideFallback: false
```

| 键                                      | 类型    | 默认值           | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------- | ------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retry.enabled`                          | boolean | `true`            | 重试瞬态 provider 错误。                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `retry.maxRetries`                       | number  | `10`              | 每个请求的最大重试次数。                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `retry.baseDelayMs`                      | number  | `500`             | 初始退避。                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `retry.maxDelayMs`                       | number  | `300000`          | 退避上限（5 分钟）。当没有凭据或模型回退成功时，provider 声明的大于该值的等待会快速失败而不是睡眠；`0` 禁用该上限（以便自动恢复穿越 provider 声明的配额重置）。                                                                                                                                                                                                                                                                                                                  |
| `retry.modelFallback`                    | boolean | `true`            | 当某个模型不可用时回退到另一个模型。                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `retry.fallbackChains`                   | record  | `{}`              | 把角色、模型选择器或 `provider/*` 通配符映射到有序的回退选择器。含 `/` 的键面向模型，并胜过角色：`provider/model-id` 匹配那个精确模型，`provider/*` 匹配该 provider 的每个模型。`provider/*` _条目_ 保留失败模型的 id 并更换 provider。`default` 链覆盖每个没有自己链的已分配角色。未知的模型/provider 或格式错误的链会在启动时作为配置警告报告。 |
| `retry.fallbackRevertPolicy`             | enum    | `cooldown-expiry` | `cooldown-expiry` 在抑制窗口结束后回到主模型；`never` 保持使用回退模型，直到手动切换。                                                                                                                                                                                                                                                                                                                                                     |
| `providers.anthropic.serverSideFallback` | boolean | `false`           | 选择加入 Anthropic 的 `server-side-fallback-2026-06-01` beta。只有直接 `anthropic` provider 请求——使用 `anthropic-messages` API、针对 Claude Fable 或 Mythos 模型——才有资格。在 Anthropic 安全分类器拦截时，provider 可以在服务端用 `claude-opus-4-8` 重试；其他所有 provider、API 与模型不受影响。                                                                                                                                          |
| `providers.openai-codex.codeMode`           | enum    | `off`             | 针对 `code_mode_only` 模型（GPT-5.6 Sol/Terra/Luna）的 Codex Code Mode，镜像 codex-rs 的行为：直接工具面收拢为 `eval`/`ask`/`todo`，所有其他会话工具都从 `eval` 单元中经由其 `tool.<name>()` 桥接调用，从而把多步工具工作收拢为一次模型往返。`auto` 跟随模型目录的 `tool_mode` 标志；`on` 对任何 Codex 模型强制启用；`off`（默认）保留完整的直接工具面。激活时，turn 元数据携带 codex-rs 的 `tool_namespaces_info` 暴露快照。 |
| `providers.openai-codex.codeModeDirectTools` | array   | `[]`              | 当 Codex Code Mode 激活时，除了 `eval`/`ask`/`todo` 之外还要保持可直接调用的额外工具名；会话中未启用的条目会被忽略。 |

当活动模型持续失败（429、配额墙、provider 中断）且 `retry.modelFallback` 开启时，会话按特异性选择拥有该失败模型的链：先是精确的 `provider/model-id` 键，然后 `provider/*` 通配符，再是当前角色的链，最后 `default`。若多个角色分配了同一模型，yaml 键顺序不决定结果：活动会话角色胜出；当会话不在这些角色上时，`default` 胜过其他匹配角色。它会跳过选择器仍在冷却中的模型，并在该 turn 的其余部分切换。当 agent 定义列出多个模型模式时，subagent 会得到各自按 spawn 生成的链——第一个可解析的模式是主模式，其余成为其回退；`agent:<name>` 键并不存在于 `fallbackChains`。

### 工具与批准

```yaml
tools:
  format: auto
  approvalMode: yolo # default
  approval:
    bash: prompt
    edit: allow
  maxTimeout: 0
  intentTracing: true
```

| 键                            | 类型    | 默认值 | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------ | ------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools.format`                 | enum    | `auto`  | 工具线上格式（wire format）：`auto`, `native`, `glm`, `hermes`, `kimi`, `xml`, `anthropic`, `deepseek`, `harmony`, `qwen3`, `gemini`, `gemma` 或 `minimax`。`native` 总是使用 provider 原生的工具调用。`auto` 也使用原生调用，除非所选模型显式具有 `supportsTools: false`；此时它会选择模型 family 所属的方言，在不知道特定 family 方言时回退到 GLM。其他值强制使用该属主方言（owned in-band dialect）。`xml` 是 [generic XML format](./toolconv/xml.md)；`minimax` 是 [MiniMax format](./toolconv/minimax.md)。在会话启动时生效。见 [GLM](./toolconv/glm-4.5.md)、[Qwen3/Hermes](./toolconv/qwen3.md)、[Kimi](./toolconv/kimi-k2.md)、[Anthropic](./toolconv/anthropic.md)、[DeepSeek](./toolconv/deepseek.md)、[Harmony](./toolconv/harmony.md)、[Gemini](./toolconv/gemini.md) 与 [Gemma](./toolconv/gemma.md)。 |
| `tools.approvalMode`           | enum    | `yolo`  | `always-ask`（自动批准只读）、`write`（自动批准读 + 工作区写入）、`yolo`（自动批准所有层级）。`--approval-mode` 与 `--auto-approve`/`--yolo` 按运行覆盖。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `tools.approval`               | record  | `{}`    | 按工具名称键控的逐工具策略；每个值是 `allow`、`deny` 或 `prompt`。例如 `omp config set tools.approval '{"bash":"prompt"}'`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `tools.maxTimeout`             | number  | `0`     | 工具最大运行时长（秒）；`0` = 无上限。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `tools.intentTracing`          | boolean | `true`  | 记录每次调用的 intent 字符串。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `tools.outputMaxColumns`       | number  | `768`   | 流式输出的每行字节上限；`0` 禁用。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `tools.artifactSpillThreshold` | number  | `50`    | 工具输出超过该 KB 数时溢出（spill）到 artifact。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `tools.artifactHeadBytes`      | number  | `20`    | 溢出时保留在行内的头部 KB 数；`0` = 仅尾部。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `tools.artifactTailBytes`      | number  | `20`    | 溢出时保留在行内的尾部 KB 数。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `tools.artifactTailLines`      | number  | `500`   | 溢出时保留在行内的最大尾部行数。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

各个内置工具与 Eval prelude 由各自的键开关，例如 `bash.enabled`、`launch.enabled`、`eval.py`、`eval.js`、`glob.enabled`、`grep.enabled`、`fetch.enabled`、`browser.enabled`、`computer.enabled`、`astEdit.enabled`、`astGrep.enabled` 与 `web_search.enabled`。图片问题使用 `read <image>?q=<question>` 并遵循 `images.questionTimeoutMs`。

### 窗口作用域的 computer 使用

默认禁用的 `computer` Eval prelude 通过原生 OS API 捕获并控制真实的主机窗口。窗口句柄可以隔离一个应用，而无需聚焦它或移动真实指针；`desktop` 对象保留选定显示器的合成与全局输入行为。它与管理 Chromium/CDP 标签页与结构化页面自动化的 `browser` Eval prelude 保持分离。

```yaml
computer:
  enabled: true
  display: all
  maxWidth: 3840
  maxHeight: 2400
```

| 键                  | 类型    | 默认值 | 说明                                                                                                                                                                                                                                                        |
| -------------------- | ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `computer.enabled`   | boolean | `false` | 启用可感知窗口的 `computer` Eval prelude；`/computer` 斜杠命令仅对当前会话切换它。                                                                        |
| `computer.display`   | string  | `all`   | 只控制 `desktop` 目标：合成所有活动显示器，或使用一个数字显示器 ID。                                                                                                                                                            |
| `computer.maxWidth`  | number  | `3840`  | 合成截图的最大像素宽度。无法保留原始细节的图像传输层（包括 GitHub Copilot Responses 与 xAI OAuth）会把有效宽度限制在 `1280`；Claude 系模型使用同样的上限作为兼容性回退。 |
| `computer.maxHeight` | number  | `2400`  | 合成截图的最大像素高度。那些坐标安全的传输层把有效高度限制在 `896`；其他模型保留配置的上限。                                                                                                 |

每次调用都会读取 computer 设置与活动模型的坐标安全图像限制；编辑设置文件需要新会话，而运行时设置变更应用于下一次调用。直接 `computer` helper 与传给 `computer.run(fnOrCode, options)` 的代码通过 desktop 根或 `window(...)` 选择目标。切换目标会使先前的坐标帧失效，因此要在指针输入前捕获新目标。启用输入前，请配置 `tools.approvalMode` 或 `tools.approval.computer` 并授予平台权限。见 [Window-scoped computer use](computer-use.md)。

### Shell、eval 与 LSP

```yaml
bash:
  enabled: true
  autoBackground:
    enabled: true
    thresholdMs: 60000

eval:
  py: true
  js: true

python:
  kernelMode: session # session, per-call
  interpreter: ""

lsp:
  enabled: true
  lazy: true
  diagnosticsOnWrite: true
  diagnosticsOnEdit: false
  formatOnWrite: false
```

| 键                               | 类型    | 默认值   | 说明                                                                                                                                                       |
| --------------------------------- | ------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bash.enabled`                    | boolean | `true`    | 启用 bash 工具。                                                                                                                                       |
| `launch.enabled`                  | boolean | `true`    | 为共享的长运行项目进程启用 launch 工具。                                                                                           |
| `bash.autoBackground.enabled`     | boolean | `true`   | 自动将长运行命令转入后台。                                                                                                                      |
| `bash.autoBackground.thresholdMs` | number  | `60000`   | 自动转后台之前的阈值。                                                                                                                        |
| `eval.py`                         | boolean | `true`    | Python eval 后端。`PI_PY=0` 对该进程禁用。                                                                                                    |
| `eval.js`                         | boolean | `true`    | JavaScript eval 后端。`PI_JS=0` 对该进程禁用。                                                                                                |
| `eval.tools.enabled`              | boolean | `true`    | 把内核定义的 `@tool` / `tool(fn)` 函数暴露给 `task`、`agent()` 与 `workpool()` subagent。                                                      |
| `eval.workpool.freshAgents`       | boolean | `false`   | 为每个条目派生新的 workpool agent，而不是复用空闲 worker 或批处理排队条目。                                                        |
| `python.kernelMode`               | enum    | `session` | `session`（持久内核）或 `per-call`。                                                                                                                |
| `python.interpreter`              | string  | `""`      | Python 解释器路径；空 = 自动检测。                                                                                                          |
| `lsp.enabled`                     | boolean | `true`    | 语言服务器集成。`--no-lsp` 对该次运行禁用。                                                                                               |
| `lsp.lazy`                        | boolean | `true`    | 按需启动服务器。                                                                                                                                    |
| `lsp.shared`                      | boolean | `true`    | 通过 daemon broker 在本地 `omp` 进程之间共享每个项目一个语言服务器；broker 不可用时回退到私有服务器。 |
| `lsp.diagnosticsOnWrite`          | boolean | `true`    | 写入后运行诊断。                                                                                                                              |
| `lsp.diagnosticsOnEdit`           | boolean | `false`   | 编辑后运行诊断。                                                                                                                              |
| `lsp.formatOnWrite`               | boolean | `false`   | 写入时格式化文件。                                                                                                                                      |
| `lsp.diagnosticsDeduplicate`      | boolean | `true`    | 折叠重复的诊断。                                                                                                                             |
| `shellPath`                       | string  | _(unset)_ | 覆盖 bash 使用的 shell 二进制。                                                                                                                     |

### 文件：编辑与读取

```yaml
edit:
  mode: hashline # apply_patch, hashline, patch, replace
  fuzzyMatch: true
  fuzzyThreshold: 0.95
  blockAutoGenerated: true
  blackbox:
    enabled: false

read:
  defaultLimit: 300
  toolResultPreview: false
  summarize:
    enabled: true
    prose: false
```

| 键                       | 类型    | 默认值    | 说明                                             |
| ------------------------- | ------- | ---------- | ------------------------------------------------- |
| `edit.mode`               | enum    | `hashline` | `apply_patch`, `hashline`, `patch`, `replace`。    |
| `edit.fuzzyMatch`         | boolean | `true`     | 允许模糊锚点匹配。                      |
| `edit.fuzzyThreshold`     | number  | `0.95`     | 模糊匹配的相似度阈值。          |
| `edit.blockAutoGenerated` | boolean | `true`     | 拒绝编辑生成的/lockfile 类文件。     |
| `edit.streamingAbort`     | boolean | `false`    | 流式编辑不匹配时中止。                 |
| `edit.blackbox.enabled`   | boolean | `false`    | 为 AST 解析回归附加完整源码。      |
| `read.defaultLimit`       | number  | `300`      | 没有选择器时 `read` 的默认行数。 |
| `read.summarize.enabled`  | boolean | `true`     | 代码读取的结构化摘要。              |
| `read.summarize.prose`    | boolean | `false`    | 也摘要散文（prose）文件。                        |
| `read.toolResultPreview`  | boolean | `false`    | 工具结果的内联预览。                   |
| `readLineNumbers`         | boolean | `false`    | 显示纯行号。                          |

### Context、压缩与记忆

```yaml
contextPromotion:
  enabled: false

compaction:
  enabled: true
  methodOrder: [remote, snapcompact, handoff, shake, soft]
  midTurnEnabled: true # check thresholds between tool-loop provider requests
  thresholdPercent: -1 # -1 = default reserve-based behavior
  thresholdTokens: -1 # fixed token limit when > 0
memory:
  backend: off # off, local, hindsight, mnemopi
```

| 键                           | 类型    | 默认值                                  | 说明                                                                                                                                                                                                                                     |
| ----------------------------- | ------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contextPromotion.enabled`    | boolean | `false`                                  | 在 context 溢出时提升到活动模型显式的 `contextPromotionTarget`。                                                                                                                                                      |
| `compaction.enabled`          | boolean | `true`                                   | 自动对话压缩。                                                                                                                                                                                                        |
| `compaction.asyncEnabled`     | boolean | `true`                                   | 在 context 接近压缩阈值时于后台投机式摘要，越过阈值后把就绪的结果拼接进来。                                                                                        |
| `compaction.midTurnEnabled`   | boolean | `true`                                   | 在下一次 provider 请求前的安全 mid-turn 工具循环边界检查阈值。                                                                                                                                                  |
| `compaction.methodOrder`      | array   | `remote, snapcompact, handoff, shake, soft` | 有序回退。`remote` 使用 provider 原生的、兼容 OpenAI 的服务器压缩；不可用或失败的方法继续下一个。 |
| `compaction.thresholdPercent` | number  | `-1`                                     | 占 context 百分比的触发条件；`-1` = 基于保留（reserve）的默认行为。                                                                                                                                                                                 |
| `compaction.thresholdTokens`  | number  | `-1`                                     | 当 `> 0` 时的固定 token 触发条件。                                                                                                                                                                                                           |
| `compaction.reserveTokens`    | number  | _(unset)_                                | 绝对的保留下限。未设置时，有效保留值是 `16384` 与 context 窗口 15% 中较大者；若该默认值会让小窗口没有实际预算，则回退到 15% 保留。                         |
| `compaction.keepRecentTokens` | number  | `20000`                                  | 近期 token 总是保留。                                                                                                                                                                                                           |
| `compaction.autoContinue`     | boolean | `true`                                   | 压缩后自动继续。                                                                                                                                                                                                  |
| `memory.backend`              | enum    | `off`                                    | `off`, `local`, `hindsight`, `mnemopi`。每个后端有各自的 `hindsight.*` / `mnemopi.*` / `memories.*` 调优键。                                                                                                                  |
| `autolearn.enabled`           | boolean | `false`       | 实验性：agent 停止后，提示它把经验捕获到记忆，并在 `~/.omp/agent/managed-skills` 下创建/增强隔离的托管技能。启用 `manage_skill` 工具（记忆后端激活时还会启用 `learn`）。 |
| `autolearn.autoContinue`      | boolean | `false`       | 当 `autolearn.enabled` 时，在停止时自动运行一次捕获 turn（会消耗额外 token）。Off = 一条被动提醒挂到你的下一个 turn。                                                                                                           |
| `autolearn.minToolCalls`      | number  | `5`           | 只有在某 turn 至少使用了这么多工具后才提示。                                                                                                                                                                               |

`compaction` 还有额外的调优键（空闲压缩、取代/丢弃启发式），在 `omp config list` 中可见。完整策略参考见 [Compaction](./compaction.md)。

### 外观与终端

```yaml
theme:
  dark: titanium
  light: light
symbolPreset: unicode # unicode, nerd, ascii
colorBlindMode: false

statusLine:
  preset: default # default, minimal, compact, full, nerd, ascii, custom
  separator: powerline-thin
  transparent: false
  showHookStatus: true

terminal:
  showImages: true
images:
  autoResize: true
  blockImages: false
tui:
  hyperlinks: auto # off, auto, always
```

| 键                         | 类型    | 默认值          | 可选值                                                                    |
| --------------------------- | ------- | ---------------- | ------------------------------------------------------------------------- |
| `theme.dark`                | string  | `titanium`       | 深色终端背景上使用的主题。                                 |
| `theme.light`               | string  | `light`          | 浅色终端背景上使用的主题。                                |
| `symbolPreset`              | enum    | `unicode`        | `unicode`, `nerd`, `ascii`。                                               |
| `colorBlindMode`            | boolean | `false`          | diff 新增行用蓝色而非绿色。                             |
| `showHardwareCursor`        | boolean | `true`           | 显示终端硬件光标。                                        |
| `statusLine.preset`         | enum    | `default`        | `default`, `minimal`, `compact`, `full`, `nerd`, `ascii`, `custom`。       |
| `statusLine.separator`      | enum    | `powerline-thin` | `powerline`, `powerline-thin`, `slash`, `pipe`, `block`, `none`, `ascii`。 |
| `statusLine.sessionAccent`  | boolean | `true`           | 用会话颜色给编辑器边框染色。                            |
| `statusLine.transparent`    | boolean | `false`          | 状态行使用终端背景。                          |
| `statusLine.showHookStatus` | boolean | `true`           | 显示 hook 状态消息。                                                |
| `terminal.showImages`       | boolean | `true`           | 内联渲染图片（终端支持时）。                     |
| `images.autoResize`         | boolean | `true`           | 为模型兼容性调整大图尺寸。                              |
| `images.blockImages`        | boolean | `false`          | 绝不向 provider 发送图片。                                           |
| `tui.hyperlinks`            | enum    | `auto`           | `off`, `auto`, `always`。                                                  |
| `tui.resizeScrollback`      | enum    | `rebuild`        | 宽度变化稳定后如何刷新保留在终端 scrollback 中的 transcript 行：`append` 在保留历史之下以新宽度重放 transcript，`rebuild` 擦除面板 scrollback 然后重放一份当前宽度副本，`preserve` 只重绘视口。 |

自定义状态行时，设置 `statusLine.preset: custom` 并配置 `statusLine.leftSegments`、`statusLine.rightSegments` 与 `statusLine.segmentOptions`。在任一段列表中包含 `status` 即可渲染通过 `ctx.ui.setStatus()` 注册的扩展状态，按键排序并以行内方式连接。设置 `statusLine.showHookStatus: false` 可在页脚中抑制同样的状态。

### 交互

| 键                    | 类型    | 默认值         | 可选值                                                                                                  |
| ---------------------- | ------- | --------------- | ------------------------------------------------------------------------------------------------------- |
| `steeringMode`         | enum    | `one-at-a-time` | `all`, `one-at-a-time`。排队的 steering 消息如何投递。                                     |
| `followUpMode`         | enum    | `one-at-a-time` | `all`, `one-at-a-time`。                                                                                 |
| `interruptMode`        | enum    | `immediate`     | `immediate`, `wait`。                                                                                    |
| `doubleEscapeAction`   | enum    | `rewind`          | `rewind`, `none`。                                                                               |
| `autoResume`           | boolean | `false`         | 自动恢复 cwd 中最近的会话。                                                         |
| `plan.enabled`         | boolean | `true`          | 启用 plan 模式。                                                                                       |
| `plan.defaultOnStartup` | boolean | `false`         | 当 plan 模式启用时，每个新的交互式会话都以 plan 模式启动。Print/JSON（`--print`）模式会忽略它并打印一条说明；无头 plan 流程请使用 `--plan-yolo`。 |
| `ask.timeout`          | number  | `0`             | `ask` prompt 超时前的秒数；`0` = 无超时。（旧的毫秒值会迁移为秒。） |
| `ask.notify`           | enum    | `on`            | `on`, `off`。                                                                                            |

### Providers 与服务

```yaml
providers:
  webSearchOrder: [perplexity, exa, gemini]
  imageOrder: [openai, xai]
  fetch: auto
  webSearchGeminiModel: gemini-2.5-flash
  tinyModel: online
  tinyModelDevice: default
  tinyModelDtype: default
  openaiWebsockets: auto
  openrouterVariant: default
  kimiApiFormat: auto
  cacheRetention: auto
  maxInFlightRequests:
    anthropic: 2

provider:
  appendOnlyContext: auto # auto, on, off

exa:
  enabled: true
  searchDelayMs: 1000

searxng:
  endpoint: https://search.example.com
  token: SEARXNG_TOKEN
```

| 键                                 | 类型    | 默认值   | 可选值 / 说明                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------- | ------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `providers.webSearchOrder`          | array   | `[]`      | 用于 `web_search` 的按优先级排序的 provider id（`perplexity`, `gemini`, `anthropic`, `codex`, `xai`, `zai`, `exa`, `tinyfish`, `jina`, `kagi`, `tavily`, `firecrawl`, `brave`, `kimi`, `parallel`, `synthetic`, `searxng`, `startpage`, `duckduckgo`, `ecosia`, `google`, `mojeek`, `public`）。重复与未知的 id 会被忽略；未列出的 provider 之后保留其内置的相对顺序。空 = 内置顺序。替换已移除的 `providers.webSearch` enum（旧值迁移到本列表头部）。 |
| `providers.webSearchExclude`        | array   | `[]`      | `web_search` 绝不能使用的搜索 provider id，即使作为回退也不行。接受的 provider id 与 `providers.webSearchOrder` 相同。                                                                                                                                                                                                                                                                                              |
| `providers.webSearchTimeoutSeconds` | number  | `60`      | 在自动链推进到下一个回退之前，提供给每个 `web_search` provider 传输层的硬超时（秒）。较慢的模型驱动 provider 请用更大的值；超过 `300` 的值上限为五分钟。这不是整条链的截止时间，provider 特定的上游或聚合限制仍可能更短。                                                                                   |
| `providers.webSearchGeminiModel`    | string  | _(unset)_ | 当 `web_search` 使用 Gemini 时，用于 Google Search grounding 的 Gemini 模型 id；默认为 `gemini-2.5-flash`，可由 `GEMINI_SEARCH_MODEL` 覆盖。                                                                                                                                                                                                                                                                                        |
| `providers.imageOrder`              | array   | `[]`      | 按优先级排序的图片生成 provider id（`openai`, `openai-codex`, `antigravity`, `xai`, `gemini`, `openrouter`）。未列出的 provider 跟随活动会话 provider 与内置顺序。替换已移除的 `providers.image` enum（旧值迁移到本列表头部）。                                                                                                                                |
| `providers.fetch`                   | enum    | `auto`    | `auto`, `native`, `trafilatura`, `lynx`, `parallel`, `firecrawl`, `jina`。                                                                                                                                                                                                                                                                                                                                                              |
| `providers.tinyModel`               | enum    | `online`  | `online` 或本地模型（`lfm2.5-230m`, `lfm2.5-350m`, `falcon-h1-90m`）。                                                                                                                                                                                                                                                                                                                                                              |
| `providers.tinyModelDevice`         | enum    | `default` | 本地 tiny 模型的 ONNX 执行 provider，或 `mlx`（Apple 芯片，经 mlx-lm）。可由 `PI_TINY_DEVICE` 覆盖。                                                                                                                                                                                                                                                                                                                                                         |
| `providers.maxInFlightRequests`     | record  | `{}`      | LLM HTTP 请求的按 provider 正并发上限，在使用同一 config 根的本地 `omp` 进程之间共享。省略的 provider 不设限。`omp config set` 拒绝非正数或非数值。                                                                                                                                                                                                          |
| `providers.tinyModelDtype`          | enum    | `default` | 本地 tiny 模型的 ONNX 精度。可由 `PI_TINY_DTYPE` 覆盖。                                                                                                                                                                                                                                                                                                                                                                   |
| `providers.openaiWebsockets`        | enum    | `auto`    | `auto`, `off`, `on`。                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `providers.openrouterVariant`       | enum    | `default` | `default`, `nitro`, `floor`, `online`, `exacto`。                                                                                                                                                                                                                                                                                                                                                                                       |
| `providers.kimiApiFormat`           | enum    | `auto`    | `auto`, `openai`, `anthropic`。`auto` 跟随实时模型元数据。                                                                                                                                                                                                                                                                                                                                                                     |
| `providers.cacheRetention`          | enum    | `auto`    | `auto`, `short`, `long`, `none`。转发给支持的 provider 的 prompt-cache 保留策略。`auto` 保留 provider 默认值（Anthropic：5m 条目 + 空闲 keep-alive 刷新）并遵循 `PI_CACHE_RETENTION`；`short` 强制 5m；`long` 在支持处使用 1h TTL 并禁用 keep-alive 刷新；`none` 禁用 prompt 缓存与缓存亲和路由。                                                                 |
| `provider.appendOnlyContext`        | enum    | `auto`    | `auto`, `on`, `off`。                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `exa.enabled`                       | boolean | `true`    | 启用 Exa 网页搜索 provider。                                                                                                                                                                                                                                                                                                                                                                                                    |
| `exa.searchDelayMs`                 | number  | `1000`    | Exa 网页搜索请求之间的最小延迟（毫秒）；设为 `0` 可禁用限速。                                                                                                                                                                                                                                                                                                                                               |
| `searxng.endpoint`                  | string  | _(unset)_ | SearXNG 实例 URL。                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `searxng.token`                     | string  | _(unset)_ | SearXNG token；还有 `searxng.basicUsername`/`searxng.basicPassword`/`searxng.categories`/`searxng.language`/`searxng.engines`（逗号分隔的引擎名或 bang 快捷方式，例如 `ddg, br, startpage`，作为 API 的 `engines=` 参数发送）/`searxng.safesearch`。                                                                                                                                                                                                                                                                                                 |
| `auth.broker.url`                   | string  | _(unset)_ | Auth-broker URL。可由 `OMP_AUTH_BROKER_URL` 覆盖。                                                                                                                                                                                                                                                                                                                                                                                  |
| `auth.broker.token`                 | string  | _(unset)_ | Auth-broker token。可由 `OMP_AUTH_BROKER_TOKEN` 覆盖。                                                                                                                                                                                                                                                                                                                                                                              |
| `secrets.enabled`                   | boolean | `false`   | 在 provider 请求前启用配置的密钥混淆与内置的凭据形态 token 脱敏。见 [Secret obfuscation](./secrets.md)。                                                                                                                                                                                                                                                                                  |

provider 凭据与自定义模型定义分开配置——见 [Providers](./providers.md) 与 [Models](./models.md)。

### 其他组

本目录中未逐表列出的每个 schema 路径都明确交给 `omp config list`。其他组包括：

- Agent 行为与安全：`ask.*`, `eval.*`, `features.*`, `goal.*`, `loop.*`, `model.loopGuard.*`, `model.toolCallLoopGuard.*`, `prewalk.*`, `recap.*`, `tools.*`, 与 `vault.*`。
- 执行与内容：`commit.*`, `completion.*`, `edit.*`, `error.*`, `extensionHandlers.*`, `generate_image.*`, `git.*`, `images.*`, `live.*`, `paste.*`, `power.*`, `read.*`, `shellMinimizer.*`, `speech.*`, `terminal.*`, 与 `title.*`。
- 界面与启动：`display.*`, `statusLine.*`, `startup.*`, `stt.*`, `tui.*`, 与 `ttsr.*`。
- 集成、存储与发现：`async.*`, `bashInterceptor.*`, `codexResets.*`, `collab.*`, `commands.*`, `dev.*`, `exa.*`, `gc.*`, `github.*`, `hindsight.*`, `magicKeywords.*`, `mcp.*`, `memories.*`, `mnemopi.*`, `providers.*`, `searxng.*`, `share.*`, `skills.*`, `task.*`（含 subagent 收尾守卫：`task.softRequestBudget` 及其 steering 通知 `task.softRequestBudgetNotice`）, `todo.*`, `tts.*`, 与 `workspace.*`。
- 未分组键：`setupVersion`, `proseOnlyThinking`, `omitThinking`, `externalThinking`, `includeWorkspaceTree`, `autocompleteMaxVisible`, `emojiAutocomplete`, `extendedContext`, `disabledExtensions`, `inlineToolDescriptors`, 与 `treeFilterMode`。

这些设置遵循上文所示的、由 schema 定义的类型与默认值规则。

## 旧版迁移

`omp` 自动迁移更老的 config 形态。这些都不需要你操作；列出它们是为了让你知道在 `config.yml` 中可能看到哪些变化。

### 启动时迁移到 `config.yml`

当 `~/.omp/agent/config.yml` 与兼容的 `config.yaml` 都不存在时，启动会从旧来源构建一次规范的 `config.yml`，然后写出结果：

1. `~/.omp/agent/settings.json`（成功解析后重命名为 `settings.json.bak`）。
2. 持久化在 `agent.db` 中的设置。

任一主 YAML 文件存在后，这些旧来源不再被读取。通用配置加载器也会对其他配置文件执行 `.json` -> `.yml` 迁移（当只有 `.json` 形式存在时）。

### 字段级迁移

每当加载原始设置（全局、项目、overlay 与运行时覆盖）时应用：

| 旧                                                                      | 新                                                                                                          |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `inspect_image.enabled` / `inspect_image.mode`                           | 已移除                                                                                                      |
| `inspect_image.timeoutMs`                                                | `images.questionTimeoutMs`                                                                                   |
| `queueMode`                                                              | `steeringMode`                                                                                               |
| `ask.timeout` 以毫秒计（值 `> 1000`）                           | 秒（除以 1000）                                                                                    |
| 扁平的 `theme: "<name>"` 字符串                                            | `theme.dark` / `theme.light`（槽位由亮度决定；内置的 `light`/`dark` 会被丢弃以使用默认值） |
| 旧版 `task.isolation.mode: none`                                       | `task.isolation.enabled: false`                                                                              |
| 旧版 `task.isolation.mode: <backend>`                                  | `task.isolation.enabled: true` + `isolation.backend: <backend>`                                              |
| `task.simple`                                                            | 已移除                                                                                                      |
| 旧版隔离后端（`worktree`, `fuse-overlay`, `fuse-projfs`）    | `rcopy`, `overlayfs`, `projfs`                                                                               |
| `lastChangelogVersion`                                                   | 移动到标记文件并从 `config.yml` 中剥离                                                        |

## 故障排查

### 项目设置未生效

- 启动 `omp` 时请从包含 `.omp/config.yml` 的目录开始。设置发现只检查当前工作目录的 `.omp/`，不检查祖先目录。
- 确保 `.omp/` 非空；空的配置目录会被忽略。
- 确认文件是有效的 YAML 且顶层为映射。
- 从该目录运行 `omp config get <key>` 查看有效值。
- 记住 `--config` overlay 与运行时标志会覆盖项目 config。

### 全局数组在项目中消失了

数组是替换而非追加。若项目设置了 `disabledProviders`、`enabledModels`、`cycleOrder`、`extensions` 或任何其他数组，请在项目层包含**完整**的期望值——全局数组会被整体替换。

### 编辑配置后 provider 仍然可用

- 检查你禁用的是模型 provider id（例如 `anthropic`）还是发现来源 id（例如 `claude`）——它们是命名空间不同、效果也不同的两回事。
- 检查是否有项目（或 overlay）的 `disabledProviders` 数组替换了你的全局数组。
- 凭据仍可能来自环境变量、`.env`、OAuth、存储的认证或 `models.yml`；禁用 provider 无论如何都会阻止选择，但要确认你编辑的是正确的层。见 [Providers](./providers.md)。
- 若模型列表已经初始化，请重启会话。

### `omp config set` 改了错误的文件

`omp config set` 与 `omp config reset` 总是写入活动 agent 目录下的全局 `config.yml`。运行 `omp config path` 打印它。项目本地设置请直接编辑 `<repo>/.omp/config.yml`。

### `omp config reset` 没有删除我的键

`reset` 把 schema **默认值**写进全局 config——它持久化默认值而不是删除键。要停止用全局 config 覆盖项目值，请手动从 `~/.omp/agent/config.yml` 中删除该键。

### `--config` overlay 在启动时失败

`--config` 文件是仅进程内的 YAML 映射。缺失的文件、无效的 YAML 或顶层数组/标量都是硬错误——它不会静默回退到较低优先级的设置。请修正路径或内容。

### 环境变量胜过我的配置

某些设置（模型角色、eval 后端、tiny 模型的设备/精度、auth broker、PTY）可被环境变量或 CLI 标志覆盖以方便单机使用，且这些优先于 `config.yml`。取消该变量或去掉该标志，即可让持久化的值生效。见 [Environment overrides](#environment-overrides) 与 [Environment variables](./environment-variables.md)。

### `omp config set <key>` 提示 "Unknown setting"

键必须与 schema 路径完全匹配，没有简写。使用 `theme.dark`，而不是 `theme`。运行 `omp config list` 查看每个有效键。