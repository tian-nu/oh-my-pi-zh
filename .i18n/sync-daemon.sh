#!/bin/bash
# 每天检查一次上游更新（cron 不可用时的替代方案）
while true; do
  # 睡到下一个 04:10
  now=$(date +%s); target=$(date -d "tomorrow 04:10" +%s)
  sleep $((target - now))
  /home/ubuntu/projects/oh-my-pi/.i18n/sync-check.sh >> /home/ubuntu/omp-i18n-sync.log 2>&1
done
