#!/usr/bin/env bash
# oh-my-pi 汉化版 · 上游同步检测脚本
# 用途：拉取上游更新，列出需要增量翻译的文件。由 cron 定期调用。
# 翻译本身需要 AI（本会话），脚本只做检测并生成待办清单：
#   .i18n/pending.txt  —— 每行一个有变化的 .md 文件
# 配置：
UPSTREAM=https://github.com/can1357/oh-my-pi.git
UPSTREAM_REF=main
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR" || exit 1

git fetch "$UPSTREAM" "$UPSTREAM_REF" --quiet || { echo "fetch 失败"; exit 1; }
LAST=$(cat .i18n/last-upstream 2>/dev/null || echo "")
NOW=$(git rev-parse FETCH_HEAD)

if [ "$LAST" = "$NOW" ]; then
  echo "$(date '+%F %T') 上游无变化 ($NOW)"
  exit 0
fi

# 找出上游 main 中有变动的 md 文件（含新增）
if [ -n "$LAST" ]; then
  RANGE="$LAST..$NOW"
else
  RANGE="$NOW" # 首次：全量
fi
git diff --name-only --diff-filter=ACMR "$RANGE" -- '*.md' > .i18n/pending.txt
COUNT=$(wc -l < .i18n/pending.txt)
echo "$(date '+%F %T') 上游更新 $LAST..$NOW，待翻译 $COUNT 个 md 文件（见 .i18n/pending.txt）"
# 注意：不要在这里更新 .i18n/last-upstream；翻译完成并 commit 后由 AI 更新。
