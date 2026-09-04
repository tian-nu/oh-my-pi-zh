# 环境变量（当前运行时参考）

本参考派生自以下位置的当前代码路径：

- `packages/coding-agent/src/**`
- `packages/ai/src/**`（coding-agent 使用的 provider/认证解析）
- `packages/utils/src/**` 与 `packages/tui/src/**` 中直接影响 coding-agent 运行时的变量

本文档只记录实际生效的行为。

## 解析模型与优先级

大多数运行时查找使用 `@oh-my-pi/pi-utils` 的 `$env`（`packages/utils/src/env.ts`）。

`$env` 加载顺序：

1. 已存在的进程环境（`Bun.env`）
2. 当前值为空/未设置的键，从启动工作目录的项目 `.env` 读取
3. 当前值为空/未设置的键，从活跃 agent `.env`（通常 `~/.omp/agent/.env`）读取
4. 当前值为空/未设置的键，从活跃 config-root `.env`（通常 `~/.omp/.env`）读取
5. 当前值为空/未设置的键，从 home `.env`（`~/.env`）读取

agent/root 位置遵循 profile、`PI_CONFIG_DIR`，以及——仅对默认 profile——`PI_CODING_AGENT_DIR`。Dotenv 名称必须是 shell 标识符（`[A-Za-z_][A-Za-z0-9_]*`）；不安全的名称/值被丢弃。OMP 的解析器保持值字面；只有 Bun 自身的启动目录 dotenv 自动加载可能在本模块运行前执行 Bun 支持的展开。

每个 `.env` 文件内的附加规则：每个 `OMP_*` 键都镜像到其 `PI_*` 别名，且该镜像值会替换同一文件中的 `PI_*` 值。此镜像作用于解析出的 dotenv 文件，不作用于从父进程继承的任意变量。

---

## 1) 模型/provider 认证

除非另有说明，这些变量经 `getEnvApiKey()`（`packages/ai/src/stream.ts`）消费。

### 核心 provider 凭据

