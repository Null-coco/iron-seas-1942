#!/bin/sh
# 本地 CI：全量验收 + 黄金种子（UI 端到端需要 Chrome，单列）
set -e
DIR=$(cd "$(dirname "$0")/.." && pwd)
NODE="${NODE_BIN:-node}"
[ -x "$NODE" ] || NODE=$(command -v node)
cd "$DIR"
echo "== run-all"
"$NODE" test/run-all.mjs
echo "== golden seed"
"$NODE" test/golden.seed.test.mjs
