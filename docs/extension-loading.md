# Extension 加载（TypeScript/JavaScript 模块）

本文档介绍 coding agent 在启动时如何发现并加载扩展模块。被扫描的原生/配置目录会自动发现 `.ts` 和 `.js`；显式指定的文件和已安装插件的 manifest 条目还可以使用 `.mjs` 和 `.cjs`。

本文**不**涵盖 [`gemini-extension.json` manifest extensions](./gemini-manifest-extensions.md)，那部分单独文档化。

## 该子系统做什么

扩展加载会构建一份模块入口文件列表，用 Bun 逐个导入模块，执行其工厂函数，并返回：

- 已加载的扩展定义
- 每个路径的加载错误（不会中止整体加载）
- 一个共享的扩展运行时对象，供之后 `ExtensionRunner` 使用

## 主要实现文件

- `src/extensibility/extensions/loader.ts` — 路径发现 + 导入/执行
- `src/extensibility/extensions/index.ts` — 公开导出
- `src/extensibility/extensions/runner.ts` — 加载后的运行时/事件执行
- `src/discovery/builtin.ts` — 扩展模块的原生自动发现 provider
- `src/extensibility/plugins/legacy-pi-compat.ts` — 原位模块图加载与宿主包兼容性重写
- `src/config/settings.ts` — 加载合并后的 `extensions` / `disabledExtensions` 设置

---

## 扩展加载的输入

### 1) 自动发现的原生扩展模块

`discoverAndLoadExtensions()` 先向发现 provider 询问 `extension-module` 能力项，然后只保留 provider 的 `native` 项。

原生 `extension-module` 发现来自：

- 项目目录：`<cwd>/.omp/extensions`
- 用户目录：活动 agent 目录的 `extensions/`（默认 `~/.omp/agent/extensions`）
- 原生旧版/settings JSON 条目：`<cwd>/.omp/settings.json#extensions` 以及活动 agent 目录的 `settings.json#extensions`