| 变量                            | 用于                                             | 何时必需                                                       | 说明 / 优先级                                                                                        |
| ------------------------------- | ------------------------------------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_OAUTH_TOKEN`         | Anthropic API 认证                               | 以 OAuth token 认证使用 Anthropic                              | 在 provider 认证解析中优先于 `ANTHROPIC_API_KEY`                                                      |
| `ANTHROPIC_API_KEY`             | Anthropic API 认证                               | 不以 OAuth token 使用 Anthropic                                | `ANTHROPIC_OAUTH_TOKEN` 之后的回退                                                                    |
| `ANTHROPIC_FOUNDRY_API_KEY`     | 经 Azure Foundry / 企业网关的 Anthropic          | 启用 `CLAUDE_CODE_USE_FOUNDRY`                                 | Foundry 模式启用时优先于 `ANTHROPIC_OAUTH_TOKEN` 和 `ANTHROPIC_API_KEY`                               |
| `OPENAI_API_KEY`                | OpenAI 认证                                      | 未显式传 apiKey 参数时使用 OpenAI 系 provider                  | 由 OpenAI Completions/Responses provider 使用                                                         |
| `OPENAI_CODEX_OAUTH_TOKEN`      | OpenAI Codex 认证                                | 使用 `openai-codex` provider                                   | 环境提供的 Codex OAuth token                                                                          |
| `GEMINI_API_KEY`                | Google Gemini 认证                               | 使用 `google` provider 模型                                    | Gemini provider 映射的主 key                                                                          |
| `GOOGLE_API_KEY`                | Gemini 图像工具认证回退                          | 无 `GEMINI_API_KEY` 时使用 `gemini_image` 工具                 | 由 coding-agent 图像工具回退路径使用                                                                  |
| `GROQ_API_KEY`                  | Groq 认证                                        | 使用 Groq 模型                                                 |                                                                                                       |
| `CEREBRAS_API_KEY`              | Cerebras 认证                                    | 使用 Cerebras 模型                                             |                                                                                                       |
| `FIREWORKS_API_KEY`             | Fireworks 认证                                   | 使用 Fireworks 模型                                            |                                                                                                       |
| `FIREPASS_API_KEY`              | Fire Pass 认证                                   | 使用 Fire Pass 模型                                            |                                                                                                       |
| `TOGETHER_API_KEY`              | Together 认证                                    | 使用 `together` provider                                       |                                                                                                       |
| `AIMLAPI_API_KEY`               | AIML API 认证                                    | 使用 `aimlapi` provider                                        | 位于 `https://api.aimlapi.com/v1` 的 OpenAI 兼容 AIML API 端点                                        |
| `HUGGINGFACE_HUB_TOKEN`         | Hugging Face 认证                                | 使用 `huggingface` provider                                    | 主 Hugging Face token 环境变量                                                                        |
| `HF_TOKEN`                      | Hugging Face 认证                                | 使用 `huggingface` provider                                    | `HUGGINGFACE_HUB_TOKEN` 未设置时的回退                                                                |
| `SYNTHETIC_API_KEY`             | Synthetic 认证                                   | 使用 Synthetic 模型                                            |                                                                                                       |
| `NVIDIA_API_KEY`                | NVIDIA 认证                                      | 使用 `nvidia` provider                                         |                                                                                                       |
| `NANO_GPT_API_KEY`              | NanoGPT 认证                                     | 使用 `nanogpt` provider                                        |                                                                                                       |
| `NOVITA_API_KEY`                | Novita 认证                                      | 使用 `novita` provider                                         |                                                                                                       |
| `VENICE_API_KEY`                | Venice 认证                                      | 使用 `venice` provider                                         |                                                                                                       |
| `LITELLM_API_KEY`               | LiteLLM 认证                                     | 使用 `litellm` provider                                        | OpenAI 兼容的 LiteLLM 代理 key                                                                        |
| `LM_STUDIO_API_KEY`             | LM Studio 认证（可选）                           | 使用需要认证主机的 `lm-studio` provider                        | 本地 LM Studio 通常无需认证；需要 key 时任意非空 token 均可                                           |
| `OLLAMA_API_KEY`                | Ollama 认证（可选）                              | 使用需要认证主机的 `ollama` provider                           | 本地 Ollama 通常无需认证；需要 key 时任意非空 token 均可                                              |
| `LLAMA_CPP_API_KEY`             | llama.cpp 认证（可选）                           | 使用需要认证主机的 `llama.cpp` provider                        | 本地 llama.cpp 通常无需认证；配置了 key 时任意非空 token 均可                                         |
| `XIAOMI_API_KEY`                | Xiaomi MiMo 认证                                 | 使用 `xiaomi` provider                                         |                                                                                                       |
| `XIAOMI_TOKEN_PLAN_AMS_API_KEY` | Xiaomi MiMo Token Plan 认证（AMS）               | 使用 `xiaomi-token-plan-ams` provider                          |                                                                                                       |
| `XIAOMI_TOKEN_PLAN_CN_API_KEY`  | Xiaomi MiMo Token Plan 认证（CN）                | 使用 `xiaomi-token-plan-cn` provider                           |                                                                                                       |
| `XIAOMI_TOKEN_PLAN_SGP_API_KEY` | Xiaomi MiMo Token Plan 认证（SGP）               | 使用 `xiaomi-token-plan-sgp` provider                          |                                                                                                       |
| `MOONSHOT_API_KEY`              | Moonshot 认证                                    | 使用 `moonshot` provider                                       | `KIMI_API_KEY` 可作为回退别名接受                                                                     |
| `XAI_API_KEY`                   | xAI 认证                                         | 使用 xAI 模型或作为 `xai-oauth` 的回退                         |                                                                                                       |
| `XAI_OAUTH_TOKEN`               | xAI OAuth/SuperGrok 认证                         | 使用 `xai-oauth` provider                                      | 对 `xai-oauth` 优先于 `XAI_API_KEY`                                                                   |
| `OPENROUTER_API_KEY`            | OpenRouter 认证                                  | 使用 OpenRouter 模型                                           | 当首选/自动 provider 为 OpenRouter 时也被图像工具使用                                                 |
| `MISTRAL_API_KEY`               | Mistral 认证                                     | 使用 Mistral 模型                                              |                                                                                                       |
| `ZAI_API_KEY`                   | z.ai 认证                                        | 使用 z.ai 模型                                                 | 也被 z.ai web search provider 使用                                                                    |
| `ZHIPU_API_KEY`                 | Zhipu Coding Plan 认证                           | 使用 `zhipu-coding-plan` provider                              |                                                                                                       |
| `UMANS_AI_CODING_PLAN_API_KEY`  | Umans AI Coding Plan 认证                        | 使用 `umans` provider                                          |                                                                                                       |
| `MINIMAX_API_KEY`               | MiniMax 认证                                     | 使用 `minimax` provider                                        |                                                                                                       |
| `MINIMAX_CODE_API_KEY`          | MiniMax Code 认证                                | 使用 `minimax-code` provider                                   |                                                                                                       |
| `MINIMAX_CODE_CN_API_KEY`       | MiniMax Code CN 认证                             | 使用 `minimax-code-cn` provider                                |                                                                                                       |
| `OPENCODE_API_KEY`              | OpenCode 认证                                    | 使用 `opencode-go` / `opencode-zen` 模型                       |                                                                                                       |
| `QIANFAN_API_KEY`               | Qianfan 认证                                     | 使用 `qianfan` provider                                        |                                                                                                       |
| `QWEN_OAUTH_TOKEN`              | Qwen Portal 认证                                 | 以 OAuth token 使用 `qwen-portal`                              | 优先于 `QWEN_PORTAL_API_KEY`                                                                          |
| `QWEN_PORTAL_API_KEY`           | Qwen Portal 认证                                 | 以 API key 使用 `qwen-portal`                                  | `QWEN_OAUTH_TOKEN` 之后的回退                                                                         |
| `ZENMUX_API_KEY`                | ZenMux 认证                                      | 使用 `zenmux` provider                                         | 用于 ZenMux 的 OpenAI 与 Anthropic 兼容路由                                                           |
| `VLLM_API_KEY`                  | vLLM 认证/发现选择启用                           | 使用 `vllm` provider（本地 OpenAI 兼容服务器）                 | 对无需认证的本地服务器，任意非空值均可                                                                |
| `CURSOR_ACCESS_TOKEN`           | Cursor provider 认证                             | 使用 Cursor provider                                           | `CURSOR_API_KEY` 可作为别名接受                                                                       |
| `AI_GATEWAY_API_KEY`            | Vercel AI Gateway 认证                           | 使用 `vercel-ai-gateway` provider                              | `VERCEL_AI_GATEWAY_API_KEY` 可作为别名接受                                                            |
| `CLOUDFLARE_AI_GATEWAY_API_KEY` | Cloudflare AI Gateway 认证                       | 使用 `cloudflare-ai-gateway` provider                          | 带 AI Gateway Run 权限的网关 token；`/login` 会将其与路由 ID 一同存储                                 |
| `CLOUDFLARE_ACCOUNT_ID`         | Cloudflare AI Gateway 账户路由                   | 使用环境提供的网关 token                                       | 账户 ID 已由 `/login` 存储时不需要                                                                    |
| `CLOUDFLARE_GATEWAY_ID`         | Cloudflare AI Gateway 选择                       | 使用环境提供的网关 token                                       | 网关 slug，常见为 `default`；已由 `/login` 存储时不需要                                               |
| `ALIBABA_CODING_PLAN_API_KEY`   | Alibaba Coding Plan 认证                         | 使用 `alibaba-coding-plan` provider                            |                                                                                                       |
| `ALIBABA_TOKEN_PLAN_API_KEY`    | QwenCloud Token Plan 认证                        | 使用 `alibaba-token-plan` provider                             | 首选的 provider 专属名称                                                                              |
| `BAILIAN_TOKEN_PLAN_API_KEY`    | QwenCloud Token Plan 认证                        | 使用 `alibaba-token-plan` provider                             | 与 Qwen Code 的 Token Plan 预设兼容                                                                   |
| `DEEPINFRA_API_KEY`             | DeepInfra 认证                                   | 使用 `deepinfra` provider                                      |                                                                                                       |
| `DEEPSEEK_API_KEY`              | DeepSeek 认证                                    | 使用 DeepSeek 模型                                             |                                                                                                       |
| `SILICONFLOW_API_KEY`           | SiliconFlow 认证                                 | 使用 `siliconflow` provider                                    |                                                                                                       |
| `SILICONFLOW_CN_API_KEY`        | SiliconFlow（中国）认证                          | 使用 `siliconflow-cn` provider                                 |                                                                                                       |
| `KILO_API_KEY`                  | Kilo 认证                                        | 使用 Kilo 模型                                                 |                                                                                                       |
| `OLLAMA_CLOUD_API_KEY`          | Ollama Cloud 认证                                | 使用 `ollama-cloud` provider                                   |                                                                                                       |
| `CLINE_API_KEY`                 | ClinePass 订阅 + 免费层认证                      | 使用 `cline-pass` provider                                     | 官方 Cline API key 变量                                                                               |
| `YOLO_AUTO_API_KEY`             | Yolo-Auto 认证                                   | 使用 `yolo-auto` provider                                      | 包月 Qwen 模型；对 `https://yolo-auto.com/v1/models` 验证                                             |
| `WAFER_SERVERLESS_API_KEY`      | Wafer Serverless 认证                            | 使用 `wafer-serverless` provider                               | 按量付费的 Wafer SKU；对 `https://pass.wafer.ai/v1/models` 验证                                       |
| `GITLAB_TOKEN`                  | GitLab Duo 认证                                  | 使用 `gitlab-duo` / `gitlab-duo-agent` provider                | 两个 GitLab provider 读取同一 token                                                                   |
| `BASETEN_API_KEY`               | Baseten 认证                                     | 使用 `baseten` provider                                        | 也可经交互式 API key 登录配置（`/login baseten`，key 来自 Baseten 控制台）                            |
| `COREWEAVE_API_KEY` / `WANDB_API_KEY` | CoreWeave Serverless Inference 认证        | 使用 `coreweave` provider                                      | 两个变量均可（W&B 回退）。`COREWEAVE_PROJECT`（回退 `WANDB_INFERENCE_PROJECT`）提供必需的 `OpenAI-Project` 头 |
| `SAKANA_API_KEY` / `FUGU_API_KEY` | Sakana AI 认证                                 | 使用 `sakana` provider                                         | 两个变量均可；`SAKANA_BASE_URL` / `FUGU_BASE_URL` 覆盖请求 base URL                                   |
| `DEVIN_API_KEY`                 | Devin 认证                                       | 使用 `devin` provider                                          | 也可经交互式登录（`/login devin`，OAuth）获得                                                         |
| `AIAND_API_KEY`                 | ai& 认证                                         | 使用 `aiand` provider                                          |                                                                                                       |
| `GMI_API_KEY`                   | GMI Cloud 认证                                   | 使用 `gmi-cloud` provider                                      |                                                                                                       |
| `MODEL_API_KEY` / `META_API_KEY` | Meta Model API 认证                             | 使用 `meta` provider                                           | 两个变量均可                                                                                          |

### GitHub/Copilot token

| 变量                   | 用于                           | 说明                                      |
| ---------------------- | ------------------------------ | ----------------------------------------- |
| `COPILOT_GITHUB_TOKEN` | GitHub Copilot provider 认证   | 通用的 GitHub token 在此处不使用         |
| `GH_TOKEN`             | web 抓取器中的 GitHub API 认证 | `GITHUB_TOKEN` 之后的 web 抓取器回退      |
| `GITHUB_TOKEN`         | web 抓取器中的 GitHub API 认证 | web 抓取器先检查此项再检查 `GH_TOKEN`     |

### Auth broker / auth gateway（远程凭据保险库）

启用 broker 后，本地 SQLite 凭据存储被绕过，所有 OAuth refresh / access token 都存于 broker 主机。完整协议、CLI 表面和 5 分钟/15 秒用量缓存分层见 [`auth-broker-gateway.md`](./auth-broker-gateway.md)。

