#!/usr/bin/env bash
# headersHelper для HTTP MCP-серверов из .mcp.json: печатает {"Authorization":"Bearer …"}.
# Токен — через mcp-secret.sh (env → Keychain); для GITHUB_PAT ещё fallback на `gh auth token`.
# Токена нет → {}: сервер честно покажет 401 в /mcp, а не «badly formatted header».
# Claude Code запускает helper при каждом подключении, лимит — 10 с.
set -uo pipefail

NAME="${1:?usage: mcp-auth-headers.sh <NAME>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"

TOKEN="$(bash "$SCRIPT_DIR/mcp-secret.sh" "$NAME" 2>/dev/null)"
if [ -z "$TOKEN" ] && [ "$NAME" = "GITHUB_PAT" ] && command -v gh >/dev/null 2>&1; then
  TOKEN="$(gh auth token 2>/dev/null)"
fi

case "$TOKEN" in
  '')
    echo "mcp-auth-headers: $NAME не найден (env / Keychain hr-helper-mcp) — см. .claude/mcp.md" >&2
    printf '{}\n'
    ;;
  *[!A-Za-z0-9_.-]*)
    echo "mcp-auth-headers: $NAME содержит недопустимые символы — не отправляю" >&2
    printf '{}\n'
    ;;
  *)
    printf '{"Authorization":"Bearer %s"}\n' "$TOKEN"
    ;;
esac
