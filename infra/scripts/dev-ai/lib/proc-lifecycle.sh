# shellcheck shell=bash
# Фоновые сервисы разработчика на macOS: запуск, отвязанный от терминала; остановка всем деревом;
# замок от двойного старта. Подключается через source (infra/scripts/dev-ai/mcp-hub.sh), своих
# команд не имеет. Только ps/pgrep/lsof базовой системы; bash 3.2 (системный) — без ассоциативных
# массивов. Зачем всё это — infra/mcp-hub/README.md, «Старт и стоп».
#
# Настройки — глобальные переменные вызывающего скрипта: STOP_WAIT — сколько секунд ждать выхода по
# TERM до KILL (по умолчанию 10), LOCK_WAIT — сколько секунд ждать чужой замок (300).

# ── процессы ────────────────────────────────────────────────────────────────────────────────

# lstart ps печатает в локали и часовом поясе того, кто спрашивает: «Wed Oct 21 10:40:44 2026» под C,
# «среда, 21 октября 2026 г. 10:40:44» под ru_RU, другой час под другим TZ. Владельца замка записывает
# один вызов, а сверяет другой (терминал владельца и агент), поэтому время старта — всегда в C и UTC.
ps_c() { LC_ALL=C TZ=UTC0 ps "$@"; }

# Время старта процесса — вместе с pid однозначно называет процесс: pid умершего переиспользуется.
proc_start() {
  local s
  s="$(ps_c -o lstart= -p "$1" 2>/dev/null)" || return 0
  # shellcheck disable=SC2086 # без кавычек намеренно: пробелы выравнивания ps схлопываются
  echo $s
}

proc_field() { ps -o "$2=" -p "$1" 2>/dev/null | tr -d ' ' || true; } # <pid> <pgid|ppid|tty|etime|stat>
proc_cmd() { ps -ww -o command= -p "$1" 2>/dev/null || true; }

# Жив и не зомби; со вторым аргументом — ещё и тот же самый процесс (время старта совпало).
proc_alive() {
  local stat
  stat="$(proc_field "$1" stat)"
  [ -n "$stat" ] || return 1
  case "$stat" in Z*) return 1 ;; esac
  [ -z "${2:-}" ] || [ "$(proc_start "$1")" = "$2" ]
}

proc_age() { # секунды с запуска; etime — [[дд-]чч:]мм:сс
  local t d=0 h=0 m=0 s=0 a b c
  t="$(proc_field "$1" etime)"
  [ -n "$t" ] || { echo 0; return 0; }
  case "$t" in *-*) d="${t%%-*}"; t="${t#*-}" ;; esac
  IFS=: read -r a b c <<<"$t"
  if [ -n "${c:-}" ]; then h="$a"; m="$b"; s="$c"; else m="$a"; s="${b:-0}"; fi
  echo $((10#$d * 86400 + 10#$h * 3600 + 10#$m * 60 + 10#$s))
}

descendants() { # все потомки, рекурсивно — по одному снимку ps, а не pgrep на каждый процесс
  ps -axo pid=,ppid= 2>/dev/null | awk -v root="$1" '
    { kids[$2] = kids[$2] " " $1 }
    END {
      n = split(kids[root], q, " ")
      for (h = 1; h <= n; h++) {
        print q[h]
        m = split(kids[q[h]], c, " ")
        for (i = 1; i <= m; i++) q[++n] = c[i]
      }
    }' || true
}

in_tree() { # <корень> <pid>: pid — сам корень или его потомок
  local root="$1" pid="$2" n=0
  while [ -n "$pid" ] && [ "$pid" -gt 1 ] && [ "$n" -lt 64 ]; do
    [ "$pid" = "$root" ] && return 0
    pid="$(proc_field "$pid" ppid)"
    n=$((n + 1))
  done
  return 1
}

group_members() { # живые (не зомби) процессы группы
  ps -axo pid=,pgid=,stat= 2>/dev/null | awk -v g="$1" '$2 == g && $3 !~ /^Z/ { print $1 }' || true
}

port_listener() { # pid, который слушает порт на TCP (первый, если их несколько)
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | sort -un | sed -n 1p || true
}

# ── остановка ───────────────────────────────────────────────────────────────────────────────
# Снимок дерева — строки «pid|время старта». Сигнал получает только тот же самый процесс: к моменту
# KILL pid умершего потомка мог достаться чужому. Живость всего снимка — одним вызовом ps (дерево
# хаба — десятки процессов, а Mac под нагрузкой).
snapshot_of() { # <pid…>; процессы, которых уже нет, в снимок не попадают
  local p rest
  [ "$#" -gt 0 ] || return 0
  ps_c -o pid=,lstart= -p "$(IFS=,; echo "$*")" 2>/dev/null | while read -r p rest; do
    # shellcheck disable=SC2086 # разбиение намеренно: пробелы выравнивания ps схлопываются
    set -- $rest
    printf '%s|%s\n' "$p" "$*"
  done || true
}

snapshot_alive() { # <снимок> → его строки, чьи процессы живы (не зомби) и всё те же
  local pids p st rest
  pids="$(printf '%s\n' "$1" | sed -n 's/^\([0-9][0-9]*\)|.*/\1/p' | paste -sd, -)"
  [ -n "$pids" ] || return 0
  ps_c -o pid=,stat=,lstart= -p "$pids" 2>/dev/null | while read -r p st rest; do
    case "$st" in Z*) continue ;; esac
    # shellcheck disable=SC2086
    set -- $rest
    printf '%s|%s\n' "$p" "$*"
  done | grep -Fx -- "$1" || true
}

