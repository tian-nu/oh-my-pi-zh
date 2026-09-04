# Marketplace 插件系统

marketplace 系统让你可以从 Git、本地或直接目录源发现、安装和管理插件。它与 Claude Code 插件注册表格式兼容。

## 快速开始

```
/marketplace add anthropics/claude-plugins-official
/marketplace install wordpress.com@claude-plugins-official
```

在 TUI 中，不带参数的 `/marketplace` 会打开交互式插件浏览器。在 ACP/RPC 命令处理中，`/marketplace` 列出已配置的 marketplace；使用 `/marketplace discover` 浏览。

## 概念

**marketplace** 是一个 Git 仓库（或本地目录），包含位于 `.omp-plugin/marketplace.json`（首选）或 `.claude-plugin/marketplace.json`（Claude Code 兼容回退）的目录文件。该目录列出可用插件及其来源、描述和元数据。

**plugin** 是一个包含 Claude/OMP 插件内容（如 skills、commands、agents、rules、hooks、tools、MCP server 或 LSP server）的目录。Marketplace 安装还会加载 `package.json` `omp.extensions` 声明的扩展模块：安装时将缓存的插件 symlink 到作用域的 `node_modules` 树，并记录到 `omp-plugins.lock.json`——与 npm 安装和 `omp plugin link` 的插件使用相同的运行时表面。插件以 `name@marketplace` 标识（例如 `code-review@claude-plugins-official`）。

**作用域（Scopes）**：marketplace 插件可以安装在两个作用域：

- **user**（默认）——在所有项目中可用，存储在用户插件数据根目录的 `installed_plugins.json`（默认 `~/.omp/plugins/installed_plugins.json`）
- **project**——仅在活动项目中可用，存储在最近的项目 `.omp/plugins/installed_plugins.json`

已启用的 project 作用域安装会遮蔽同一插件已启用的 user 作用域安装。已禁用的 project 安装不会遮蔽 user 安装。

在 Linux 和 macOS 上，`omp config init-xdg` 会创建 XDG data、state 和 cache 根目录；它不会移动现有数据。一旦相关根目录存在且设置了 `XDG_DATA_HOME`、`XDG_STATE_HOME` 和 `XDG_CACHE_HOME`，新的 user marketplace/插件状态会解析到 `$XDG_DATA_HOME/omp` 下（包括 `marketplaces.json` 和 `plugins/`）。下文的 `~/.omp` 路径是非 XDG 默认值。

## 命令

### 交互模式

| Command        | Effect                                    |
| -------------- | ----------------------------------------- |
| `/marketplace` | Open interactive plugin browser (install) |

### Marketplace 管理

| Command                      | Effect                                       |
| ---------------------------- | -------------------------------------------- |
| `/marketplace add <source>`  | Add a marketplace source                     |
| `/marketplace remove <name>` | Remove a marketplace                         |
| `/marketplace update [name]` | Re-fetch catalog(s); omit name to update all |
| `/marketplace list`          | List configured marketplaces                 |

### 插件操作

| Command                                                                   | Effect                                             |
| ------------------------------------------------------------------------- | -------------------------------------------------- |
| `/marketplace discover [marketplace]`                                     | Browse available plugins                           |
| `/marketplace install [--force] [--scope user\|project] name@marketplace` | Install a plugin                                   |
| `/marketplace uninstall [--scope user\|project] name@marketplace`         | Uninstall a plugin; no args opens the TUI selector |
| `/marketplace installed`                                                  | List installed marketplace plugins                 |
| `/marketplace upgrade [--scope user\|project] [name@marketplace]`         | Upgrade one or all plugins                         |
| `/plugins list`                                                           | List npm/link and marketplace plugins              |
| `/plugins enable [--scope user\|project] name@marketplace`                | Enable a marketplace plugin                        |
| `/plugins disable [--scope user\|project] name@marketplace`               | Disable a marketplace plugin                       |

### CLI 等价命令

相同的操作也可以从命令行使用：

