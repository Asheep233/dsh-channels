#!/bin/bash
# dsh-channels build: host tsc -> client types -> client bundle(tsdown).
# Host has zero runtime deps on @deepseek-ai/*; client only depends on React
# supplied by the shell (must stay external).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TSC="node_modules/.bin/tsc"
TSDOWN="node_modules/.bin/tsdown"
if [ ! -x "$TSC" ] || [ ! -x "$TSDOWN" ]; then
  echo "=== installing build deps (typescript / tsdown / @types/node / @types/react) ==="
  npm install --no-audit --no-fund
fi

echo "=== 1/3 compile host (tsc -> lib/index.js) ==="
"$TSC" -p tsconfig.json

echo "=== 2/3 client types (tsc -> lib/types/client) ==="
"$TSC" -p tsconfig.client.json

echo "=== 3/3 client bundle (tsdown -> lib/client.js) ==="
npm run --silent build:client

echo "=== build ok ==="
ls -l lib/index.js lib/client.js
