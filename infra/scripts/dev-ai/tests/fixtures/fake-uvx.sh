#!/bin/bash
# Подставная обёртка serena для tests/mcp-hub-detach.test.sh. Тест копирует её как <tmp>/bin/uvx:
# mcp-hub.sh узнаёт обёртку serena по программе (uv/uvx), а у скрипта программа — его имя. Как
# `uv tool uvx`, держит python-ребёнка (<tmp>/bin/serena) с теми же аргументами и ждёт его.
python3 "$(dirname "$0")/serena" "$@" &
wait $!
