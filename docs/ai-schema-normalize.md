# AI 工具 schema 归一化

`@oh-my-pi/pi-ai` 提供统一的 schema 归一化器，各 provider 在工具上线前使用它。所有 walker 位于 `packages/ai/src/utils/schema/normalize.ts`；操作性约定见 `packages/ai/src/utils/schema/CONSTRAINTS.md`。

不再有独立的 `strict-mode.ts` 模块——OpenAI strict-mode 清洗、OpenAI Responses `oneOf` 重写、Google/Vertex/Gemini-CLI 清洗、Cloud Code Assist Claude 清洗以及 MCP 清洗都共用同一个选项驱动的遍历。

## 入口

所有导出位于 `@oh-my-pi/pi-ai/utils/schema`：

- `normalizeSchema(value, options)` — 通用的选项驱动 walker。
- `normalizeSchemaForGoogle(value)` — Gemini / Vertex / Gemini CLI。
- `normalizeSchemaForCCA(value)` — Cloud Code Assist Claude（Antigravity + GCA）。
- `normalizeSchemaForMCP(value)` — 进入 custom-tool registry 之前的 MCP `inputSchema`。`tool-bridge.ts` 会把每个 MCP `inputSchema` 都经过这个分发器。
- `sanitizeSchemaForOpenAIResponses(schema)`（别名 `normalizeSchemaForOpenAIResponses`）— 递归地把 `oneOf` 重写为 `anyOf`，给 object schema 添加空的 `properties`，并移除 Responses API 拒绝的正则 lookaround。
- `sanitizeSchemaForStrictMode(schema)` 以及 `enforceStrictSchema(schema)` / `tryEnforceStrictSchema(schema)` — OpenAI strict-mode 流水线（sanitize → enforce）。三者都从 `normalize.ts` 导出。
- 来自 `./adapt` 的 `adaptSchemaForStrict(schema, strict)` — 轻量组合器，把 draft-07 输入升级到 2020-12，并包装 `tryEnforceStrictSchema` 供 provider 调用点使用。`./adapt` 还导出 `NO_STRICT` 全局旁路标志（环境变量 `PI_NO_STRICT`），所有发出 `strict: true` 的 provider 都遵守它。
- `normalizeSchemaForMoonshot(value)` — Moonshot/Kimi 的 MFJS 子集。
- `sanitizeSchemaForOllama(schema)` — 针对 Ollama 的 Go schema 解析器重写布尔子 schema、type 数组和布尔型 object 开放性关键字。
- `sanitizeSchemaForGrammar(schema)` — 为受语法约束的 OpenAI 兼容后端放宽布尔子 schema，同时保留布尔型 `additionalProperties` / `unevaluatedProperties`。

统一流程重构中已移除：

- `strict-mode.ts`（并入 `normalize.ts`）。
- `sanitize-google.ts` 和 `normalize-cca.ts`（由 `normalizeSchemaFor*` 分发器取代）。
- `StringEnum` 辅助函数 — 请使用 `type.enumerated(...)`；omptype 会发出 provider 兼容的 JSON Schema。
- `sanitizeSchemaFor{Google,CCA,MCP}` / `prepareSchemaForCCA` — 更名为 `normalizeSchemaFor{Google,CCA,MCP}`。

## 分发器映射

| Provider 传输层                                                    | 分发器                                                                       |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `openai-completions`                                               | `adaptSchemaForStrict`（启用 strict mode 时 sanitize + enforce）              |
| `openai-responses`、`openai-codex-responses`                       | strict-mode 适配前先 `sanitizeSchemaForOpenAIResponses`                      |
| `azure-openai-responses`                                           | `sanitizeSchemaForOpenAIResponses`；不做适配，发出 `strict: false`            |
| 使用 MFJS 的 Moonshot/Kimi 原生宿主（`toolSchemaFlavor: "moonshot-mfjs"`） | `normalizeSchemaForMoonshot`                                 |
| 语法型 OpenAI 兼容宿主（`toolSchemaFlavor: "grammar"`）             | `sanitizeSchemaForGrammar`                                      |
| `ollama` / `ollama-cloud` 工具参数                                 | `toolWireSchema` → `sanitizeSchemaForOllama`                                 |
| `google-generative-ai`、`google-vertex`、Gemini CLI                | `normalizeSchemaForGoogle`                                                   |
| Cloud Code Assist Claude（Antigravity + GCA，`claude-*` 模型 id）  | `normalizeSchemaForCCA`                                                      |
| MCP `inputSchema` 摄取                                             | `normalizeSchemaForMCP`                                                      |
| `anthropic-messages`（原生，非 CCA）                               | `anthropic.ts` 中的 per-provider 白名单                                      |

Gemini CLI / Antigravity CCA 必须运行完整的 `normalizeSchemaForCCA` 流水线（而不只是第一遍关键字剥离），以与共享的 Google Claude 路径保持一致。

## 遍历语义

`normalizeSchema` 先把输入升级到 JSON Schema 2020-12，解引用整棵树，然后用分发器固定的选项集遍历。每个节点：