| 变量                                | 用于                                                                                         | 何时必需                                                                                                                  | 说明 / 优先级                                                                                                                                                                                                                                                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OMP_AUTH_BROKER_URL`               | 远程 auth-broker 的基础 URL（如 `https://broker.tailnet:8765`）；选择 broker 模式            | 经 broker 解析凭据时；`omp auth-gateway serve` 也必需（gateway 本身就是 broker 客户端）                                   | 优先于 `config.yml` 中的 `auth.broker.url`。设置了它但无可解析 token 时，`resolveAuthBrokerConfig()` 硬报错而不回退到本地 SQLite。                                                                                                                                                    |
| `OMP_AUTH_BROKER_TOKEN`             | 除 `/v1/healthz` 外每个 broker 端点都发送的 bearer token                                     | 设置了 `OMP_AUTH_BROKER_URL` 且无法从 `auth.broker.token` 或 `<config-dir>/auth-broker.token` 获得 token                  | 解析顺序：此环境变量 → `auth.broker.token`（支持 `$ENV_NAME` 间接引用）→ `<config-dir>/auth-broker.token`（权限 `0600`）。`<config-dir>` 为 `~/.omp/`（遵循 `PI_CONFIG_DIR`）。                                                                                                       |
| `OMP_AUTH_BROKER_SNAPSHOT_TTL_MS`   | 加密的本地 broker snapshot 缓存的新鲜度窗口                                                  | broker 模式下可选                                                                                                         | 默认 `3600000`（1 h）。新鲜度基于 broker 的 `snapshot.generatedAt`；`0` 禁用缓存读写，并在每次启动时强制旧的阻塞式获取。                                                                                                                                                              |
| `OMP_AUTH_BROKER_SNAPSHOT_CACHE`    | 加密的本地 broker snapshot 缓存路径                                                          | broker 模式下可选                                                                                                         | 默认 `~/.omp/cache/auth-broker-snapshot.enc`（或 XDG cache 等价路径）。适用于测试、临时主机或迁移 `0600` 缓存文件。                                                                                                                                                                   |
| `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE` | 可信 broker 客户端的进程级 OAuth 账户路由                                                    | broker 模式下可选                                                                                                         | 指向一个 JSON 对象的路径，该对象将 provider ID 映射到精确的 broker `identityKey` 数组。缺失的 provider 不受限；`[]` 隐藏该 provider 的 OAuth 账户；API key 保持可见。启动时解析一次，输入无效时失败关闭。这不是服务端授权。                                                            |

gateway 没有专用的环境变量 —— 它继承 `OMP_AUTH_BROKER_*`。它自己的入站 bearer token 位于 `<config-dir>/auth-gateway.token`，经 `omp auth-gateway token` 管理。

---

## 2) Provider 特定的运行时配置

### 出站代理路由

在应用 `NO_PROXY` / `no_proxy` 之后，provider HTTP 请求按以下顺序解析代理：

1. `PI_PROXY_<PROVIDER>`（provider ID 大写、非字母数字替换为 `_`，例如 `PI_PROXY_GITHUB_COPILOT`）
2. `PI_PROXY`
3. HTTPS 与 WebSocket 目标用 `HTTPS_PROXY` / `https_proxy`，HTTP 用 `HTTP_PROXY` / `http_proxy`
4. `ALL_PROXY` / `all_proxy`

Provider 代理查找在进程生命周期内缓存。本地主机目标绕过 provider fetch 包装器。

两种 `PI_PROXY` 形式的作用范围不同：

- `PI_PROXY` 在 CLI 启动时安装到进程级 `fetch` 上，因此也覆盖
  provider fetch 包装器之外的请求 —— OAuth token 刷新
  和登录、用量探测、模型发现。没有它，被区域封锁的 token
  端点在刷新时返回 `403 Request not allowed`，即使流本身
  走了代理。
- `PI_PROXY_<PROVIDER>` 只作用于该 provider 的请求，并对它们
  覆盖 `PI_PROXY`。它不覆盖上述非 provider 作用域的调用；若该
  provider 封锁了你的区域，请同时设置 `PI_PROXY`。

回环、链路本地、私有网段（`10/8`、`172.16/12`、`192.168/16`）以及
`NO_PROXY` 目标始终绕过，因此本地模型服务器和 MCP 主机保持直连。

### Anthropic Foundry Gateway（Azure / 企业代理）

启用 `CLAUDE_CODE_USE_FOUNDRY` 后，Anthropic 请求切换到 Foundry 模式：

- Base URL 从 `FOUNDRY_BASE_URL` 解析（未设置时回退保持模型/默认 base URL）。
- provider `anthropic` 的 API key 解析变为：
  `ANTHROPIC_FOUNDRY_API_KEY` → `ANTHROPIC_OAUTH_TOKEN` → `ANTHROPIC_API_KEY`。
- `ANTHROPIC_CUSTOM_HEADERS` 解析为逗号/换行分隔的 `key: value`
  对并合并进请求头。当 `ANTHROPIC_BASE_URL` 指向非 Anthropic
  主机（例如企业 API 网关）时它们同样被转发，因此需要专有
  认证头的企业网关无需启用 Foundry 模式即可工作。
- TLS 客户端/服务器材料可从环境值注入：
  `NODE_EXTRA_CA_CERTS`、`CLAUDE_CODE_CLIENT_CERT`、`CLAUDE_CODE_CLIENT_KEY`。
  每项都接受：
  - 指向 PEM 内容的文件系统路径，或
  - 内联 PEM（包括转义的 `\n` 序列）。

  `NODE_EXTRA_CA_CERTS` 对每次 provider 请求都生效（OpenAI 兼容、
  Codex、Ollama、Azure Responses、Google、Anthropic），不只 Foundry —— Bun 的
  `fetch` 原生不消费该环境变量，因此该 bundle 会与系统根存储
  一起合并进 `RequestInit.tls.ca`。`CLAUDE_CODE_*` mTLS
  材料仍仅限 Anthropic Foundry。

| 变量                        | 值类型                                         | 行为                                                                                                                                                          |
| --------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE_CODE_USE_FOUNDRY`   | 布尔型字符串（`1`、`true`、`yes`、`on`）       | 为 Anthropic provider 启用 Foundry 模式                                                                                                                       |
| `FOUNDRY_BASE_URL`          | URL 字符串                                     | Foundry 模式下的 Anthropic 端点 base URL                                                                                                                      |
| `ANTHROPIC_FOUNDRY_API_KEY` | Token 字符串                                   | 用于 `Authorization: Bearer <token>`                                                                                                                          |
| `ANTHROPIC_CUSTOM_HEADERS`  | 头列表字符串                                   | 额外头；格式 `header-a: value, header-b: value` 或换行分隔。当 `ANTHROPIC_BASE_URL` 非 Anthropic 时，Foundry 之外同样转发。                                    |
| `NODE_EXTRA_CA_CERTS`       | PEM 路径或内联 PEM                             | 用于服务器证书验证的额外 CA 链                                                                                                                                |
| `CLAUDE_CODE_CLIENT_CERT`   | PEM 路径或内联 PEM                             | mTLS 客户端证书                                                                                                                                               |
| `CLAUDE_CODE_CLIENT_KEY`    | PEM 路径或内联 PEM                             | mTLS 客户端私钥（必须与证书配对）                                                                                                                             |

### Amazon Bedrock

| 变量                                                                            | 默认 / 行为                                                                                                                                     |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `AWS_REGION`                                                                    | 主区域来源                                                                                                                                      |
| `AWS_DEFAULT_REGION`                                                            | `AWS_REGION` 未设置时的回退                                                                                                                     |
| `AWS_PROFILE`                                                                   | 启用具名 profile 认证路径                                                                                                                       |
| `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`                                   | 启用 IAM key 认证路径                                                                                                                           |
| `AWS_BEARER_TOKEN_BEDROCK`                                                      | 最高优先级的 bearer token 认证路径；设置时跳过 AWS profile/凭据链查找                                                                            |
| `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` / `AWS_CONTAINER_CREDENTIALS_FULL_URI` | 在 provider 检测中将 Bedrock 标记为可用（凭据解析本身覆盖环境 key、profile/SSO/`credential_process`，然后 IMDSv2）                              |
| `AWS_WEB_IDENTITY_TOKEN_FILE` + `AWS_ROLE_ARN`                                  | 在 provider 检测中将 Bedrock 标记为可用（与上述 ECS 变量同样的注意事项）                                                                        |
| `AWS_BEDROCK_SKIP_AUTH`                                                         | 为 `1` 时注入虚拟凭据（代理/免认证场景）                                                                                                        |
| `HTTPS_PROXY` / `HTTP_PROXY`                                                    | 经 Bun 的原生 fetch 代理支持生效（provider 不再自带 AWS SDK / proxy-agent 传输）                                                                 |
| `NO_PROXY`                                                                      | 将匹配的主机排除在 Bun 原生代理路由之外                                                                                                         |

provider 代码中的区域回退：`options.region` → `AWS_REGION` → `AWS_DEFAULT_REGION` → `us-east-1`。

原生 Bedrock 解析器实现的额外凭据链控制：

| 变量                                                                          | 行为                                                                    |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `AWS_SESSION_TOKEN`                                                           | 与 `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` 配对的会话 token       |
| `AWS_SHARED_CREDENTIALS_FILE`, `AWS_CONFIG_FILE`                              | 覆盖共享凭据/配置 INI 路径                                              |
| `AWS_SDK_LOAD_CONFIG`                                                         | `1`/`true` 在无显式 profile 时启用共享配置加载                          |
| `AWS_ROLE_SESSION_NAME`                                                       | web 身份角色承担的会话名称                                              |
| `AWS_CONTAINER_AUTHORIZATION_TOKEN`, `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE` | ECS 容器凭据的授权                                                      |
| `AWS_EC2_METADATA_DISABLED`                                                   | `true` 禁用 IMDSv2                                                      |
| `AWS_EC2_METADATA_SERVICE_ENDPOINT`, `AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE` | 覆盖 IMDS 端点 / 选择 IPv6 回退                                         |

### Azure OpenAI Responses

| 变量                               | 默认 / 行为                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `AZURE_OPENAI_API_KEY`             | 未作为选项传入 API key 时必需                                               |
| `AZURE_OPENAI_API_VERSION`         | 默认 `v1`                                                                   |
| `AZURE_OPENAI_BASE_URL`            | 直接 base URL 覆盖                                                          |
| `AZURE_OPENAI_RESOURCE_NAME`       | 用于构造 base URL：`https://<resource>.openai.azure.com/openai/v1`          |
| `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` | 可选映射字符串：`modelId=deploymentName,model2=deployment2`                 |

