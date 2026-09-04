# 勘误 — GPT-5 Harmony 头部泄漏

历史研究笔记，非当前运行时契约。下文统计来自具名的本地 stats
数据库快照，而非签入的测试或运行时代码。

## 当前运行时缓解措施

当前行为实现于
`packages/ai/src/utils/harmony-leak.ts` 和
`packages/agent/src/agent-loop.ts`：

- 对 Harmony 方言模型的请求在重放前会转义不可信文本、工具结果和序列化工具参数中保留的 `<|...|>` 拼写。
- 每一个 provider 为 `openai-codex` 的模型都启用响应泄漏检测，而非固定的模型 ID 列表。
- 裸的 `to=functions.NAME` 标记并不足够。检测需要一个共信号（channel 相邻、glitch token、脚本不匹配、级联、伪造结果框架，或可信的尾随解析边界）；fenced 示例被忽略。
- agent 循环扫描已定稿的可见文本和 thinking。命中时丢弃部分响应并最多重试两次，随后以错误升级。审计回调接收 action/signal 元数据以及被移除内容的哈希/脱敏预览。
- 工具参数检测在调用方未提供结构有效工具解析结束处的字节偏移时有意保持惰性。主 agent 循环当前不提供该边界，避免对讨论该协议的合法工具数据产生误中止。
- 对有界的自由格式 `eval` 输入和当前的 hashline `edit` DSL（以 `@` 开头的输入）存在恢复支持：它在被污染行处截断并追加 `*** Abort`。Apply-patch 信封和 JSON-schema edit 输入不具备恢复资格，在可用有界检测时使用中止/重试。

下文的语料表描述的是该快照中存在的历史输入格式；它们不是当前 `edit` 工具所接受语法的清单。

## 1. 问题

OpenAI 在 Harmony chat 协议中为工具调用加框：

```
<|start|>assistant<|channel|>commentary to=functions.<NAME><|message|>{ARGS}<|call|>
```

`<|channel|>commentary to=functions.NAME` 是**路由头部** ——
由运行时消费以分发调用的控制 token。正常运行下这些
token 从不作为内容出现；运行时会剥离它们。

缺陷在于：gpt-5 模型偶尔会在 `{ARGS}` 内部**作为普通内容**发出这些路由 token 的**纯文本影子** —— 相同字符但没有 `<|…|>` 括号 —— 并继续产出更多伪路由结构（channel 名、正文标记、多语言垃圾、伪造的工具结果框架）。污染存在于可见的工具参数内部，并被当作预期内容分发给工具。

**关键细节。** 真正的 `<|start|>` / `<|channel|>` /
`<|message|>` / `<|call|>` 特殊 token 几乎从不出现在工具
参数中。泄漏出来的是无括号拼写 —— `analysis to=functions.X
code …` —— 因为 OpenAI 施加了一个 logit 掩码，在 args 区域内
抑制控制 token ID。本应流向这些特殊 token 的概率质量
重新分布到模型同样学过的无括号纯文本表示上。这使得泄漏
在结构上对路由解析器不可见，并逐字落入工具输入。

工具参数中的表现（真实语料示例）：

```
~      add_function(iso, ctx, ns, "installSystemChangeObserver",
        os_install_system_change_observer);】【"】【analysis to=functions.edit
        code above เงินไทยฟรีuser to=functions.edit code …
```

开头的代码是真实且符合预期的。从第一个非拉丁 token 起、到下一个干净结构边界为止的一切都是污染。

---

## 2. 观测统计与失败模式

来源：`~/.omp/stats.db`（`ss_tool_calls`、`ss_assistant_msgs`），截至
2026-05-10。共扫描 1.05M 次工具调用。

### 2.1 比率

| 模型          | 工具参数中的泄漏 |   调用数 | 每百万      |
| ------------- | -----------------: | ------: | ----------: |
| gpt-5.4       |                 37 | 226,957 |         163 |
| gpt-5.3-codex |                 17 | 112,243 |         151 |
| gpt-5.5       |                  2 |  80,750 |          25 |
| gpt-5.2-codex |                  0 |       — |           — |

另有 15 次命中在 assistant 可见文本 / thinking 块中。

### 2.2 工具分布

| 工具                           |   命中 |
| ------------------------------ | -----: |
| `edit`                         |     38 |
| `eval`                         |     11 |
| `report_tool_issue`            |      3 |
| `grep`/`read`/`search`/`yield` | 各 1 次 |

集中在自由格式（非 JSON-schema）参数格式的工具上。

### 2.3 泄漏形状（确定性）

```
LEAK         ::= JUNK_PREFIX MARKER CHANNEL_BODY (LEAK)?
MARKER       ::= "to=functions." TOOL_NAME
CHANNEL_BODY ::= " code " (SPAM | reasoning_prose | fake_tool_output)*
JUNK_PREFIX  ::= (GLITCH_TOKEN | CHANNEL_WORD | NON_LATIN_RUN | "}" | "】【")+
```

**级联很常见。**71 条被污染记录中的 96 个标记出现里，39 条包含 ≥2 个标记，7 条包含 ≥3 个 —— 模型背靠背发出多个伪造的 `to=functions.X code …` 块，中间常夹着伪造的 `code_output\nCell N:\n…` 框架。一旦纯文本脚手架进入残差流，前缀现在_看起来就像_一个全新的工具信封开始，于是关于续写的宏观先验持续为更多脚手架投票。自我放大。

### 2.4 Glitch token

`o200k_base` 中的单 token 标识符，其嵌入表现为近初始化状态，源于后训练中的欠代表性。自然语料中紧邻标记之前的 ASCII 残留：

