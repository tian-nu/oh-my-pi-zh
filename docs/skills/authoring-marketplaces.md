---
name: authoring-marketplaces
description: 创建新的 omp marketplace 时使用。涵盖 marketplace.json schema、source 类型、安装命令和发布流程。
---

# 编写 Marketplace

marketplace 是一个 Git 仓库（或本地目录），其中包含一个目录清单文件，位于 `.omp-plugin/marketplace.json`（omp 专属目录的首选位置）或 `.claude-plugin/marketplace.json`（兼容 Claude Code；作为回退使用）。任何人都可以编写 marketplace。用户通过 `/marketplace add owner/repo` 添加它，然后从中安装单个插件。

## 最小可用的 marketplace

```
my-marketplace/
  .claude-plugin/
    marketplace.json
  plugins/
    my-plugin/
      skills/
        my-skill/
          SKILL.md
```

```json
{
  "name": "my-marketplace",
  "owner": { "name": "Your Name" },
  "plugins": [
    {
      "name": "my-plugin",
      "description": "What it does",
      "source": "./plugins/my-plugin"
    }
  ]
}
```

推送到 GitHub。用户通过以下方式安装：

```
/marketplace add your-github-username/my-marketplace
/marketplace install my-plugin@my-marketplace
```

## marketplace.json schema

目录清单文件位于仓库根目录的 `.omp-plugin/marketplace.json` 或 `.claude-plugin/marketplace.json`。omp 优先使用 `.omp-plugin/` 路径，回退到 Claude 路径；一个仓库也可以同时发布两者，以便从单一源码树暴露面向不同工具的目录。

### 顶层字段

| 字段 | 必需 | 说明 |
|---|---|---|
| `name` | 是 | Marketplace 名称。小写字母数字、连字符、点。必须以字母数字开头和结尾。最长 64 个字符。 |
| `owner` | 是 | 对象，至少包含 `owner.name`（字符串） |
| `owner.name` | 是 | Marketplace 所有者名称 |
| `owner.email` | 否 | 所有者联系邮箱 |
| `plugins` | 是 | 插件条目数组（见下文） |
| `metadata.description` | 否 | marketplace 的简短描述 |
| `metadata.version` | 否 | 目录元数据版本字符串 |
| `metadata.pluginRoot` | 否 | 前置到所有相对插件 source 路径的字符串 |
| 其他顶层字段 | 否 | 解析器会保留，但 marketplace 安装/运行时逻辑不使用 |

### 插件条目字段

| 字段 | 必需 | 说明 |
|---|---|---|
| `name` | 是 | 插件名称（命名规则与 marketplace 名称相同） |
| `source` | 是 | 插件的位置 — 字符串或对象（见下文 source 类型） |
| `description` | 否 | 插件简短描述 |
| `version` | 否 | 版本字符串；回退顺序为 `.claude-plugin/plugin.json`、`package.json`、source SHA，最后是 `0.0.0` |
| `author` | 否 | `{ name, email? }` |
| `homepage` | 否 | URL |
| `category` | 否 | 例如 `development`、`productivity`、`security` |
| `tags` / `keywords` | 否 | 字符串标签/关键词数组 |
| `repository` | 否 | 仓库 URL |
| `license` | 否 | 许可证字符串 |
| `strict` | 否 | 布尔元数据标志；会保留，但安装/运行时逻辑不使用 |
| `commands`, `agents`, `hooks`, `mcpServers` | 否 | 解析器保留的目录元数据；运行时发现来自已安装的插件树和 manifest |
| `lspServers` | 否 | 内联 server 映射或插件内路径；安装时会写入 `.lsp.json` |
| `dapAdapters` | 否 | 内联 adapter 映射或插件内 JSON/YAML 路径；安装时会写入 `.dap.json`、`.dap.yaml` 或 `.dap.yml` |

