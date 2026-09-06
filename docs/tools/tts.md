# tts

> 根据文本生成语音音频文件，并写入 `output_path`。

## 源码
- 入口：`packages/coding-agent/src/tools/tts.ts`
- 本地语音目录：`packages/coding-agent/src/tts/models.ts`
- 本地 worker 客户端：`packages/coding-agent/src/tts/tts-client.ts`
- 会话注入：`packages/coding-agent/src/sdk.ts`（`speechgen.enabled`）

SDK 仅在 `speechgen.enabled=true`（默认 `false`）时注册这个已获 write 批准的自定义工具。

## 输入

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `text` | `string` | 是 | 要合成的文本。长度必须在 `1..15000` 字符之间。 |
| `voice_id` | `string` | 否 | 语音 id。在 xAI 上默认为 `eve`；本地后端改用 `tts.localVoice`；DeepInfra 仅在设置时才转发它（模型特定 id，否则用服务端默认值）。 |
| `language` | `string` | 否 | xAI 的语言提示。默认为 `en`。 |
| `output_path` | `string` | 是 | 相对会话 cwd 解析的目标路径。 |
| `sample_rate` | `number.integer` | 否 | xAI 采样率覆盖。本地与 DeepInfra 后端会忽略。 |
| `bit_rate` | `number.integer` | 否 | xAI MP3 比特率覆盖。WAV 以及本地与 DeepInfra 后端会忽略。 |

## 输出
- 成功时：
  - `content[0].type = "text"`
  - `content[0].text = "Saved <bytes> bytes to <path> (voice=<voice>, codec=<codec>, backend=<backend>...)."`
  - `details = { bytes, voiceId, codec, backend }`
- 凭据缺失（xAI 或 DeepInfra）、云端 HTTP 失败以及本地 worker 返回 `null` 时，返回 `isError: true`，带一个文本块且无 `details`。其他异常、取消与超时则向上传播。

## 流程
1. SDK 仅在 `speechgen.enabled` 为 true 时注入 `tts`。
2. `output_path` 相对会话 cwd 解析。请求的 codec 由其大小写不敏感的后缀推断：`.wav` 表示 WAV，其他一律表示 MP3。
3. `providers.tts`（默认 `auto`）选择路由（`local` / `xai` / `deepinfra` / `auto`）：
   - `local`：始终使用本地设备端后端。
   - `xai`：始终使用 xAI Grok Voice；缺少凭据时返回错误结果。
   - `deepinfra`：始终使用 DeepInfra 兼容 OpenAI 的语音端点；缺少凭据时返回错误结果。
   - `auto`：优先使用本地，但当存在 xAI 凭据时会把 MP3 请求路由到 xAI，因为只有云端路径能输出 MP3。
4. 本地合成忽略每次调用传入的 `voice_id`、`language`、`sample_rate` 和 `bit_rate`；它使用 `tts.localModel` 与 `tts.localVoice`，通过共享的 ONNX tiny-model worker 调用 Kokoro-82M，编码为 PCM16 WAV 并写入 WAV 文件。
5. xAI 合成解析 Grok Voice 凭据，调用 `<baseURL>/tts`，并直接写入 provider 返回的字节。仅当 WAV、采样率或 MP3 比特率与 xAI 默认值不同时才发送显式的 `output_format`。
6. DeepInfra 合成解析 DeepInfra API key，向 `https://api.deepinfra.com/v1/openai/audio/speech` POST `{ model, input, response_format, voice? }`（模型 `hexgrad/Kokoro-82M`），并直接写入 provider 返回的字节；仅当调用方设置了 `voice_id` 时才转发 `voice`。

## 模式 / 变体
- 本地后端：完全设备端 Kokoro-82M，模型权重就绪后无网络 provider 调用；输出始终为 WAV/PCM16。
- xAI 后端：Grok Voice 云端合成；输出可为 MP3 或 WAV。
- DeepInfra 后端：兼容 OpenAI 的 `/audio/speech` 云端合成（`hexgrad/Kokoro-82M`）；输出可为 MP3 或 WAV。
- Auto 后端：默认本地，除非 MP3 路径加上 xAI 凭据需要走云端路由。

## 副作用
- 文件系统：写入 `output_path`；本地合成收到非 WAV 目标时写入同级的 `.wav` 路径。
- 网络：xAI 后端调用配置的 xAI/Grok Voice HTTP 端点；DeepInfra 后端调用 `api.deepinfra.com`；本地后端可能通过 tiny-model 栈下载/缓存模型权重。
- 会话状态：读取 cwd、模型注册表以及设置 `providers.tts`、`tts.localModel` 和 `tts.localVoice`。
- 后台工作 / 取消：云端调用（xAI 与 DeepInfra）使用 60 秒超时；本地合成接收调用方的 abort 信号。
- 流式 / 更新：合成为单次完成，不发出 `onUpdate` 进度。

## 限制与上限
- 文本 schema 限制：`1..15_000` 个 JavaScript 字符串字符。
- xAI 默认值：voice `eve`、language `en`、采样率 `24000`、比特率 `128000`；非 `.wav` 路径请求 MP3。
- DeepInfra 默认模型：`hexgrad/Kokoro-82M`；未设置 `voice_id` 时使用服务端默认语音。
- 描述中列出的内置 xAI 语音：`ara`、`eve`、`leo`、`rex`、`sal`；自定义 xAI voice id 也可接受。
- 默认本地模型：`kokoro`（`onnx-community/Kokoro-82M-v1.0-ONNX`，q8）。
- 默认本地语音：`af_heart`；支持的本地语音包括 `af_heart`、`af_bella`、`af_nicole`、`af_aoede`、`af_kore`、`af_sarah`、`am_michael`、`am_fenrir`、`am_puck`、`bf_emma`、`bm_george` 与 `bm_fable`。

## 错误

- 缺少 xAI 凭据返回错误结果：`No xAI credentials. Run /login → xAI Grok OAuth (SuperGrok or X Premium+) or set XAI_API_KEY.`
- 缺少 DeepInfra 凭据返回错误结果：`No DeepInfra credentials. Run /login → DeepInfra or set DEEPINFRA_API_KEY.`
- 云端 HTTP 失败（xAI 或 DeepInfra）返回错误结果，最多包含 provider 详情的开头 300 个字符：`<xAI TTS|DeepInfra TTS> failed (<status>): <detail>`。
- 本地 worker 返回 `null` 时返回错误结果，注明模型 key 以及可能的 worker/模型下载问题。
- 调用方取消、60 秒云端超时、文件系统写入错误以及本地 worker 抛出的失败都会向上传播，而不是包装成 `isError` 结果。

## 备注
- 本地刻意不内置 MP3 输出。对 `speech.mp3` 的本地请求会写入 `speech.wav`，并在工具结果中如此说明。
- `voice_id` 与 `language` 是 xAI 请求体字段；本地语音选择来自设置，这样模型调用无需在每次调用时枚举本地 voice id。
