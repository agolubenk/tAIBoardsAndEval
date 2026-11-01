#!/usr/bin/env bash
# Подключение сервера к ЛОКАЛЬНОЙ консоли (пока она не на Vercel):
#   1) ставит агента на сервер (agent/install.sh) и кладёт env из data/<agent-id>.agent.env;
#   2) держит обратный SSH-туннель: на сервере 127.0.0.1:8797 → консоль на этом компьютере.
# Агент ходит в http://127.0.0.1:8797 на сервере — наружу ничего не открывается.
#
#   scripts/connect-agent.sh install <ssh-цель> [agent-id]   # один раз (нужен sudo на сервере)
#   scripts/connect-agent.sh tunnel  <ssh-цель>              # пока консоль локальная — держать запущенным
#   scripts/connect-agent.sh daemon  <ssh-цель>              # то же в фоне с переподключением (data/tunnel.pid)
#   scripts/connect-agent.sh stop                            # остановить фоновый туннель
#
# <ssh-цель> — как для ssh: root@1.2.3.4 или алиас из ~/.ssh/config.
set -euo pipefail

cmd="${1:-}"
target="${2:-}"
agent_id="${3:-contabo-prod}"
here="$(cd "$(dirname "$0")/.." && pwd)"
port="${OPS_PORT:-8797}"

if [[ "$cmd" == "stop" ]]; then
  pid_file="$here/data/tunnel.pid"
  if [[ -f "$pid_file" ]]; then
    pid="$(cat "$pid_file")"
    # Сначала цикл (иначе он поднимет ssh заново), затем его текущий ssh.
    children="$(pgrep -P "$pid" || true)"
    kill "$pid" 2>/dev/null || true
    [[ -n "$children" ]] && kill $children 2>/dev/null || true
    rm -f "$pid_file"
    echo "туннель остановлен"
  else
    echo "фоновый туннель не запущен"
  fi
  exit 0
fi
[[ -n "$cmd" && -n "$target" ]] || { sed -n '2,13p' "$0"; exit 1; }

case "$cmd" in
  install)
    env_file="$here/data/$agent_id.agent.env"
    [[ -f "$env_file" ]] || { echo "нет $env_file — создайте агента в «Настройки → Агенты»"; exit 1; }
    # Консоль локальная: агент на сервере ходит в неё через туннель на localhost.
    remote_env="$(sed -E "s#^OPS_CONSOLE_URL=.*#OPS_CONSOLE_URL=http://127.0.0.1:$port#" "$env_file")"
    tmp="/tmp/hrh-ops-agent-install"
    ssh "$target" "rm -rf $tmp && mkdir -p $tmp && chmod 700 $tmp"
    scp -q "$here/agent/hrh-ops-agent.py" "$here/agent/hrh_ops_collect.py" "$here/agent/hrh_ops_edge.py" "$here/agent/hrh_ops_vpn.py" \
      "$here/agent/hrh-ops-vpnd.py" "$here/agent/hrh-ops-agent.service" "$here/agent/hrh-ops-vpn.service" \
      "$here/agent/hrh-ops-agent.env.example" "$here/agent/install.sh" "$target:$tmp/"
    printf '%s\n' "$remote_env" | ssh "$target" "umask 077 && cat > $tmp/agent.env"
    ssh -t "$target" "cd $tmp && sudo ./install.sh && sudo install -m 600 -o root -g root agent.env /etc/hrh-ops-agent.env \
      && sudo systemctl enable --now hrh-ops-agent && sudo systemctl restart hrh-ops-agent && rm -rf $tmp \
      && sudo systemctl --no-pager --lines=5 status hrh-ops-agent"
    echo "агент установлен. Теперь держите туннель: $0 tunnel $target"
    ;;
  tunnel)
    echo "туннель: $target:127.0.0.1:$port → localhost:$port (Ctrl+C — закрыть; агент будет «молчать»)"
    exec ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
      -R "127.0.0.1:$port:127.0.0.1:$port" "$target"
    ;;
  daemon)
    mkdir -p "$here/data"
    # Ключ обязателен: в фоне пароль не спросить (BatchMode). Обрыв → новая попытка через 10 с.
    nohup bash -c "while true; do ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
      -o ServerAliveCountMax=3 -R 127.0.0.1:$port:127.0.0.1:$port '$target'; sleep 10; done" \
      >> "$here/data/tunnel.log" 2>&1 &
    echo $! > "$here/data/tunnel.pid"
    echo "туннель в фоне (pid $(cat "$here/data/tunnel.pid"), лог data/tunnel.log); остановить: $0 stop"
    ;;
  *)
    sed -n '2,13p' "$0"
    exit 1
    ;;
esac
