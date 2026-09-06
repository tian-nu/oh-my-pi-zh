# 机密混淆

防止敏感值（API key、token、密码）被发送给 LLM provider。启用后，配置的机密与内置的、形似凭据的 token 模式会在 provider 可见文本离开进程之前被替换。可逆占位符会在执行前于模型编写的工具参数中还原，也会在本地会话上下文为显示或恢复而重建时还原。

## 启用

默认禁用。可通过 `/settings` UI 或直接在 `config.yml` 中切换：

```yaml
secrets:
  enabled: true
```

## 工作原理

1. 会话启动时，机密从以下来源收集：
   - **环境变量**：名称匹配常见机密模式（`KEY`、`SECRET`、`TOKEN`、`PASSWORD`、`PASS`、`AUTH`、`CREDENTIAL`、`PRIVATE`、`OAUTH`）且值长度至少 8 个字符
   - **`secrets.yml` 文件**（见下文）
   - 内置的可逆 regex，用于只出现在会话内容或工具结果中的常见 GitHub、GitLab 与 OpenAI 风格凭据 token

2. provider 可见文本中的匹配值会被替换为确定性占位符，例如 `$$3P8W5JH1TK2Q$$`、`$$3P8W5JH1TK2Q:L$$` 或 `$$GITHUBTOKEN_3P8W5JH1TK2Q:L$$`。

3. 实时的、模型编写的工具参数会被深度遍历，占位符在工具执行前被还原。会话上下文在为本地显示/恢复还原占位符后，会在 provider 重放前再次混淆。Replace 模式的替换是单向的，不会被还原。

两种模式决定每个机密的处理方式：

| 模式 | 行为 | 可逆 |
| --------------------- | --------------------------------------------------------------------------------------------- | ---------- |
| `obfuscate`（默认） | 替换为确定性的 `$$HASH(:hint)$$` 或 `$$FRIENDLY_HASH(:hint)$$` 占位符 | 是 |
| `replace` | 替换为配置的 `replacement`；省略时替换为确定性的等长值 | 否 |

混淆模式下，短于 8 个字符的明文值与 regex 匹配会被忽略，以免把普通的短词也打码。Replace 模式可以处理短值；一个没有自定义 replacement 的 replace 模式 regex，只有在所有可能的 1–2 字符匹配都无法被脱敏成互不相同且稳定的值时才会被拒绝。

## secrets.yml

在 YAML 中定义自定义机密条目。会检查两个位置：

| 级别 | 路径 | 用途 |
| ------- | -------------------------- | --------------------------- |
| 全局 | `~/.omp/agent/secrets.yml` | 所有项目共用的机密 |
| 项目 | `<cwd>/.omp/secrets.yml` | 项目专属的机密 |

项目条目会覆盖 `content` 相同的全局条目。

### 结构

数组中的每个条目都包含以下字段：

| 字段 | 类型 | 必需 | 描述 |
| -------------- | ---------------------------- | -------- | ------------------------------------------------------------- |
| `type` | `"plain"` 或 `"regex"` | 是 | 匹配策略 |
| `content` | string | 是 | 机密值（plain）或 regex 模式（regex） |
| `mode` | `"obfuscate"` 或 `"replace"` | 否 | 默认：`"obfuscate"` |
| `replacement` | string | 否 | 自定义替换值（仅 replace 模式） |
| `flags` | string | 否 | Regex 标志（仅 regex 类型） |
| `friendlyName` | string | 否 | 混淆模式占位符经净化的、模型可见的标签 |

### 示例

#### 明文机密

```yaml
# Obfuscate a specific API key (default mode)
- type: plain
  content: sk-proj-abc123def456

# Replace a database password with a fixed string
- type: plain
  content: hunter2
  mode: replace
  replacement: "********"
```

#### 友好名称

`friendlyName` 为可逆混淆占位符添加语义上下文，而不会暴露机密值：

```yaml
- type: plain
  content: github_pat_abc123def456
  friendlyName: GitHub Token
```