项目根目录是原生 provider 的 `.omp` 目录（`SOURCE_PATHS.native.projectDir`），仅限 cwd，不会向上遍历祖先目录。用户根目录是通过 `getAgentDir()` 得到的活动 profile 的 agent 目录，因此在 `omp --profile <name>` 下它变为 `~/.omp/profiles/<name>/agent/extensions`（并遵循 `PI_CODING_AGENT_DIR`）。参见 [Profiles](./config-usage.md#profiles)。

注意：

- 原生自动发现目前基于 `.omp`。
- 旧版 `.pi` 在包 manifest（`pi.extensions`）和项目覆盖查找中仍被接受，但 `.pi/extensions` 在这里不是原生根目录。

### 2) 发现的 JS/TS hook 工厂

原生自动发现之后，`discoverAndLoadExtensions()` 还会追加来自 `hook` 能力的 JS/TS hook 工厂 — 即入口路径为 `.ts`/`.js` 文件的任何 hook — 使它们通过同一模块管线加载。

hook 能力加载已经应用了自己的 hook 专属禁用 id，因此这些路径不会额外被 `disabledExtensions` 的 extension-module 名称过滤。

### 3) 已安装插件的扩展条目

hook 发现之后，`discoverAndLoadExtensions()` 通过 `getAllPluginExtensionPaths(cwd)` 追加来自已启用已安装插件的扩展入口点。

插件扩展条目来自包的 `omp.extensions` / `pi.extensions` manifest，包括已启用的 feature 条目。

已安装插件的 manifest 解析接受显式的 `.ts`、`.js`、`.mjs` 和 `.cjs` 文件。对于指向目录的 manifest 条目，它识别 `index.ts`、`index.js`、`index.mjs` 或 `index.cjs`；扩展目录展开使用同样的四个后缀。这比原生和配置目录的自动扫描范围更宽，后者仍限于 `.ts` 和 `.js`。

### 4) 显式配置的路径

插件扩展条目之后，会追加并解析配置的路径。

主会话启动路径（`sdk.ts`）中的配置路径来源：

1. CLI 提供的路径（`--extension/-e`；`--hook` 也被视为扩展路径）
2. 合并设置中的 `extensions` 数组

设置文件：

- 用户级：活动 agent 目录的 `config.yml`（默认 `~/.omp/agent/config.yml`；使用 `--profile <name>` 时为 `~/.omp/profiles/<name>/agent/config.yml`；`PI_CODING_AGENT_DIR` 可覆盖 agent 目录）
- 项目级/原生设置能力：`<cwd>/.omp/config.yml` 和 `<cwd>/.omp/settings.json`

原生 extension-module 发现还会从以下位置读取旧版 JSON 扩展列表：

- 活动 agent 目录的 `settings.json`（默认 `~/.omp/agent/settings.json`）
- `<cwd>/.omp/settings.json`

示例：

```yaml
# ~/.omp/agent/config.yml
extensions:
  - ~/my-exts/safety.ts
  - ./local/ext-pack
```

```json
{
  "extensions": ["./.omp/extensions/my-extra"]
}
```

---

## 启用/禁用控制

### 禁用发现

- CLI：`--no-extensions`
- SDK 选项：`disableExtensionDiscovery`

行为区分：

- SDK：当 `disableExtensionDiscovery=true` 时，环境性扩展工厂会被排除，而 `additionalExtensionPaths` 仍正常解析（包括带 `package.json#omp.extensions` 的包目录）。
- CLI：`--no-extensions` 遵循同样的"仅显式"契约。显式的 `-e/--extension` 和 `--hook` 路径仍会加载，且只有显式指定的扩展包的同级能力根目录仍然有效。项目/用户级 `extensions:` 设置和已安装的 OMP 扩展包会被排除在该同级目录面之外。

该标志管理的是扩展工厂和 OMP 扩展包的同级根目录；它不是整进程的能力隔离开关。属于其他发现子系统的 skills、MCP server、工具、prompts 和规则保留各自的启用/禁用控制。

### 禁用特定扩展模块

`disabledExtensions` 设置按扩展 id 格式过滤：

- `extension-module:<derivedName>`

`derivedName` 基于入口路径（`getExtensionNameFromPath`），例如：

- `/x/foo.ts` -> `foo`
- `/x/bar/index.ts` -> `bar`

示例：

```yaml
disabledExtensions:
  - extension-module:foo
```

### 禁用其他能力的特定条目

`disabledExtensions` 不仅限于扩展模块。每个定义了 `toExtensionId` 的能力都会向同一列表贡献 id，加载时会在条目进入会话之前将其过滤掉。

上下文文件使用 `context-file:<level>:<basename>`，其中 `<level>` 是 `user` 或 `project`：

```yaml
disabledExtensions:
  - context-file:user:CLAUDE.md
```

该 id 不携带目录和层级信息，因此一条 `project` 条目会禁用发现遍历可达的任意深度下的同名文件。参见
[Context files](./context-files.md#disabling-a-single-context-file)。

---

## 路径与入口解析

### 路径规范化

对于配置的路径：

1. 规范化 Unicode 空格和受支持的路径简写（包括 `file://`、`@/absolute/path`，以及绝对/相对路径前多余的 `:`）
2. 展开 `~`
3. 若为相对路径，则基于当前 `cwd` 解析
4. 拒绝内部的 `local://` 协议；它必须由其协议处理器解析，不能当作文件系统路径

### 配置路径是文件时

直接将其作为模块入口候选。支持显式的 `.ts`、`.js`、`.mjs` 和 `.cjs` 文件。

### 配置路径是目录时

解析顺序：

1. 该目录下带 `omp.extensions`（或旧版 `pi.extensions`）字段的 `package.json` -> 使用声明的条目
2. `index.ts`
3. `index.js`
4. 否则扫描一层以寻找扩展入口：
   - 直接的 `*.ts` / `*.js`
   - 子目录的 `index.ts` / `index.js`
   - 子目录中带 `omp.extensions` / `pi.extensions` 的 `package.json`

规则与约束：

- 除一级子目录外不做递归发现
- manifest 中声明的 `extensions` 条目相对于该包目录解析
- 声明的条目仅在文件存在/可访问时才被纳入
- 在 `*/index.{ts,js}` 成对出现时，优先 TypeScript 而非 JavaScript
- 符号链接被视为合格的文件/目录

### 忽略行为因来源而异

- 原生自动发现（发现辅助中的 `discoverExtensionModulePaths`）使用原生 glob，参数为 `gitignore: true` 和 `hidden: false`。
- `loader.ts` 中显式配置目录的扫描使用 `readdir` 规则，**不**应用 gitignore 过滤。

---

## 加载顺序与优先级

`discoverAndLoadExtensions()` 构建一个有序列表，然后调用 `loadExtensions()`。

顺序：

1. 原生自动发现的模块
2. 发现的 JS/TS hook 工厂
3. 已安装插件的扩展条目
4. 显式配置的路径（按提供顺序）

在 `sdk.ts` 中，配置顺序为：

1. CLI 附加路径
2. 设置中的 `extensions`

去重：

- 基于绝对路径
- 先看到的路径优先
- 之后出现的重复被忽略

推论：如果同一路径既被自动发现又被显式配置，它只会在第一个位置（自动发现阶段）加载一次。

---

## 模块导入与工厂契约

每个候选路径都通过 `loadLegacyPiModule()` 加载（`src/extensibility/plugins/legacy-pi-compat.ts`）：

- 先解析入口的 realpath，然后带 `?mtime` 缓存穿透参数动态导入，使编辑后的源码能够重新加载。自 16.3.7 起，同一 mtime 标签会通过图级的 `onLoad` 重写传播到扩展拥有的依赖图中的每个模块 — 相对的 `./`/`../` 导入、包 `imports` 别名（`#alias/*`），以及扩展本地的裸依赖 — 因此同进程的重复导入能感知整个图中的编辑，而不只是入口文件。宿主解析的重写（旧版 pi 包 specifier、TypeBox shim）保持不带标签的 `file://` URL，因为它们指向宿主进程内的代码，这些代码在重载之间从不变化
- 一个作用域化的 Bun `onLoad` 钩子在求值前将旧版 pi 包 specifier（`@mariozechner/*`、`@earendil-works/*`）和裸的 `@sinclair/typebox` 重写到宿主打包的副本上。旧版 Pi 包根导入通过兼容 shim 解析：迁移到 `@oh-my-pi/pi-catalog/models` 的 catalog 符号（`calculateCost`、`modelsAreEqual`、`getBundledProviders`，以及 `getModel`/`getModels` 别名）由旧版 pi-ai shim（`src/extensibility/legacy-pi-ai-shim.ts`）重新导出，旧版 `@oh-my-pi/pi-coding-agent` 导入 — 包括 `DefaultResourceLoader` — 解析到 `src/extensibility/legacy-pi-coding-agent-shim.ts` 中的兼容加载器
- 工厂由 `getExtensionFactory(module)` 选择：若模块本身是函数则用模块本身，否则用 `module.default`
- 工厂必须是函数（`ExtensionFactory`），可以返回 `void` 或 promise；加载会等待其完成后再继续下一个路径

如果导出不是函数，该路径以结构化错误失败，加载继续。

---

## 失败处理与隔离

### 加载期间

每个扩展路径的失败被捕获为 `{ path, error }`，不会阻止其他路径加载。

常见情况：

- 导入失败 / 文件缺失
- 无效的工厂导出（非函数）
- 执行工厂时抛出异常

### 运行时隔离模型

- 扩展**不是沙箱化的**（同一进程/运行时）。
- 它们共享一个 `EventBus` 和一个 `ExtensionRuntime` 实例。
- 加载期间，运行时动作方法会刻意抛出 `ExtensionRuntimeNotInitializedError`；动作接线在之后的 `ExtensionRunner.initialize()` 中进行。

### 加载之后

当事件流经 `ExtensionRunner` 时，处理器异常会被捕获并作为扩展错误发出，而不是使运行器循环崩溃。

---

## 最小用户级/项目级布局示例

### 用户级

```text
~/.omp/agent/
  config.yml
  extensions/
    guardrails.ts
    audit/
      index.ts
```

### 项目级

```text
<repo>/
  .omp/
    settings.json
    extensions/
      checks/
        package.json
      lint-gates.ts
```

`checks/package.json`：

```json
{
  "omp": {
    "extensions": ["./src/check-a.ts", "./src/check-b.js"]
  }
}
```

旧版 manifest 键仍然接受：

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```
