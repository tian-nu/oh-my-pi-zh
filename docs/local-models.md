# 嵌入式本地 Tiny 模型实验

本文档总结了可选 **本地** tiny 模型路径背后的实验：用于会话标题生成
（`providers.tinyModel`）、Mnemopi 记忆提取/整合
（`providers.memoryModel`），以及 `auto` 思考难度分类器
（`providers.autoThinkingModel`，它使用记忆模型注册表）。这是给维护者的事实性工程记录：
我们测量了什么、哪些配方胜出、我们最终发布了哪些模型。三个设置
默认都是 `online`，因此现有用户不会产生任何下载或设备端推理成本，除非
主动启用。在在线路径上，优先使用配置的 `tiny` 角色，当该角色未设置时
使用任务特定的在线回退。

## 运行时 / 环境发现

- **技术栈**：运行于 Bun 下的 `@huggingface/transformers`（transformers.js）v4。在 Bun 中该库
  加载 **原生 `onnxruntime-node` 后端**（而非 WASM 构建）。
- **非 FHS 发行版（NixOS，以及任何 loader 路径上没有 `libstdc++.so.6` 的主机）**：
  按需加载的 `onnxruntime-node` / `sherpa-onnx-node` / `sharp` addon 是预编译二进制，
  它们 `dlopen` `libstdc++.so.6` 与 `libgcc_s.so.1`，并携带自己的 `DT_RUNPATH`，因此 omp
  可执行文件自身的 RPATH 中没有任何东西能解析它们。请把 `OMP_NATIVE_LIBRARY_PATH` 设为
  存放这些库的冒号分隔目录；omp 只对推理 worker 子进程把它追加到 `LD_LIBRARY_PATH`
  （绝不对 shell/eval/daemon 子进程）。Nix 包
  （`nix/package.nix`）默认设置此项。
- **每模型一个 worker，且非持久 keep-alive**：每个本地模型恰好由拥有 socket 的机器上的
  一个 worker 进程服务：socket 为 `~/.omp/run/tiny/<model>-<backend>.sock`
  （Windows 上为命名管道）。第一个需要该模型的 omp 进程以 detached 方式生成 worker
  （日志紧邻 socket，为 `*.sock.log`）；其他每个 omp 进程只是连接，因此模型
  只驻留一次而非每实例一次。没有任何东西监督它：worker 在没有请求
  15 分钟后自行退出（`OMP_TINY_WORKER_IDLE_MS` 供测试覆盖该窗口），
  解除其 socket 链接，任意 omp 进程的下一个请求会生成一个新的 worker。并发
  生成在 `.bind.lock` 文件锁上竞争：输者看到存活的 socket 便退出，而其父进程
  采纳胜者。`ping` 返回启动标签（`<omp version>|onnx|<device>|<dtype>` 或
  `mlx|<mlx-lm version>|<script crc>`），因此 omp 升级或改变的
  `providers.tinyModelDevice`/`Dtype` 会告诉运行中的 worker 关闭并重新生成它。
  两个并发实例若带有*冲突*的设备设置，会不断替换彼此的
  worker，所以要统一一个。协议是消息级的（`load`、带 messages / prefill /
  stop / max tokens 的 `chat`）；prompt 构造与标题提取位于客户端，因此两种 worker
  种类可互换。
- **设备策略**：本地 tiny 模型默认仅 CPU 推理，若显式的加速 provider
  无法初始化，则在 CPU 上重试一次。
  - 用 `providers.tinyModelDevice` 设置持久选择 provider（`default` 保持 CPU），
    或用 `PI_TINY_DEVICE` env var 按运行选择（后者覆盖该设置）。
  - 可接受值为 `cpu`、`gpu`、`mlx`/`metal`、`webgpu`、`auto`、`cuda`、`dml`、`coreml`、
    `wasm`、`webnn`、`webnn-gpu`、`webnn-cpu` 与 `webnn-npu`。
  - 直接 `coreml` 仍通过 `PI_TINY_DEVICE=coreml` 选择启用；它不是默认的一部分，因为
    缓存的 decoder-LLM ONNX 加载可能在会话初始化期间失败。
  - WebGPU/Metal 可用于单进程 eval harness，但生产 worker 会强制
    Darwin 的 `gpu`/`webgpu`/`auto` 请求回到 CPU，因为 ONNX Runtime/Bun 目前
    在 WebGPU 推理后的 worker teardown 上硬崩溃。
  - 仅当你显式放弃 CPU 默认时，才使用 `providers.tinyModelDevice` 或
    `PI_TINY_DEVICE`。
