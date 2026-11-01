#!/usr/bin/env bash
# Копия OAuth-сессий 1mcp перед сменой версии (backup_client_sessions в lib/mcp-hub-admin.sh): без неё откат с 0.39
# на 0.38 терял бы входы — 0.39 переносит сессии в карантин и удаляет прежние файлы. Боевой каталог хаба не трогает.
#
#   bash infra/scripts/dev-ai/tests/mcp-hub-upgrade.test.sh   # ~1 с
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/mcp-hub-upgrade.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "mcp-hub-upgrade: $*" >&2; exit 1; }

CONFIG_DIR="$TMP/config"
# shellcheck source=../lib/mcp-hub-admin.sh
source "$HERE/../lib/mcp-hub-admin.sh"

# Сессий нет — копировать нечего, это не ошибка.
mkdir -p "$CONFIG_DIR"
backup_client_sessions 0.38.2 >/dev/null || fail "без clientSessions вернул ошибку"
[ ! -e "$CONFIG_DIR/backups" ] || fail "без clientSessions создал каталог копий"

# Сессии есть — копия рядом с конфигом, содержимое байт в байт, каталог копий 700.
mkdir -p "$CONFIG_DIR/clientSessions/nested"
printf 'oauth-notion' >"$CONFIG_DIR/clientSessions/oauth_notion.json"
printf 'oauth-sentry' >"$CONFIG_DIR/clientSessions/nested/oauth_sentry.json"
out="$(backup_client_sessions 0.38.2)" || fail "копия не сделалась"
copy="$(find "$CONFIG_DIR/backups" -maxdepth 1 -name 'clientSessions-0.38.2-*' | head -1)"
[ -n "$copy" ] || fail "нет каталога копии clientSessions-0.38.2-*"
diff -r "$CONFIG_DIR/clientSessions" "$copy" >/dev/null || fail "копия отличается от оригинала"
[ "$(stat -f %Lp "$CONFIG_DIR/backups")" = "700" ] || fail "каталог копий не 700"
case "$out" in *"$copy"*) ;; *) fail "не сказал, куда положил копию: $out" ;; esac

# Копировать некуда (каталог копий — файл) — ошибка: ensure_runtime тогда не обновляет 1mcp.
rm -rf "$CONFIG_DIR/backups" && touch "$CONFIG_DIR/backups"
if backup_client_sessions 0.38.2 >/dev/null 2>&1; then fail "сбой копии не вернул ошибку"; fi

echo "mcp-hub-upgrade: ok"
