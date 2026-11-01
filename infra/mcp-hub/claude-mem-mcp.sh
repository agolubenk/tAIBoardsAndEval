#!/bin/sh
# claude-mem (mcp-search) для хаба: тот же сервер, что плагин claude-mem поднимает в каждой сессии Claude Code,
# но одной копией на всех клиентов хаба. Данные и воркер (:37701) — общие, у плагина; обёртка только находит
# установленную копию `mcp-server.cjs`: сначала маркетплейс (оттуда работает воркер), затем самая свежая в кэше.
C="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
S="$C/plugins/marketplaces/thedotmack/plugin/scripts/mcp-server.cjs"
if [ ! -f "$S" ]; then
  S="$(ls -td "$C"/plugins/cache/thedotmack/claude-mem/*/scripts/mcp-server.cjs 2>/dev/null | head -1)"
fi
if [ -z "$S" ] || [ ! -f "$S" ]; then
  echo "claude-mem: mcp-server.cjs не найден — плагин claude-mem не установлен" >&2
  exit 1
fi
# Воркер поднимает короткоживущая команда плагина, как хук SessionStart: демон отвязывается и уходит к launchd.
# Подними его сам mcp-server.cjs — воркер стал бы потомком хаба, и `mcp-hub:stop` погасил бы его вместе с деревом,
# а с ним память всех сессий Claude Code. Уже запущенный воркер команда не трогает (~0,2 с). Вывод — в /dev/null:
# stdout обёртки — канал MCP. Сбой не фатален: mcp-server.cjs попробует поднять воркер сам.
CM="$(command -v claude-mem 2>/dev/null || echo "$HOME/.local/bin/claude-mem")"
if [ -x "$CM" ]; then "$CM" start >/dev/null 2>&1 || true; fi
exec node "$S"