- **MLX 后端（Apple silicon）**：`PI_TINY_DEVICE=mlx`（或 `metal`）替换 worker 本身，而非
  ONNX provider：每模型 worker 是 `mlx-server.py`，从 omp 在首次使用时
  安装于 `~/.omp/agent/cache/tiny-mlx-runtime/` 的固定 `mlx-lm` venv 运行（经 `uv`，否则
  `python3 -m venv`，需 Python ≥ 3.10）。它把模型的预量化 4-bit MLX 导出
  （注册表中的 `mlxRepo`）下载到 `~/.omp/agent/cache/tiny-models/mlx/`，带逐字节进度，
  用 `mlx_lm.load` 加载，并说 ONNX worker 所说的同一协议，因此标题、
  记忆补全与 `auto` 思考分类器都无需改动即可工作，且 Python 进程
  是唯一涉及的进程。`PI_TINY_DTYPE` 被忽略。若 venv 引导失败（无 Python、
  安装错误、非 Apple 主机），omp 记录警告并为该进程的剩余部分使用 ONNX CPU worker。
  在 M4 Max 上测得：冷 venv 安装 + LFM2.5-230M 下载 + 加载 15.7s；第二个 omp 实例
  远不到一秒即挂接到运行中的 worker；warmup 后标题 15–60ms；
  Qwen3-1.7B（在 onnxruntime-node 上受阻）下载 984MB，约 200ms 内完成一次记忆
  提取回答。
- **量化：q4 是最佳点** —— 磁盘占用更小、加载更快、推理也快。
  q8/int8 在 CPU 上加载更慢_且_推理更慢。每个已发布模型默认 `q4`；要持久覆盖
  精度，用 `providers.tinyModelDtype` 设置（`default` 保持 `q4`，例如 `fp16`
  以获得更高保真度），或用 `PI_TINY_DTYPE` 按运行覆盖（后者覆盖该设置）。可接受 `auto`、
  `fp32`、`fp16`、`q8`、`int8`、`uint8`、`q4`、`bnb4`、`q4f16`、`q2`、`q2f16`、`q1`、`q1f16`；
  无法识别的值会在 worker 启动时响亮地失败。
- **加载时间修正（重要）。** 早先认为 "q4 >=1B 的模型需要数分钟加载"
  是**测量假象**：由并行运行约 5 个多 GB 的 HuggingFace 下载
  （I/O 饱和）造成。干净、隔离的 **warm** 加载都在 3s 内：
  - TinyLlama-1.1B q4：约 0.5s
  - Llama-3.2-1B q4：约 2.8s（`graphOpt=all`）/ 约 0.5s（`disabled`）
  - LFM2-1.2B q4：约 0.36s
  - Qwen2.5-1.5B q4：约 1.5s
  - Qwen3-1.7B q4：约 1.6s
  - gemma-3-1b q4：约 1.1s
  - 结论：**1B–1.7B 模型在 CPU 上可行。**
- **`session_options.graphOptimizationLevel`** 权衡加载与推理速度：`disabled` = 加载最快、
  推理略慢；`all` = 默认。
- **首次运行**从 HF Hub 下载权重到缓存目录（q4 权重约 150MB–1.1GB，视
  模型而定）；随后的 **warm** 加载在亚秒到约 3s 之间。推理是异步的，对
  记忆任务后台友好；标题近乎交互式。

## 任务 1：会话标题生成（`providers.tinyModel`）

**任务**：把第一条用户消息变成 3–7 个词的标题。Tiny 模型（sub-1B）即可胜任。

**胜出的配方**：

- 纯系统 prompt（无 few-shot）。
- 用 `<title>` **prefill** assistant 轮次并在 `</title>` **停止**，然后取第一行。
- 贪心解码（`do_sample:false`），chat template 中 `enable_thinking:false`。

**我们学到的东西**：

- **Few-shot 示例会污染 sub-0.6B 模型的标题**，使其复制示例主题。共享 prompt
  对嵌入式模型关闭示例，同时为能力强的在线模型保留它们。
- **大小写指令在最小的模型上会变成输出**。[`normalizeGeneratedTitle`](../packages/coding-agent/src/tiny/text.ts)
  在生成后调和大小写，因此 prompt 省略该规则。
- **Token 偏置（`bad_words_ids`）在这里确认无效** —— prefill 已控制
  开头。

**替换基准**（30 个近期首会话 prompt，q4 CPU，无示例）：

| 模型              | 缓存 | Warm 平均 / p95 | 3–7 词 | 观察到的取舍                               |
| ------------------ | ----: | --------------: | ----------: | ----------------------------------------------- |
| LFM2.5-230M        | 214MB |      93 / 194ms |       21/28 | 最佳语义平衡；偶有通用标题 |
| Falcon-H1-Tiny-90M | 147MB |     117 / 174ms |       17/29 | 最小；复杂输入上保真度较低       |
| LFM2.5-350M        | 292MB |     166 / 266ms |        4/30 | 极其简短，常为单个词的标签       |

