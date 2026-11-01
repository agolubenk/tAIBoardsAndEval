#!/usr/bin/env bash
# Issues a ready WireGuard config for one more device of the t-boards tunnel
# (wg0 from wg-setup.sh). The keypair is made here; the private key goes only
# to the output and is not kept on the VPS.
# stdout carries the config alone, so it can go straight into a file on the Mac:
#   ssh root@VPS 'bash wg-issue.sh LABEL full' > ~/Downloads/t-boards-LABEL.conf
# (no ssh -t: a terminal would mix the log into the file). The log and a QR code
# for the phone app go to stderr.
# Usage: wg-issue.sh LABEL [split|full]  ·  wg-issue.sh --revoke LABEL
set -euo pipefail

WG_IF=wg0
WG_NET=10.77.0
WG_PORT=51820
CONF=/etc/wireguard/$WG_IF.conf
FULL_DNS="1.1.1.1, 9.9.9.9"

exec 3>&1 1>&2
log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() {
  log "СТОП: $*"
  exit 1
}

[ "$(id -u)" = 0 ] || die "нужен root"
revoke=""
if [ "${1:-}" = --revoke ]; then
  revoke=1
  shift
fi
label="${1:-}"
mode="${2:-split}"
[[ "$label" =~ ^[A-Za-z0-9._-]{1,32}$ ]] || die "имя устройства — латиница, цифры, . _ - (до 32)"
case "$mode" in split | full) ;; *) die "режим — split или full, не «$mode»" ;; esac
[ -f "$CONF" ] && systemctl is-active --quiet "wg-quick@$WG_IF" || die "$WG_IF не поднят — сначала wg-setup.sh"

umask 077
exec 9>"$CONF.lock"
flock 9
tag="# $label ("
has_label() { grep -qF -- "$tag" "$CONF"; }
apply() { wg syncconf "$WG_IF" <(wg-quick strip "$WG_IF"); }
backup() { cp -a "$CONF" "$CONF.bak-$(date +%Y%m%d-%H%M%S)"; }

if [ -n "$revoke" ]; then
  has_label || die "устройства «$label» нет в $CONF"
  backup
  # Drops the [Peer] block whose first line is the device comment.
  awk -v tag="$tag" '
    /^\[Peer\]$/ { held = $0; next }
    held != "" { if (index($0, tag) == 1) skip = 1; else print held; held = "" }
    skip && /^$/ { skip = 0; next }
    skip && /^\[/ { skip = 0 }
    !skip { print }
  ' "$CONF" >"$CONF.new"
  mv "$CONF.new" "$CONF"
  ! has_label || die "блок «$label» не удалился, $CONF не тронут сверх бэкапа"
  apply
  log "устройство $label отозвано, туннель с его ключом больше не пускает"
  exit 0
fi

has_label && die "устройство «$label» уже есть — другое имя или сначала --revoke $label"
public_ip="$(ip -4 route get 1.1.1.1 | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}')"
[ -n "$public_ip" ] || die "не нашёл публичный IP"

last="$({ grep -E "^AllowedIPs = $WG_NET\.[0-9]+/32" "$CONF" || true; } | sed -E 's|.*\.([0-9]+)/32|\1|' | sort -n | tail -1)"
next=$((${last:-1} + 1))
[ "$next" -le 254 ] || die "в $WG_NET.0/24 кончились адреса"
peer_ip="$WG_NET.$next"

private="$(wg genkey)"
public="$(printf '%s' "$private" | wg pubkey)"
backup
printf '\n[Peer]\n# %s (%s)\nPublicKey = %s\nAllowedIPs = %s/32\n' "$label" "$mode" "$public" "$peer_ip" >>"$CONF"
apply
wg show "$WG_IF" peers | grep -qxF "$public" || die "пир не появился в $WG_IF; отзыв: wg-issue.sh --revoke $label"

if [ "$mode" = full ]; then
  allowed="0.0.0.0/0, ::/0"
  dns="DNS = $FULL_DNS"$'\n'
else
  allowed="$WG_NET.0/24"
  dns=""
fi
conf="[Interface]
PrivateKey = $private
Address = $peer_ip/32
${dns}
[Peer]
PublicKey = $(wg show "$WG_IF" public-key)
Endpoint = $public_ip:$WG_PORT
AllowedIPs = $allowed
PersistentKeepalive = 25"
unset private
printf '%s\n' "$conf" >&3
log "устройство $label ($mode): $peer_ip, конфиг выведен"

if ! command -v qrencode >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq qrencode >/dev/null 2>&1 || true
fi
if command -v qrencode >/dev/null 2>&1; then
  log "QR для телефона (WireGuard → + → Сканировать QR-код):"
  qrencode -t ansiutf8 <<<"$conf"
else
  log "qrencode не поставился — QR не будет, файл конфига готов"
fi
unset conf
log "Mac: WireGuard → Импорт туннелей из файла. Проверка: ping $WG_NET.1; в full внешний IP станет $public_ip"
log "Отзыв: bash $0 --revoke $label"