```
omp plugin marketplace add <source>
omp plugin marketplace remove <name>
omp plugin marketplace update [name]
omp plugin marketplace list
omp plugin discover [marketplace]
omp plugin install [--force] [--scope user|project] name@marketplace
omp plugin uninstall [--scope user|project] name@marketplace
omp plugin upgrade [--scope user|project] [name@marketplace]
omp plugin enable [--scope user|project] name@marketplace
omp plugin disable [--scope user|project] name@marketplace
omp plugin list

```

TUI 的 marketplace 变更操作（显式命令和选择器）会更新磁盘状态并使发现缓存失效，但不会刷新活动会话。运行 `/reload-plugins` 刷新 skills、斜杠命令和 MCP server；重启会话以加载新安装的工具、hooks 或扩展模块。ACP/RPC marketplace 处理器会自动刷新 skills 和斜杠命令，但同样不会重建每个已初始化的能力集。

## Marketplace 源

运行 `/marketplace add <source>` 时，系统会对来源分类：

| Source format                   | Type                                               | Example                                |
| ------------------------------- | -------------------------------------------------- | -------------------------------------- |
| `owner/repo`                    | GitHub shorthand                                   | `anthropics/claude-plugins-official`   |
| `https://...*.json`             | Direct catalog URL                                 | `https://example.com/marketplace.json` |
| `https://...` / `http://...`    | Git repository unless the URL path ends in `.json` | `https://github.com/org/repo`          |
| `git@...` / `ssh://...`         | Git repository                                     | `git@github.com:org/repo.git`          |
| `./path` or `~/path` or `/path` | Local directory                                    | `./my-marketplace`                     |

Git 和本地源必须包含位于 `.omp-plugin/marketplace.json`（首选）或 `.claude-plugin/marketplace.json`（Claude Code 兼容回退）的目录。直接目录 URL 只缓存 JSON 目录；URL 来源目录中的插件不能使用 `"./plugins/foo"` 这样的相对字符串源。

## 目录格式（marketplace.json）

