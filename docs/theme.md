# 主题化参考

本文档说明主题系统在编程 agent 中的工作方式：schema、加载、运行时行为与失败模式。

## 主题系统控制什么

主题系统驱动：

- TUI 各处使用的前景/背景颜色 token
- markdown 样式适配器（`getMarkdownTheme()`）
- 选择器/编辑器/设置列表适配器（`getSelectListTheme()`、`getEditorTheme()`、`getSettingsListTheme()`）
- 符号预设与符号覆盖（`unicode`、`nerd`、`ascii`）
- 原生高亮器（`@oh-my-pi/pi-natives`）使用的语法高亮颜色
- 状态行分段颜色

主要实现：`src/modes/theme/theme.ts`。

## Theme JSON 结构

主题文件为 JSON 对象，按 `theme.ts`（`themeJsonSchema`）中的运行时 schema 校验，并与 `src/modes/theme/theme-schema.json` 保持一致。

顶层字段：

- `name`（必填）
- `colors`（必填；所有颜色 token 均必填）
- `vars`（可选；可复用的颜色变量）
- `export`（可选；HTML 导出颜色）
- `symbols`（可选）
  - `preset`（可选：`unicode | nerd | ascii`）
  - `overrides`（可选：`SymbolKey` 的键/值覆盖）

颜色值接受：

- hex 字符串（`"#RRGGBB"`）
- 256 色索引（`0..255`）
- 变量引用字符串（通过 `vars` 解析）
- 空字符串（`""`），表示终端默认值（前景 `\x1b[39m`，背景 `\x1b[49m`）

## 必需与可选的颜色 token

除 `thinkingMax` 外，下面所有 token 在 `colors` 中都是必填的；它仅为兼容性而保留为可选，并回退到 `thinkingXhigh`。

### 核心文本与边框（11）

`accent`、`border`、`borderAccent`、`borderMuted`、`success`、`error`、`warning`、`muted`、`dim`、`text`、`thinkingText`

### 背景块（7）

`selectedBg`、`userMessageBg`、`customMessageBg`、`toolPendingBg`、`toolSuccessBg`、`toolErrorBg`、`statusLineBg`

### 消息/工具文本（5）

`userMessageText`、`customMessageText`、`customMessageLabel`、`toolTitle`、`toolOutput`

### Markdown（10）

`mdHeading`、`mdLink`、`mdLinkUrl`、`mdCode`、`mdCodeBlock`、`mdCodeBlockBorder`、`mdQuote`、`mdQuoteBorder`、`mdHr`、`mdListBullet`

### 工具 diff 与语法高亮（12）

`toolDiffAdded`、`toolDiffRemoved`、`toolDiffContext`、
`syntaxComment`、`syntaxKeyword`、`syntaxFunction`、`syntaxVariable`、`syntaxString`、`syntaxNumber`、`syntaxType`、`syntaxOperator`、`syntaxPunctuation`

### 模式/思考边框（8 个必填，1 个可选）

`thinkingOff`、`thinkingMinimal`、`thinkingLow`、`thinkingMedium`、`thinkingHigh`、`thinkingXhigh`、可选 `thinkingMax`、`bashMode`、`pythonMode`

### 状态行分段颜色（13）

`statusLineSep`、`statusLineModel`、`statusLinePath`、`statusLineGitClean`、`statusLineGitDirty`、`statusLineContext`、`statusLineSpend`、`statusLineStaged`、`statusLineDirty`、`statusLineUntracked`、`statusLineOutput`、`statusLineCost`、`statusLineSubagents`

## 可选 token

### `export` 段（可选）

用于 HTML 导出的主题辅助：

- `export.pageBg`
- `export.cardBg`
- `export.infoBg`

若省略，导出代码会从解析后的主题颜色推导默认值。

### `symbols` 段（可选）

- `symbols.preset` 设置主题级的默认符号集。
- `symbols.overrides` 可覆盖单个 `SymbolKey` 的值。
- `symbols.spinnerFrames` 覆盖加载 spinner 帧。接受扁平 `string[]`（应用于两种 spinner 类型）或对象 `{ "status"?: string[], "activity"?: string[] }` 以分别覆盖每种类型；未指定的类型回退到符号预设的默认帧。`status` 驱动加载器和工具执行指示器使用的约 12.5fps spinner，`activity` 驱动 markdown 进度条及类似高频 UI 使用的约 30fps spinner。

运行时优先级：

1. 设置中的 `symbolPreset` 覆盖（若已设置）
2. theme JSON 中的 `symbols.preset`
3. 回退 `"unicode"`

无效的覆盖键会被忽略并记录日志（`logger.debug`）。

#### 框线（box-drawing）边框

