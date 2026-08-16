#!/bin/bash
# TaskSwarm npm 标准包名恢复提醒（2026-08-17 23:25 北京时间）
# 由 launchd 调度：~/Library/LaunchAgents/com.taskswarm.restore-npm.plist
# 触发时弹 macOS 通知 + 打开恢复文档。
set -e

DOC="/Users/robin/myProject/dsh-taskswarm/docs/restore-npm-name.zh-CN.md"
MSG="TaskSwarm npm 24h 冷却期已到：恢复标准包名 dsh-taskswarm@0.2.38（步骤见文档）"

if [ -f "$DOC" ]; then
  open "$DOC"
fi

osascript -e "display notification \"$MSG\" with title \"TaskSwarm 提醒\" sound name \"Glass\"" 2>/dev/null || true
logger -t taskswarm-reminder "$MSG"