Base URL 解析：选项 `azureBaseUrl` → 环境变量 `AZURE_OPENAI_BASE_URL` → 选项/环境资源名 → `model.baseUrl`。

### Google Vertex AI

| 变量                             | 是否必需                       | 说明                                                                                                                      |
| -------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `GOOGLE_CLOUD_PROJECT`           | 是（除非经选项传入）           | 主项目 ID 来源                                                                                                            |
| `GCP_PROJECT`                    | 回退                           | 备用项目 ID 来源                                                                                                          |
| `GCLOUD_PROJECT`                 | 回退                           | 备用项目 ID 来源                                                                                                          |
| `GOOGLE_CLOUD_PROJECT_ID`        | 仅 OAuth 登录辅助              | 由 Gemini CLI OAuth 项目发现使用                                                                                          |
| `GOOGLE_VERTEX_LOCATION`         | 是（除非经选项传入）           | 主 Vertex location 来源                                                                                                   |
| `GOOGLE_CLOUD_LOCATION`          | 回退                           | 备用 Vertex location 来源                                                                                                 |
| `VERTEX_LOCATION`                | 回退                           | 备用 Vertex location 来源                                                                                                 |
| `GOOGLE_CLOUD_API_KEY`           | 条件性                         | 直接 Vertex API key 认证；否则在设置了项目与 location 时 ADC 回退可完成认证                                               |
| `GOOGLE_APPLICATION_CREDENTIALS` | 条件性                         | 若设置，文件必须存在；否则检查 ADC 回退路径（`~/.config/gcloud/application_default_credentials.json`）                     |

`GOOGLE_CLOUD_ACCESS_TOKEN`（或兼容的 `CLOUDSDK_AUTH_ACCESS_TOKEN` 回退）提供显式的 Google OAuth access token 并绕过 ADC token 获取。

### Kimi

| 变量                   | 默认 / 行为                                              |
| ---------------------- | -------------------------------------------------------- |
| `KIMI_CODE_OAUTH_HOST` | 主 OAuth host 覆盖                                       |
| `KIMI_OAUTH_HOST`      | 回退 OAuth host 覆盖                                     |
| `KIMI_CODE_BASE_URL`   | 覆盖 Kimi 用量端点 base URL（`usage/kimi.ts`）           |

OAuth host 链：`KIMI_CODE_OAUTH_HOST` → `KIMI_OAUTH_HOST` → `https://auth.kimi.com`。

### OpenAI 兼容端点控制

| 变量                                | 默认 / 行为                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------- |
| `OPENAI_BASE_URL`                   | 模型/provider 未提供默认值时，OpenAI 兼容请求的 base URL 回退                               |
| `MOONSHOT_BASE_URL`                 | Moonshot chat 与模型发现端点覆盖                                                            |
| `XAI_BASE_URL`                      | xAI HTTP 端点覆盖                                                                           |
| `SAKANA_BASE_URL` / `FUGU_BASE_URL` | Sakana/Fugu 端点覆盖（`SAKANA_BASE_URL` 胜出）                                              |
| `PI_OPENROUTER_RESPONSES`           | Responses API 默认启用，除非设为 `0`；`0` 选择 OpenAI Completions 路由                      |
| `UMANS_WEBSEARCH_PROVIDER`          | 未显式提供时默认的 Umans Anthropic web-search provider 选择                                 |

### Gemini CLI 与 Antigravity 兼容性

| 变量                        | 默认 / 行为                                                     |
| --------------------------- | --------------------------------------------------------------- |
| `PI_AI_GEMINI_CLI_VERSION`  | 覆盖 Gemini CLI user-agent 版本标签（未设置为 `0.46.0`）        |
| `PI_AI_ANTIGRAVITY_VERSION` | 覆盖自动发现的 Antigravity hub user-agent 版本；未设置且发现失败时回退为 `2.8.0` |
| `PI_AI_ANTIGRAVITY_CL`      | 覆盖 Antigravity hub user-agent 构建变更号（未设置为 `963137146`） |
| `PI_AI_ANTIGRAVITY_OS`      | 覆盖 Antigravity hub user-agent os_type（未设置时固定 `darwin`）|
| `PI_AI_ANTIGRAVITY_ARCH`    | 覆盖 Antigravity hub user-agent arch（未设置时固定 `arm64`）    |

### GitLab Duo

| 变量                             | 默认 / 行为                                                                                                                                                                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GITLAB_CLIENT_ID`               | OAuth 客户端 ID。未设置时使用内置 GitLab OAuth 应用的客户端 ID。                                                                                                                                                                                                                                 |
| `GITLAB_REDIRECT_URI`            | 向 GitLab 通告的确切 OAuth 重定向 URI。未设置时本地回调使用 `http://localhost:8080/callback`，并带随机端口回退。必须使用 HTTP 或 HTTPS；回环回调必须使用 HTTP 并绑定 URI 的 host 和端口。                                                                                                          |
| `GITLAB_DUO_NAMESPACE_ID`        | Workflow 命名空间覆盖。运行时选项优先；否则命名空间/项目发现使用当前凭据和工作目录。                                                                                                                                                                                                              |
| `GITLAB_DUO_PROJECT_ID`          | 按 ID 的 Workflow 项目覆盖。运行时 `projectId`，其次运行时 `projectPath`，优先；此变量优先于 `GITLAB_DUO_PROJECT_PATH`。                                                                                                                                                                          |
| `GITLAB_DUO_PROJECT_PATH`        | 无运行时项目或未设 `GITLAB_DUO_PROJECT_ID` 时按路径的 Workflow 项目覆盖。                                                                                                                                                                                                                         |
| `GITLAB_DUO_WORKFLOW_DEFINITION` | Workflow 定义覆盖；运行时 `workflowDefinition` 优先。默认 `ambient`。                                                                                                                                                                                                                             |
| `GITLAB_DUO_WORKFLOW_TRACE`      | 仅当值恰为 `1` 时启用 workflow 追踪。每个追踪事件按每行一个 JSON 对象追加；追踪写入失败被忽略。                                                                                                                                                                                                   |
| `GITLAB_DUO_WORKFLOW_TRACE_FILE` | 追踪输出路径。值被修剪；未设置或空白时默认为从 provider 模块解析 `../../../../.tmp/gitlab-duo-workflow-trace.log` 得到的绝对路径（源码检出中为 `<repo>/.tmp/gitlab-duo-workflow-trace.log`）。缺失的父目录自动创建。                                                                               |

`GITLAB_CLIENT_ID` 和 `GITLAB_REDIRECT_URI` 影响 OAuth 登录。四个路由/创建
覆盖（`GITLAB_DUO_NAMESPACE_ID`、`GITLAB_DUO_PROJECT_ID`、
`GITLAB_DUO_PROJECT_PATH` 和 `GITLAB_DUO_WORKFLOW_DEFINITION`）影响
`gitlab-duo-agent` 的 Workflow 命名空间/项目解析或 workflow 创建；它们
不配置 OAuth。上述两个追踪变量只影响本地诊断
输出。非回环
重定向 URI 无法由本地回调监听器直接服务，因此
经粘贴代码路径完成。

### OpenAI Codex responses（功能/调试控制）

