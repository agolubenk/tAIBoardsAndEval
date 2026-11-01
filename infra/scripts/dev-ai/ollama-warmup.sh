#!/usr/bin/env bash
set -euo pipefail

OLLAMA_HOST="${OLLAMA_HOST:-http://127.0.0.1:11434}"

models=(
  "glm4:latest"
  "qwen2.5:7b"
  "nomic-embed-text:latest"
  "hr-helper-agent:latest"
  "hr-helper-vision:latest"
  "tiel-coder:35b-a3b-iq3s"
)
# Ростер 2026-10-28: после d-mac-models = drop-4 (2026-10-23) на Mac остались glm4/qwen2.5/
# nomic-embed + вернувшийся Tiel-Coder (L-tier). Прежний список с qwen3.6/mistral/qwen3-coder
# и hr-helper-алиасами удалённых моделей падал на первом же 404.
# DeepSeek-R1 выведен из dev-стека 2026-08-13: роль независимого аналитика забрал
# glm4:latest (другая линейка, вдвое легче), см. .continue/rules/02-context-routing.md.

echo "Checking Ollama at $OLLAMA_HOST ..."
curl -fsS "$OLLAMA_HOST" >/dev/null

warm_llm() {
  local model="$1"
  echo "Warming LLM: $model"
  curl -fsS "$OLLAMA_HOST/api/generate" \
    -H "Content-Type: application/json" \
    -d "{
      \"model\": \"$model\",
      \"prompt\": \"Reply with one word: ok\",
      \"stream\": false,
      \"options\": {
        \"num_predict\": 8
      }
    }" >/dev/null || echo "⚠ $model не установлена/не отвечает — пропуск (не фатально)"
}

warm_embed() {
  local model="$1"
  echo "Warming EMBED: $model"
  curl -fsS "$OLLAMA_HOST/api/embeddings" \
    -H "Content-Type: application/json" \
    -d "{
      \"model\": \"$model\",
      \"prompt\": \"warmup\"
    }" >/dev/null
}

for model in "${models[@]}"; do
  case "$model" in
    *embed*|nomic-embed-text:latest)
      warm_embed "$model"
      ;;
    *)
      warm_llm "$model"
      ;;
  esac
done

echo "Warmup complete."
