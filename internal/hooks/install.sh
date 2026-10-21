#!/bin/sh
# 安装机器级钩子：把扫描器/词表/钩子装到 ~/.dsh-gates，并对指定仓库设置 core.hooksPath
# 用法：sh internal/hooks/install.sh <repo> [<repo> ...]
set -eu
SRC="$(cd "$(dirname "$0")/../.." && pwd)"
GATE="$HOME/.dsh-gates"
mkdir -p "$GATE/hooks" "$GATE/reports"
cp "$SRC/internal/hooks/pre-push-scan.mjs" "$GATE/pre-push-scan.mjs"
cp "$SRC/internal/wordlist.json" "$GATE/wordlist.json"
cp "$SRC/internal/wordlist.sha256" "$GATE/wordlist.sha256"
cp "$SRC/internal/hooks/pre-push" "$GATE/hooks/pre-push"
chmod +x "$GATE/hooks/pre-push"
for repo in "$@"; do
  git -C "$repo" config core.hooksPath "$GATE/hooks"
  echo "  ✅ 已为 $repo 设置 core.hooksPath=$GATE/hooks"
done
echo "  ✅ 钩子与词表已安装到 $GATE"