signal_lines() { # <сигнал> <строки снимка>
  local p st
  while IFS='|' read -r p st; do
    if [ -n "$p" ]; then kill "-$1" "$p" 2>/dev/null || true; fi
  done <<<"$2"
}

tree_alive() { # <pid> <группа: 1|пусто> <снимок>
  if [ -n "$2" ] && [ -n "$(group_members "$1")" ]; then return 0; fi
  [ -n "$(snapshot_alive "$3")" ]
}

wait_tree_gone() { # <pid> <группа> <снимок> <секунд>: по часам, не по числу проверок
  local deadline
  deadline=$(($(date +%s) + $4))
  while tree_alive "$1" "$2" "$3"; do
    [ "$(date +%s)" -lt "$deadline" ] || return 1
    sleep 0.5
  done
}

# Гасит процесс со всем деревом: TERM → до STOP_WAIT с → KILL оставшимся. Лидер своей группы
# (запуск через spawn_detached) — сигнал ещё и всей группе: туда входят и потомки, успевшие
# осиротеть. Запущенный по-старому сидит в группе вызвавшего shell — там только снимок дерева,
# чтобы не задеть соседей по группе.
kill_tree() {
  local pid="$1" group="" snap
  if [ "$(proc_field "$pid" pgid)" = "$pid" ]; then group=1; fi
  # shellcheck disable=SC2046 # список pid потомков
  snap="$(snapshot_of "$pid" $(descendants "$pid"))"
  if [ -n "$group" ]; then kill -TERM -- "-$pid" 2>/dev/null || true; fi
  signal_lines TERM "$(snapshot_alive "$snap")"
  wait_tree_gone "$pid" "$group" "$snap" "${STOP_WAIT:-10}" && return 0
  if [ -n "$group" ]; then kill -KILL -- "-$pid" 2>/dev/null || true; fi
  signal_lines KILL "$(snapshot_alive "$snap")"
  wait_tree_gone "$pid" "$group" "$snap" 5 && return 0
  echo "⚠ pid $pid: часть дерева пережила KILL" >&2
  return 1
}

# ── запуск ──────────────────────────────────────────────────────────────────────────────────
# Своя сессия и группа: SIGHUP от закрытия терминала (конец задачи VS Code) сюда не доходит, даже
# если процесс ставит свой обработчик SIGHUP (так делает 1mcp — и nohup тогда не спасает).
# setsid(1) на macOS нет — делает python3; он же exec-ает команду, поэтому pid в SPAWNED_PID —
# сам сервис, и его PGID == PID (по этому kill_tree узнаёт, что можно гасить группу). Дескрипторы
# вызывающего с 3-го закрываются до exec: сервису они не нужны, а унаследованный пайп не дал бы
# читателю (npm, агент, `| tee`) дождаться EOF, пока сервис жив.
SPAWNED_PID=""
spawn_detached() { # <лог> <команда…>
  local log="$1"
  shift
  python3 -c 'import os, sys
for fd in os.listdir("/dev/fd"):
    if int(fd) > 2:
        try:
            os.close(int(fd))
        except OSError:
            pass
os.setsid()
os.execvp(sys.argv[1], sys.argv[1:])' "$@" </dev/null >>"$log" 2>&1 &
  SPAWNED_PID=$!
}

