#!/usr/bin/env bash
# Stdio-обёртка t-boards для MCP-хаба (infra/mcp-hub/mcp.json): ключ API t-boards (env → Keychain) →
# stdio-пакет @kaneo/mcp из форка (boards/packages/mcp; в инстансе-инкубаторе — t-boards/app/packages/mcp) → REST https://d4dev.admin.hrhelper.space.
#
# Почему не HTTP-MCP самого t-boards (/api/mcp): d4dev резолвится в адрес туннеля 10.77.0.1, а 1mcp не пускает
# OAuth на приватные адреса (защита от SSRF, «authority_mismatch»). Ключ API идёт в REST как Bearer, лес видит
# такие вызовы агентом `key:<id>` — так же, как вызовы встроенного MCP.
#
# Ключ: t-boards → Настройки → API-ключи; положить —
#   security add-generic-password -U -s hr-helper-mcp -a T_BOARDS_API_KEY -w  # ключ спросит сам, мимо истории
# Нужен поднятый туннель WireGuard и строка `10.77.0.1 d4dev.admin.hrhelper.space` в /etc/hosts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# Канонический дом — boards/ (tAIBE); инстанс-инкубатор держит форк в t-boards/app.
BOARDS="$ROOT/boards"
[ -d "$BOARDS/packages/mcp" ] || BOARDS="$ROOT/t-boards/app"
ENTRY="$BOARDS/packages/mcp/dist/index.js"
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"

# Ошибка настройки — пауза 5 мин перед выходом: хаб перезапускает упавший сервер (restartOnExit), а сама она
# не пройдёт, пока не положат ключ или не соберут пакет. После этого — `mcp-hub.sh restart hub`, не ждать.
# Хаб грузит серверы асинхронно (--enable-async-loading) — пауза его старт не задерживает.
# Нет туннеля — не ошибка настройки: сервер работает, вызовы инструментов падают по таймауту.
fail() {
  echo "t-boards: $*" >&2
  sleep 300
  exit 1
}

# Ключ уходит на этот адрес заголовком Bearer: только https, http — лишь для t-boards на этой машине.
KANEO_API_URL="${T_BOARDS_URL:-https://d4dev.admin.hrhelper.space}"
case "$KANEO_API_URL" in
  https://* | http://127.0.0.1:*) ;;
  *) fail "T_BOARDS_URL=$KANEO_API_URL — нужен https:// (или http://127.0.0.1:<порт> для локального t-boards)" ;;
esac
if ! KANEO_API_KEY="$(bash "$SCRIPT_DIR/mcp-secret.sh" T_BOARDS_API_KEY)"; then
  fail "T_BOARDS_API_KEY не найден (env / Keychain hr-helper-mcp) — см. шапку $0"
fi
[ -f "$ENTRY" ] || fail "нет $ENTRY — собрать: (cd $BOARDS/packages/mcp && pnpm run build)"
# Сборка без зависимостей падает сразу после exec, и хаб перезапускал бы её без паузы.
[ -d "$(dirname "$ENTRY")/../node_modules" ] || fail "нет зависимостей t-boards — (cd $BOARDS && pnpm install)"
export KANEO_API_KEY KANEO_API_URL

exec node "$ENTRY"