| 表面字符串        | 单 token      | Token ID |                  语料命中        |
| ----------------- | :----------: | -------: | ------------------------------: |
| `Japgolly`        |      ✅      |  199,745 |                               1 |
| `Jsii`            |      ✅      |  114,318 | (subtoken of `Jsii_commentary`) |
| `Jsii_commentary` |  — (3 toks)  |        — |                               2 |
| `changedFiles`    |  — (2 toks)  |        — |                               8 |
| `RTLU`            |  — (2 toks)  |        — |                               3 |

`Japgolly` 位于词表最后的 0.13% —— 与 2023 年 GPT-2 词表中产生 `SolidGoldMagikarp` 的 GitHub 语料残留同族（Rumbelow & Watkins）。`SolidGoldMagikarp` 本身在 `o200k_base` 中分词为 5 个 token —— 那个特定 token 被退役了，但这个类别没有。

对多 token 条目而言，语料层面的签名是表面字符串；底层的 glitch 触发是一个子 token（例如 `Jsii_commentary` 中的 `Jsii`）。检测器列表（`G` 信号）以表面字符串为键。

在无关会话间保持稳定。被视为高精度检测信号。

### 2.5 Channel 词泄漏

`analysis`（5）、`assistant`（5）、`commentary`（3）、`user`（1）直接出现在 `to=` 之前。总是裸词；从不是 `<|channel|>analysis` 或任何其他带括号形式。与 §1 一致 —— 括号被掩蔽，而词没有。

### 2.6 非拉丁垃圾残留

96 次标记命中，按文字：CJK 40、西里尔 12、Telugu/Kannada/Malayalam
18、泰文 8、格鲁吉亚文 7、亚美尼亚文 7、阿拉伯文 1。反复出现的片段是
中文赌博 SEO（`大发时时彩`、`天天中彩票`）、格鲁吉亚/阿布哈兹垃圾，以及泰文赌场垃圾 —— 众所周知的低质量爬取残留。

这与受控复现（§7.3）中观察到的文字分布相同，与 prompt 的自然语言无关。

### 2.7 `edit` 工具的失败模式细分

语料中 `edit` 工具存在两个变体：

| 变体                                               | 调用数 | 恢复                                                                                                                                                 |
| -------------------------------------------------- | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Patch-DSL（`[PATH#TAG]`/锚点/`SWAP DEL INS` 操作） |    27 | **可恢复**，经操作截断（§3.3）                                                                                                                       |
| JSON-schema（`{path,edits:[…]}`）                  |    11 | **不可恢复** —— 污染被转义在 JSON 字符串_内部_，解析器干净地接受它，内容将逐字写入源文件                                                              |

仅就 Patch-DSL 泄漏而言：

- 20/27 例：污染在最后一输入行；其后无内容。
- 7/27 例：污染在输入中部；其后是以下之一：对更早文件/锚点的重复重放、面向_另一个_工具调用的预期内容（模型将其下一次调用内联开始），或纯幻觉。污染之后的内容永远不可信。

### 2.8 机制（已确认）

**由空嵌入 glitch token 引发的先验坍缩，落入一个
控制 token 被掩蔽的盆地，其概率质量重新分布到
Harmony 协议的纯文本影子上。**

逐步说明：

1. 模型正处于 Harmony 工具调用的 `{ARGS}` 中。运行时施加
   一个 logit 掩码，在 args 区域内抑制结构性控制 token（`<|channel|>`、
   `<|message|>`、`<|call|>`、`<|start|>`、`<|end|>`）。没有这个掩码，正常生成会不断
   幻觉出信封关闭；有了它，这些 token ID 在 args 中 logit 为
   `-∞`。
2. 采样到一个 glitch token `g`。按构造，`g` 在 BPE
   合并语料中存在但在 LM/RL 训练中几乎不存在，因此其**输入嵌入
   `e_g` ≈ 小范数的近初始化噪声**。
3. 在位置 t+1，残差更新 `h_{t+1} ≈ LN(h_t + e_g + Attn +
   MLP)` 由前缀派生项主导；刚发出 token 的
   信号实际上缺席。生成多样性通常来自 `e_x` 将残差引导到不同子区域 ——
   此处被剥离。
4. 因此下一 token 分布坍缩到**去除局部条件后的前缀续写条件先验**上。在工具调用 rollout 上下文中，该先验在 Harmony 脚手架（控制 token + 路由 token）上急剧尖峰化 ——
   这正是 RL 训练的内容。
5. 掩码将控制 token ID 置零。质量重新分布到**次优续写**上：同一协议的无括号表面形式拼写（`analysis`、`commentary`、` to=functions.X`、
   `code`）。这一拼写未被掩蔽，因为这些字符是
   普通 token。
6. 一旦少量纯文本脚手架 token 落入残差
   流，前缀现在就类似于一个全新的信封开始。宏观
   先验持续为更多脚手架投票。级联（§2.3）随之而来。
7. 标记之后的多语言垃圾是同一种先验坍缩
   续写，抽取自 glitch token 的训练邻域（通常是 ESL/自动生成的多语言网页垃圾 —— 恰好是 §2.6 中的爬取残留）。

**语料数据要求解释、而只有实验解释了的两条推论：**

- **括号从不出现在工具参数中**（§1、§2.5）。掩码正是使泄漏
  以纯文本落地而非真正信封关闭的原因。
- **反直觉的语法依赖**（§7.4）。格式越接近 OpenAI 的训练分布，泄漏_越严重_。偏离分布的
  自定义语法会削弱宏观先验盆地；官方
  `*** Begin Patch` 格式是最强的坍缩目标。

2023 年的 SolidGoldMagikarp 论文记录了机制 (1)+(2)+(4)。
新的部分是 (5)：当受约束解码掩蔽了自然坍缩
目标时，经未掩蔽纯文本影子洗过的质量
就成为一条结构上不可见的渗出通道。
