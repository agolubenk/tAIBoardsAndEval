#!/usr/bin/env bash
# Agent pipeline (локальный workflow AI, без deepseek — слишком тяжёлый для dev-машин):
#   glm4:latest         → hr-helper-agent
#   mistral-small3.2    → hr-helper-analytics, hr-helper-json
#
# Использование (из корня репозитория):
#   npm run ollama:pipeline
#   SKIP_PULL=1 npm run ollama:pipeline
#   CONFIGURE_SHELL=0 npm run ollama:pipeline
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=dev-common.sh
source "$ROOT/infra/scripts/dev/dev-common.sh"

OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://127.0.0.1:11434}"
MODELS_DIR="$ROOT/infra/local/ollama/models"
export OLLAMA_CONTEXT_LENGTH="${OLLAMA_CONTEXT_LENGTH:-64000}"
export OLLAMA_KEEP_ALIVE="${OLLAMA_KEEP_ALIVE:-30m}"
export OLLAMA_NUM_PARALLEL="${OLLAMA_NUM_PARALLEL:-2}"
export OLLAMA_MAX_LOADED_MODELS="${OLLAMA_MAX_LOADED_MODELS:-1}"

PIPELINE_BASE_MODELS=(
  "glm4:latest"
  "mistral-small3.2"
)

PIPELINE_ALIASES=(
  "hr-helper-agent:hr-helper-agent.Modelfile"
  "hr-helper-analytics:hr-helper-analytics.Modelfile"
  "hr-helper-json:hr-helper-json.Modelfile"
)

configure_shell_context() {
  if [ "${CONFIGURE_SHELL:-1}" != "1" ]; then
    return 0
  fi
  local zshrc="${HOME}/.zshrc"
  if [ -f "$zshrc" ] && grep -q 'OLLAMA_CONTEXT_LENGTH=' "$zshrc" 2>/dev/null; then
    echo "→ ~/.zshrc уже содержит OLLAMA_CONTEXT_LENGTH — пропуск."
    return 0
  fi
  {
    echo ""
    echo "# HR Helper — Ollama agent pipeline context"
    echo "export OLLAMA_CONTEXT_LENGTH=${OLLAMA_CONTEXT_LENGTH}"
  } >>"$zshrc"
  echo "→ Добавлено в ~/.zshrc: export OLLAMA_CONTEXT_LENGTH=${OLLAMA_CONTEXT_LENGTH}"
}

require_ollama_cli() {
  if ! command -v ollama >/dev/null 2>&1; then
    echo "Ошибка: установите Ollama — https://ollama.com/download" >&2
    exit 1
  fi
}

create_alias() {
  local name="$1"
  local file="$2"
  echo "→ ollama create $name ← $file (num_ctx=${OLLAMA_CONTEXT_LENGTH})"
  ollama create "$name" -f "$file" </dev/null || {
    echo "Предупреждение: пересоздаю $name…" >&2
    ollama rm "$name" 2>/dev/null || true
    ollama create "$name" -f "$file"
  }
}

pull_pipeline_models() {
  if [ "${SKIP_PULL:-0}" = "1" ]; then
    echo "→ SKIP_PULL=1 — загрузка базовых моделей пропущена."
    return 0
  fi
  echo "→ Загрузка моделей pipeline (glm4 + mistral, может занять время)…"
  local model
  for model in "${PIPELINE_BASE_MODELS[@]}"; do
    echo "   pull $model …"
    hr_ollama_pull_with_retry "$model" || {
      echo "   ⚠ Не удалось скачать $model после ${PULL_RETRIES:-3} попыток" >&2
      echo "   Подсказка: pkill ollama; rm -f ~/.ollama/models/blobs/*-partial*; OLLAMA_CONTEXT_LENGTH=64000 ollama serve" >&2
      exit 1
    }
  done
}

create_pipeline_aliases() {
  local entry name file
  for entry in "${PIPELINE_ALIASES[@]}"; do
    name="${entry%%:*}"
    file="${entry#*:}"
    create_alias "$name" "$MODELS_DIR/$file"
  done
}

recreate_legacy_aliases() {
  if [ "${RECREATE_LEGACY_ALIASES:-1}" != "1" ]; then
    return 0
  fi
  echo "→ Пересоздание legacy-алиасов с num_ctx=${OLLAMA_CONTEXT_LENGTH}…"
  create_alias "hr-helper-text" "$MODELS_DIR/hr-helper-text.Modelfile"
  create_alias "hr-helper-resume" "$MODELS_DIR/hr-helper-resume.Modelfile"
  create_alias "hr-helper-vision" "$MODELS_DIR/hr-helper-vision.Modelfile"
  create_alias "hr-helper-embed" "$MODELS_DIR/hr-helper-embed.Modelfile"
}

print_summary() {
  echo ""
  echo "Готово. Модели:"
  ollama list
  echo ""
  echo "Ollama serve с контекстом 64k: OLLAMA_CONTEXT_LENGTH=${OLLAMA_CONTEXT_LENGTH} ollama serve"
}

configure_shell_context
require_ollama_cli
echo "→ Проверка / запуск Ollama ($OLLAMA_BASE_URL)…"
hr_ensure_ollama "$OLLAMA_BASE_URL"
pull_pipeline_models
create_pipeline_aliases
recreate_legacy_aliases
print_summary