所有轮廓型 chrome——工具结果框、浮层、代码围栏、编辑器、欢迎横幅——都用 `boxRound.*` token 绘制：圆角（`╭╮╰╯`）加上 T 形/十字接头（`├┤┬┴┼`；这些字符没有圆角 Unicode 形式，因此取自 `boxSharp.*` token）。markdown 表格是唯一例外，使用全尖锐的 `boxSharp.*` 系列（`┌┐└┘`）。

覆盖行为遵循这一划分：

- `boxRound.{topLeft,topRight,bottomLeft,bottomRight,horizontal,vertical}` 重新设置每个边框的角与边的样式。
- `boxSharp.{cross,teeDown,teeUp,teeRight,teeLeft}` 重新设置各处的分隔线/接头样式（圆角框与表格均适用）。
- `boxSharp.{topLeft,topRight,bottomLeft,bottomRight}` 现在只影响 markdown 表格的角。

## 内置与自定义主题来源

主题查找顺序（`loadThemeJson`）：

1. 内置嵌入主题（编译进 `defaultThemes` 的 `dark.json`、`light.json` 以及所有 `defaults/*.json`）
2. 自定义主题文件：`<customThemesDir>/<name>.json`

自定义主题目录来自 `getCustomThemesDir()`：

- 默认：`~/.omp/agent/themes`
- 可被 `PI_CODING_AGENT_DIR` 覆盖（`$PI_CODING_AGENT_DIR/themes`）

`getAvailableThemes()` 返回排序后的内置 + 自定义名称合并结果，名称冲突时内置主题优先。

## 加载、校验与解析

对自定义主题文件：

1. 读取 JSON
2. 解析 JSON
3. 按 `themeJsonSchema` 校验
4. 递归解析 `vars` 引用
5. 按终端能力模式把解析后的值转换为 ANSI

校验行为：

- 缺少必需的颜色 token：给出明确的成组错误消息
- token 类型/值错误：带 JSON path 的校验错误
- 未知主题文件：`Theme not found: <name>`

变量引用行为：

- 支持嵌套引用
- 引用缺失变量时抛出异常
- 循环引用时抛出异常

## 终端颜色模式行为

颜色模式检测（`detectColorMode`）：

- `COLORTERM=truecolor|24bit` => truecolor
- `WT_SESSION` => truecolor
- `TERM` 为 `dumb`、`linux` 或空 => 256color
- 否则 => truecolor

转换行为：

- hex -> `Bun.color(..., "ansi-16m" | "ansi-256")`
- 数值 -> `38;5` / `48;5` ANSI
- `""` -> 重置为默认前景/背景

## 运行时切换行为

### 初始主题（`initTheme`）

`main.ts` 用以下设置初始化主题：

- `symbolPreset`
- `colorBlindMode`
- `theme.dark`
- `theme.light`

自动主题槽位选择按以下顺序依据终端外观：

1. 终端报告的 OSC 11 背景亮度（除非 macOS/Zellij 回退路径生效）
2. `COLORFGBG` 背景索引（`< 8` => dark，`>= 8` => light）
3. 仅对已知有问题的 macOS/Zellij OSC 11 路径使用 macOS 外观回退
4. dark 槽位回退

设置 schema 中的当前默认值：

- `theme.dark = "titanium"`
- `theme.light = "light"`
- `symbolPreset = "unicode"`
- `colorBlindMode = false`

### 显式切换（`setTheme`）

- 加载所选主题
- 更新全局 `theme` 单例
- 可选启动 watcher
- 触发 `onThemeChange` 回调

失败时：

- 回退到内置 `dark`
- 返回 `{ success: false, error }`

### 预览切换（`previewTheme`）

- 把临时预览主题应用到全局 `theme`
- 本身**不**更改持久化的设置
- 返回成功/错误，不做回退替换

设置 UI 用此功能做实时预览，并在取消时恢复之前的主题。

## Watcher 与热重载

启用 watcher 时（`setTheme(..., true)` / 交互式初始化）：

- 仅当 `<customThemesDir>/<currentTheme>.json` 存在时监视该文件
- 内置主题实际上不被监视；内置主题查找也优先于同名自定义文件
- 文件变化会安排一次防抖重载；重载出错或文件暂时缺失时保留最后成功加载的主题
- watcher 不做删除/重命名回退；它等待未来的成功重载或显式主题切换

自动模式还会根据终端外观变化、`SIGWINCH` 以及（生效时）macOS 回退观察器重新评估 dark/light 槽位映射。

## 色盲模式行为

`colorBlindMode` 在运行时只改动一个 token：

- `toolDiffAdded` 做 HSV 调整（绿色向蓝色偏移）
- 仅当解析后的值是 hex 字符串时才应用该调整

其他 token 不变。

## 主题设置保存在哪里

主题相关设置由 `Settings` 持久化到全局 config YAML：

- 路径：`<agentDir>/config.yml`
- 默认 agent 目录：`~/.omp/agent`
- 生效的默认文件：`~/.omp/agent/config.yml`