| 变量                                        | 行为                                                                                                                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_CODEX_DEBUG`                            | `1`/`true` 启用 Codex provider 调试日志                                                                                                                                                                       |
| `PI_CODEX_WEBSOCKET`                        | `1`/`true` 启用 websocket 传输偏好                                                                                                                                                                            |
| `PI_CODEX_RESPONSES_LITE`                   | `1`/`true` 将常规推理选择加入 Responses Lite；`0`/`false` 强制标准 Responses 请求体；未设置时常规推理默认完整 Responses                                                                                       |
| `PI_OPENAI_STATEFUL`                        | 覆盖平台 OpenAI Responses API 的有状态链接默认值（`previous_response_id`，强制 `store: true`）：对 api.openai.com 默认开启，其他位置关闭                                                                      |
| `PI_CODEX_ZSTD`                             | `0`/`false` 禁用发送到官方 Codex API 的请求体 zstd 压缩（默认启用）                                                                                                                                           |
| `PI_CODEX_WEBSOCKET_IDLE_TIMEOUT_MS`        | 正整数覆盖（默认 `300000`）                                                                                                                                                                                   |
| `PI_CODEX_WEBSOCKET_FIRST_EVENT_TIMEOUT_MS` | 首事件超时覆盖（默认 `300000`）                                                                                                                                                                               |
| `PI_CODEX_WEBSOCKET_PING_INTERVAL_MS`       | Ping 间隔覆盖（默认 `10000`）                                                                                                                                                                                 |
| `PI_CODEX_WEBSOCKET_PONG_TIMEOUT_MS`        | Pong 超时覆盖（默认 `60000`）                                                                                                                                                                                 |
| `PI_CODEX_WEBSOCKET_MESSAGE_QUEUE_CAPACITY` | 缓冲消息容量覆盖（默认 `4096`）                                                                                                                                                                               |
| `PI_CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS`      | 连接不再被复用前的最大空闲时间（默认 `30000`）                                                                                                                                                                |
| `PI_CODEX_WEBSOCKET_RETRY_BUDGET`           | 非负整数覆盖（默认 `5`）                                                                                                                                                                                      |
| `PI_CODEX_WEBSOCKET_RETRY_DELAY_MS`         | 正整数基础退避覆盖（默认 `500`）                                                                                                                                                                              |
| `PI_STREAM_FIRST_EVENT_TIMEOUT_MS`          | 通用流首事件超时；`0` 禁用                                                                                                                                                                                    |
| `PI_STREAM_IDLE_TIMEOUT_MS`                 | 通用流空闲超时；`0` 禁用                                                                                                                                                                                      |
| `PI_OPENAI_STREAM_FIRST_EVENT_TIMEOUT_MS`   | OpenAI 特定的首事件超时覆盖；`0` 禁用并优先于通用值。`omp config set providers.streamFirstEventTimeoutSeconds <seconds>` 提供持久化等价物                                                                 |
| `PI_OPENAI_STREAM_IDLE_TIMEOUT_MS`          | OpenAI 特定的空闲超时覆盖；`0` 禁用并优先于通用值。`omp config set providers.streamIdleTimeoutSeconds <seconds>` 提供持久化等价物                                                                            |

### Cursor provider 调试

| 变量               | 行为                                                                     |
| ------------------ | ------------------------------------------------------------------------ |
| `DEBUG_CURSOR`     | 启用 provider 调试日志；`2`/`verbose` 输出详细负载片段                   |
| `DEBUG_CURSOR_LOG` | 可选的 JSONL 调试日志输出文件路径                                        |

### Prompt 缓存兼容性开关

| 变量                 | 行为                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_CACHE_RETENTION` | 支持处的缓存保留覆盖（`anthropic`、`openai-responses`、Bedrock）。接受 `long`、`short` 或 `none`；其他值被忽略                                     |

---

## 3) Web search 子系统

### 搜索 provider 凭据

| 变量                                                | 使用者                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------- |
| `EXA_API_KEY`                                       | Exa 搜索/MCP；也可使用 `/login exa`                                       |
| `TINYFISH_API_KEY`                                  | TinyFish 搜索 provider（必需）                                            |
| `BRAVE_API_KEY`                                     | Brave 搜索 provider                                                       |
| `PERPLEXITY_API_KEY`                                | Perplexity 搜索 provider 的 API key 模式                                  |
| `PERPLEXITY_COOKIES`                                | Perplexity cookie 认证搜索模式                                            |
| `PI_PERPLEXITY_RESPONSES`                           | `1` 选择 Perplexity Responses 端点而非 Chat Completions                   |
| `PI_PERPLEXITY_MODEL`                               | Perplexity 消费者订阅模型偏好（默认 `experimental`）                      |
| `PI_PERPLEXITY_API_MODEL`                           | Perplexity 直接 API 模型覆盖（默认 `sonar-pro`）                          |
| `FIRECRAWL_API_KEY`                                 | Firecrawl 搜索 provider（未设置时为免 key 回退）与 fetch reader 后端（必需） |
| `FIRECRAWL_BASE_URL`                                | Firecrawl API 端点覆盖（`FIRECRAWL_API_URL` 是回退别名）                  |
| `GOOGLE_GEMINI_BASE_URL`                            | Gemini 搜索端点覆盖；必须是有效的绝对 HTTP(S) URL                         |
| `TAVILY_API_KEY`                                    | Tavily 搜索 provider                                                      |
| `ZAI_API_KEY`                                       | z.ai 搜索 provider（也检查 `agent.db` 中存储的 OAuth）                    |
| `OPENAI_API_KEY` / DB 中的 Codex OAuth              | Codex 搜索 provider 的可用性/认证                                         |
| `PI_CODEX_WEB_SEARCH_MODEL`                         | Codex 搜索 provider 模型覆盖                                              |
| `GEMINI_SEARCH_MODEL`                               | Gemini 搜索模型覆盖                                                       |
| `MOONSHOT_SEARCH_API_KEY` / `KIMI_SEARCH_API_KEY`   | Kimi/Moonshot 搜索 provider 的环境认证                                    |
| `MOONSHOT_SEARCH_BASE_URL` / `KIMI_SEARCH_BASE_URL` | Kimi/Moonshot 搜索端点覆盖                                                |
| `KAGI_API_KEY`                                       | Kagi 搜索 provider                                                        |
| `JINA_API_KEY`                                      | Jina 搜索 provider                                                        |
| `PARALLEL_API_KEY`                                  | Parallel 搜索 provider                                                    |
| `SEARXNG_ENDPOINT`, `SEARXNG_TOKEN`                 | SearXNG 端点与可选 bearer token                                           |
| `SEARXNG_BASIC_USERNAME`, `SEARXNG_BASIC_PASSWORD`  | SearXNG HTTP Basic Auth 凭据                                              |

DuckDuckGo 搜索免 key —— 它查询无 JS 的 HTML 前端（`html.duckduckgo.com`），无需凭据；它还为免凭据的 `public` 聚合供数（与 startpage、google、ecosia、mojeek 并列）。

SearXNG 还从 `~/.omp/agent/config.yml` 读取等价的 `searxng.endpoint`、`searxng.token`、`searxng.basicUsername` 和 `searxng.basicPassword` 设置；环境变量是回退。

### Anthropic web search 认证链

`searchAnthropic()` 按以下顺序解析凭据：

1. `ANTHROPIC_SEARCH_API_KEY`
2. `authStorage.getApiKey("anthropic")` 回退凭据（运行时和配置覆盖、存储的 OAuth、登录来源的 API key、通用 Anthropic 环境回退，然后其他存储的 API key；Foundry 模式下环境回退为 `ANTHROPIC_FOUNDRY_API_KEY` → `ANTHROPIC_OAUTH_TOKEN` → `ANTHROPIC_API_KEY`，否则为 `ANTHROPIC_OAUTH_TOKEN` → `ANTHROPIC_API_KEY`）

无论哪条凭据路径，base URL 解析为：

1. `ANTHROPIC_SEARCH_BASE_URL`
2. 启用 `CLAUDE_CODE_USE_FOUNDRY` 时的 `FOUNDRY_BASE_URL`
3. `ANTHROPIC_BASE_URL`
4. `https://api.anthropic.com`

相关变量：

