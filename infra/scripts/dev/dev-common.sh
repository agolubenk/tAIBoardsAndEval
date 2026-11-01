#!/usr/bin/env bash
# Общие функции скриптов ИИ-контура (infra/scripts/dev-ai/*). Не запускать напрямую.
# Дом слоя держит только помощники Ollama и локального env — помощники dev-стека host-проекта
# (compose, миграции, порты приложения) остаются в host-проекте. Имена функций (hr_*) сохранены:
# их зовут скрипты dev-ai, одинаковые в доме и в инстансе.

hr_wait_tcp_listen() {
  local port="${1:?port}"
  local max="${2:-180}"
  local i
  echo "→ Ожидание :$port (API)…"
  for ((i = 1; i <= max; i++)); do
    if command -v nc >/dev/null 2>&1; then
      if nc -z 127.0.0.1 "$port" 2>/dev/null; then
        echo "→ :$port доступен."
        return 0
      fi
    else
      if bash -c "exec 3<>/dev/tcp/127.0.0.1/$port" 2>/dev/null; then
        exec 3<&- 3>&- 2>/dev/null || true
        echo "→ :$port доступен."
        return 0
      fi
    fi
    sleep 0.5
  done
  echo "Предупреждение: :$port не ответил за ~$((max / 2)) с — Vite стартует, возможны ECONNREFUSED в логе." >&2
  return 0
}

# Проверяет, что Ollama доступна на localhost:11434.
# Если не запущена, пробует поднять `ollama serve` в фоне (best-effort).
hr_ensure_ollama() {
  local base_url="${1:-http://localhost:11434}"
  local host port
  host="$(echo "$base_url" | sed -E 's#https?://([^:/]+).*#\1#')"
  port="$(echo "$base_url" | sed -E 's#.*:([0-9]+).*#\1#')"

  if [ -z "${host:-}" ] || [ -z "${port:-}" ]; then
    echo "Предупреждение: не смог разобрать OLLAMA_BASE_URL='$base_url'." >&2
    return 0
  fi

  # Быстрый health-check: /api/tags должен отвечать.
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS --max-time 1 "$base_url/api/tags" >/dev/null 2>&1; then
      echo "→ Ollama доступна ($base_url)."
      return 0
    fi
  else
    # Без curl: fallback на TCP listen
    hr_wait_tcp_listen "$port" 10 >/dev/null 2>&1 || true
    return 0
  fi

  if ! command -v ollama >/dev/null 2>&1; then
    echo "Предупреждение: Ollama не запущена и команда 'ollama' не найдена. LLM-обогащение будет отключено." >&2
    return 0
  fi

  echo "→ Ollama не отвечает — пробую запустить 'ollama serve'…"
  # Запускаем в фоне; лог — в tmp, чтобы не мешать concurrently.
  export OLLAMA_CONTEXT_LENGTH="${OLLAMA_CONTEXT_LENGTH:-64000}"
  (nohup ollama serve >/tmp/hr-helper-ollama.log 2>&1 &)

  # Ждём до ~5 сек
  for _ in $(seq 1 10); do
    if curl -fsS --max-time 1 "$base_url/api/tags" >/dev/null 2>&1; then
      echo "→ Ollama поднята ($base_url)."
      return 0
    fi
    sleep 0.5
  done

  echo "Предупреждение: Ollama не поднялась за 5с (см. /tmp/hr-helper-ollama.log). Продолжаю без LLM." >&2
  return 0
}

# После сбоя pull Ollama иногда оставляет *-partial-N без partial-0 → повторный pull падает.
hr_ollama_cleanup_stale_partials() {
  find "${HOME}/.ollama/models/blobs" -name '*-partial-[0-9]*' -size -512c -delete 2>/dev/null || true
}

# Pull с повтором (по умолчанию 3 попытки, 5с пауза) — используется скриптами ollama-setup-*.sh.
hr_ollama_pull_with_retry() {
  local model="$1"
  local attempt max="${PULL_RETRIES:-3}"
  for attempt in $(seq 1 "$max"); do
    if ollama pull "$model"; then
      return 0
    fi
    echo "   ⚠ pull $model: попытка ${attempt}/${max} не удалась" >&2
    hr_ollama_cleanup_stale_partials
    if [ "$attempt" -lt "$max" ]; then
      echo "   → повтор через 5с…" >&2
      sleep 5
    fi
  done
  return 1
}

#
# Huntflow/network helpers
#

# Загружает переменные окружения из локального файла (dev only).
# Нужен для прокси/VPN сценариев: Nest (Node) не читает системный прокси macOS автоматически.
#
# Поддерживаемый файл (не коммитить): infra/local/.env.dev.local
# Пример содержимого:
#   HUNTFLOW_HTTPS_PROXY=http://proxy.company.local:3128
#   NO_PROXY=localhost,127.0.0.1,::1
#
hr_load_local_dev_env() {
  local root="${1:-}"
  if [ -z "${root:-}" ]; then
    return 0
  fi
  local f="$root/infra/local/.env.dev.local"
  if [ ! -f "$f" ]; then
    return 0
  fi
  # shellcheck disable=SC1090
  set -a
  source "$f"
  set +a
}

