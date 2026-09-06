# 安装 ID

按安装持久化的 UUID，跨会话与 profile 共享。当 provider 兼容协议、账户级设备元数据、auth-broker 用量上报或去重诊断推送需要稳定的安装身份时，它提供这一身份。UUID 本身是随机的，不由主机名、用户名、硬件或账户数据派生。

## API

由 `@oh-my-pi/pi-utils`（`packages/utils/src/dirs.ts`）导出：

| 符号 | 用途 |
| --- | --- |
| `getInstallId(): string` | 返回安装 ID，首次调用时生成并持久化一个。结果在运行时的整个生命周期内缓存在进程内。 |
| `__resetInstallIdCacheForTests(): void` | 清空进程内缓存。仅供测试——严禁在生产代码中调用。 |

生成的 ID 是小写 RFC 4122 UUID。既有持久化值在匹配 `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`（正则带 `i` 标志）时按不区分大小写接受，并原样返回存储的值。

## 存储

- 路径：`<base-config-root>/install-id`——默认即 `~/.omp/install-id`，遵循 `PI_CONFIG_DIR`。相对于基础配置根目录（`getBaseConfigRoot()`）解析，与当前激活的 profile 无关，因此主机上的每个 profile 共享同一个安装 ID（安装身份按安装计，而非按 profile 计）。
- 格式：单个 UUID 行（末尾带 `\n`）。
- 权限：文件以 `0o600` 模式创建。
- 生命周期：独立于 `~/.omp/agent/`。清除 agent 状态（会话、设置、数据库）不会重新生成安装 ID；只有删除 `install-id` 文件本身才会。

## 生成与生命周期

1. 首次调用 `getInstallId()` 会读取该文件。若内容可解析为有效 UUID，则缓存并返回该值。
2. 否则辅助函数调用 `crypto.randomUUID()`（基于 Node CSPRNG 的 UUID v4）生成一个新 ID。
3. 新值通过 `open(O_WRONLY | O_CREAT | O_EXCL, 0o600)` 写入。排他创建保护意味着两个进程同时首次调用时不可能都成功——落败者会看到 `EEXIST`，重新读取胜者的文件并采用该 ID。
4. 若既有文件含有非空垃圾内容（未通过 UUID 正则），会在排他创建前对其执行 `unlink`，以免 `O_EXCL` 因陈旧数据而失败。
5. 其他任何写入失败（只读文件系统、权限错误）都会被吞掉：新生成的 UUID 仍会在内存中缓存，让进程其余部分看到稳定值；后续进程启动时会重试持久化。
6. 之后的进程内调用直接返回缓存值，不触碰磁盘。首次调用后修改磁盘上的文件不会生效，直到进程重启（或测试调用 `__resetInstallIdCacheForTests`）。

## 使用方

| 使用方 | 用途 |
| --- | --- |
| `packages/ai/src/providers/openai-codex-responses.ts` | 将该值作为 OpenAI Codex 兼容的 `installationId` 发送，与按会话/线程/窗口区分的 ID 一并携带。 |
| `packages/ai/src/providers/anthropic.ts` 与 `packages/coding-agent/src/session/session-metadata.ts` | 从安装 ID 派生 Claude 兼容的 `device_id` 元数据；存在 Anthropic 账户 UUID 时以其为作用域。原始安装 ID 不直接用作 device ID。 |
| `packages/ai/src/auth-broker/remote-store.ts` | 在发送给所配置 auth broker 的用量观测报告中包含它。这些报告还包含主机名；install-ID 辅助函数本身不生成也不组合该元数据。 |
| `packages/coding-agent/src/tools/report-tool-issue.ts` | 在自动 QA 的问题反馈推送中作为 `installId` 包含它，以便后端关联来自同一安装的报告。 |

新的使用方必须将该值视为不透明数据。辅助函数不产生任何 PII，但传输层仍可能把它与其他元数据一同发送；每个使用方仍要负责记录并最小化自己的完整载荷。

## 另见

- [environment-variables.md](environment-variables.md) —— `PI_CONFIG_DIR` 控制 `install-id` 的存放位置。
- [config-usage.md](config-usage.md) —— 更全面的配置根目录布局。
