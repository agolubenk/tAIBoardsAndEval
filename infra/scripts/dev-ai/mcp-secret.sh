#!/usr/bin/env bash
# Секрет для MCP-сервера из .mcp.json: сначала env, затем macOS Keychain
# (service hr-helper-mcp, account = имя переменной). Печатает значение, код 1 — не найден.
#
# Почему не `${VAR}` в .mcp.json: Claude, запущенный из VSCode/Dock, не видит export'ов
# из ~/.zshrc, а credential-переменные в headers удалённых серверов Claude Code читает
# пустыми намеренно (→ «Authorization header is badly formatted»). Детали — .claude/mcp.md.
#
# Положить секрет:  security add-generic-password -U -s hr-helper-mcp -a <NAME> -w '<value>'
set -euo pipefail

NAME="${1:?usage: mcp-secret.sh <NAME>}"

if [ -n "${!NAME:-}" ]; then
  printf '%s\n' "${!NAME}"
  exit 0
fi

if command -v security >/dev/null 2>&1; then
  security find-generic-password -s hr-helper-mcp -a "$NAME" -w 2>/dev/null && exit 0
fi

exit 1
