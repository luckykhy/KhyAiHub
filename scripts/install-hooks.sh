#!/bin/bash
# 安装 Git hooks
# 用法：npm run hooks:install

set -e

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

echo "🔧 安装 Git hooks...\n"

# 配置 git 使用 works/build/githooks 目录
git config core.hooksPath works/build/githooks

# 方案 P W10：mailmap 已迁 docs/.mailmap（根面收敛），per-machine 指认随本脚本落盘
git config mailmap.file docs/.mailmap

# 确保 hook 脚本有执行权限
chmod +x works/build/githooks/*

echo "✅ Git hooks 已安装\n"
echo "已安装的 hooks："
ls -la works/build/githooks/