持久化的键：

- `theme.dark`
- `theme.light`
- `symbolPreset`
- `colorBlindMode`

存在旧版迁移：旧的扁平 `theme: "name"` 会根据亮度检测迁移到嵌套的 `theme.dark` 或 `theme.light`。

## 创建自定义主题（实操）

1. 在自定义主题目录中创建文件，例如 `~/.omp/agent/themes/my-theme.json`。
2. 包含 `name`、可选 `vars` 以及**全部必填**的 `colors` token。
3. 可选包含 `symbols` 与 `export`。
4. 在 Settings 中选择主题（`Appearance -> Dark Theme` 或 `Appearance -> Light Theme`），取决于你想使用哪个自动槽位。

最小骨架：

```json
{
  "name": "my-theme",
  "vars": {
    "accent": "#7aa2f7",
    "muted": 244
  },
  "colors": {
    "accent": "accent",
    "border": "#4c566a",
    "borderAccent": "accent",
    "borderMuted": "muted",
    "success": "#9ece6a",
    "error": "#f7768e",
    "warning": "#e0af68",
    "muted": "muted",
    "dim": 240,
    "text": "",
    "thinkingText": "muted",

    "selectedBg": "#2a2f45",
    "userMessageBg": "#1f2335",
    "userMessageText": "",
    "customMessageBg": "#24283b",
    "customMessageText": "",
    "customMessageLabel": "accent",
    "toolPendingBg": "#1f2335",
    "toolSuccessBg": "#1f2d2a",
    "toolErrorBg": "#2d1f2a",
    "toolTitle": "",
    "toolOutput": "muted",

    "mdHeading": "accent",
    "mdLink": "accent",
    "mdLinkUrl": "muted",
    "mdCode": "#c0caf5",
    "mdCodeBlock": "#c0caf5",
    "mdCodeBlockBorder": "muted",
    "mdQuote": "muted",
    "mdQuoteBorder": "muted",
    "mdHr": "muted",
    "mdListBullet": "accent",

    "toolDiffAdded": "#9ece6a",
    "toolDiffRemoved": "#f7768e",
    "toolDiffContext": "muted",

    "syntaxComment": "#565f89",
    "syntaxKeyword": "#bb9af7",
    "syntaxFunction": "#7aa2f7",
    "syntaxVariable": "#c0caf5",
    "syntaxString": "#9ece6a",
    "syntaxNumber": "#ff9e64",
    "syntaxType": "#2ac3de",
    "syntaxOperator": "#89ddff",
    "syntaxPunctuation": "#9aa5ce",

    "thinkingOff": 240,
    "thinkingMinimal": 244,
    "thinkingLow": "#7aa2f7",
    "thinkingMedium": "#2ac3de",
    "thinkingHigh": "#bb9af7",
    "thinkingXhigh": "#f7768e",
    "thinkingMax": "#ff007c",

    "bashMode": "#2ac3de",
    "pythonMode": "#bb9af7",

    "statusLineBg": "#16161e",
    "statusLineSep": 240,
    "statusLineModel": "#bb9af7",
    "statusLinePath": "#7aa2f7",
    "statusLineGitClean": "#9ece6a",
    "statusLineGitDirty": "#e0af68",
    "statusLineContext": "#2ac3de",
    "statusLineSpend": "#7dcfff",
    "statusLineStaged": "#9ece6a",
    "statusLineDirty": "#e0af68",
    "statusLineUntracked": "#f7768e",
    "statusLineOutput": "#c0caf5",
    "statusLineCost": "#ff9e64",
    "statusLineSubagents": "#bb9af7"
  }
}
```

## 测试自定义主题

使用这个工作流：

1. 启动交互模式（watcher 从启动起即启用）。
2. 打开设置并预览主题值（实时 `previewTheme`）。
3. 对自定义主题文件，在运行中编辑 JSON，确认保存时自动重载。
4. 检验关键表面：
   - markdown 渲染
   - 工具块（pending/success/error）
   - diff 渲染（added/removed/context）
   - 状态行可读性
   - thinking 级别边框变化
   - bash/python 模式边框颜色
5. 若你的主题依赖字形宽度/外观，请验证两种符号预设。

## 实际约束与注意事项

- 自定义主题需要全部 `colors` token，除可选的 `thinkingMax`（回退到 `thinkingXhigh`）。
- `export` 与 `symbols` 可选。
- theme JSON 中的 `$schema` 仅供参考；运行时校验由代码中兼容 ArkType 的 schema 强制执行（`src/modes/theme/schema.ts` 中的 `themeJsonSchema`）。
- `setTheme` 失败回退到 `dark`；`previewTheme` 失败不替换当前主题。
- 文件 watcher 重载错误或临时文件缺失时保留当前已加载的主题，直到成功重载或显式切换主题。