| 变量                        | 默认 / 行为                                                                                                                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ANTHROPIC_SEARCH_API_KEY`  | 专用于 Anthropic web search provider 的 API key。最高优先级的搜索认证；对搜索调用覆盖 `ANTHROPIC_API_KEY` / OAuth / Foundry，不影响 chat completions。                                                                                      |
| `ANTHROPIC_SEARCH_BASE_URL` | 专用于 Anthropic web search provider 的 base URL。对 `ANTHROPIC_SEARCH_API_KEY` 或回退 Anthropic 凭据均适用；对搜索调用覆盖 `ANTHROPIC_BASE_URL`（以及 Foundry 模式下的 `FOUNDRY_BASE_URL`）。                                             |
| `ANTHROPIC_SEARCH_MODEL`    | 搜索模型覆盖。默认 `claude-haiku-4-5`。                                                                                                                                                                                                    |
| `ANTHROPIC_BASE_URL`        | 未设置搜索专用 base URL 时 Anthropic 请求的通用回退 base URL。                                                                                                                                                                             |

使用 `ANTHROPIC_SEARCH_BASE_URL`（可选配合 `ANTHROPIC_SEARCH_API_KEY`）可以让 chat 继续经企业网关路由（`ANTHROPIC_BASE_URL` 或 `CLAUDE_CODE_USE_FOUNDRY=true`），同时把 web search 指向直连的 Anthropic 端点，反之亦然。

### Perplexity OAuth 流程行为标志

| 变量                | 行为                                                                            |
| ------------------- | ------------------------------------------------------------------------------- |
| `PI_AUTH_NO_BORROW` | 设置后禁用 Perplexity 登录流程中的 macOS 原生应用 token 借用路径                |

---

## 4) Python 工具与内核运行时

| 变量                   | 默认 / 行为                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `PI_PY`                | Python 的布尔型覆盖；未设置时遵从 `eval.py`（默认启用）                                             |
| `PI_JS`                | JavaScript 的布尔型覆盖；未设置时遵从 `eval.js`（默认启用）                                         |
| `PI_PYTHON_SKIP_CHECK` | 为真时跳过 Python 解释器可用性检查（子进程运行器仍按需启动）                                        |
| `PI_PYTHON_IPC_TRACE`  | 为真时记录与 Python 运行器子进程交换的 NDJSON 帧                                                    |
| `VIRTUAL_ENV`          | Python 运行时解析的最高优先级 venv 路径                                                             |
| `CONDA_PREFIX`         | `VIRTUAL_ENV` 之后、本地 `.venv` / `venv` 目录之前的 Python 环境回退                                |

Python 子进程过滤拒绝常见的 API key，并允许安全的基础变量以及 `LC_`、`XDG_` 和 `PI_` 前缀。

---

## 5) Agent/运行时行为开关

| 变量                         | 默认 / 行为                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_SMOL_MODEL`              | `smol` 角色的临时模型覆盖（CLI `--smol` 优先）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `PI_SLOW_MODEL`              | `slow` 角色的临时模型覆盖（CLI `--slow` 优先）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `PI_PLAN_MODEL`              | `plan` 角色的临时模型覆盖（CLI `--plan` 优先）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `PI_NO_TITLE`                | 设置时（任意非空值），禁用首条用户消息上的自动会话标题生成                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `PI_TINY_DEVICE`             | 本地微型模型的推理后端；覆盖 `providers.tinyModelDevice` 设置（默认：CPU；ONNX providers `cpu`、`gpu`、`webgpu`、`auto`、`cuda`、`dml`、`coreml`、`wasm`、`webnn`、`webnn-gpu`、`webnn-cpu`、`webnn-npu`，或 `mlx`/`metal` 以在 Apple 芯片上经 mlx-lm 运行 MLX 权重）                                                                                                                                                                                                                                                                                                                                        |
| `PI_TINY_DTYPE`              | 本地微型模型的 ONNX 量化/精度；覆盖 `providers.tinyModelDtype` 设置（默认：各模型自带的 dtype，当前 `q4`；支持 `auto`、`fp32`、`fp16`、`q8`、`int8`、`uint8`、`q4`、`bnb4`、`q4f16`、`q2`、`q2f16`、`q1`、`q1f16`）                                                                                                                                                                                                                                                                                                                      |
| `PI_NO_INTERLEAVED_THINKING` | 为 `1` 时禁用 Anthropic 交错 thinking 预算行为，并对旧的 thinking 模式使用输出 token 膨胀                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `PI_NO_THINKING_LOOP_GUARD`  | 为 `1` 时禁用模型 thinking 循环守卫                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `NULL_PROMPT`                | 为 `true` 时系统 prompt 构建器返回空字符串                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `PI_BLOCKED_AGENT`           | 在任务工具中阻止特定的 subagent 类型                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `PI_SUBPROCESS_CMD`          | 覆盖 subagent spawn 命令（绕过 `omp` / `omp.cmd` 解析）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `PI_TASK_MAX_OUTPUT_BYTES`   | 每个 subagent 捕获的最大输出字节（默认 `500000`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `PI_TASK_MAX_OUTPUT_LINES`   | 每个 subagent 捕获的最大输出行数（默认 `5000`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `PI_WALK_WORKERS`            | `omp grep` walker 及相关并行遍历使用的文件系统 walker 工作线程数（`pi-walker`；默认 `4`；`0` = 自动检测，`1` = 串行）。由 `PI_GREP_WORKERS` 更名；旧名称不再读取                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `PI_TIMING`                  | 设置时（任意非空值），经 `logger.printTimings()` 向 **stderr** 打印层级化的 timing-span 树。交互模式下 agent 就绪后（TUI 启动前）打印一次；print 模式下在整个 prompt 批次完成后打印。print 模式的 prompt 包裹在 `print:prompt:initial` / `print:prompt:next` span 中，使每条用户消息显示为独立行。`PI_TIMING=x` 在交互模式下打印后立即以退出码 0 退出进程（用于只测冷启动）。`PI_TIMING=full` 列出每个模块加载条目而非仅前 N 个。 |
| `PI_DEBUG_STARTUP`           | 设置时（任意非空值），在每个启动阶段开始/结束时向 **stderr** 流式输出一行同步的 `[startup] <phase>:start` / `:done` 标记 —— 包括命令模块导入（`cli:load:<name>`）和原生插件提取/`dlopen`（`native:*`）。与 `PI_TIMING`（仅在启动完成后打印）不同，标记能在硬挂起中幸存：stderr 上的最后一行指出进程卡住的阶段。可与 `PI_TIMING` 自由组合；标记与 span 树共享相同的阶段名。                                                                                |
| `PI_PACKAGE_DIR`             | 覆盖包资源基础目录解析（`docs/`、`examples/`、`CHANGELOG.md`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `OMP_SKIP_SETUP`             | 除 `0`、`false` 或 `no` 外的任意非空值跳过自动交互式设置场景；显式强制的设置会忽略它                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `PI_DISABLE_LSPMUX`          | 为 `1` 时禁用 lspmux 检测/集成并强制直接 spawn LSP 服务器                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `PI_RPC_EMIT_TITLE`          | 在 RPC 模式中启用标题事件的布尔型标志                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `SMITHERY_URL`               | Smithery web URL 覆盖（默认 `https://smithery.ai`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `SMITHERY_API_URL`           | Smithery API base URL 覆盖（默认 `https://api.smithery.ai`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `SMITHERY_API_KEY`           | 用于托管 MCP 认证查找的 Smithery API key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `PUPPETEER_EXECUTABLE_PATH`  | Eval 浏览器运行时的 Chromium 可执行文件覆盖                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `LITELLM_BASE_URL`           | LiteLLM 代理 base URL 回退（未设置为 `http://localhost:4000/v1`）；显式的 `providers.litellm.baseUrl` / `models.yml` 配置胜出                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `LM_STUDIO_BASE_URL`         | 默认隐式 LM Studio 发现 base URL 覆盖（未设置为 `http://127.0.0.1:1234/v1`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `OLLAMA_BASE_URL`            | 默认隐式 Ollama 发现 base URL 覆盖（未设置时用 `OLLAMA_HOST`，再否则 `http://127.0.0.1:11434`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `OLLAMA_HOST`                | `OLLAMA_BASE_URL` 未设置时用于隐式 Ollama 发现的 Ollama 主机；接受 Ollama 风格的值，如 `127.0.0.1:11434` 或 `http://host:11434`                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `OLLAMA_CONTEXT_LENGTH`      | 隐式 Ollama 发现的正整数 context-window 覆盖；只影响 OMP 的 context 预算，不改变 Ollama 运行时的 `num_ctx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `LLAMA_CPP_BASE_URL`         | 默认隐式 Llama.cpp 发现 base URL 覆盖（未设置为 `http://127.0.0.1:8080`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `PI_EDIT_VARIANT`            | 值有效时强制 edit 工具变体（`patch`、`replace`、`hashline`、`apply_patch`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `PI_INTENT_TRACING`          | 工具意图元数据的布尔型覆盖；回退到 `tools.intentTracing`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `PI_STRICT_EDIT_MODE`        | 为 `1` 时禁用内置的模型特定 edit-mode 回退，使配置的/全局 `edit.mode` 生效，除非 `PI_EDIT_VARIANT` 或 `edit.modelVariants` 覆盖它                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `PI_FORCE_IMAGE_PROTOCOL`    | 在使用处强制受支持的图像协议（`kitty`、`iterm2`/`iterm`、`sixel`、`none`）。在 tmux 内设置 `kitty` 也会选择加入 Kitty Unicode 占位符布局，除非 `PI_KITTY_PLACEHOLDERS=0` 或 `PI_NO_KITTY_PLACEHOLDERS=1` 禁用它                                                                                                                                                                                                                                                                                                                                                                                             |
| `PI_ALLOW_SIXEL_PASSTHROUGH` | 在 `PI_FORCE_IMAGE_PROTOCOL=sixel` 时允许 SIXEL 透传                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `PI_NO_PTY`                  | 为 `1` 时禁用 bash 工具的交互式 PTY 路径                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `OMP_MCP_TIMEOUT_MS`         | 为每个 MCP 服务器覆盖 MCP 客户端请求超时（毫秒）。`0` 禁用客户端超时（`AbortSignal` 永不触发）。无效（负数或非数字）值伴随警告被忽略，并使用每服务器配置或默认值（`30000`）。                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `PI_DISABLE_UUTILS_BUILTINS` | 除 `0`/`false` 外的非空值禁用 bash 工具的 uutils 内置命令；`shell.env.PI_DISABLE_UUTILS_BUILTINS` 胜出                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `OMP_NO_WEBP`                | `1` 或 `true`（不区分大小写）在图像缩放格式选择中禁用 WebP                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `MNEMOPI_EMBEDDING_MODEL`    | 未提供显式覆盖时，mnemopi memory 配置的嵌入模型覆盖                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `PI_AUTO_QA`                 | 对自动工具问题报告注入/记录具有最高优先级的布尔标志（其次查询 `dev.autoqa` 设置）；`0`/`false` 禁用，`1`/`true` 强制开启                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `PI_AUTO_QA_PUSH`            | `1`/`true` 绕过同意对话框，在无头/非交互环境中强制工具问题推送记录                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `PI_AUTO_QA_PUSH_URL`        | auto QA grievance 推送的端点覆盖；优先于 `dev.autoqaPush.endpoint` 设置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `PI_BROWSER_RELAY`           | 浏览器 relay 的 `0`/`1` 开关；覆盖 `browser.relay` 设置（Eval 的浏览器 API 需要时 relay 自动启动）                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### Hindsight memory 后端