marketplace 目录位于仓库根目录的 `.omp-plugin/marketplace.json`。当 omp 是唯一的目标消费者时，优先使用此路径。要保持 Claude Code 兼容（omp 从两个路径加载相同形态），则发布到 `.claude-plugin/marketplace.json`——当 `.omp-plugin/marketplace.json` 不存在时 omp 将其作为回退。仓库可以同时携带两者：omp 读取 `.omp-plugin/` 副本，Claude Code 读取 `.claude-plugin/` 副本。目录格式两者相同：

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "my-marketplace",
  "owner": {
    "name": "Your Name",
    "email": "you@example.com"
  },
  "metadata": {
    "description": "A collection of plugins",
    "version": "1.0.0",
    "pluginRoot": "plugins"
  },
  "plugins": [
    {
      "name": "my-plugin",
      "description": "What this plugin does",
      "source": "./my-plugin",
      "category": "development",
      "homepage": "https://github.com/you/my-plugin"
    }
  ]
}
```

### 必填字段

| Field        | Description                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `name`       | Marketplace name. Lowercase alphanumeric, hyphens, and dots. Must start and end with alphanumeric. Max 64 chars. |
| `owner.name` | Marketplace owner name                                                                                           |
| `plugins`    | Array of plugin entries                                                                                          |

顶层 `metadata.description`、`metadata.version` 和 `metadata.pluginRoot` 是可选的。设置 `metadata.pluginRoot` 时，它会前置到相对的插件 `source` 路径。

### 插件条目字段

| Field         | Required | Description                                                                                    |
| ------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `name`        | yes      | Plugin name (same rules as marketplace name)                                                   |
| `source`      | yes      | Where to find the plugin (see below)                                                           |
| `description` | no       | Short description                                                                              |
| `version`     | no       | Version string; install version falls back to plugin manifest, source SHA, then `0.0.0`        |
| `author`      | no       | `{ name, email? }`                                                                             |
| `homepage`    | no       | URL                                                                                            |
| `repository`  | no       | Repository URL/string                                                                          |
| `license`     | no       | License string                                                                                 |
| `keywords`    | no       | Array of string keywords                                                                       |
| `category`    | no       | Category string (e.g. `development`, `productivity`, `security`)                               |
| `tags`        | no       | Array of string tags                                                                           |
| `strict`      | no       | Boolean metadata flag; preserved but not used by install/runtime logic                         |
| `commands`    | no       | Command metadata; preserved but runtime commands are discovered from the installed plugin tree |
| `agents`      | no       | Agent metadata; preserved but not consumed by marketplace installation                         |
| `hooks`       | no       | Hook metadata; preserved but runtime hooks are discovered from the installed plugin tree       |
| `mcpServers`  | no       | MCP metadata; preserved here; runtime MCP configuration comes from the plugin manifest/tree    |
| `lspServers`  | no       | Inline map or in-plugin path; copied to `.lsp.json` during installation                        |
| `dapAdapters` | no       | Inline map or in-plugin JSON/YAML path; copied to `.dap.json`, `.dap.yaml`, or `.dap.yml`      |

### 插件源格式

`source` 字段支持以下格式。字符串源必须以 `./` 开头，并在可选的 `metadata.pluginRoot` 前置后于 marketplace 根目录内解析：

**相对路径**（marketplace 仓库内）：

```json
"source": "./my-plugin"
```

**Git 仓库 URL**：

```json
"source": {
  "source": "url",
  "url": "https://github.com/org/repo.git",
  "sha": "abc123..."
}
```

**GitHub 简写**：

```json
"source": {
  "source": "github",
  "repo": "org/repo",
  "ref": "main",
  "sha": "abc123..."
}
```

**Git 子目录**（monorepo）：

```json
"source": {
  "source": "git-subdir",
  "url": "https://github.com/org/monorepo.git",
  "path": "plugins/my-plugin",
  "ref": "main",
  "sha": "abc123..."
}
```

**npm 包**（解析但尚不可安装）：

```json
"source": {
  "source": "npm",
  "package": "@scope/my-plugin",
  "version": "1.0.0"
}
```

当前安装器行为会以 `npm plugin sources are not yet supported` 拒绝 npm marketplace 源；请使用相对路径、GitHub、URL 或 git-subdir 源。

无效的目录 JSON 或无效的必填顶层字段会拒绝整个目录。无效的插件条目会被记录并跳过，以便其他有效条目保持可用。

## 更新、移除与作用域

- `/marketplace update [name]` 只刷新目录；不会重新安装插件。
- `omp plugin upgrade name@marketplace` 在省略 `--scope` 时重新安装每个已安装的作用域。`/marketplace upgrade name@marketplace`、uninstall 以及 enable/disable 在插件同时存在于两个作用域时要求 `--scope user|project`。
- 升级全部插件只比较声明了 `version` 的目录条目。Semver 版本必须更新；非 semver 版本在不相等时视为已变更。单个插件失败会被跳过，因此全插件升级可以部分成功。
- `marketplace.autoUpdate` 控制启动检查：`off`、`notify`（默认）或 `auto`。超过 24 小时的目录会在版本检查前尽力刷新。尽管名称如此，当前 `notify` 模式只把更新可用性写入调试日志，不显示用户可见的通知。
- 移除 marketplace 会移除其注册表条目和目录缓存；不会卸载已缓存并注册的插件。

## 磁盘布局

```
~/.omp/
  marketplaces.json              # Registry of added marketplaces
  plugins/
    installed_plugins.json       # User-scoped marketplace plugins (version: 2)
    omp-plugins.lock.json        # Runtime enable/feature state
    node_modules/<package>       # Symlink to the cached plugin
    cache/
      marketplaces/<name>/       # Cached marketplace clone/catalog
      plugins/<marketplace>___<plugin>___<version>/  # Cached plugin directories

<project>/.omp/
  plugins/
    installed_plugins.json       # Project-scoped marketplace plugins (version: 2)
    omp-plugins.lock.json        # Project runtime enable/feature state
    node_modules/<package>       # Symlink to the cached plugin
```

## 命名规则

Marketplace 和插件名称必须：

- 以小写字母或数字开头和结尾
- 只包含小写字母、数字、连字符和点
- 最多 64 个字符

插件 ID（`name@marketplace`）总长最多 128 个字符。

有效示例：`my-plugin`、`code-review`、`wordpress.com`、`ai-firstify`
无效示例：`-bad`、`bad-`、`.bad`、`Bad`、`under_score`
