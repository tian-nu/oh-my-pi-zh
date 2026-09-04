# mini-marketplace

一个最小的 `oh-my-pi` marketplace 目录示例，演示 `marketplace.json` 格式。它使用相对路径 source 列出一个插件（`my-plugin`）。

## 安装命令

```
/marketplace add ./docs/skills/examples/mini-marketplace
/marketplace install my-plugin@example-marketplace
```

或通过 CLI：

```
omp plugin marketplace add ./docs/skills/examples/mini-marketplace
omp plugin install my-plugin@example-marketplace
```

## 演示内容

- `marketplace.json` 所需的最小字段：`name`、`owner.name`、`plugins`
- 使用 `./` 前缀的相对路径插件 source（`"source": "./my-plugin"`）
- 插件与 marketplace 目录捆绑在同一目录树内
- 额外的目录元数据：本示例包含一个顶层 `description`；当前 marketplace 解析会保留额外的顶层字段，而运行时行为只使用必需字段和插件条目。

## 结构

```
mini-marketplace/
  .claude-plugin/
    marketplace.json      ← catalog
  README.md
  my-plugin/
    package.json          ← omp.extensions manifest
    index.ts              ← extension entry point
```

已发布的 marketplace 和本地 marketplace 使用相同的目录位置。omp 会优先加载 marketplace 根目录下的 `.omp-plugin/marketplace.json`，并回退到 `.claude-plugin/marketplace.json`（即本示例附带的 Claude Code 兼容路径）。将 `/marketplace add` 指向此文件夹即可加载本示例。