**已内置的本地选项**：`lfm2.5-230m`、`lfm2.5-350m`、`falcon-h1-90m`。
**默认设置**：`online`。`omp tiny-models` 的默认本地下载是 `lfm2.5-230m`。

## 任务 2：Mnemopi 记忆（`providers.memoryModel`）

Mnemopi 运行两个 small-LLM 任务：

1. **提取** —— 从单条消息中拉取持久、结构化的条目。
2. **整合** —— 把记忆列表总结成 1–3 句忠实的句子。

这些需要**比标题更大的模型：1B–1.7B**。我们通过四个并行 agent 测试了 LFM2-1.2B、
Qwen2.5-1.5B、Qwen3-1.7B 与 gemma-3-1b（q4，CPU），每个运行 27–31 次实验。

### 提取发现

原装 5 类 JSON prompt 在小型模型上有两种失败方式：

1. 全空示例 `{"facts":[],...}` 被**逐字复制** → 提取出 0 条事实。
2. 有能力的模型会发出**数组内的 JSON 对象**，Mnemopi 的 `String(item)` 会把它强转为
   字面字符串 `[object Object]`。

稳健的修正是**每行一条的输出格式**（由 Mnemopi 解析器的 line-fallback 消费）
或**扁平 JSON 字符串数组**。每个模型还会过度提取纯粹的闲聊；显式的
chit-chat → NONE 示例是最好的缓解手段。

### 技法取舍与标题任务相反

- 在 1B+ 规模，**few-shot 是主导质量杠杆**：例如 Qwen2.5-1.5B 提取 F1 从 1 shot 到
  3 shots 由 0.52 → 0.83；gemma 用 2 shots 时 recall 0.65 → 0.92。
- **Prefill 有损提取** —— 它会在闲聊上强行输出，产生误报。
- **System-split**（把指令放入 system 角色）对有 system 角色的模型有帮助。
- 两个任务都是**贪心 >= temperature**。
- **Token 偏置**再次无效。

### 各模型评价（两两对比，16 个 fixture 的测试集）

- **Qwen3-1.7B** —— 提取最有纪律：闲聊返回空、无埋藏事实泄漏、
  保留语言、干净的扁平 JSON。缺点：粒度粗，漏掉一次多轮值
  更新。
- **Qwen2.5-1.5B** —— 提取粒度最佳（原子事实）、抓住了值更新、零
  闲聊泄漏。缺点：整合最弱（run-on、不去重），另有一次退化的
  埋藏事实输出。
- **gemma-3-1b** —— 整合最佳（去重有效、忠实、干净的单一记忆）。缺点：泄漏
  闲聊且翻译了德语。
- **LFM2-1.2B** —— 扎实且加载最快。缺点：`Label: value` 噪声、闲聊与埋藏
  泄漏、轻飘飘的单一记忆摘要。

### 推荐与当前可用性

实验在提取精度上偏向 **Qwen3-1.7B**，但已发布的 ONNX 导出目前
无法在 `onnxruntime-node` 下运行：其 RotaryEmbedding 缓存更新不受支持。
运行时会在加载模型前拒绝该选择，而不是在推理期间失败。

在可运行的选项中，注册表把 `lfm2-1.2b` 标为推荐的本地记忆模型。
`gemma-3-1b` 偏向整合质量，而 `qwen2.5-1.5b` 偏向细粒度提取。

**已配置的本地选项**：`llama3.2:3b`、`qwen3-1.7b`（如上所述当前已禁用）、
`gemma-3-1b`、`qwen2.5-1.5b`、`lfm2-1.2b`。
**默认设置**：`online`。

### 已知的 Mnemopi parser bug（由这些实验暴露）

- `String(item)` 对对象数组条目产生 `[object Object]`。
- line-fallback 会丢弃 `<=10` 字符的条目，因此像 `Name: Can` 这样正确的短事实会被丢弃。

## 集成备注

- `providers.tinyModel`、`providers.memoryModel` 与 `providers.autoThinkingModel` 默认
  为 `online`，因此现有用户**不会产生下载或设备端推理成本**，除非主动启用。
- 本地推理**在 worker 中**运行（脱离主线程）；模型缓存在磁盘上，
  首次使用时下载。
- 记忆本地路径通过 Mnemopi prompt 覆盖应用改进后的配方（行格式 + 防闲聊的提取
  prompt、加固的整合 prompt）；**在线路径
  不变**。
- `providers.autoThinkingModel` 使用与 `providers.memoryModel` 相同的已内置本地选项。
