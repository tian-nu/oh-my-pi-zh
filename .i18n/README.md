# oh-my-pi 汉化工程说明

本目录是汉化版仓库的基础设施，随仓库一起提交。

## 结构

- `sync-check.sh` — 拉上游、对比上次已翻的上游 commit，生成 `.i18n/pending.txt`（待翻译文件清单）。cron 每天 04:00 调用。
- `build_map.py` — 翻译完成后构建/更新翻译记忆 `map/<文件>.json`（源段落 sha1 → 译文段落）。
- `map/` — 翻译记忆。上游更新时，未变的段落直接复用译文，只有变化的段落需要重翻。
- `pending.txt` / `last-upstream` — 同步状态（临时文件，不入库亦可）。

## 完整同步流程（上游更新后）

1. `bash .i18n/sync-check.sh` → 得到 pending.txt
2. 对 pending.txt 中每个文件：
   - 用 `git show FETCH_HEAD:路径` 取上游新版原文
   - 按空行分块，逐块查 `map/<文件>.json`：命中 → 直接复用旧译文；未命中 → AI 翻译新段落
   - 按 1:1 块序拼回，覆盖工作区文件
3. `python3 .i18n/build_map.py <上游新版> <译文> .i18n/map/<路径>.json` 更新记忆
4. 全部译完后：`git rev-parse FETCH_HEAD > .i18n/last-upstream`
5. commit（注明 `chore(i18n): sync upstream <short-hash>`）并 push

## 翻译规则（所有译者/AI 必须遵守）

1. 段落结构 1:1（空行分块），不合并、不拆分。
2. 不译：代码块、URL、链接 target、HTML 标签/属性、frontmatter 键名；inline code 保持原样。
3. 专有名词保持英文：omp、oh-my-pi、Pi、Bun、LSP、DAP、MCP、TypeScript、Rust、Homebrew、Nix、Docker 等。
4. 每个汉化 md 顶部加汉化声明（README 已有模板）。
5. 术语表（随进度补充）见 `glossary.md`。
