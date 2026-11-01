#!/usr/bin/env bash
# Автозапуск бота на Mac владельца: LaunchAgent стартует его при входе в систему и поднимает после сбоя
# (сторож бота выходит с кодом 1, если работа встала). Код копируется в ~/.hr-owner-queue-bot/app: фоновому
# процессу macOS не даёт читать ~/Desktop (там репозиторий) без отдельного разрешения, а копия не зависит
# от worktree. Повторный запуск — обновить копию кода и перезапустить.
#   bash deploy/install-launchd.sh            — установить и запустить
#   bash deploy/install-launchd.sh --remove   — остановить и удалить
set -euo pipefail
LABEL=com.hrhelper.owner-queue-bot
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE="${OQB_HOME:-$HOME/.hr-owner-queue-bot}"
NODE="$(command -v node)"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
if [ "${1:-}" = "--remove" ]; then rm -f "$PLIST"; echo "Автозапуск удалён."; exit 0; fi

# Бот, запущенный вручную, держит профиль Chrome и токен — останавливаем, launchd запустит свой.
if [ -f "$STATE/bot.pid" ] && kill -0 "$(cat "$STATE/bot.pid")" 2>/dev/null; then
  kill "$(cat "$STATE/bot.pid")"
  for _ in $(seq 1 20); do kill -0 "$(cat "$STATE/bot.pid" 2>/dev/null || echo 0)" 2>/dev/null || break; sleep 0.5; done
fi

APP="$STATE/app"
mkdir -p "$APP"
cp "$DIR"/*.mjs "$APP"/
if [ "$(node -p "try{require('$APP/node_modules/playwright/package.json').version}catch{''}")" != "1.64.0" ]; then
  echo "== ставлю playwright 1.64.0 в $APP (браузер — установленный Google Chrome)"
  (cd "$APP" && { [ -f package.json ] || npm init -y >/dev/null; } && npm install --no-audit --no-fund --ignore-scripts playwright@1.64.0 >/dev/null)
fi

mkdir -p "$HOME/Library/LaunchAgents"
cat >"$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$APP/bot.mjs</string></array>
  <key>WorkingDirectory</key><string>$APP</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$STATE/bot.log</string>
  <key>StandardErrorPath</key><string>$STATE/bot.log</string>
</dict></plist>
PL
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Автозапуск установлен ($LABEL), код: $APP (копия из $DIR), лог: $STATE/bot.log"
