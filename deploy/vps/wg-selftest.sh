#!/usr/bin/env bash
# Local proof of wg-setup.sh on Linux (Mac + Docker): a privileged container
# with real iptables, a dummy wg0 and stand-ins for wg and systemctl. Checks a
# split and a full device, a re-run that changes nothing, the claude-mem proxy
# address taken from .env, the upgrade of a wg0 from the first kit and a clean
# down. Leaves nothing behind.
# Usage: deploy/vps/wg-selftest.sh
set -euo pipefail

vps="$(cd "$(dirname "$0")" && pwd)"

docker run --rm --privileged -v "$vps:/kit:ro" alpine:3.20 sh -euc '
apk add -q bash iptables iproute2 >/dev/null
mkdir -p /stub
cat >/stub/wg <<"EOF"
#!/bin/sh
case "$1" in
  genkey) echo "SERVERprivateKEYserverPRIVATEkeySERVERpriv0=" ;;
  show) echo "SERVERpublicKEYserverPUBLICkeySERVERpublic0=" ;;
  syncconf) cat >/dev/null ;;
esac
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
echo "ok: re-run changes nothing"

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
echo "ok: first-kit wg0 upgraded, mac kept, phone added as 10.77.0.3"

/stub/systemctl stop
left="$(iptables-save | grep -c -E "TB-WG|10\.77\.0" || true)"
[ "$left" = 0 ] || { iptables-save | grep -E "TB-WG|10\.77\.0"; fail "rules left after down: $left"; }
echo "ok: down removes every rule"
echo "wg-selftest: all checks passed"
'
