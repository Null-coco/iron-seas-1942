#!/bin/sh
# 铁海 1942 启动脚本。默认 http://127.0.0.1:8787
DIR=$(cd "$(dirname "$0")" && pwd)
NODE="${NODE_BIN:-/Users/zl/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node}"
if [ ! -x "$NODE" ]; then NODE=$(command -v node); fi
if [ -z "$NODE" ]; then echo "找不到 node，请设置 NODE_BIN 环境变量"; exit 1; fi
if [ ! -f "$DIR/server/serve.mjs" ]; then
  echo "[warn] server/serve.mjs 尚未生成（由 ai-bridge-server 任务负责）";
  exit 2
fi
exec "$NODE" "$DIR/server/serve.mjs" "$@"
