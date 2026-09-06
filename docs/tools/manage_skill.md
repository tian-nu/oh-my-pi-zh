# manage_skill

> 创建、更新或删除一个隔离的受管 skill（managed skill）。

## 来源
- 入口：`packages/coding-agent/src/tools/manage-skill.ts`
- 面向模型的 prompt：`packages/coding-agent/src/prompts/tools/manage-skill.md`
- 受管 skill 辅助函数：`packages/coding-agent/src/autolearn/managed-skills.ts`
- skill 发现：`packages/coding-agent/src/extensibility/skills.ts`

## 注册 / 可见性
- 工具元数据：`approval = "write"`、`strict = true`、`loadMode = "essential"`。它保持顶层注册，而不挂载到 `xd://` 之下。
- 注册要求 `autolearn.enabled = true`（默认 `false`），但与 `memory.backend` 无关。
- 启用的顶层会话会自动把它包含在普通的显式工具列表中。子 agent 不会自动发现或接收它，但当其请求工具/frontmatter 列表中显式包含时可以使用它。
- 执行为单次完成，不发出进度更新。

## 输入

| 字段 | 类型 | 必需 | 说明 |
|---|---|---:|---|
| `action` | `"create" \| "update" \| "delete"` | Yes | 受管 skill 变更操作。 |
| `name` | `string` | Yes | kebab-case 的受管 skill 名称。 |
| `description` | `string` | Create/update | 用于 skill 发现的一行描述。 |
| `body` | `string` | Create/update | 供 `SKILL.md` 使用的 Markdown 正文；不要包含 frontmatter。 |

## 输出
- `delete`：`content[0].text = "Deleted managed skill \"<name>\"."`，`details = { action: "delete", name }`
- `create`：`content[0].text = "Created managed skill \"<name>\" (managed-skills/<name>/SKILL.md)."`，`details = { action: "create", name }`
- `update`：`content[0].text = "Updated managed skill \"<name>\" (managed-skills/<name>/SKILL.md)."`，`details = { action: "update", name }`
- 创建时发生已创作 skill 遮蔽会返回 `isError: true`，带 `details = { action: "create", name, shadowed: true }`。

## 流程
1. 仅当 `autolearn.enabled` 为 true 时，`ManageSkillTool.createIf(...)` 才暴露该工具，并捕获会话可选的 `refreshSkills` 回调。
2. schema 校验要求 `create`/`update` 同时提供 `description` 与 `body`；`delete` 只需要 `name`。
3. `delete` 调用 `deleteManagedSkill(name)`，然后在回调存在时刷新活动 skill。
4. `create` 规范化名称，并检查是否有活动 authored skill 已占用该名称；若有，它返回错误结果且不写入。
5. `create`/`update` 调用 `writeManagedSkill(...)`，后者会规范化/校验名称、净化生成的 frontmatter、对同名进程内写入做串行化，并在 managed-skills 根目录下写入 `SKILL.md`。
6. 创建/更新成功后，工具在回调存在时刷新活动 skill，使交互式会话能立即发现该变更。

## 模式 / 变体
- `create`：以排他创建语义原子地创建 `SKILL.md`；若已存在则失败。
- `update`：覆盖既有的常规单链接受管 `SKILL.md`；若不存在则失败。
- `delete`：递归删除既有的受管 skill 目录；若不存在则失败。
- 对同一规范化名称的变更在进程内按提交顺序串行执行；不同名称可以并行。跨进程竞争不做串行化。

## 副作用
- 文件系统：写入或删除 `<agent-dir>/managed-skills/<name>/SKILL.md`；默认 agent 目录为 `~/.omp/agent`。
- 网络：无。
- 会话状态：在工具创建期间读取 `autolearn.enabled`，并在变更成功且存在 `refreshSkills` 时刷新活动 skill 列表。
- 后台工作：无。

## 限制与上限
- 可用性要求 `autolearn.enabled = true`。
- 名称会去除首尾空白并转为小写，之后必须匹配 `[a-z0-9][a-z0-9-]{0,63}`。
- 描述会被净化为一行，并去除控制/格式字符、尖括号、反引号与重复波浪号。
- 正文会去除首尾空白且必须保持非空；生成的 frontmatter 只包含规范化的 `name` 与净化的 `description`。
- 最终受管 `SKILL.md` 内容（含 frontmatter 与描述）上限为 `64_000` UTF-8 字节。
- 会检查 managed-skills 根目录、skill 目录与文件以防止符号链接逃逸；update 还拒绝非常规文件或有多重硬链接的文件。

## 错误
- 无效名称抛出 `Invalid skill name "<raw>"...`。
- create/update 未同时提供 `description` 与 `body` 会被 schema 校验拒绝；执行期的防御性错误为 `"<action>" requires both "description" and "body".`
- 净化为空的描述抛出 `Managed skill "<name>" needs a non-empty description.`
- 去除空白后为空的正文抛出 `Managed skill "<name>" needs a non-empty body.`
- 超出体积的最终文件抛出 `Managed skill is <bytes> bytes; the limit is 64000.`
- 对既有受管文件执行 `create`、对缺失目标执行 `update`/`delete` 会抛出动作专属的辅助函数错误。
- 在 `create` 上的 authored 名称遮蔽是一个正常工具结果：`isError: true` 且 `details.shadowed = true`；不写入任何文件。
- 不安全的根目录、符号链接目录/文件、非常规文件以及多重硬链接的 update 文件会抛出安全错误。

## 备注
- 受管 skill 生成在 `<agent-dir>/managed-skills` 下，从不修改 authored skill。
- 不要在 `body` 中包含 YAML frontmatter；`writeManagedSkill(...)` 会生成规范化的 `name` 与净化的 `description` frontmatter。
- `update` 不会绕过 authored skill 的优先级：若存在同名的 authored skill，受管 skill 在发现中仍处于被遮蔽状态。