### 完整目录示例

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "acme-plugins",
  "owner": {
    "name": "Acme Corp",
    "email": "plugins@acme.example"
  },
  "metadata": {
    "description": "Official Acme plugins for oh-my-pi"
  },
  "plugins": [
    {
      "name": "acme-linter",
      "description": "Enforce Acme coding standards",
      "category": "development",
      "source": "./plugins/linter"
    },
    {
      "name": "acme-deploy",
      "description": "One-command deploy to Acme cloud",
      "category": "devops",
      "source": {
        "source": "github",
        "repo": "acme-corp/omp-deploy-plugin",
        "ref": "main"
      }
    }
  ]
}
```

## 插件 source 类型

### 1. 相对路径字符串

指向 marketplace 仓库自身内部的子目录。必须以 `./` 开头。

```json
"source": "./plugins/my-plugin"
```

路径相对于 marketplace 仓库根目录解析。超出仓库根目录的路径穿越会被拒绝。

可以使用 `metadata.pluginRoot` 避免重复书写公共前缀：

```json
{
  "metadata": { "pluginRoot": "./plugins" },
  "plugins": [
    { "name": "plugin-a", "source": "./plugin-a" },
    { "name": "plugin-b", "source": "./plugin-b" }
  ]
}
```

### 2. Git URL

完整的 Git 仓库 URL。可选地通过 `ref` 固定分支/标签，或通过 `sha` 固定精确提交：

```json
"source": {
  "source": "url",
  "url": "https://github.com/org/my-plugin.git",
  "ref": "main",
  "sha": "a1b2c3d4..."
}
```

### 3. GitHub 简写

GitHub 仓库的简写形式。功能上等同于 Git URL，但更简洁：

```json
"source": {
  "source": "github",
  "repo": "org/my-plugin",
  "ref": "v2.1.0",
  "sha": "a1b2c3d4..."
}
```

### 4. Git 子目录（monorepo）

适用于位于较大仓库子目录中的插件。`url` 接受完整的 HTTPS URL 或 GitHub `owner/repo` 简写：

```json
"source": {
  "source": "git-subdir",
  "url": "https://github.com/org/monorepo.git",
  "path": "packages/my-plugin",
  "ref": "main",
  "sha": "a1b2c3d4..."
}
```

`path` 必须解析到克隆仓库的内部 — 目录逃逸会被拒绝。

### 5. NPM 包

将插件声明为 npm 包。`version` 可选：

```json
"source": {
  "source": "npm",
  "package": "@acme/omp-plugin",
  "version": "1.2.0"
}
```

> 注意：npm 插件 source 可以通过目录解析，但安装时会以 `npm plugin sources are not yet supported` 拒绝。目前请使用相对路径或基于 Git 的 source。

## 插件结构

插件目录（无论 source 类型）按约定位置携带其内容，全部可选：

```
my-plugin/
  skills/<name>/SKILL.md         ← skills
  commands/*.md                  ← slash commands
  agents/*.md                    ← subagent definitions
  hooks/pre/, hooks/post/        ← hooks
  tools/                         ← custom tools
  .mcp.json                      ← MCP server definitions (default location)
  .claude-plugin/plugin.json     ← optional paths for skills/commands and other manifest metadata
  package.json                   ← optional version and `omp.extensions`
  README.md                      ← recommended: description + usage
```

> 注意：MCP server 也可以通过 manifest 的 `mcpServers` 字段声明 — 既可以是内联 server 映射，也可以是指向插件根目录内配置文件的路径（`{ "mcpServers": "./mcp-omp.json" }`）。omp 先读取 `.omp-plugin/plugin.json`，再读取 `.claude-plugin/plugin.json`；manifest 声明会替换默认的 `.mcp.json` 而不是与之合并，因此同一份发布树可以携带面向不同 harness 的 MCP 配置。

> 注意：通过 `package.json` 的 `omp.extensions` 声明的扩展模块**确实会**从 marketplace 安装中加载 — 安装时会把缓存的插件符号链接到对应 scope 的 `node_modules`，并记录到 `omp-plugins.lock.json`，与 npm 安装和 `omp plugin link` 安装的插件使用相同的运行时入口。

## 安装命令

```
/marketplace install name@marketplace-name
/marketplace install --force name@marketplace-name     # reinstall
/marketplace install --scope project name@marketplace  # project-scoped
```

等价的 CLI 命令：

```
omp plugin marketplace add owner/repo
omp plugin install name@marketplace-name
```

scope 行为：

- **user**（默认）— 安装到用户插件数据根目录的 `installed_plugins.json`（默认 `~/.omp/plugins/installed_plugins.json`），在所有项目中可用。在 Linux 和 macOS 上，`omp config init-xdg` 会创建 XDG 根目录（但不会迁移数据）；一旦相关根目录存在且设置了 XDG 变量，新的用户状态将使用 `$XDG_DATA_HOME/omp/plugins/installed_plugins.json`。
- **project** — 安装到 `<project>/.omp/plugins/installed_plugins.json`，仅在该项目中可用

一个已启用的 project 范围安装会遮蔽同名 `name@marketplace` ID 的已启用 user 范围安装。已禁用的 project 副本会让 user 副本保持生效。

安装与发现细节：

- 无效的插件条目会被记录并跳过；无效的 JSON 或缺失必需的顶层字段会拒绝整个目录。
- `skills/` 和 `commands/` 可以通过 `.claude-plugin/plugin.json` 重新映射。声明的 skill 路径通常在默认值之上追加；当插件的目录 source 恰好是 `"./"` 时，它们会替换默认值。声明的 `commands`（首选）或 `slash-commands` 会替换默认值，除非显式包含 `./commands`。位于插件根目录之外的路径会被忽略并给出警告。
- 目录中的 `lspServers` 和 `dapAdapters` 值会在安装期间落地。目录中的 `commands`、`agents`、`hooks` 和 `mcpServers` 则只是元数据；它们不会重新映射运行时发现。

## 命名规则

Marketplace 名称和插件名称必须：

- 只包含小写字母、数字、连字符（`-`）和点（`.`）
- 以小写字母或数字开头和结尾
- 不超过 64 个字符

插件 ID（`name@marketplace`）总共不得超过 128 个字符。

有效：`my-plugin`、`code-review`、`acme.tools`、`ai-v2`
无效：`-bad-start`、`bad-end-`、`.dot-start`、`Under_score`、`HAS_CAPS`

## 发布流程

1. 在一个新 Git 仓库的 `.omp-plugin/marketplace.json`（仅 omp）或 `.claude-plugin/marketplace.json`（与 Claude Code 共享）中创建 `marketplace.json`。
2. 添加指向子目录（或外部 source）的插件条目。
3. 推送到 GitHub。
4. 分享 `owner/repo` 字符串。用户通过 `/marketplace add owner/repo` 添加。
5. 更新目录后，用户运行 `/marketplace update your-marketplace-name` 拉取最新版本。

发布前在本地测试：

```
/marketplace add ./path/to/my-marketplace
```

本地路径 source 也接受 `~/` 和绝对路径。

## 延伸阅读

- `docs/marketplace.md` — marketplace 系统内部实现、磁盘布局、命令参考
- `docs/skills/authoring-extensions.md` — 如何编写插件内的扩展模块
- `docs/skills/examples/mini-marketplace/` — 最小可用的 marketplace 示例
