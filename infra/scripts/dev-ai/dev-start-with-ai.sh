#!/usr/bin/env bash
# Dev в Docker (backend + frontend) + Ollama на хосте (модели + serve).
#
# Использование (из корня репозитория):
#   bash infra/scripts/dev-start-with-ai.sh
#   SKIP_OLLAMA_PULL=1 bash infra/scripts/dev-start-with-ai.sh   # только create-алиасы, без pull GGUF
#   KILL_OLLAMA_PORT=1 bash infra/scripts/dev-start-with-ai.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

export OLLAMA_ENABLED=true
export AI_LOCAL_ENABLED=true
# На хосте — 127.0.0.1; в Docker backend — host.docker.internal (не смешивать через export).
HOST_OLLAMA_URL="${OLLAMA_BASE_URL:-http://127.0.0.1:11434}"
DOCKER_OLLAMA_URL="${DOCKER_OLLAMA_BASE_URL:-http://host.docker.internal:11434}"
export OLLAMA_MODEL_VISION="${OLLAMA_MODEL_VISION:-hr-helper-vision}"
export OLLAMA_MODEL_TEXT_GEN="${OLLAMA_MODEL_TEXT_GEN:-hr-helper-text}"
export OLLAMA_MODEL_ANALYTICS="${OLLAMA_MODEL_ANALYTICS:-hr-helper-analytics}"
export OLLAMA_MODEL_EMBEDDING="${OLLAMA_MODEL_EMBEDDING:-hr-helper-embed}"
export OLLAMA_KEEP_ALIVE="${OLLAMA_KEEP_ALIVE:-30m}"
export OLLAMA_CONTEXT_LENGTH="${OLLAMA_CONTEXT_LENGTH:-64000}"

if [ "${SKIP_OLLAMA_SETUP:-0}" != "1" ]; then
  if [ "${SKIP_OLLAMA_PULL:-0}" = "1" ]; then
    OLLAMA_BASE_URL="$HOST_OLLAMA_URL" SKIP_PULL=1 bash "$ROOT/infra/scripts/dev-ai/ollama-setup-models.sh"
  else
    OLLAMA_BASE_URL="$HOST_OLLAMA_URL" bash "$ROOT/infra/scripts/dev-ai/ollama-setup-models.sh"
  fi
fi

exec env \
  KILL_OLLAMA_PORT="${KILL_OLLAMA_PORT:-0}" \
  OLLAMA_BASE_URL="$DOCKER_OLLAMA_URL" \
  bash "$ROOT/infra/scripts/dev/dev-restart-everything.sh"
