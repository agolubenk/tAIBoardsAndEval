#!/usr/bin/env bash
# Stdio-обёртка postgres-readonly (.mcp.json): URI роли mcp_readonly (env → Keychain) → postgres-mcp.
# Роль и пароль — infra/scripts/db/mcp-readonly-role.sql; детали — .claude/mcp.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATH="$HOME/.local/bin:$PATH:/opt/homebrew/bin:/usr/local/bin"

if ! DATABASE_URI="$(bash "$SCRIPT_DIR/mcp-secret.sh" MCP_PG_READONLY_URI)"; then
  echo "postgres-readonly: MCP_PG_READONLY_URI не найден (env / Keychain hr-helper-mcp) — см. .claude/mcp.md" >&2
  exit 1
fi
export DATABASE_URI

# mcp<2: postgres-mcp импортирует mcp.server.fastmcp, которого в mcp 2.x нет (переименован в
# MCPServer) — без пина uvx берёт свежий mcp и сервер падает на старте (CONNECTION_CLOSED).
# postgres-mcp==0.3.0 + overrides (pglast==7.21): все его версии жёстко требуют pglast==7.2.0, а на PyPI из
# ветки 7.x остались только 7.20/7.21 — без override резолвер молча берёт чужой postgres-mcp 0.1.0, который
# читает первый аргумент как строку подключения («invalid dsn: invalid connection option "--access-mode"»).
exec uvx --overrides "$SCRIPT_DIR/postgres-mcp.overrides.txt" --with 'mcp<2' 'postgres-mcp==0.3.0' --access-mode=restricted
