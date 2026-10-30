#!/usr/bin/env bash
# Local proof of the WireGuard scripts on Linux (Mac + Docker): a privileged
# container with real iptables, a dummy wg0 and stand-ins for wg and systemctl.
# Checks a split and a full device, a re-run that changes nothing, the
# claude-mem proxy address taken from .env, preshared keys and MTU from
# wg-setup.sh and wg-issue.sh, the shared lock in all three scripts, wg-psk.sh
# live and its refusals, backup retention and file modes, the upgrade of a wg0
# from the first kit and a clean down. Leaves
# nothing behind.
# Usage: deploy/vps/wg-selftest.sh
set -euo pipefail

vps="$(cd "$(dirname "$0")" && pwd)"

docker run --rm --privileged -v "$vps:/kit:ro" alpine:3.20 sh -euc '
apk add -q bash iptables iproute2 flock >/dev/null
mkdir -p /stub
# The live peers are read back from wg0.conf, since syncconf is a no-op here.
cat >/stub/peers.awk <<"EOF"
function out() { if (pub != "") print (what == "peers") ? pub : pub "\t" (psk == "" ? "(none)" : psk); pub = ""; psk = "" }
/^\[/ { out(); peer = ($0 == "[Peer]"); next }
peer && $1 == "PublicKey" { pub = $3 }
peer && $1 == "PresharedKey" { psk = $3 }
END { out() }
EOF
cat >/stub/wg <<"EOF"
#!/bin/sh
case "$1" in
  genkey | genpsk) head -c 32 /dev/urandom | base64 ;;
  pubkey) echo "$(sha256sum | cut -c1-43)=" ;;
  show)
    case "${3:-}" in
      # /tmp/wg-lose-psk: the live interface "loses" the keys, as if wg set had not taken them.
      preshared-keys) awk -v what="$3" -f /stub/peers.awk /etc/wireguard/wg0.conf |
        { if [ -e /tmp/wg-lose-psk ]; then sed "s/\t.*/\t(none)/"; else cat; fi; } ;;
      peers) awk -v what="$3" -f /stub/peers.awk /etc/wireguard/wg0.conf ;;
      *) echo "SERVERpublicKEYserverPUBLICkeySERVERpublic0=" ;;
    esac ;;
  # The live change goes to a journal: peer and the key read from the file it was given.
  set) printf "%s %s\n" "$4" "$(cat "$6")" >>/tmp/wg-set.log ;;
  syncconf) cat >/dev/null ;;
esac
EOF
# FAKE_TS pins the backup timestamp, so two edits land in the same second.
cat >/stub/date <<"EOF"
#!/bin/sh
if [ -n "${FAKE_TS:-}" ] && [ "$1" = "+%Y%m%d-%H%M%S" ]; then echo "$FAKE_TS"; else exec /bin/date "$@"; fi
EOF
cat >/stub/wg-quick <<"EOF"
#!/bin/sh
grep -v -E "^(Address|PostUp|PostDown) = " "/etc/wireguard/$2.conf"
EOF
cat >/stub/systemctl <<"EOF"
#!/bin/sh
case "$1" in
  is-active) ip link show wg0 >/dev/null 2>&1 ;;
  start)
    ip link add wg0 type dummy
    ip addr add 10.77.0.1/24 dev wg0
    ip link set wg0 up
    /etc/wireguard/t-boards-rules.sh up wg0 ;;
  stop)
    /etc/wireguard/t-boards-rules.sh down wg0
    ip link del wg0 ;;
