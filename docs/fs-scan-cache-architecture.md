# 文件系统扫描缓存架构契约

本文档定义由 `crates/pi-walker` 实现并被暴露给 `packages/coding-agent` 的原生发现 API 消费的共享 Rust 文件系统扫描缓存。

## 所有权与数据模型

缓存位于 `crates/pi-walker/src/cache.rs`。它存储目录遍历得到的自有 `CollectedEntry` 列表，而非最终的 glob、模糊搜索、grep 或 AST 结果。`crates/pi-walker/src/lib.rs` 中的 `WalkRequest` 在该收集层之上应用静态过滤、排序、限制以及可选的空结果重验。

当前的原生消费者：

- `crates/pi-natives/src/glob.rs` — 通过 `GlobOptions.cache` 选择启用
- `crates/pi-natives/src/fd.rs`（`fuzzyFind`）— 通过 `FuzzyFindOptions.cache` 选择启用
- `crates/pi-natives/src/ast.rs`（`astGrep` / `astEdit` 发现）— 目录操作数始终缓存

`crates/pi-natives/src/grep.rs` 使用 `WalkRequest` 做候选发现，但显式设置 `.cache(false)`；当前的公开 `GrepOptions` 没有 cache 字段。

将 walker 结果桥接到 JavaScript 的 N-API DTO 层位于 `crates/pi-natives/src/iofs.rs`；如其文件头所述，"`pi-walker` owns traversal and cache policy"，`iofs.rs` 只保留面向 JS 的形状和转换。公开的失效绑定仍是 `invalidateFsScanCache(path?)` —— 声明于 `iofs.rs`（转发到 `pi_walker::invalidate_path_string` / `pi_walker::invalidate_all`），并导出于 `packages/natives/native/index.d.ts` / `index.js`。Coding-agent 的变更辅助函数位于 `packages/coding-agent/src/tools/fs-cache-invalidation.ts`。

## 缓存键分区

每个缓存键由以下组成：

- 规范化后的根目录
- 完整的生效 `WalkOptions` 值，仅清除其 `cache` 位

因此，所有影响遍历的选项都会对条目进行分区：隐藏与 ignore 策略、`.git` 和 `node_modules` 剪枝、符号链接策略、元数据详细程度、每目录顺序、根目录发射、min/max 深度、contents-first 遍历、目录错误策略以及同一文件系统策略。这些字段中任何一项不同的调用都不共享扫描。特别地，`follow_links` **是**当前键的一部分。

高层的 `WalkRequest` 过滤、排序、结果限制、空重查策略和 size-hint 策略不直接存储在键中。收集之前，size-hint 策略和最大文件大小过滤可能将生效的元数据详细程度提升为 `Full`，进而对底层扫描进行分区。

## 收集行为

`pi-walker` 将相对根路径相对于当前 cwd 解析，要求目录存在，并在可能时对其进行规范化。`WalkOptions` 控制遍历；消费者显式选择自己的策略，而不是继承 walker 的所有默认值。

收集的条目包含规范化为正斜杠的相对路径和文件类型。`WalkDetail::Full` 额外请求 mtime 和常规文件大小。取消通过调用方提供的心跳传递。

与遍历相关的并行工作使用共享的 Rayon 池：

- `PI_WALK_WORKERS` 默认为 `4`
- `0` 自动检测可用并行度
- `1` 强制串行工作
- 辅助操作仅在 256 项及以上时并行化

## 新鲜度与淘汰

可通过环境变量覆盖的全局策略：

- `FS_SCAN_CACHE_TTL_MS` — 默认 `1000`
- `FS_SCAN_EMPTY_RECHECK_MS` — 默认 `200`
- `FS_SCAN_CACHE_MAX_ENTRIES` — 默认 `16`

启用缓存时：

- TTL `0` 绕过缓存，返回 `cache_age_ms = 0` 的新扫描。
- 命中且年龄小于 TTL 时克隆存储的条目并报告其年龄。
- 过期的条目被移除并替换为新扫描。
- 插入后，超过配置上限的条目按创建时间从最旧开始淘汰。

