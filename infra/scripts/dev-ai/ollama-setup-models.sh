#!/usr/bin/env bash
# Установка и алиасы локальных моделей Ollama для HR Helper.
# Создаёт hr-helper-{vision,text,analytics,embed} поверх Hugging Face GGUF / nomic-embed-text.
#
# Использование (из корня репозитория):
#   bash infra/scripts/ollama-setup-models.sh
#   SKIP_PULL=1 bash infra/scripts/ollama-setup-models.sh   # только create-алиасы
#   WARMUP_EMBED=1 bash infra/scripts/ollama-setup-models.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=dev-common.sh
source "$ROOT/infra/scripts/dev/dev-common.sh"

OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://127.0.0.1:11434}"
MODELS_DIR="$ROOT/infra/local/ollama/models"

export OLLAMA_KEEP_ALIVE="${OLLAMA_KEEP_ALIVE:-30m}"
export OLLAMA_NUM_PARALLEL="${OLLAMA_NUM_PARALLEL:-2}"
# 1 модель в RAM: glm4 (~16GB) + mistral (~15GB) не держим одновременно — OLLAMA_MAX_LOADED_MODELS=1
export OLLAMA_MAX_LOADED_MODELS="${OLLAMA_MAX_LOADED_MODELS:-1}"
export OLLAMA_CONTEXT_LENGTH="${OLLAMA_CONTEXT_LENGTH:-64000}"

if ! command -v ollama >/dev/null 2>&1; then
  echo "Ошибка: установите Ollama — https://ollama.com/download" >&2
  exit 1
fi

echo "→ Проверка / запуск Ollama ($OLLAMA_BASE_URL)…"
hr_ensure_ollama "$OLLAMA_BASE_URL"

create_alias() {
  local name="$1"
  local file="$2"
  echo "→ ollama create $name ← $file"
  ollama create "$name" -f "$file" </dev/null || {
    echo "Предупреждение: не удалось создать $name (возможно уже существует). Пробую пересоздать…" >&2
    ollama rm "$name" 2>/dev/null || true
    ollama create "$name" -f "$file"
  }
}

if [ "${SKIP_PULL:-0}" != "1" ]; then
  echo "→ Загрузка базовой embedding-модели (nomic-embed-text)…"
  ollama pull nomic-embed-text

  echo "→ Загрузка GGUF для алиасов (может занять десятки минут при первом запуске)…"
  echo "   Vision (MiniCPM-o)…"
  ollama pull hf.co/openbmb/MiniCPM-o-2_6-GGUF:Q4_K_M || echo "   ⚠ Vision pull failed — проверьте сеть / HF"

  echo "   Text (Qwen 3.6 27B Q4_K_M)…"
  ollama pull qwen3.6:27b-q4_K_M || echo "   ⚠ Text pull failed"

  echo "   Analytics (Mistral Small 3.2)…"
  ollama pull mistral-small3.2 || echo "   ⚠ Analytics pull failed"
fi

create_alias "hr-helper-embed" "$MODELS_DIR/hr-helper-embed.Modelfile"
create_alias "hr-helper-vision" "$MODELS_DIR/hr-helper-vision.Modelfile"
create_alias "hr-helper-text" "$MODELS_DIR/hr-helper-text.Modelfile"
create_alias "hr-helper-resume" "$MODELS_DIR/hr-helper-resume.Modelfile"
# Analytics — опционально (тяжёлая модель; сбой не блокирует dev-стек)
create_alias "hr-helper-analytics" "$MODELS_DIR/hr-helper-analytics.Modelfile" \
  || echo "   ⚠ hr-helper-analytics пропущен (опционально для аналитики)"

if [ "${WARMUP_EMBED:-1}" = "1" ]; then
  echo "→ Прогрев embedding (держим в памяти)…"
  curl -fsS "$OLLAMA_BASE_URL/api/embeddings" \
    -H 'Content-Type: application/json' \
    -d '{"model":"hr-helper-embed","prompt":"warmup"}' >/dev/null \
    && echo "   hr-helper-embed OK" \
    || echo "   ⚠ warmup embed failed"
fi

echo ""
echo "Готово. Алиасы:"
ollama list | grep -E 'hr-helper-|NAME' || ollama list
echo ""
echo "Проверка API Nest: GET http://localhost:3001/api/v1/ai-local/health"
