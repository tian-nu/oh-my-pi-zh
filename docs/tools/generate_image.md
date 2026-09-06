# generate_image

> 生成或编辑图像，并把生成的图像文件写入临时路径。

## 源码
- 入口：`packages/coding-agent/src/tools/image-gen.ts`
- 面向模型的 prompt：`packages/coding-agent/src/prompts/tools/image-gen.md`
- 会话注入：`packages/coding-agent/src/sdk.ts` (`getImageGenTools()`)

仅当 `generate_image.enabled=true`（默认 `false`）且会话的显式工具过滤器（如有）请求了 `generate_image` 时，才会注册该自定义工具。

## 输入

| 字段 | 类型 | 必需 | 描述 |
|---|---:|---:|---|
| `subject` | `string` | 是 | 主要图像 prompt。编辑时，请描述期望结果与每张输入图像的作用。 |
| `action` | `string` | 否 | subject 正在做什么。 |
| `scene` | `string` | 否 | 地点或环境。 |
| `composition` | `string` | 否 | 镜头角度与构图。 |
| `lighting` | `string` | 否 | 光照设置。 |
| `style` | `string` | 否 | 艺术风格。 |
| `text` | `string` | 否 | 要在图像中渲染的文本。请保持简短，需要时注明清晰度。 |
| `changes` | `string[]` | 否 | 对输入图像的编辑指令。 |
| `aspect_ratio` | `"1:1" \| "3:4" \| "4:3" \| "9:16" \| "16:9" \| "3:2" \| "2:3"` | 否 | 请求的输出宽高比。 |
| `image_size` | `"1024x1024" \| "1536x1024" \| "1024x1536"` | 否 | 请求的输出尺寸（所选 provider 支持时）。 |
| `input` | `Array<{ path?: string; data?: string; mime_type?: string }>` | 否 | 通过本地路径或内联 base64 数据提供的输入图像。 |
| `provider` | `"auto" \| "openai" \| "openai-codex" \| "antigravity" \| "xai" \| "openrouter" \| "gemini" \| "deepinfra"` | 否 | 每次请求的 provider 偏好。先尝试具体值；`auto` 或省略时使用配置/会话顺序。 |

## 输出
- 成功且带图像数据时：
  - `content[0].type = "text"`
  - `content[0].text` 总结 provider/model 与已保存的图像路径。
  - `details = { provider, model, imageCount, imagePaths, images, responseText?, revisedPrompt?, promptFeedback?, usage? }`
- 不含图像数据的 provider 响应会返回 `imageCount: 0`、空的 `imagePaths`/`images`，以及任何可用的 provider 文本/反馈。

## 流程
1. SDK 仅在功能开关与工具过滤器允许时，才通过 `getImageGenTools()` 把 `generate_image` 作为自定义工具注入。
2. provider 顺序为：请求内具体的 `provider`、`providers.imageOrder` 中的条目、活动会话模型对应的图像 provider，然后是内置顺序 `openai`、`openai-codex`、`antigravity`、`xai`、`openrouter`、`gemini`、`deepinfra`；重复项会被移除。`provider: "auto"` 不会新增 provider。
3. 工具会跳过没有可用凭据的 provider。已认证 provider 的 HTTP 失败会被收集并尝试下一个 provider；校验、解析、本地 I/O、取消与超时失败不构成回退条件。
4. 输入图像只在找到第一个可用 provider 之后解析一次。`path` 相对于会话 cwd 解析并进行内容嗅探。内联 `data` 可以是原始 base64（要求 `mime_type`），也可以是 `data:<mime>;base64,...` URL。
5. provider 专属的宽高比支持会在选定 provider 之后检查。
6. provider 分发：
   - OpenAI：在活动且兼容的 GPT Responses 模型上进行托管的 Responses 图像生成。
   - OpenAI Codex：在兼容的、已连接的 ChatGPT/Codex 订阅模型上进行托管的 Responses 图像生成，即使当前聊天模型来自其他 provider。
   - Antigravity：Google Antigravity SSE 端点。
   - OpenRouter：支持图像的 chat completion 端点。
   - xAI：Grok Imagine 生成或编辑端点。
   - Gemini：带 `responseModalities: ["IMAGE"]` 的 Gemini `generateContent`。
   - DeepInfra：兼容 OpenAI 的 `images/generations` 端点（默认模型 `black-forest-labs/FLUX-2-pro`，接受 `DEEPINFRA_API_KEY`）。仅文生图——编辑请求会落到后面支持编辑的 provider。