1. 把 `snake_case` 组合器/属性键重命名为 camelCase（`any_of` → `anyOf` 等；冲突遵循 python-genai 的 `pop(from)`/`set(to)` 语义——snake_case 获胜）。
2. 在递归子节点前，对可空联合应用 `handle_null_fields` 折叠。
3. 剥离目标 provider 不支持的键，并可通过 spill 格式化器（`spill.ts`）把人类可读的键（`pattern`、`format`、min/max、`default`、`examples` 等）提升到同级的 `description`。结构/元键（`$ref`、`$defs`、`additionalProperties`）不会被 spill。
4. 归一化类型联合（`type: ["T", "null"]` → Google 上为 `type: "T"` + 可空标记，CCA 上为普通 `type: "T"`）。
5. 折叠仅 object / 同类型的组合器，可选择有损折叠混合类型组合器（仅 CCA），并运行残余组合器不动点。
6. 当设置了 `validateAndFallback`（CCA 路径）时，用内部结构校验器（`meta-validator.ts` 的 `isValidJsonSchema`）校验，并在残余不兼容时发出逐工具的回退 `{ "type": "object", "properties": {} }`——残余不兼容包括 `type` 数组、`type: "null"`、`nullable` 键，或任何剩余的 `anyOf`/`oneOf`/`allOf`。

## OpenAI strict-mode 流水线

`adaptSchemaForStrict(schema, strict)` 运行 `tryEnforceStrictSchema`，它组合了：

1. **Sanitize**（`sanitizeSchemaForStrictMode`）：剥离非结构关键字（`format`、`pattern`、min/max、`examples`、`default`、`if`/`then`/`else`、`not`、`unevaluated*`、`patternProperties`、`dependent*`、`content*`、`min/maxProperties`、`$dynamicRef` 等）。`default` 值在被丢弃前以内联方式写入同级 `description`，形如 ` (default: X)`——除非 `description` 已包含 `(default:` 或不存在 `description`。
2. **Enforce**（`enforceStrictSchema`）：每个 object 节点获得 `additionalProperties: false`，每个属性进入 `required`，可选属性变为可空联合（`anyOf: [<original>, { "type": "null" }]`）。元组 `prefixItems` 递归地 strict 化。

两个阶段都使用缓存/循环守卫，因此 ref、`allOf` 和可空包装保持确定性而不会无限递归。`tryEnforceStrictSchema` 是 fail-open 的：任何异常都会返回 `{ strict: false, schema: upgraded }`，因此调用方必须只在 enforcement 确实成功时才发出 `strict: true`。

### strict-mode 归一化器处理的边界情况

- **本地 `$ref` 内联。** OpenAI strict mode 拒绝带同级键的 `{ "$ref": "...", "description": "..." }`。sanitizer 会针对根预解析本地 `#/...` ref 并合并，**同级键获胜**——与 `openai-python` 的 `_ensure_strict_json_schema` 优先级相同。递归 ref 由每次遍历的 epoch 保护。
- **单项 `allOf`。** `{ "allOf": [X], ...siblings }` 折叠为 `{ ...X, ...siblings }`，内联条目的键获胜（与 `openai-python` 的 `_pydantic.py:79-83` 一致）。多项 `allOf` 保持原样，由下游校验器在需要时拒绝。
- **type 数组分支与可空联合。** 当节点有 `type: ["T", "U"]` 时，sanitizer 为每个类型生成一个变体 schema，并剪除类型专属关键字（如 `properties`/`required` 只留在 `object` 变体上，`items` 只留在 `array` 变体上）。共享的 `description` 被**提升到 `anyOf` 包装上**，而不是在每个分支上重复——因此严格的可空联合变成 `{ anyOf: [T, { type: "null" }], description: "..." }`，而不是 `anyOf: [{ ..., description }, { ..., description }]`。
- **没有 `type` 的 enum/const。** sanitize 和 enforce 路径都会调用 `inferStrictPrimitiveTypeFromEnumOrConst` 从 `enum` / `const` 值推断基础 `type`。混合基础类型的 enum（`[1, "two", null]`）、包含对象/数组的 enum，以及非基础类型的 `const` 值（`{a:1}`、`[1,2,3]`）无法用单个 `type` 关键字描述，会触发 strict-mode 的 fail-open 路径——发出无类型的 schema 只会被 OpenAI 在线上拒绝。

## 性能：静态指纹缓存

`packages/catalog/src/model-manager.ts` 中的 `resolveProviderModels` 与 `packages/catalog/src/model-cache.ts` 中的 `readModelCache`/`writeModelCache` 通过 `model_cache` SQLite 表上的 `static_fingerprint` 列协作（当前缓存 schema 版本 12）。

- `fingerprintStatic(staticModels, dynamicModelsAuthoritative)` 哈希静态 catalog 切片（`Bun.hash(JSON.stringify(models))` 的 base36），加注指纹格式/版本和 authoritative 模式前缀，并用符号属性标记数组以记忆化非 authoritative 结果。端点迁移丢弃 ID 也折叠进缓存标识。
- 当跳过网络获取、缓存新鲜且 authoritative、恢复的 header 完整、且静态指纹匹配时，`resolveProviderModels` 返回恢复的缓存模型，而不重建静态/动态合并。
- `mergeModelSources` 和 `mergeDynamicModels` 对空源输入短路，避免不必要的 `Map` 构建。

所有更旧缓存 schema 版本的行都会被删除。新增缓存列使用保守默认值，但只有存储版本恰好等于当前版本的行才会被复用。

## 相关

- `docs/models.md` — registry、等价性、compat 标志（`supportsStrictMode`、`toolStrictMode`、`disableStrictTools`）。
- `docs/provider-streaming-internals.md` — 归一化后的 schema 在 provider 流循环下游的使用方式。
- `docs/mcp-server-tool-authoring.md` — 通过 `normalizeSchemaForMCP` 摄取 MCP `inputSchema`。
- `packages/ai/src/utils/schema/CONSTRAINTS.md` — 每条归一化规则的操作性约定。