`loadHindsightConfig()` 将每个受支持的环境覆盖解析到对应的
`hindsight.*` 设置，然后是其内置默认值。字符串值被修剪，空字符串
被忽略。布尔值不区分大小写：只有 `true`、`1` 和 `yes` 表示真；
其他任何有定义的值都表示假。整数值使用十进制 `parseInt`；非数字值
被忽略，且加载器不会对解析出的整数做钳制。枚举值必须精确匹配
列出的某一个小写值；无效值被忽略。

| 变量                               | 覆盖的设置                      | 接受值 / 内置默认                                                                 |
| ---------------------------------- | ------------------------------- | --------------------------------------------------------------------------------- |
| `HINDSIGHT_API_URL`                | `hindsight.apiUrl`              | 非空字符串；默认 `http://localhost:8888`                                          |
| `HINDSIGHT_API_TOKEN`              | `hindsight.apiToken`            | 非空字符串；默认未设置                                                            |
| `HINDSIGHT_BANK_ID`                | `hindsight.bankId`              | 非空字符串；默认未设置，因此由所选 scoping 模式推导 bank                           |
| `HINDSIGHT_BANK_MISSION`           | `hindsight.bankMission`         | 非空字符串；默认空字符串                                                          |
| `HINDSIGHT_RETAIN_MODE`            | `hindsight.retainMode`          | `full-session` 或 `last-turn`；默认 `full-session`                                |
| `HINDSIGHT_RECALL_BUDGET`          | `hindsight.recallBudget`        | `low`、`mid` 或 `high`；默认 `mid`                                                |
| `HINDSIGHT_AUTO_RECALL`            | `hindsight.autoRecall`          | 布尔；默认 `true`                                                                 |
| `HINDSIGHT_AUTO_RETAIN`            | `hindsight.autoRetain`          | 布尔；默认 `true`                                                                 |
| `HINDSIGHT_SCOPING`                | `hindsight.scoping`             | `global`、`per-project` 或 `per-project-tagged`；默认 `per-project-tagged`        |
| `HINDSIGHT_DEBUG`                  | `hindsight.debug`               | 布尔；默认 `false`                                                                |
| `HINDSIGHT_RECALL_MAX_TOKENS`      | `hindsight.recallMaxTokens`     | 整数；默认 `1024`                                                                 |
| `HINDSIGHT_RECALL_CONTEXT_TURNS`   | `hindsight.recallContextTurns`  | 整数；默认 `1`                                                                    |
| `HINDSIGHT_RECALL_MAX_QUERY_CHARS` | `hindsight.recallMaxQueryChars` | 整数；默认 `800`                                                                  |
| `HINDSIGHT_RETAIN_EVERY_N_TURNS`   | `hindsight.retainEveryNTurns`   | 整数；默认 `3`                                                                    |
| `HINDSIGHT_REQUEST_TIMEOUT_MS`     | `hindsight.requestTimeoutMs`    | 整数毫秒；默认 `30000`                                                            |
| `HINDSIGHT_REFLECT_TIMEOUT_MS`     | `hindsight.reflectTimeoutMs`    | 整数毫秒；默认 `120000`                                                           |
| `HINDSIGHT_RECALL_TIMEOUT_MS`      | `hindsight.recallTimeoutMs`     | 整数毫秒；默认 `30000`                                                            |
| `HINDSIGHT_RETAIN_TIMEOUT_MS`      | `hindsight.retainTimeoutMs`     | 整数毫秒；默认 `60000`                                                            |

使用 CLI `--no-pty` 时也会在内部设置 `PI_NO_PTY`。

---

## 6) 存储与配置根路径

这些影响 coding-agent 存储数据的位置以及加载哪些进程本地的设置覆盖层。

| 变量                                                | 默认 / 行为                                                                                                                |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `OMP_PROFILE`                                       | 规范的具名 profile 选择器；即使显式为空也胜过 `PI_PROFILE`                                                                 |
| `PI_PROFILE`                                         | 仅在 `OMP_PROFILE` 未定义时使用的旧版 profile 选择器                                                                       |
| `PI_CONFIG_DIR`                                     | home 下的配置根目录名（默认 `.omp`）                                                                                      |
| `PI_CODING_AGENT_DIR`                               | 仅默认 profile 的完整 agent 目录覆盖；具名 profile 忽略它                                                                  |
| `PI_CODING_AGENT_SESSION_DIR`                       | 由 launch 参数解析消费的初始会话目录覆盖                                                                                   |
| `PI_CONFIG_FILES`                                   | 设置覆盖层的平台路径列表（Unix 上 `:`，Windows 上 `;`）；在显式 `--config` 覆盖层之前按序加载                              |
| `OMP_AUTORESEARCH_DB_DIR`                           | 每项目 autoresearch DB 与项目工件根目录的目录覆盖                                                                          |
| `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME` | 在 macOS/Linux 上，仅当目标 `omp` 根（或具名 profile 根）已存在时才重定向对应的 OMP 路径                                   |
| `PWD`                                               | 路径辅助函数中匹配规范化的当前工作目录时使用                                                                               |
| `OMP_WORKTREE_DIR`                                  | agent 管理的 worktree 目录覆盖（默认 `~/.omp/wt`）；必须是绝对路径或 `~` 相对路径，相对路径被忽略；胜过 `worktree.base` 设置 |
| `OMP_GITHUB_CACHE_DB`                               | 覆盖 GitHub view 缓存数据库路径（默认 `~/.omp/cache/github-cache.db`）                                                     |

---

## 7) Shell/工具执行环境

（来自 `packages/utils/src/procmgr.ts` 与 coding-agent bash 工具集成。）

