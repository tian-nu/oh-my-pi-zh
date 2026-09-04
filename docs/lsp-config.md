# OMP 中的 LSP 配置

本指南说明如何为 OMP coding agent 配置 language server。

代码中的权威来源：

- 服务端配置类型：`packages/coding-agent/src/lsp/types.ts`（`ServerConfig`）
- 配置加载器：`packages/coding-agent/src/lsp/config.ts`
- 内置服务端定义：`packages/coding-agent/src/lsp/defaults.json`

## 自动检测

当没有配置文件贡献服务端覆盖时，OMP 通过交叉两个条件自动检测内置服务端：

1. 当前工作目录包含该服务端至少一个 `rootMarkers`。
2. 服务端二进制可用——先检查受支持的项目本地 bin 目录（例如 `node_modules/.bin/`、Python 虚拟环境、Ruby binstubs、Go 的项目 `bin/`），再检查 `$PATH`。

启动时的 root-marker 检测只看 cwd；不会搜索父目录。`*.cabal` 这类通配符 marker 匹配 cwd 内的直接条目，不递归。常见场景无需任何配置；完整内置集合见 [`defaults.json`](../packages/coding-agent/src/lsp/defaults.json)。

## 配置文件位置

OMP 从多个来源合并 LSP 配置，优先级从低到高：

| 优先级     | 位置                                                                                                         |
| ---------: | ------------------------------------------------------------------------------------------------------------ |
|      最低  | `~/lsp.json`、`~/.lsp.json`、`~/lsp.yaml`、`~/.lsp.yaml`、`~/lsp.yml`、`~/.lsp.yml`                           |
|            | 插件 LSP 配置（marketplace / `--plugin-dir` 根目录）                                                          |
|            | 用户配置目录：活动原生 agent 目录，然后 `~/.claude/lsp.*`、`~/.codex/lsp.*`、`~/.gemini/lsp.*`                |
|            | Cwd 配置目录：`<cwd>/.omp/lsp.*`、`<cwd>/.claude/lsp.*`、`<cwd>/.codex/lsp.*`、`<cwd>/.gemini/lsp.*`          |
|      最高  | Cwd 根目录：`<cwd>/lsp.*` 和 `<cwd>/.lsp.*`                                                                   |

每个位置都接受 `.json`、`.yaml` 和 `.yml`，包括隐藏变体。当多个变体在同一位置共存时，优先级从高到低为 `lsp.json`、`.lsp.json`、`lsp.yaml`、`.lsp.yaml`、`lsp.yml`、`.lsp.yml`。

合并按服务端浅合并：更高优先级的服务端对象只覆盖其顶层字段，但 `settings`、`initOptions`、`capabilities` 和 `workspaceReadyTimings` 这类对象值字段会整体替换较低值而非深度合并。覆盖文件中不存在的服务端保持内置默认值。

原生用户配置目录遵循 `PI_CONFIG_DIR` 和活动 profile；`~/.omp/agent/lsp.json` 是默认 profile 的写法。此共享配置查找不会把 `PI_CODING_AGENT_DIR` 当作任意替换基础目录。项目与 cwd 来源不向上遍历祖先目录。

**推荐位置：**

- 用户全局偏好 → 活动原生 agent 目录下的 `lsp.json`
- 项目专属覆盖 → `<cwd>/.omp/lsp.json`

> **注意：** 只有当至少一个可读配置贡献了非空服务端映射时才会跳过自动检测模式。仅设置 `idleTimeoutMs` 的配置仍使用内置自动检测。存在服务端覆盖时，OMP 先把它们合并到全部默认值上，然后保留 root marker 匹配 cwd、二进制可解析且合并后配置未 `disabled` 的服务端。

## 文件结构

JSON 和 YAML 均可接受。顶层对象既可以使用 `servers` 包装键，也可以直接使用扁平映射：

```json
{
  "servers": {
    "server-name": { ... }
  },
  "idleTimeoutMs": 300000
}
```

或（扁平形式，无 `servers` 包装）：

```json
{
  "server-name": { ... },
  "idleTimeoutMs": 300000
}
```

顶层键：

- `servers` — 服务端名到 `ServerConfig` 的映射（可选包装；扁平形式等价）
- `idleTimeoutMs` — 空闲 language server 在此毫秒数后关闭；省略、零和负值均禁用空闲关闭

不要混用包装与扁平的服务端条目：当 `servers` 存在时，除 `idleTimeoutMs` 外的兄弟键不会被当作服务端。

