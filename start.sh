#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js，请先安装 Node.js 20 或更高版本。"
  exit 1
fi

echo "[BrightBot] 安装依赖..."
npm install --allow-remote=all --dangerously-allow-all-scripts

echo "[BrightBot] 构建前端..."
npm run build

if [[ "$(uname -s)" == "Linux" ]] && [[ ! -x "vendor/vnc/linux-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')/usr/bin/x11vnc" ]]; then
  echo "[BrightBot] Linux 内置 VNC 尚未安装，可执行 npm run vnc:install 安装到项目目录。"
fi

if [[ "${BRIGHTBOT_MODE:-master}" == "node" ]]; then
  echo "[BrightBot] 启动远程节点：${BRIGHTBOT_NODE_NAME:-$(hostname)}"
  exec node server/node-client.js
fi

PORT="${PORT:-8787}"
URL="http://127.0.0.1:${PORT}"

echo "[BrightBot] 启动服务：${URL}"
node server/index.js &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM

for _ in {1..40}; do
  if curl -fsS "${URL}/api/health" >/dev/null 2>&1; then
    if command -v open >/dev/null 2>&1; then
      open "$URL"
    elif command -v xdg-open >/dev/null 2>&1; then
      xdg-open "$URL" >/dev/null 2>&1 || true
    fi
    wait "$SERVER_PID"
    exit $?
  fi
  sleep 0.25
done

echo "[BrightBot] 服务启动超时。"
exit 1
