# ask

> 提示交互式用户回答一个或多个选项选择（option-picker）或自由填写（free-form）形式的问题。

## 源码位置
- 入口：`packages/coding-agent/src/tools/ask.ts`
- 面向模型的提示词：`packages/coding-agent/src/prompts/tools/ask.md`
- 主要协同文件：
  - `packages/coding-agent/src/config/settings-schema.ts` — `ask.timeout` / `ask.notify` 默认值
  - `packages/coding-agent/src/modes/theme/theme.ts` — TUI 渲染用的复选框与单选框字形
  - `packages/coding-agent/src/tui/index.ts` — 状态行渲染

## 输入

| 字段 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `questions` | `Question[]` | 是 | 一个或多个问题。空数组会被 schema 拒绝，并在运行时同样会被拦截。 |

### `Question`

| 字段 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `id` | `string` | 是 | 多问题结果中使用的稳定标识符。 |
| `question` | `string` | 是 | 展示给用户的提示文本。 |
| `options` | `{ label: string; description?: string; preview?: string }[]` | 是 | 选择器选项。`description` 是说明性文本；`preview` 为富 ask 对话框提供可选的富预览内容。不强制最小/最大数量。运行时会自行添加控件；调用方不得使用保留标签 `Other (type your own)`、`Chat about this` 或 `Next →`。 |
| `header` | `string` | 否 | 富 ask 对话框使用的可选短显示徽标。选择器回退模式会忽略它。 |
| `multi` | `boolean` | 否 | 启用多选模式。默认：`false`。 |
| `recommended` | `number` | 否 | 从零开始计数的推荐/默认选项索引。无效索引在选择时会被忽略；回退选择器会用 ` (Recommended)` 标记有效的单选选项。 |

## 输出
- 单次结果。
- `content[0].text` 为纯文本：
  - 单个问题：所选/自定义答案，外加可选的 `User added note: ...`
  - 多个问题：`User answers:` 后跟每个 `id` 一行
  - 富对话框聊天重定向：`User chose to chat about this instead of answering...`
- `details`：
  - 单个问题：`{ question, options, multi, selectedOptions, customInput?, note?, timedOut? }`
  - 多个问题：`{ results: QuestionResult[] }`；每项包含 `id`、`question`、`options`、`multi`、`selectedOptions`，以及可选的 `customInput`、`note` 和 `timedOut`
  - 聊天重定向：`{ chatRedirect: true, questions: string[] }`
- 取消与无头（headless）场景会抛出异常，而不是返回结构化的成功结果。该工具不会流式输出更新。

## 流程
1. `AskTool.createIf()` 仅在 `session.hasUI` 为 true 时才注册该可发现工具；无头会话永远不会获得它。
2. `execute()` 还要求 `context.hasUI` 与 `context.ui`；若缺失，它会中止上下文并抛出 `ToolAbortError("Ask tool requires interactive mode")`。
3. 它会从设置中读取 `ask.timeout`，把秒转换为毫秒（`0` 表示禁用超时），并在启用 plan 模式时完全禁用超时。
4. 若 `ask.notify` 不是 `off`，它会发送一条终端通知：`Waiting for input`。当 `speech.enabled` 为 true 时，它还会在打开对话框前把所有问题文本发送给语音合成器（vocalizer）。
5. 当 UI 提供 `askDialog` 时，工具会打开一个富多问题表单。富选项会收到 `header`、`description` 与 `preview`；结果可包含回答备注，也可选择对话框的 `Chat about this` 重定向。
6. 否则对每个问题使用选择器/编辑器回退：
   - 单选列表外加 `Other (type your own)`
   - 多选复选框循环，适用时外加 `Done selecting` 与 `Other (type your own)`
