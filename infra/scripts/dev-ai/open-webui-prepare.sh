#!/usr/bin/env bash
# Скачивает образ Open WebUI и создаёт volume. Контейнер НЕ запускает.
# Сервис включён в основной docker-compose.yml.
#
#   bash infra/scripts/dev-ai/open-webui-prepare.sh
#   START=1 bash infra/scripts/dev-ai/open-webui-prepare.sh   # поднять после prepare
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
COMPOSE_FILE="$ROOT/infra/docker/docker-compose.yml"

if ! command -v docker >/dev/null 2>&1; then
  echo "Ошибка: Docker не найден." >&2
  exit 1
fi

echo "→ docker compose pull (open-webui)…"
docker compose -f "$COMPOSE_FILE" pull open-webui

echo ""
echo "Образ готов. Контейнер не запущен."
echo "  Старт:  npm run open-webui:up"
echo "  UI:     http://localhost:8080"
echo "  Ollama: ${OLLAMA_BASE_URL:-http://host.docker.internal:11434}"
echo ""
echo "После первого входа: Admin → Settings → Models → num_ctx = 64000"

if [ "${START:-0}" = "1" ]; then
  echo "→ START=1 — поднимаю контейнер…"
  docker compose -f "$COMPOSE_FILE" up -d open-webui
  echo "→ Open WebUI: http://localhost:8080"
fi
