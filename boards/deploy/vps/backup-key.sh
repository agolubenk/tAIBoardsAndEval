#!/usr/bin/env bash
# Lets one Mac key pull /opt/t-boards/backups/latest.dump over WireGuard and
# nothing else: forced command, tunnel source address only, no pty or
# forwarding. Usage: backup-key.sh ["ssh-ed25519 AAAA… comment" [PEER_IP]]
set -euo pipefail

KEYS=/root/.ssh/authorized_keys
DUMP=/opt/t-boards/backups/latest.dump

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() {
  log "СТОП: $*"
  exit 1
}

[ "$(id -u)" = 0 ] || die "нужен root"
key="${1:-}"
peer_ip="${2:-10.77.0.2}"
if [ -z "$key" ]; then
  read -r -p "Публичный ключ бэкапа с Mac (ssh-ed25519 …): " key </dev/tty
fi
read -r type blob _ <<<"$key"
[ "$type" = "ssh-ed25519" ] && [[ "$blob" =~ ^[A-Za-z0-9+/]{68}$ ]] || die "это не ключ ssh-ed25519"

install -d -m 0700 /root/.ssh
touch "$KEYS"
chmod 0600 "$KEYS"
if grep -qF "$blob" "$KEYS"; then
  log "ключ уже есть в $KEYS"
else
  cp -a "$KEYS" "$KEYS.bak-$(date +%Y%m%d-%H%M%S)"
  printf 'restrict,from="%s",command="cat %s" %s %s t-boards-backup\n' "$peer_ip" "$DUMP" "$type" "$blob" >>"$KEYS"
  log "ключ добавлен: только cat $DUMP и только с $peer_ip"
fi

listen="$(ss -ltnH 'sport = :22' | awk '{print $4}' | tr '\n' ' ')"
log "sshd слушает: $listen"
case "$listen" in
  *0.0.0.0:22* | *"[::]:22"* | *"*:22"* | *10.77.0.1:22*) ;;
  *) die "sshd не слушает адрес туннеля — Mac не дотянется" ;;
esac
[ -s "$DUMP" ] && log "последний бэкап: $(stat -c '%y %s байт' "$DUMP")" || log "бэкапа ещё нет — первый появится после запуска"
log "Откат: sed -i '/t-boards-backup\$/d' $KEYS"
