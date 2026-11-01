#!/usr/bin/env bash
# Локальный LLM-шлюз (OpenRouter × N ключей + Ollama): start | stop | restart | status | models | ask | sync | logs | requests
# Данные (.env с ключами, .state) — в основной папке репо: infra/llm-gateway/ (даже если код запущен из worktree).
set -euo pipefail

CODE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
case "$CODE_DIR" in
  */worktrees/*) DEFAULT_HOME="${CODE_DIR%%/worktrees/*}/infra/llm-gateway" ;;
  *) DEFAULT_HOME="$CODE_DIR" ;;
esac
export GW_HOME="${GW_HOME:-$DEFAULT_HOME}"
STATE="$GW_HOME/.state"
PID_FILE="$STATE/gateway.pid"
LOG_FILE="$STATE/gateway.log"
mkdir -p "$STATE"

ensure_env() {
  if [ ! -f "$GW_HOME/.env" ]; then
    cp "$CODE_DIR/.env.example" "$GW_HOME/.env"
    chmod 600 "$GW_HOME/.env"
    echo "создан $GW_HOME/.env из шаблона — впиши OPENROUTER_KEY_1..3 и модели, затем: npm run llm-gateway:restart"
  fi
}

running() { [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }

port() { node --input-type=module -e "import {loadConfig} from '$CODE_DIR/src/config.mjs'; console.log(loadConfig().port)"; }

start() {
  ensure_env
  if running; then echo "уже запущен (pid $(cat "$PID_FILE"))"; return 0; fi
  local p; p="$(port)"
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "порт $p занят другим процессом:" >&2
    lsof -nP -iTCP:"$p" -sTCP:LISTEN >&2
    return 1
  fi
  nohup node "$CODE_DIR/src/server.mjs" >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  for _ in $(seq 1 30); do
    if curl -fsS -m 1 "http://127.0.0.1:$p/health" >/dev/null 2>&1; then
      echo "запущен (pid $(cat "$PID_FILE")) → http://127.0.0.1:$p/v1"
      return 0
    fi
    sleep 0.2
  done
  echo "не поднялся за 6 с — хвост лога:" >&2
  tail -n 20 "$LOG_FILE" >&2
  return 1
}

stop() {
  if running; then
    kill "$(cat "$PID_FILE")" && rm -f "$PID_FILE"
    echo "остановлен"
  else
    rm -f "$PID_FILE"
    echo "не запущен"
  fi
}

case "${1:-status}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) running && echo "pid $(cat "$PID_FILE")" || echo "не запущен (npm run llm-gateway:start)"; running && node "$CODE_DIR/src/cli.mjs" status ;;
  models) node "$CODE_DIR/src/cli.mjs" models ;;
  ask) shift; node "$CODE_DIR/src/cli.mjs" ask "$@" ;;
  sync) ensure_env; node "$CODE_DIR/src/sync-clients.mjs" "${@:2}" ;;
  logs) tail -n 50 -F "$LOG_FILE" ;;
  requests) tail -n "${2:-20}" "$STATE/requests.jsonl" ;;
  *) echo "команды: start | stop | restart | status | models | ask \"<текст>\" [модель] | sync [--dry-run] | logs | requests [N]" >&2; exit 2 ;;
esac