禁用缓存时，收集总是新扫描，既不读取也不填充共享缓存。它也不会为相同的键淘汰已有的缓存条目。

## 空结果重验

`WalkRequest` 拥有重查策略。`EmptyRecheck::Configured` 在以下条件下重试一次：

1. 首次收集是年龄非零的缓存命中，
2. 结果经过请求的高层过滤后为空，且
3. 缓存年龄至少为 `FS_SCAN_EMPTY_RECHECK_MS`（配置阈值为 `0` 时禁用此模式）。

重试在无缓存下运行，不会替换或淘汰已有的缓存条目。`EmptyRecheck::Never` 禁用该行为；`AfterMillis(n)` 提供请求特定的年龄阈值。

当前效果：

- `glob` 将其编译后的 glob 与 node-module 策略集成到 `WalkFilter` 中，因此空的过滤后匹配集可以触发重验。
- AST 发现集成了 files-only、可选 glob 和 node-module 过滤，因此空的候选集可以触发重验。
- `fuzzyFind` 以默认的全条目过滤器收集，之后打分。因此重验覆盖的是底层遍历为空的情况，而非遍历非空但所有条目得分均为零的情况。
- `grep` 不走缓存，因此不适用基于缓存年龄的重查。

## 消费者策略

- `glob`：`hidden=false`、`gitignore=true`、`cache=false`；跳过 `.git`；除非模式提到否则跳过 `node_modules`；从不跟随符号链接；使用路径顺序和模式限定的深度；仅在 mtime 排序时使用完整详细信息。
- `fuzzyFind`：`hidden=false`、`gitignore=true`、`cache=false`；跳过 `.git` 和 `node_modules`；始终跟随符号链接；使用最少详细信息和路径顺序。
- `astGrep` / `astEdit` 目录发现：`hidden=true`、`gitignore=true`，缓存始终启用；跳过 `.git`；除非提供的 glob 提到否则排除 `node_modules`；从不跟随符号链接；使用最少详细信息和路径顺序。
- `grep`：候选遍历跳过 `.git`、从不跟随符号链接、使用最少详细信息，且不走缓存。

TUI 的 `@`-mention 自动补全选择启用带缓存的 `fuzzyFind`。Coding-agent 的 grep 工具不填充此缓存。

## 失效

`invalidateFsScanCache(path?)`：

- 无路径时清除所有条目
- 有路径时移除所有缓存根是目标前缀的条目

相对路径相对于 cwd 解析。失效会对目标进行规范化；当目标已不存在时，尝试规范化其父目录并重新附加文件名。这支持创建、删除和重命名的失效。

Coding-agent 辅助函数：

- `invalidateFsScanAfterWrite(path)`
- `invalidateFsScanAfterDelete(path)`
- `invalidateFsScanAfterRename(oldPath, newPath)` — 两者不同时对两侧都失效

当前的 write、hashline、patch、replace、auto-repair、sloppy-edit 和 ACP-bridge 变更路径都会在成功变更后调用这些辅助函数。任何新的文件系统变更路径也必须如此。

## 新增一个缓存消费者

1. 选择稳定的遍历选项并复用 `WalkRequest`；任何生效 `WalkOptions` 的差异都会创建一个分区。
2. 当空结果重验应观察到稳定的候选过滤时，将其放入 `WalkFilter`。收集后的打分无法触发请求的重查。
3. 对真正需要最新结果的请求使用 `.cache(false)`；它绕过而非清除共享状态。
4. 慎重选择 `EmptyRecheck`。不要添加按调用粒度的 TTL 控制；TTL 和默认重查年龄是全局的。
5. 每次成功的写入、删除或移动之后都要失效；重命名时对两侧都失效。

## 边界

- `DashMap` 缓存是进程本地的，不持久化。
- 条目是完整的自有扫描结果，而非最终的工具结果。
- 缓存命中会克隆存储的条目向量。
- 共享只发生在相同的规范化根目录和完整生效遍历选项下。