这会生成形如 `$$GITHUBTOKEN_3P8W5JH1TK2Q:L$$` 的占位符。友好名称会被净化为大写字母与数字，上限 32 个字符；若净化后为空值则省略。无效的可选 `friendlyName` 元数据不会禁用该机密条目；该机密仍会以无标签占位符混淆。若某个标签会暴露配置的字面机密或匹配到配置的机密 regex，该特定占位符也会去掉标签。

12 字符的哈希基数是确切机密在私有、按安装实例生成的密钥下的 HMAC（密钥存储于 `~/.omp/agent/secret-placeholder.key`，在启用 XDG 的安装中为 `$XDG_STATE_HOME/omp/secret-placeholder.key`，绝不会发送给模型）。这可以防止阅读转录的人用字典哈希把占位符反推回其机密。仅大小写不同的机密会获得独立的基数，因此看到某个占位符并不能让 provider 通过改动大小写提示来合成另一个。若在惰性的内置 token 路径上无法持久化密钥，会话会发出警告并改用进程内临时密钥；混淆在该进程内仍然可逆，但占位符跨重启不稳定。大小写提示后缀标注被脱敏值的大小写：

| 提示 | 含义 |
| ---- | ---------------------------------------------- |
| `:U` | 所有含大小写的 ASCII 字母均为大写 |
| `:L` | 所有含大小写的 ASCII 字母均为小写 |
| `:C` | 首个含大小写的 ASCII 字母大写，其余小写 |
| `:M` | ASCII 大小写混合 |

regex 条目上的 `friendlyName` 标注的是所配置的 regex 条目，而非匹配到的值。请让 regex 标签足够宽泛，使其对每个匹配都为真。

#### 正则机密

```yaml
# Obfuscate any AWS-style key
- type: regex
  content: "AKIA[0-9A-Z]{16}"

# Case-insensitive match with explicit flags
- type: regex
  content: "api[_-]?key\\s*=\\s*\\w+"
  flags: "i"

# Regex literal syntax (pattern and flags in one string)
- type: regex
  content: "/bearer\\s+[a-zA-Z0-9._~+\\/=-]+/i"
```

regex 条目总是全局扫描（`g` 标志会被自动强制）。regex 字面量语法 `/pattern/flags` 作为分开的 `content` + `flags` 字段之外的另一种写法得到支持。模式内的转义斜杠（`\\/`）会被正确处理。

#### 使用 regex 的 Replace 模式

```yaml
# One-way replace connection strings (not reversible)
- type: regex
  content: "postgres://[^\\s]+"
  mode: replace
  replacement: "postgres://***"
```

## 无效条目与文件

- 缺失的 `secrets.yml` 视为没有任何条目。
- 解析失败或非数组的文档会被忽略并发出警告。
- 无效条目会被逐条跳过并发出警告。`type` 必须是 `plain` 或 `regex`；`content` 必须是非空字符串；`mode`、`replacement`、`flags` 与 regex 语法按上文所示校验。
- 无效的可选 `friendlyName` 元数据会被丢弃，而不会连带丢弃本应有效的条目。

## 与自动检测的交互

环境变量最先收集，文件定义的条目随后，内置的凭据 regex 最后运行，这样配置条目能在通用检测器之前看到匹配内容。环境扫描中重复的环境值会被折叠。环境与文件条目之间不做去重，因此同时出现在两者的明文值会被注册两次；两个占位符都会还原到同一个机密，所以去混淆不受影响。

## 关键文件

- `packages/coding-agent/src/secrets/index.ts` -- 加载、合并、环境变量收集
- `packages/coding-agent/src/secrets/obfuscator.ts` -- `SecretObfuscator` 类、占位符生成、消息混淆
- `packages/coding-agent/src/secrets/regex.ts` -- regex 字面量解析与编译
- `packages/coding-agent/src/config/settings-schema.ts` -- `secrets.enabled` 设置的定义

## 参见

- [`auth-broker-gateway.md`](./auth-broker-gateway.md) -- 远程凭据保险库与转发代理，可让 provider 的 OAuth 刷新令牌与访问令牌完全不出现在开发者主机上（与进程内混淆互补）。
