#!/bin/sh
# Mac side of t-boards memory: the read-only proxy that lets d4dev read the
# Mac's claude-mem through the tunnel (R-040, d-tb-claude-mem = proxy-ro).
#   memory-agent.sh install — install the LaunchAgent (always on, restarts itself)
#   memory-agent.sh check   — GET health answers, POST is refused
#   memory-agent.sh remove  — unload and delete the LaunchAgent
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
home="$HOME/.t-boards-memory"
label="space.hrhelper.t-boards-memory-proxy"
plist="$HOME/Library/LaunchAgents/$label.plist"
log="$HOME/Library/Logs/t-boards-memory-proxy.log"
url="http://${CMEM_PROXY_LISTEN:-10.77.0.2}:${CMEM_PROXY_PORT:-37702}"

check() {
  health=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$url/api/health" || true)
  post=$(curl -s -o /dev/null -w '%{http_code}' -m 5 -X POST "$url/api/observations" || true)
  echo "память: GET health $health (ждём 200), POST $post (ждём 405)"
  [ "$health" = 200 ] && [ "$post" = 405 ]
}

case "${1:-}" in
  install)
    # launchd starts with a bare PATH: pin the node this shell finds.
    node=$(command -v node) || {
      echo "нет node в PATH" >&2
      exit 1
    }
    mkdir -p "$home" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
    # A copy, not a link: a branch switch must not swap the code launchd runs.
    cp "$here/memory-proxy.mjs" "$home/memory-proxy.mjs"
    cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>$node</string><string>$home/memory-proxy.mjs</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict>
</plist>
EOF
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$plist"
    sleep 2
    tail -1 "$log" 2>&1 || true
    check || echo "не отвечает: туннель поднят? лог — $log" >&2
    ;;
  check)
    check
    ;;
  remove)
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    rm -f "$plist"
    echo "LaunchAgent удалён; копия прокси осталась в $home"
    ;;
  *)
    echo "usage: $0 install|check|remove" >&2
    exit 2
    ;;
esac