7. 成功 provider 响应中的内联图像会保存为临时文件；返回路径与 base64/MIME 图像元数据。没有图像数据的响应返回正常的零图像结果，而非 `isError`。

## 模式/变体
- 文生图：提供 `subject` 及可选的 style/composition 字段，不提供 `input`。
- 图像编辑：提供一个或多个 `input` 图像，外加 `changes` 与一个能指明每张图像作用的 subject。
- 文本渲染：使用 `text`；prompt 会指示调用方请求清晰、易读、拼写正确的短文本。
- provider 选择：设置 `provider` 让某个请求偏向一个后端；已认证的 HTTP 失败后，回退仍遵循剩余的配置/会话/内置顺序。

## 副作用
- 文件系统：读取本地输入图像，并把生成的输出图像写入操作系统临时目录下的 `omp-image-<snowflake>.<ext>` 文件。
- 网络：向所选图像 provider 发送 prompt 与可选的图像。响应中的 OpenRouter/xAI 图像 URL 会在保存前被下载。
- 会话状态：读取活动模型、会话 id、cwd、凭据、`providers.imageOrder`、Antigravity 端点设置与可选注入的 `fetch`。
- 后台工作/取消：provider 调用使用调用方的中止信号，外加 3 分钟超时。

## 限制与上限
- 本地路径输入上限为 `35 * 1024 * 1024` 字节（`MAX_IMAGE_SIZE`）。内联 base64 输入没有单独的工具级大小上限。
- path 输入必须存在且具有受支持的内容嗅探图像类型。每个输入对象必须包含 `path` 或 `data`；两者同时出现时 `path` 优先。
- 原始 base64 `data` 要求 `mime_type`；data URL 自带 MIME 类型。
- provider 超时为 `3 * 60 * 1000` ms。
- OpenAI 托管输出按 WebP 请求。其他响应文件使用由 MIME 推导的扩展名（`png`、`jpg`、`gif` 或 `webp`；未知 MIME 类型回退为 `.png`）。
- 常见宽高比为 `1:1`、`3:4`、`4:3`、`9:16` 与 `16:9`；只有 xAI 还接受 `3:2` 与 `2:3`。
- `image_size` 接受 `1024x1024`、`1536x1024` 与 `1024x1536`。在 xAI 上它们分别映射为 `1k`、`2k`、`2k`；省略时默认为 `1k`。
- xAI 编辑请求至多接受 3 张输入图像。

## 错误
- 没有可用的 provider 凭据：`No image API credentials found...`；该消息会列出受支持的 login/API-key 途径。
- 无效输入：文件不存在、文件超过 35 MiB、不支持的内容嗅探图像类型、缺少 `path`/`data`、图像数据为空，或没有 `mime_type` 的原始 base64。
- OpenAI 路径没有兼容的 GPT 模型：`Missing active GPT model for OpenAI image generation`。
- Antigravity 凭据缺少 `projectId`：`Missing projectId in antigravity credentials`。
- 超过三张 xAI 编辑引用：`xAI image edits accept up to 3 reference images...`。
- 若没有到达任何可用的 xAI 途径，`3:2` 或 `2:3` 请求会失败。
- 已认证 provider 的 HTTP 失败会落到后续 provider。若所有这些 provider 都失败，工具会抛出 `AggregateError`，列出所有尝试过的 provider 并包含它们各自的 provider 专属 HTTP 错误。
- 取消、三分钟超时、畸形的 provider 响应与本地 I/O 错误会直接抛出。

## 说明
- 该工具是自定义工具，而非内置的 `AgentTool` 类，因此它的根文档放在这里，尽管面向模型的 prompt 位于 `src/prompts/tools/image-gen.md`。
- 多张输入图像应在 `subject` 中命名为 `Image 1`、`Image 2` 等，以便 provider 收到无歧义的编辑指令。