## ServerConfig 字段

| 字段                    | 类型       | 新服务端是否必填         | 说明                                                                                                     |
| ----------------------- | ---------- | ------------------------: | -------------------------------------------------------------------------------------------------------- |
| `command`               | `string`   |                      是 | 二进制名（经本地 bins / PATH 解析）或绝对路径                                                             |
| `args`                  | `string[]` |                       否 | 传给二进制的参数                                                                                          |
| `fileTypes`             | `string[]` |                      是 | 该服务端处理的文件扩展名，例如 `[".ts", ".tsx"]`                                                          |
| `languageId`            | `string`   |                       否 | 在 `textDocument/didOpen` 中发送的 LSP 语言 id；省略时从文件路径推断                                       |
| `rootMarkers`           | `string[]` |                      是 | 指示项目根的文件/目录；支持 `*.cabal` 这类一级通配符模式                                                   |
| `initOptions`           | `object`   |                       否 | 在 LSP 握手期间作为 `initializationOptions` 发送                                                          |
| `settings`              | `object`   |                       否 | 通过 `workspace/didChangeConfiguration` 推送                                                              |
| `disabled`              | `boolean`  |                       否 | 设为 `true` 禁用该服务端                                                                                  |
| `warmupTimeoutMs`       | `number`   |                       否 | 该服务端的启动超时（毫秒）                                                                                |
| `isLinter`              | `boolean`  |                       否 | 标记仅做 lint/格式化的服务端；将其排除在类型智能操作之外                                                   |
| `capabilities`          | `object`   |                       否 | 选择性启用的服务端特定功能；见 [Capabilities](#capabilities)                                               |
| `workspaceReadyTimings` | `object`   |                       否 | rust-analyzer workspace 就绪轮询的高级时序覆盖；见下文                                                     |

覆盖内置服务端时可以省略必填字段，因为它们在校验前会被继承。真正的新服务端则三者都需要。`resolvedCommand` 和 `createClient` 是运行时专属字段，不可配置。

### Capabilities

`capabilities` 对象启用 OMP 按服务端支持的可选功能：

```json
{
  "capabilities": {
    "flycheck": true,
    "ssr": true,
    "expandMacro": true,
    "runnables": true,
    "relatedTests": true
  }
}
```

所有字段均为布尔且可选。当前仅由 `rust-analyzer` 使用。

### rust-analyzer 高级就绪时序

`workspaceReadyTimings` 调整 rust-analyzer 的 workspace 就绪轮询：

```json
{
  "servers": {
    "rust-analyzer": {
      "workspaceReadyTimings": {
        "timeoutMs": 30000,
        "pollMs": 250,
        "settleMs": 2000,
        "statusRequestTimeoutMs": 2000
      }
    }
  }
}
```

四个字段都是可选的毫秒值。这是高级调优面；常规配置应使用默认值。

## 常见配方

### 覆盖内置服务端的设置

部分覆盖会合并到内置默认值上。只需指定想改的字段。

```json
{
  "servers": {
    "typescript-language-server": {
      "args": ["--stdio", "--log-level", "4"]
    }
  }
}
```

```yaml
servers:
  gopls:
    settings:
      gopls:
        gofumpt: false
        staticcheck: false
```

### 禁用内置服务端

```json
{
  "servers": {
    "eslint": {
      "disabled": true
    }
  }
}
```

### 注册自定义服务端

新服务端需要非空的 `command`、`fileTypes` 和 `rootMarkers`。无效的服务端定义会带警告被忽略。不可读的文件或无效 JSON/YAML 会被忽略；加载器继续处理其余来源。

```json
{
  "servers": {
    "my-lsp": {
      "command": "my-lsp-server",
      "args": ["--stdio"],
      "fileTypes": [".xyz"],
      "rootMarkers": [".xyz-project", ".git"]
    }
  }
}
```

### 设置全局空闲超时

关闭不活跃超过五分钟的 language server：

```json
{
  "idleTimeoutMs": 300000
}
```

### 仅对某个项目禁用服务端，全局保留

将覆盖放在 `<project>/.omp/lsp.json`：

```json
{
  "servers": {
    "pylsp": {
      "disabled": true
    }
  }
}
```

`~/.omp/agent/lsp.json` 中的用户级配置不受影响；pylsp 仅在本项目被禁用。

## 内置服务端列表

以下服务端随 `defaults.json` 提供，可参与自动检测：

| 服务端 key                    | 语言                          | 二进制                            |
| ----------------------------- | ----------------------------- | --------------------------------- |
| `rust-analyzer`               | Rust                          | `rust-analyzer`                   |
| `clangd`                      | C, C++, ObjC                  | `clangd`                          |
| `zls`                         | Zig                           | `zls`                             |
| `gopls`                       | Go                            | `gopls`                           |
| `typescript-language-server`  | TypeScript, JavaScript (≤ 6)  | `typescript-language-server`      |
| `typescript-native`           | TypeScript, JavaScript (7+)   | `tsc --lsp --stdio`               |
| `denols`                      | TypeScript, JavaScript (Deno) | `deno`                            |
| `biome`                       | TS/JS/JSON（linter）          | `biome`                           |
| `eslint`                      | TS/JS/Vue/Svelte（linter）    | `vscode-eslint-language-server`   |
| `vscode-html-language-server` | HTML                          | `vscode-html-language-server`     |
| `vscode-css-language-server`  | CSS, SCSS, Less               | `vscode-css-language-server`      |
| `vscode-json-language-server` | JSON                          | `vscode-json-language-server`     |
| `tailwindcss`                 | HTML, CSS, TS/JS              | `tailwindcss-language-server`     |
| `svelte`                      | Svelte                        | `svelteserver`                    |
| `vue-language-server`         | Vue                           | `vue-language-server`             |
| `astro`                       | Astro                         | `astro-ls`                        |
| `pyright`                     | Python                        | `pyright-langserver`              |
| `basedpyright`                | Python                        | `basedpyright-langserver`         |
| `pylsp`                       | Python                        | `pylsp`                           |
| `ty`                          | Python                        | `ty`                              |
| `ruff`                        | Python（linter）              | `ruff`                            |
| `jdtls`                       | Java                          | `jdtls`                           |
| `kotlin-lsp`                  | Kotlin                        | `kotlin-lsp`                      |
| `metals`                      | Scala                         | `metals`                          |
| `hls`                         | Haskell                       | `haskell-language-server-wrapper` |
| `ocamllsp`                    | OCaml                         | `ocamllsp`                        |
| `elixirls`                    | Elixir                        | `elixir-ls`                       |
| `expert`                      | Elixir                        | `expert`                          |
| `erlangls`                    | Erlang                        | `erlang_ls`                       |
| `gleam`                       | Gleam                         | `gleam`                           |
| `solargraph`                  | Ruby                          | `solargraph`                      |
| `ruby-lsp`                    | Ruby                          | `ruby-lsp`                        |
| `rubocop`                     | Ruby（linter）                | `rubocop`                         |
| `bashls`                      | Bash, Zsh                     | `bash-language-server`            |
| `lua-language-server`         | Lua                           | `lua-language-server`             |
| `intelephense`                | PHP                           | `intelephense`                    |
| `phpactor`                    | PHP                           | `phpactor`                        |
| `omnisharp`                   | C#                            | `omnisharp`                       |
| `yamlls`                      | YAML                          | `yaml-language-server`            |
| `terraformls`                 | Terraform                     | `terraform-ls`                    |
| `dockerls`                    | Dockerfile                    | `docker-langserver`               |
| `helm-ls`                     | Helm                          | `helm_ls`                         |
| `nixd`                        | Nix                           | `nixd`                            |
| `nil`                         | Nix                           | `nil`                             |
| `ols`                         | Odin                          | `ols`                             |
| `dartls`                      | Dart                          | `dart`                            |
| `marksman`                    | Markdown                      | `marksman`                        |
| `texlab`                      | LaTeX                         | `texlab`                          |
| `graphql`                     | GraphQL                       | `graphql-lsp`                     |
| `prismals`                    | Prisma                        | `prisma-language-server`          |
| `vimls`                       | Vim script                    | `vim-language-server`             |
| `emmet-language-server`       | HTML, CSS, JSX                | `emmet-language-server`           |
| `sourcekit-lsp`               | Swift                         | `sourcekit-lsp`                   |
| `swiftlint`                   | Swift（linter）               | `swiftlint`                       |
| `tlaplus`                     | TLA+                          | `tlapm_lsp`                       |

每个项目只保留一个 TypeScript 服务端：当解析到的 `tsc` 属于没有 `lib/tsserver.js` 的 TypeScript 安装（TypeScript 7+）时，`typescript-native` 胜出并丢弃 `typescript-language-server`，因为它无法驱动该安装；否则丢弃 `typescript-native`，因为较旧的 `tsc` 会拒绝 `--lsp`。