7. 在回退多问题模式下，左/右方向键处理程序可向前/向后移动并保留先前的回答。最后一个问题在选择后会自动前进。
8. 若在回答前触发超时，回退模式会自动选择有效的推荐选项，否则选择第一个选项；结果文本会附上 ` (auto-selected after timeout)`，并设置 `details.timedOut`。富对话框会报告自身的 `timedOut` 回答。
9. 若用户在未超时的情况下取消，`execute()` 会中止工具上下文并抛出 `ToolAbortError("Ask tool was cancelled by the user")`。
10. 成功时它会格式化人类可读的文本以及结构化的 `details`；TUI 渲染器使用 `details` 进行富结果展示。

## 模式 / 变体
- 单个问题：返回扁平化的 `details` 字段。
- 多个问题：返回 `details.results[]`；回退模式允许用方向键前后导航，而富 UI 会呈现完整表单。
- 单选：一个选项或自定义输入。
- 多选：切换选择的选项或自定义输入。在回退模式中，仅当未处于向前导航且至少选中一个选项时才显示 `Done selecting`。
- 富 ask 对话框：支持按问题设置 header、选项预览、回答备注，以及 `Chat about this` 重定向。
- 选择器/编辑器回退：支持 label/description，但不支持 header、预览、备注或聊天重定向。

## 副作用
- 用户可见的提示 / 交互式 UI
  - 当 UI 提供富表单 API 时使用 `context.ui.askDialog(...)`；否则使用选择器/编辑器回退。
  - 通过 `context.ui.select(...)` 打开选择对话框。
  - 通过 `context.ui.editor(...)` 为 `Other` 打开文本编辑器对话框。
  - 发送终端通知，除非 `ask.notify=off`。
  - 当 `speech.enabled=true` 时，通过语音合成器朗读问题文本。
- 会话状态
  - 读取 plan 模式状态以禁用超时。
  - 在无头使用或用户取消时调用 `context.abort()`。
- 后台工作 / 取消
  - 用 `untilAborted(...)` 包装 UI 等待，使中止信号能够打断挂起的对话框。

## 限制与上限
- `questions` 必须至少包含 1 项。由于 `AskTool.strict=true`，未知字段会被拒绝。
- `ask.timeout` 默认为 `0` 秒（禁用）；配置的非零值为秒数。plan 模式始终禁用它。
- 提示词指导建议提供 2–5 个选项，但代码只要求存在 `options` 数组字段，不强制最小或最大长度。
- 选项标签不得等于保留的运行时标签 `Other (type your own)`、`Chat about this` 或 `Next →`。
- 回退模式的超时仅适用于选项选择器；一旦用户选择 `Other`，编辑器不再有超时。
- `AskTool.concurrency = "exclusive"`：该工具在自己的工具批次中单独运行，因为选择器/编辑器 UI 界面是共享的，并发的 `ask` 调用会互相干扰。
- 调用渲染器会为显示而规范化不完整或畸形的流式参数：裸字符串选项会变成标签，不可用的 question/option 条目会被省略。执行阶段收到的仍是经 schema 校验的输入。

## 错误
- 缺少交互式 UI：抛出 `ToolAbortError("Ask tool requires interactive mode")`。
- 用户在没有超时的情况下取消选择器/编辑器：抛出 `ToolAbortError("Ask tool was cancelled by the user")`。
- 输入期间收到中止信号：转换为 `ToolAbortError("Ask input was cancelled")`。
- 运行时的空 `questions` 会返回文本错误负载而不是抛出异常：`Error: questions must not be empty`。
- 违反富对话框约定（结果数量、id 或顺序错误）会抛出 `Error`。

## 备注
- `recommended` 只是 UI/默认提示；无效索引会被忽略。若没有有效的推荐项，超时回退会使用第一个选项。
- 在回退单选模式下，返回的 `selectedOptions` 值会去掉追加的 ` (Recommended)` 后缀。
- 多选结果按 `Set` 插入顺序保留选择顺序，而不是在任意切换后按原始选项顺序。
- 选项标签与提示文本会原样返回在 `details` 中。description/预览/header 只用于引导呈现，不会被复制进结果 details。
- `/tree` 可以从持久化的 `ask` 调用中恢复经过 schema 校验的原始 `questions` 并重新打开，以创建同级的回答分支；格式错误的旧参数会按失败关闭（fail closed）处理。
