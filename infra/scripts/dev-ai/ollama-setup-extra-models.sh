#!/usr/bin/env bash
# Дополнительные chat-модели Ollama (вне ролевых hr-helper-* алиасов, видны в AI-чате
# напрямую по тегу через /api/tags — как glm4/mistral-small3.2):
#   Qwen3-Coder 30B-A3B Q4_K_M (MoE, ~19GB, активно 3.3B) — код-ассистент
#
# DeepSeek-R1 (7B/14B distill) выведен из dev-стека 2026-08-13: роль независимого
# аналитика в консилиуме забрал glm4:latest — другая модельная линейка, а значит другие
# систематические ошибки, при вдвое меньшем весе. Тяжёлые 32B/671B как были, так и
# остаются в блоклисте (OOM на 24ГБ). Уже скачанные образы скрипт не трогает:
# удалять их или нет — решает владелец (`ollama rm deepseek-r1:14b-qwen-distill-q4_K_M`).
#
# Использование (из корня репозитория):
#   npm run ollama:extra-models
#   SKIP_PULL=1 npm run ollama:extra-models
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=dev-common.sh
source "$ROOT/infra/scripts/dev/dev-common.sh"

OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://127.0.0.1:11434}"
export OLLAMA_CONTEXT_LENGTH="${OLLAMA_CONTEXT_LENGTH:-64000}"
export OLLAMA_KEEP_ALIVE="${OLLAMA_KEEP_ALIVE:-30m}"

EXTRA_MODELS=(
  "qwen3-coder:30b-a3b-q4_K_M"
)

if ! command -v ollama >/dev/null 2>&1; then
  echo "Ошибка: установите Ollama — https://ollama.com/download" >&2
  exit 1
fi

echo "→ Проверка / запуск Ollama ($OLLAMA_BASE_URL)…"
hr_ensure_ollama "$OLLAMA_BASE_URL"

if [ "${SKIP_PULL:-0}" = "1" ]; then
  echo "→ SKIP_PULL=1 — загрузка пропущена."
else
  for model in "${EXTRA_MODELS[@]}"; do
    echo "→ Загрузка $model …"
    hr_ollama_pull_with_retry "$model" || {
      echo "   ⚠ Не удалось скачать $model после ${PULL_RETRIES:-3} попыток" >&2
      exit 1
    }
  done
fi

echo ""
echo "Готово. Модели:"
ollama list | grep -E 'qwen3-coder|NAME' || ollama list
echo ""
echo "Появятся в AI-чате по тегу напрямую (без hr-helper-* алиаса)."