esac
EOF
chmod +x /stub/*
export PATH="/stub:$PATH"
# Docker on the VPS owns DOCKER-USER; the rules must hook into it.
iptables -N DOCKER-USER
iptables -I FORWARD -j DOCKER-USER

fail() { echo "FAIL: $*"; exit 1; }
setup() { bash /kit/wg-setup.sh "$@" >/tmp/out 2>&1 || { cat /tmp/out; fail "wg-setup.sh $*"; }; }
k1=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
k2=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=

setup "$k1" mac split && cp /tmp/out /tmp/split.out
grep -q "^AllowedIPs = 10.77.0.0/24$" /tmp/split.out || fail "split profile"
grep -q "^Address = 10.77.0.2/32$" /tmp/split.out || fail "split address"
grep -q "^MTU = 1380$" /tmp/split.out || fail "split MTU"
psk_of() { grep -A3 "^# $1 (" /etc/wireguard/wg0.conf | sed -n "s/^PresharedKey = //p"; }
mac_psk="$(psk_of mac)"
[ -n "$mac_psk" ] || fail "new peer without PresharedKey"
grep -qxF "PresharedKey = $mac_psk" /tmp/split.out || fail "printed PresharedKey differs from the peer"
setup "$k2" phone full && cp /tmp/out /tmp/full.out
grep -q "^AllowedIPs = 0.0.0.0/0, ::/0$" /tmp/full.out || fail "full profile"
grep -q "^DNS = " /tmp/full.out || fail "full DNS"
grep -q "^Address = 10.77.0.3/32$" /tmp/full.out || fail "full address"
echo "ok: split 10.77.0.2, full 10.77.0.3"

snapshot() { iptables-save | grep -v -E "^(#|:)" | sed -E "s/\[[0-9]+:[0-9]+\]//"; }
before="$(snapshot)"
setup "$k2" phone full
[ "$before" = "$(snapshot)" ] || fail "re-run changed the rules"
[ "$(grep -c "^\[Peer\]" /etc/wireguard/wg0.conf)" = 2 ] || fail "re-run added a peer"
grep -q "^PresharedKey" /tmp/out && fail "re-run printed the PresharedKey again"
echo "ok: re-run changes nothing, new peers get a PresharedKey and MTU 1380"

redirects="$(iptables -t nat -S PREROUTING | grep -c REDIRECT)"
[ "$redirects" = 1 ] || fail "redirects: $redirects"
iptables -t nat -C PREROUTING -i wg0 -d 10.77.0.1/32 -p tcp --dport 443 -j REDIRECT --to-ports 8443 || fail "redirect not bound to the tunnel address"
chain() {
  cat <<EOF
-A TB-WG -i wg0 -o eth0 -j ACCEPT
-A TB-WG -i eth0 -o wg0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A TB-WG -s $1/32 -i wg0 -p tcp -m tcp --sport $2 -m conntrack --ctstate ESTABLISHED -j RETURN
-A TB-WG -i wg0 -m conntrack --ctstate DNAT -j RETURN
-A TB-WG -i wg0 -j DROP
EOF
}
iptables -S TB-WG | tail -n +2 >/tmp/chain
chain 10.77.0.2 37702 | diff - /tmp/chain || fail "forwarding chain differs"
grep -qF -e "-s 10.77.0.2 -p tcp --sport 37702 " /etc/wireguard/t-boards-rules.sh || fail "install.sh check misses the rule"
iptables -C DOCKER-USER -j TB-WG || fail "no DOCKER-USER hook"
echo "ok: forwarding chain in order, hooked into FORWARD and DOCKER-USER"

# The claude-mem proxy address comes from the app .env; a bad value falls back.
mkdir -p /opt/t-boards
printf "CLAUDE_MEM_WORKER_HOST=10.77.0.5\nCLAUDE_MEM_WORKER_PORT=38000\n" >/opt/t-boards/.env
setup "$k2" phone full
iptables -S TB-WG | tail -n +2 | diff <(chain 10.77.0.5 38000) - || fail "memory address from .env not applied"
printf "CLAUDE_MEM_WORKER_HOST=192.168.1.2\nCLAUDE_MEM_WORKER_PORT=38000\n" >/opt/t-boards/.env
setup "$k2" phone full
iptables -S TB-WG | tail -n +2 | diff <(chain 10.77.0.2 37702) - || fail "address outside the tunnel kept"
rm -r /opt/t-boards
setup "$k2" phone full
echo "ok: claude-mem proxy address from .env, outside the tunnel falls back"

# wg-issue.sh: the server makes the keys; the same PresharedKey goes to the peer and the profile.
issue() { bash /kit/wg-issue.sh "$@" >/tmp/conf 2>/tmp/log </dev/null || { cat /tmp/log; fail "wg-issue.sh $*"; }; }
for i in 1 2 3 4 5; do : >/etc/wireguard/wg0.conf.bak-20200101-00000$i; done
grep "^PresharedKey = " /etc/wireguard/wg0.conf >/tmp/psk.before
issue tablet full
tablet_psk="$(sed -n "s/^PresharedKey = //p" /tmp/conf)"
[ -n "$tablet_psk" ] || fail "issued profile without PresharedKey"
[ "$(psk_of tablet)" = "$tablet_psk" ] || fail "issued PresharedKey differs from the peer"
grep -q "^MTU = 1380$" /tmp/conf || fail "issued profile without MTU"
grep -q "^Address = 10.77.0.4/32$" /tmp/conf || fail "issued address"
grep "^PresharedKey = " /etc/wireguard/wg0.conf | head -n "$(wc -l </tmp/psk.before)" | diff /tmp/psk.before - ||
  fail "issuing a device changed other PresharedKeys"
issue laptop split
[ "$(sed -n "s/^PresharedKey = //p" /tmp/conf)" != "$tablet_psk" ] || fail "two devices share a PresharedKey"
bash /kit/wg-issue.sh --revoke tablet >/dev/null 2>&1 </dev/null || fail "revoke tablet"
grep -qF "$tablet_psk" /etc/wireguard/wg0.conf && fail "revoked device left its PresharedKey"
[ "$(psk_of mac)" = "$mac_psk" ] || fail "revoke changed the mac PresharedKey"
backups="$(ls /etc/wireguard | grep -c "^wg0.conf.bak-")"
[ "$backups" = 3 ] || fail "backups kept: $backups"
# At least one real backup is newer than the five planted ones, so the three oldest must be gone.
ls /etc/wireguard | grep -q "^wg0.conf.bak-20200101-00000[123]$" && fail "oldest backups kept"
echo "ok: wg-issue.sh PresharedKey in peer and profile, others untouched, three backups"

# Backups: a re-run that changes nothing keeps the last real state; edits within one
# second or after the clock went back keep the newest three; both scripts share one backup().
sed -n "/^backup() {/,/^}/p" /kit/wg-setup.sh >/tmp/backup.setup
sed -n "/^backup() {/,/^}/p" /kit/wg-issue.sh | diff /tmp/backup.setup - || fail "backup() differs between wg-setup.sh and wg-issue.sh"
has_backup() { for f in /etc/wireguard/wg0.conf.bak-[0-9]*; do cmp -s "$1" "$f" && return 0; done; return 1; }
cp /etc/wireguard/wg0.conf /tmp/pre
issue spare split
for i in 1 2 3; do
  export FAKE_TS=20991231-00000$i
  setup "$k2" phone full
done
has_backup /tmp/pre || fail "idle re-runs pushed out the state before the last edit"
rm -f /etc/wireguard/wg0.conf.bak-[0-9]*
n=0
for step in same1 same2 -same1 -same2 same3 -same3; do
  n=$((n + 1))
  cp /etc/wireguard/wg0.conf /tmp/state.$n
  # Five edits in one second, the sixth after the clock went back.
  export FAKE_TS=20991231-120000
  [ "$n" -lt 6 ] || export FAKE_TS=20991231-110000
  case "$step" in
    -*) bash /kit/wg-issue.sh --revoke "${step#-}" >/dev/null 2>&1 </dev/null || fail "revoke ${step#-}" ;;
    *) issue "$step" split ;;
  esac
done
unset FAKE_TS
for n in 4 5 6; do has_backup /tmp/state.$n || fail "edit $n of six lost its backup"; done
[ -e /etc/wireguard/wg0.conf.bak-20991231-120000-05 ] || fail "backups out of order: $(ls /etc/wireguard | grep bak-)"
bash /kit/wg-issue.sh --revoke spare >/dev/null 2>&1 </dev/null || fail "revoke spare"
for f in /etc/wireguard/wg0.conf /etc/wireguard/wg0.conf.bak-[0-9]*; do
  [ "$(stat -c %a "$f")" = 600 ] || fail "$f is $(stat -c %a "$f"), not 600"
done
echo "ok: backups keep the last real state and the newest three edits of one second, all 600"

# Each of the three scripts waits for the lock another one holds.
held() { rm -f /tmp/held; ( flock 9; sleep 3; : >/tmp/held ) 9>/etc/wireguard/wg0.conf.lock & sleep 1; }
held; setup "$k2" phone full; [ -f /tmp/held ] || fail "wg-setup.sh did not wait for the lock"
held; issue locked split; [ -f /tmp/held ] || fail "wg-issue.sh did not wait for the lock"
bash /kit/wg-issue.sh --revoke locked >/dev/null 2>&1 </dev/null || fail "revoke locked"

# wg-psk.sh changes one peer, live and in the file; the key shows up in no output.
mac_pub="$(grep -A2 "^# mac (" /etc/wireguard/wg0.conf | sed -n "s/^PublicKey = //p")"
new_psk="$(wg genpsk)"
held
printf %s "$new_psk" | bash /kit/wg-psk.sh 10.77.0.2 >/tmp/out 2>&1 || { cat /tmp/out; fail "wg-psk.sh set"; }
[ -f /tmp/held ] || fail "wg-psk.sh did not wait for the lock"
[ "$(psk_of mac)" = "$new_psk" ] || fail "wg-psk.sh did not set the mac PresharedKey"
[ "$(tail -1 /tmp/wg-set.log)" = "$mac_pub $new_psk" ] || fail "wg-psk.sh did not apply the key to the live peer"
grep -qF "$new_psk" /tmp/out && fail "wg-psk.sh printed the key"
[ "$(psk_of phone)" = "$(sed -n 2p /tmp/psk.before | sed "s/^PresharedKey = //")" ] || fail "wg-psk.sh changed another peer"
[ "$(stat -c %a /etc/wireguard/wg0.conf)" = 600 ] || fail "wg-psk.sh left wg0.conf wider than 600"
bash /kit/wg-psk.sh --remove 10.77.0.2 >/tmp/out 2>&1 </dev/null || { cat /tmp/out; fail "wg-psk.sh --remove"; }
[ -z "$(psk_of mac)" ] || fail "wg-psk.sh --remove left the PresharedKey"
[ "$(tail -1 /tmp/wg-set.log)" = "$mac_pub " ] || fail "wg-psk.sh --remove did not clear the live key"
[ ! -e /etc/wireguard/wg0.conf.bak-psk ] || fail "wg-psk.sh left its backup"

# Refusals leave wg0.conf as it was.
cp /etc/wireguard/wg0.conf /tmp/conf.before
refused() {
  if bash /kit/wg-psk.sh "$@" >/tmp/out 2>&1; then fail "wg-psk.sh $* went through"; fi
  grep -q "СТОП" /tmp/out || fail "wg-psk.sh $*: no reason given"
  cmp -s /tmp/conf.before /etc/wireguard/wg0.conf || fail "wg-psk.sh $* changed wg0.conf"
}
refused 10.77.0.2 </dev/null
printf %s "$new_psk" | refused 10.77.0.99
printf %s "$new_psk" | refused
# A failed live check keeps the backup and the rollback; the next run will not overwrite it.
: >/tmp/wg-lose-psk
if printf %s "$new_psk" | bash /kit/wg-psk.sh 10.77.0.2 >/tmp/out 2>&1; then fail "wg-psk.sh passed a failed live check"; fi
rm /tmp/wg-lose-psk
[ -e /etc/wireguard/wg0.conf.bak-psk ] && grep -q "Откат: cp /etc/wireguard/wg0.conf.bak-psk" /tmp/out || fail "failed live check without backup and rollback"
grep -qF "$new_psk" /tmp/out && fail "wg-psk.sh printed the key on failure"
[ "$(stat -c %a /etc/wireguard/wg0.conf.bak-psk)" = 600 ] || fail "bak-psk wider than 600"
cp /etc/wireguard/wg0.conf /tmp/conf.before
printf %s "$new_psk" | refused 10.77.0.2
cmp -s /tmp/conf.before /etc/wireguard/wg0.conf.bak-psk && fail "the next run overwrote bak-psk"
mv /etc/wireguard/wg0.conf.bak-psk /etc/wireguard/wg0.conf
[ -z "$(psk_of mac)" ] || fail "rollback from bak-psk did not restore the mac peer"
echo "ok: wg-psk.sh waits for the lock, sets and removes one peer live, refuses bad input and keeps the backup of a failed run"

# wg0 from the first kit: redirect for any destination, rules inline.
/stub/systemctl stop
cat >/etc/wireguard/wg0.conf <<"EOF"
[Interface]
Address = 10.77.0.1/24
ListenPort = 51820
PrivateKey = SERVERprivateKEYserverPRIVATEkeySERVERpriv0=
# The edge nginx of the product owns 0.0.0.0:443, so tunnel traffic for 443
# goes to the t-boards TLS terminator on 10.77.0.1:8443.
PostUp = iptables -t nat -I PREROUTING 1 -i %i -p tcp --dport 443 -j REDIRECT --to-ports 8443
PostDown = iptables -t nat -D PREROUTING -i %i -p tcp --dport 443 -j REDIRECT --to-ports 8443

[Peer]
# mac
PublicKey = AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
AllowedIPs = 10.77.0.2/32
EOF
ip link add wg0 type dummy && ip addr add 10.77.0.1/24 dev wg0 && ip link set wg0 up
iptables -t nat -I PREROUTING 1 -i wg0 -p tcp --dport 443 -j REDIRECT --to-ports 8443
setup "$k2" phone full
[ "$(iptables -t nat -S PREROUTING | grep -c REDIRECT)" = 1 ] || fail "old redirect left behind"
grep -q "^PostUp = /etc/wireguard/t-boards-rules.sh up %i$" /etc/wireguard/wg0.conf || fail "conf not upgraded"
grep -q "^PostUp = iptables" /etc/wireguard/wg0.conf && fail "old PostUp kept"
[ "$(grep -c "^\[Peer\]" /etc/wireguard/wg0.conf)" = 2 ] || fail "upgrade lost a peer"
[ "$(grep -c "^PresharedKey" /etc/wireguard/wg0.conf)" = 1 ] || fail "upgrade gave the old mac peer a PresharedKey"
echo "ok: first-kit wg0 upgraded, mac kept without a new key, phone added as 10.77.0.3"

/stub/systemctl stop
left="$(iptables-save | grep -c -E "TB-WG|10\.77\.0" || true)"
[ "$left" = 0 ] || { iptables-save | grep -E "TB-WG|10\.77\.0"; fail "rules left after down: $left"; }
echo "ok: down removes every rule"
echo "wg-selftest: all checks passed"
'