rotate_log() { # прошлый лог — в .prev: в нём причина, по которой упал прошлый запуск
  if [ -f "$1" ]; then mv -f "$1" "$1.prev"; fi
}

# ── замок от двойного старта ────────────────────────────────────────────────────────────────
# mkdir атомарен. Владелец — pid и время старта (ps_c: одинаково в любой локали и TZ): замок
# умершего (SIGKILL, перезагрузка) снимается, а не держит всех до таймаута. Каталог, а не flock:
# фоновые сервисы не наследуют дескриптор и не держат замок после выхода скрипта.
LOCK_DIR=""
LOCK_ME="" # «pid|время старта» владельца — этого вызова, пока замок у него
lock_owner() { cat "$LOCK_DIR/owner" 2>/dev/null || true; }

dir_age() { echo $(($(date +%s) - $(stat -f %m "$1" 2>/dev/null || date +%s))); }

lock_stale() { # <содержимое owner>
  if [ -z "$1" ]; then
    # каталог создан, владелец ещё не записан — протух, только если так висит долго
    [ "$(dir_age "$LOCK_DIR")" -gt 30 ]
    return
  fi
  ! proc_alive "${1%%|*}" "${1#*|}"
}

# Снять протухший замок <владелец>; код 0 — снят. Под вторым замком: иначе двое, одновременно увидев
# протухший замок, оба его снимут, и второй снесёт уже свежий замок первого.
lock_reap() {
  local rc=1
  if [ -d "$LOCK_DIR.reap" ] && [ "$(dir_age "$LOCK_DIR.reap")" -gt 30 ]; then rmdir "$LOCK_DIR.reap" 2>/dev/null || true; fi
  mkdir "$LOCK_DIR.reap" 2>/dev/null || return 1
  if [ "$(lock_owner)" = "$1" ] && rm -rf "$LOCK_DIR" 2>/dev/null && [ ! -d "$LOCK_DIR" ]; then
    echo "→ снят протухший замок ${1%%|*}"
    rc=0
  fi
  rmdir "$LOCK_DIR.reap" 2>/dev/null || true
  return "$rc"
}

lock_acquire() { # <каталог замка>
  local waited=0 owner who said="" wait="${LOCK_WAIT:-300}"
  LOCK_DIR="$1"
  mkdir -p "$(dirname "$LOCK_DIR")"
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    owner="$(lock_owner)"
    who="${owner%%|*}"
    [ -n "$who" ] || who="?" # каталог уже создан, владелец ещё не записан
    if lock_stale "$owner"; then
      lock_reap "$owner" && continue
      # не снялся (снимает другой вызов или нет прав) — ждём, как живой замок, с тем же таймаутом
    elif [ -z "$said" ]; then
      echo "→ сервисы уже запускает или останавливает другой вызов (pid $who) — жду до $wait с"
      said=1
    fi
    if [ "$waited" -ge "$wait" ]; then
      if lock_stale "$owner"; then
        echo "✗ замок $LOCK_DIR протух (pid $who не жив), но снять его не вышло — rm -rf $LOCK_DIR" >&2
      else
        echo "✗ замок $LOCK_DIR держится дольше $wait с (pid $who) — повторить позже" >&2
      fi
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  LOCK_ME="$$|$(proc_start $$)"
  printf '%s\n' "$LOCK_ME" >"$LOCK_DIR/owner"
}

# Снимает только свой замок: если его всё-таки сочли протухшим и забрали, чужой не трогаем.
lock_release() {
  [ -n "$LOCK_ME" ] || return 0
  if [ "$(lock_owner)" = "$LOCK_ME" ]; then rm -rf "$LOCK_DIR"; fi
  LOCK_ME=""
}