| 变量                       | 行为                                                                           |
| -------------------------- | ------------------------------------------------------------------------------ |
| `PI_BASH_NO_CI`            | 抑制向 spawn 的 shell 环境自动注入 `CI=true`                                   |
| `CLAUDE_BASH_NO_CI`        | `PI_BASH_NO_CI` 的旧版别名回退                                                 |
| `PI_BASH_NO_LOGIN`         | 禁用 login-shell 模式；shell 参数变为 `['-c']` 而非 `['-l','-c']`              |
| `CLAUDE_BASH_NO_LOGIN`     | `PI_BASH_NO_LOGIN` 的旧版别名回退                                              |
| `PI_SHELL_PREFIX`          | 可选的命令前缀包装器                                                           |
| `CLAUDE_CODE_SHELL_PREFIX` | `PI_SHELL_PREFIX` 的旧版别名回退                                               |
| `VISUAL`                   | 首选的外部编辑器命令                                                           |
| `EDITOR`                   | 回退的外部编辑器命令                                                           |

当前实现：`PI_BASH_NO_LOGIN`/`CLAUDE_BASH_NO_LOGIN` 是活跃的；任一设置时 `getShellArgs()` 返回 `['-c']`。

`PI_BASH_NO_CI`、`PI_BASH_NO_LOGIN` 和 `PI_SHELL_PREFIX` 仅在规范变量未设置时使用其 `CLAUDE_*` 别名。

---

## 8) UI/主题/会话检测（自动检测的环境变量）

这些作为运行时信号读取；通常由终端/OS 设置而非手动配置。

| 变量                                                                               | 用于                                          |
| ---------------------------------------------------------------------------------- | --------------------------------------------- |
| `COLORTERM`, `TERM`, `WT_SESSION`                                                  | 颜色能力检测（主题颜色模式）                  |
| `COLORFGBG`                                                                        | 终端背景亮/暗自动检测                         |
| `TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, `TERMINAL_EMULATOR`                        | 系统 prompt/上下文中的终端身份                |
| `TMUX_PANE`, `CMUX_SURFACE_ID`, `KITTY_WINDOW_ID`, `TERM_SESSION_ID`, `WT_SESSION` | 稳定的每终端会话 breadcrumb ID                |
| `SHELL`, `ComSpec`, `TERM_PROGRAM`, `TERM`                                         | 系统信息诊断                                  |
| `APPDATA`, `XDG_CONFIG_HOME`                                                       | lspmux 配置路径解析                           |
| `HOME`                                                                             | MCP 命令 UI 中的路径缩短                      |

`COPILOT_HOME` 覆盖 GitHub Copilot 配置 home（默认 `~/.copilot`），`COPILOT_CUSTOM_INSTRUCTIONS_DIRS` 提供额外的逗号分隔 instruction 目录。`JS_DEBUG_DAP_SERVER` 选择一个已有的 JavaScript 调试适配器服务器；`XDG_DATA_HOME` 也参与内置调试器发现。

---

## 9) TUI 运行时标志（共享包，影响 coding-agent 体验）

| 变量                           | 行为                                                                                                                                                                                                                                               |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_NOTIFICATIONS`             | `off` / `0` / `false` 抑制桌面通知                                                                                                                                                                                                                 |
| `PI_TUI_WRITE_LOG`             | 设置时将 TUI 写入记录到文件                                                                                                                                                                                                                        |
| `PI_TUI_RAW_BACKSPACE_IS_CTRL` | 为 `1` 时将原始 `0x08` 解释为 Ctrl+Backspace 而非 Backspace；当 SSH/容器跳板隐藏了 Windows Terminal 客户端时使用                                                                                                                                   |
| `PI_HARDWARE_CURSOR`           | 为 `1` 时启用硬件光标模式                                                                                                                                                                                                                          |
| `PI_NO_SYNC_OUTPUT`            | 设置时（任意非空值），禁用 DEC 2026 同步输出包装，同时保留 TUI 自动换行守卫                                                                                                                                                                        |
| `PI_NO_DECCARA`                | 设置时（为真），禁用 Kitty DECCARA 矩形 SGR 背景填充（强制填充字符串渲染）                                                                                                                                                                        |
| `PI_DEBUG_REDRAW`              | 为 `1` 时启用重绘调试日志                                                                                                                                                                                                                          |
| `PI_FORCE_IMAGE_PROTOCOL`      | 强制终端图像协议检测（`kitty`、`iterm2`/`iterm`、`sixel`、`none`）。在终端复用器内设置 `kitty` 也会选择加入 Kitty Unicode 占位符布局，除非 `PI_KITTY_PLACEHOLDERS=0` 或 `PI_NO_KITTY_PLACEHOLDERS=1` 禁用它                                           |
| `PI_KITTY_PLACEHOLDERS`        | `1` 强制开启 Kitty Unicode 占位符布局；`0` 强制关闭。在终端复用器下，只有在确认外层终端支持 Kitty `U=1` 占位符后才使用 `1` —— 否则 U+10EEEE 可能渲染为字面的 PUA 方块                                                                              |
| `PI_NO_KITTY_PLACEHOLDERS`     | `1` 硬禁用 Kitty Unicode 占位符布局并优先于 `PI_KITTY_PLACEHOLDERS`                                                                                                                                                                                |
| `PI_TUI_RESIZE_IN_PLACE`       | `1`/`true` 强制原地 resize（不借用 alt-screen，不 ED3 重折行）；`0`/`false` 强制 alt-screen 快速路径。Warp 默认开启，它在 alt-screen 切换时会重新报告尺寸                                                                                           |

### 浏览器启动/代理控制

| 变量                                   | 行为                                                                                     |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `PUPPETEER_PROXY`                      | 添加 Chromium 的 `--proxy-server` 启动参数                                               |
| `PUPPETEER_PROXY_BYPASS_LOOPBACK`      | 布尔型标志，向绕过列表添加 `<-loopback>`，使 localhost 也走代理                           |
| `PUPPETEER_PROXY_IGNORE_CERT_ERRORS`   | 布尔型标志，以忽略证书错误的方式启动 Chromium                                            |
| `CMUX_WORKSPACE_ID`, `CMUX_SURFACE_ID` | 浏览器打开分屏时目标的 cmux workspace/surface                                            |
| `CMUX_RELAY_ID`, `CMUX_RELAY_TOKEN`    | cmux relay 身份/认证回退                                                                 |

---

## 10) 提交生成控制

| 变量                      | 行为                                                                |
| ------------------------- | ------------------------------------------------------------------- |
| `PI_COMMIT_TEST_FALLBACK` | 为 `true`（不区分大小写）时强制提交回退生成路径                     |
| `PI_COMMIT_NO_FALLBACK`   | 为 `true` 时在 agent 无提案时禁用回退                               |
| `PI_COMMIT_MAP_REDUCE`    | 为 `false` 时禁用 map-reduce 提交分析路径                           |
| `DEBUG`                   | 设置时打印提交 agent 的错误堆栈追踪                                 |

---

## 11) OpenTelemetry 导出

只有至少一个信号有端点时 OMP 才初始化 OTLP 导出。`OTEL_SDK_DISABLED=true` 禁用初始化。

| 变量组                                                                                                          | 行为                                                                                            |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                                                                                   | 通用端点回退                                                                                    |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | 每信号端点；优先于通用端点                                                                      |
| `OTEL_TRACES_EXPORTER`, `OTEL_LOGS_EXPORTER`, `OTEL_METRICS_EXPORTER`                                           | 包含 `none` 的列表禁用该信号                                                                    |
| `OTEL_EXPORTER_OTLP_PROTOCOL` 及每信号的 `..._PROTOCOL` 变体                                                    | 本运行时只启用 `http/protobuf`；另一个显式协议禁用该信号                                        |
| `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`                                                                 | OpenTelemetry 资源元数据                                                                        |
| `OTEL_LOG_LEVEL`                                                                                                | 导出的最低 OMP 日志级别                                                                         |

---

## 安全敏感变量

视这些为机密；不要记录或提交它们：

- Provider/API key 与 OAuth/bearer 凭据（所有 `*_API_KEY`、`*_TOKEN`、OAuth access/refresh token）
- 云凭据（`AWS_*`、`GOOGLE_APPLICATION_CREDENTIALS` 路径可能暴露服务账号材料）
- 搜索/provider 认证变量（`EXA_API_KEY`、`BRAVE_API_KEY`、`PERPLEXITY_API_KEY`、Anthropic 搜索 key）
- Foundry mTLS 材料（`CLAUDE_CODE_CLIENT_CERT`、`CLAUDE_CODE_CLIENT_KEY`、指向私有 CA bundle 的 `NODE_EXTRA_CA_CERTS`）

Python 运行时还会在 spawn 内核子进程前显式剥离许多常见 key 变量（`packages/coding-agent/src/eval/py/runtime.ts`）。
