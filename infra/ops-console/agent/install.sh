#!/usr/bin/env bash
# Установка агента на сервер (Ubuntu/Debian, systemd). Запускать от root из каталога agent/:
#   sudo ./install.sh            — установить/обновить файлы и юнит
#   затем заполнить /etc/hrh-ops-agent.env и: sudo systemctl enable --now hrh-ops-agent
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "нужен root (sudo)"; exit 1; }
command -v python3 >/dev/null || { echo "нужен python3"; exit 1; }
command -v docker >/dev/null || echo "внимание: docker не найден — контейнеры собираться не будут"

here="$(cd "$(dirname "$0")" && pwd)"
id hrh-ops >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin hrh-ops
install -d -m 755 /opt/hrh-ops
install -m 755 "$here/hrh-ops-agent.py" /opt/hrh-ops/hrh-ops-agent.py
install -m 644 "$here/hrh_ops_collect.py" /opt/hrh-ops/hrh_ops_collect.py
install -m 644 "$here/hrh_ops_edge.py" /opt/hrh-ops/hrh_ops_edge.py
install -m 644 "$here/hrh_ops_vpn.py" /opt/hrh-ops/hrh_ops_vpn.py
install -m 755 "$here/hrh-ops-vpnd.py" /opt/hrh-ops/hrh-ops-vpnd.py
install -m 644 "$here/hrh-ops-vpn.service" /etc/systemd/system/hrh-ops-vpn.service
install -m 755 "$here/hrh-business.sh" /opt/hrh-ops/hrh-business.sh
install -m 644 "$here/hrh-ops-agent.service" /etc/systemd/system/hrh-ops-agent.service
if [[ ! -f /etc/hrh-ops-agent.env ]]; then
  install -m 600 -o root -g root "$here/hrh-ops-agent.env.example" /etc/hrh-ops-agent.env
  echo "создан /etc/hrh-ops-agent.env — впишите OPS_CONSOLE_URL, OPS_AGENT_ID, OPS_AGENT_SECRET"
fi
systemctl daemon-reload
echo "проверка без отправки:  sudo -u hrh-ops python3 /opt/hrh-ops/hrh-ops-agent.py --dry-run"
echo "запуск:                 sudo systemctl enable --now hrh-ops-agent && journalctl -u hrh-ops-agent -f"
if command -v wg >/dev/null; then
  echo "WireGuard на хосте — сборщик VPN:  sudo systemctl enable --now hrh-ops-vpn  (проверка: sudo python3 /opt/hrh-ops/hrh-ops-vpnd.py --once)"
fi
