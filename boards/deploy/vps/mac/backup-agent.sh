#!/bin/sh
# Mac side of the off-VPS backup copy.
#   backup-agent.sh key     — create the pull key (outside ~/.ssh), print its public half
#   backup-agent.sh install — install the LaunchAgent that pulls every 2 h
#   backup-agent.sh remove  — unload and delete the LaunchAgent (keys and dumps stay)
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
home="$HOME/.t-boards-backup"
label="space.hrhelper.t-boards-backup"
plist="$HOME/Library/LaunchAgents/$label.plist"

case "${1:-}" in
  key)
    mkdir -p "$home"
    chmod 700 "$home"
    [ -f "$home/id_ed25519" ] || ssh-keygen -q -t ed25519 -N '' -C t-boards-backup -f "$home/id_ed25519"
    cat "$home/id_ed25519.pub"
    ;;
  install)
    [ -f "$home/id_ed25519" ] || {
      echo "сначала: $0 key" >&2
      exit 1
    }
    cp "$here/pull-backup.sh" "$home/pull-backup.sh"
    chmod 700 "$home/pull-backup.sh"
    mkdir -p "$HOME/t-boards-backups" "$HOME/Library/LaunchAgents"
    cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>$home/pull-backup.sh</string></array>
  <key>StartInterval</key><integer>7200</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$HOME/t-boards-backups/pull.log</string>
  <key>StandardErrorPath</key><string>$HOME/t-boards-backups/pull.log</string>
</dict>
</plist>
EOF
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$plist"
    sleep 3
    tail -2 "$HOME/t-boards-backups/pull.log" 2>&1 || true
    ;;
  remove)
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    rm -f "$plist"
    echo "LaunchAgent удалён; ключ и бэкапы на месте: $home, $HOME/t-boards-backups"
    ;;
  *)
    echo "usage: $0 key|install|remove" >&2
    exit 2
    ;;
esac
