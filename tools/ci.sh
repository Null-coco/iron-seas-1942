#!/bin/sh
# 本地 CI：全量验收 + 黄金种子（UI 端到端需要 Chrome，单列）
set -e
DIR=$(cd "$(dirname "$0")/.." && pwd)
# node 查找顺序：$NODE_BIN -> PATH 里的 node -> 常见本机安装位置（PATH 里没有 node 时也能跑）
resolve_node() {
  if [ -n "$NODE_BIN" ]; then NODE="$NODE_BIN"; return 0; fi
  NODE=$(command -v node 2>/dev/null || true)
  if [ -n "$NODE" ]; then return 0; fi
  for c in "$HOME/.local/node/bin/node" "$HOME/.nvm/versions/node/current/bin/node" "$HOME/.volta/bin/node" "/opt/homebrew/bin/node" "/usr/local/bin/node"; do
    if [ -x "$c" ]; then NODE="$c"; return 0; fi
  done
  NODE=""
  return 1
}
if ! resolve_node; then
  echo "找不到 node（需要 Node >= 22）：请先安装，或用 NODE_BIN=/path/to/node 指定"
  exit 1
fi
cd "$DIR"
echo "== run-all ($NODE)"
"$NODE" test/run-all.mjs
echo "== golden seed"
"$NODE" test/golden.seed.test.mjs

