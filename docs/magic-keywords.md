# 魔法关键词

魔法关键词（Magic keywords）是用户 prompt 中可独立出现的纯文本词，能为该回合添加隐藏的、归属于用户的指令。通知注入默认启用。TUI 在编辑时用动画渐变、在已发送消息中用静态渐变高亮已识别的词；高亮是一种视觉提示，目前在设置中禁用通知注入时仍会保留。

## 关键词

| 关键词         | 效果                                                                                                                                                                                                                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ultrathink`   | 添加一条仔细的多步推理通知。自动思考启用时，还会为该回合选择当前模型支持的最高思考档位。                                                                                                                                                                                                             |
| `orchestrate`  | 添加多 agent 编排契约：规划整个任务的范围，并行委派大量独立工作，验证每个阶段，并持续推进直到请求完成。                                                                                                                                                                                               |
| `workflowz`    | 添加一个确定性的多子 agent workflow 契约，围绕持久 `eval` 内核的 `agent()`、`completion()`、句柄、`wait()` 与 `workpool()` 辅助函数展开。它面向广泛的研究、评审、迁移与对抗性覆盖。仅在 `eval` 与 `task` 都激活时才注入该通知。                                                                      |

在 prompt 的正文任意位置使用关键词：

```text
ultrathink about the failure modes before changing this API

orchestrate the migration described in docs/plan.md

workflowz an adversarial review of the authentication changes
```

## 匹配规则

匹配是经过斟酌的，让源码与路径不会意外改变 agent 行为：

- 使用精确的小写拼写。`Ultrathink`、`Orchestrate` 与 `Workflowz` 不会触发。
- 关键词必须是独立的纯文本词。句末标点与引号可以贴着它，但字母、数字、下划线、斜杠、反斜杠、连字符、文件扩展名、符号引用与调用语法都不匹配。例如 `orchestrate,` 匹配；`orchestrated`、`orchestrate.ts`、`foo::orchestrate` 与 `orchestrate()` 不匹配。
- 围栏代码块（反引号或波浪号）、inline code 片段、HTML/XML 注释/标签/元素及其内容会被忽略。
- 同一 prompt 中所有启用的关键词都可以添加各自的通知。可见的词保留在用户消息中；隐藏通知是不可显示的、归属于用户的自定义消息。
- 该指令只作用于包含该关键词的那个回合。

## 配置

打开 `/settings` 并使用 **Interaction → Magic Keywords**，或从 shell 修改设置：

```bash
# Disable every magic keyword
omp config set magicKeywords.enabled false

# Disable one keyword while leaving the others enabled
omp config set magicKeywords.ultrathink false
omp config set magicKeywords.orchestrate false
omp config set magicKeywords.workflow false
```

全局开关与三个按关键词的开关默认都是 `true`。全局开关门控所有隐藏通知；按关键词的开关只门控那一条通知（以及 ultrathink 的最大自动思考覆盖）。这些设置目前不会禁用编辑器/消息渐变。运行 `omp config list` 可检视每个设置及其当前值。配置作用域、优先级与项目本地覆盖见 [Settings](./settings.md)。
