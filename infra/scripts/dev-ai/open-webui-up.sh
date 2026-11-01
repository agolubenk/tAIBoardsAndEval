#!/usr/bin/env bash
# Запуск Open WebUI (ожидает Ollama на host.docker.internal:11434).
# Сервис включён в основной docker-compose.yml — запускается как часть общего стека.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
COMPOSE_FILE="$ROOT/infra/docker/docker-compose.yml"

docker compose -f "$COMPOSE_FILE" up -d open-webui
echo "→ Open WebUI: http://localhost:8080"
echo "→ Ollama (хост): ${OLLAMA_BASE_URL:-http://host.docker.internal:11434}"
