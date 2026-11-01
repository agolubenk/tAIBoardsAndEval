#!/usr/bin/env bash
# Тест жизненного цикла MCP-хаба (infra/scripts/dev-ai/mcp-hub.sh) — регрессия поломки 2026-10-21:
# хаб умирал с концом задачи VS Code (SIGHUP группе pty, а 1mcp своим обработчиком SIGHUP отменяет
# nohup), stop оставлял сирот serena, а «порт занят своей же сиротой» обрывал старт целиком.
#
#   bash infra/scripts/dev-ai/tests/mcp-hub-detach.test.sh      # ~2 мин
#   KEEP=1 bash infra/scripts/dev-ai/tests/mcp-hub-detach.test.sh   # не удалять временный каталог
#
# Проверяет:
#   а) под pty подставной node с обработчиком SIGHUP, как у 1mcp: запущенный через `nohup … &`
#      умирает при выходе shell, через spawn_detached из mcp-hub.sh — выживает (своя сессия, PGID == PID);
#   б) настоящий 1mcp (клон ~/.config/hr-helper-mcp-hub/runtime во временном каталоге) на свободном
#      порту, с временным конфигом и пустым mcpServers: start под pty → shell вышел → хаб жив и
#      отвечает, check зелёный; stop с другими портами эти pid-файлы не трогает; процессы, у которых
#      командная строка сервиса лишь в аргументах (цикл ожидания, монитор), не «свои»; stop гасит
#      группы без остатков, включая осиротевшего члена группы; два параллельных start → по одному
#      процессу, второй ждал замок;
#   в) сирота на нашем порту (serena и хаб без pid-файла) берётся под управление, лишняя копия
#      serena, не держащая порт, останавливается;
#   г) чужой процесс на порту serena — код 1 и понятная ошибка, хаб всё равно стартует, чужой цел;
#   д) serena, запущенная по-старому (в группе теста, не лидер группы), гасится по дереву вместе с
#      «LSP»-внуком из другой группы, сосед по группе теста жив;
#   е) протухший замок (владелец умер) снимается;
#   ж) сервис упал через секунду после старта — код 1 и хвост лога; жив, но отпустил порт — код 1, остановлен;
#   з) замок: владелец под ru_RU.UTF-8, второй вызов под C и другим TZ ждёт, а не снимает «протухший»;
#      чужой замок при выходе не удаляется;
#   и) в pid-файле serena удалённого worktree: start, check — код 1 с причиной, stop её гасит;
#   к) из связанного worktree start/restart/init отказывают (общие сервисы — из основной папки).
# Serena подставная (tests/fixtures): обёртка, как uv, + python, который игнорирует SIGTERM (настоящая
# на SIGTERM не выходила 10+ с), + «LSP»-внук в своей сессии. Боевые порты 3050/9121,
# ~/.config/hr-helper-mcp-hub и ~/Library/Logs/hr-helper-mcp-hub тест не трогает: всё — через
# MCP_HUB_CONFIG_DIR/MCP_HUB_RUNTIME_DIR/MCP_HUB_LOG_DIR/MCP_HUB_UVX и свободные порты (guard
# проверяет это перед каждым вызовом); в конце сверяет, что боевые процессы из pid-файлов живы.
#
# Только macOS (bash 3.2, script(1) из BSD). Код 0 — всё прошло; 1 — проверка упала (на первой же
# останавливается); 2 — нет окружения (python3, node, 1mcp-рантайм).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HUB_SH="$(cd "$HERE/.." && pwd)/mcp-hub.sh"
LIB="$(cd "$HERE/.." && pwd)/lib/proc-lifecycle.sh"
ROOT="$(cd "$HERE/../../../.." && pwd)"
LIVE_CONFIG="$HOME/.config/hr-helper-mcp-hub"
LIVE_RUNTIME="${MCP_HUB_TEST_RUNTIME:-$LIVE_CONFIG/runtime}"

for tool in python3 node script lsof curl pgrep; do
  command -v "$tool" >/dev/null 2>&1 || { echo "mcp-hub-detach: нет $tool в PATH" >&2; exit 2; }
done
if [ ! -x "$LIVE_RUNTIME/node_modules/.bin/1mcp" ]; then
  echo "mcp-hub-detach: нет 1mcp в $LIVE_RUNTIME (его ставит npm run mcp-hub:start)" >&2
  exit 2
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/mcp-hub-detach.XXXXXX")"
TMP="$(cd "$TMP" && pwd -P)"
SENTINEL=""

cleanup() {
  local pids
  pids="$(pgrep -f -- "$TMP" 2>/dev/null || true)"
  # shellcheck disable=SC2086 # список pid
  if [ -n "$pids" ]; then kill -KILL $pids 2>/dev/null || true; fi
  if [ -n "$SENTINEL" ]; then kill -KILL "$SENTINEL" 2>/dev/null || true; fi
  if [ -n "${KEEP:-}" ]; then echo "(каталог теста: $TMP)"; else rm -rf "$TMP"; fi
}
trap cleanup EXIT

# ── помощники ───────────────────────────────────────────────────────────────────────────────
step() { echo; echo "── $*"; }
ok() { echo "  ✓ $*"; }
fail() {
  local f
  echo "  ✗ $*" >&2
  for f in "$TMP"/*.out "$TMP"/logs/*.log; do
    if [ -f "$f" ]; then echo "  ── $f:" >&2; tail -n 25 "$f" | sed 's/^/     /' >&2; fi
  done
  exit 1
}
alive() {
  local s
  s="$(ps -o stat= -p "$1" 2>/dev/null)" || return 1
  case "$s" in "" | Z*) return 1 ;; esac
}
pgid_of() { ps -o pgid= -p "$1" 2>/dev/null | tr -d ' ' || true; }
ppid_of() { ps -o ppid= -p "$1" 2>/dev/null | tr -d ' ' || true; }
tty_of() { ps -o tty= -p "$1" 2>/dev/null | tr -d ' ' || true; }
listener() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | sort -un | sed -n 1p || true; }
count() { pgrep -f -- "$1" 2>/dev/null | wc -l | tr -d ' ' || true; }
group_alive() { ps -axo pgid=,stat= | awk -v g="$1" '$1 == g && $2 !~ /^Z/ { n++ } END { exit !n }'; }

wait_until() { # <секунд> <команда…>: ждать, пока команда не станет истинной
  local n=$(($1 * 4))
  shift
  while [ "$n" -gt 0 ]; do
    if "$@"; then return 0; fi
    sleep 0.25
    n=$((n - 1))
  done
  return 1
}
port_busy() { [ -n "$(listener "$1")" ]; }
dead() { ! alive "$1"; }

free_port() {
  python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
}

# Предохранитель: mcp-hub.sh из теста — только с временными каталогами и не на боевых портах.
guard() {
  case "${MCP_HUB_CONFIG_DIR:-}|${MCP_HUB_LOG_DIR:-}|${MCP_HUB_RUNTIME_DIR:-}" in
    "$TMP"/*"|$TMP"/*"|$TMP"/*) ;;
    *) echo "mcp-hub-detach: каталоги хаба не во временном $TMP — отказ" >&2; exit 2 ;;
  esac
  case " ${MCP_HUB_PORT:-3050} ${SERENA_HTTP_PORT:-9121} " in
    *" 3050 "* | *" 9121 "*) echo "mcp-hub-detach: боевой порт — отказ" >&2; exit 2 ;;
  esac
}

# Все процессы теста помечены каталогом $TMP в командной строке — по нему и чистим, и считаем.
HUB_PATTERN="1mcp serve --config $TMP/config/mcp.json"
WRAPPER_PATTERN="$TMP/bin/uvx"
CHILD_PATTERN="$TMP/bin/serena"
LSP_PATTERN="fake-lsp $TMP"
GORPHAN_PATTERN="fake-group-orphan $TMP"

none_running() { [ "$(count "$1")" = 0 ]; }
first_pid() { pgrep -f -- "$1" 2>/dev/null | sed -n 1p || true; }
lsp_running() { [ -n "$(first_pid "$LSP_PATTERN")" ]; }

assert_clean() { # после stop: ни одного процесса теста, порты свободны, pid-файлов и замка нет
  local what="$1" p
  for p in "$HUB_PATTERN" "$WRAPPER_PATTERN" "$CHILD_PATTERN" "$LSP_PATTERN" "$GORPHAN_PATTERN"; do
    wait_until 5 none_running "$p" || fail "$what: остался процесс «${p}»"
  done
  port_busy "$HUB_PORT" && fail "$what: :$HUB_PORT всё ещё слушается"
  port_busy "$SERENA_PORT" && fail "$what: :$SERENA_PORT всё ещё слушается"
  [ -z "$(ls "$TMP/config"/*.pid 2>/dev/null)" ] || fail "$what: остались pid-файлы: $(ls "$TMP/config"/*.pid)"
  [ ! -d "$TMP/config/lifecycle.lock" ] || fail "$what: остался замок"
  ok "$what: процессов теста нет, порты свободны, pid-файлов и замка нет"
}

# Фоном, но не задачей этого shell: родитель-подоболочка сразу выходит (ppid 1, как у сирот), группа —
# та же, что у теста; рабочий каталог — корень репо, как у запуска через npm.
spawn_bg() { # <лог> <команда…> → $BG_PID
  local log="$1"
  shift
  # cd — отдельной командой: `cd && cmd &` ушло бы в фон целым списком, через лишнюю подоболочку
  (cd "$ROOT" || exit 1
    "$@" </dev/null >"$log" 2>&1 &
    echo $! >"$TMP/bg.pid")
  BG_PID="$(cat "$TMP/bg.pid")"
}

run_hub() { # <имя вывода> <команда mcp-hub.sh…>: код возврата — в $RC, вывод — в $TMP/<имя>.out
  local name="$1"
  shift
  guard
  RC=0
  bash "$HUB_SH" "$@" >"$TMP/$name.out" 2>&1 || RC=$?
}

# ── окружение теста ─────────────────────────────────────────────────────────────────────────
HUB_PORT="$(free_port)"
SERENA_PORT="$(free_port)"
[ "$HUB_PORT" != "$SERENA_PORT" ] || { echo "порты совпали" >&2; exit 2; }
# Порты нестандартные — у скрипта свои pid-файлы: <сервис>-<порт>.pid.
SER_PIDF="$TMP/config/serena-$SERENA_PORT.pid"
HUB_PIDF="$TMP/config/hub-$HUB_PORT.pid"
serena_args() { # <проект> → $SARGS: те же аргументы, что у spawn_serena, — по ним скрипт узнаёт «свою»
  SARGS=(--from git+https://github.com/oraios/serena serena start-mcp-server --project "$1"
    --context claude-code --transport streamable-http --host 127.0.0.1 --port "$SERENA_PORT"
    --open-web-dashboard False)
}
serena_args "$ROOT"
SERENA_ARGS=("${SARGS[@]}")

mkdir -p "$TMP/bin" "$TMP/config" "$TMP/logs"
# Клон рантайма (APFS clonefile — секунда, места не занимает): start встраивает ссылки в админку
# 1mcp, и в боевом каталоге этого делать нельзя.
cp -Rc "$LIVE_RUNTIME" "$TMP/runtime" 2>/dev/null || { rm -rf "$TMP/runtime"; cp -R "$LIVE_RUNTIME" "$TMP/runtime"; }
printf '{\n  "mcpServers": {}\n}\n' >"$TMP/config/mcp.json"
cp "$HERE/fixtures/fake-uvx.sh" "$TMP/bin/uvx"
cp "$HERE/fixtures/fake-serena.py" "$TMP/bin/serena"
chmod +x "$TMP/bin/uvx" "$TMP/bin/serena"

# MCP_HUB_ALLOW_WORKTREE: тест обслуживает свою копию репо, даже если она — worktree (шаг к — без него).
export MCP_HUB_CONFIG_DIR="$TMP/config" MCP_HUB_RUNTIME_DIR="$TMP/runtime" MCP_HUB_LOG_DIR="$TMP/logs"
export MCP_HUB_UVX="$TMP/bin/uvx" MCP_HUB_PORT="$HUB_PORT" SERENA_HTTP_PORT="$SERENA_PORT" MCP_HUB_ALLOW_WORKTREE=1
export MCP_HUB_STOP_WAIT=3 MCP_HUB_LOCK_WAIT=120 GITHUB_PAT=test-dummy FAKE_MARK="$TMP" FAKE_SERENA_IGNORE_TERM=1
unset FAKE_SERENA_DIE_AFTER FAKE_SERENA_CLOSE_AFTER FAKE_SERENA_GROUP_ORPHAN || true
guard

# Боевые процессы до теста — в конце они должны быть на месте.
LIVE_BEFORE=""
for f in "$LIVE_CONFIG/hub.pid" "$LIVE_CONFIG/serena.pid"; do
  if [ -f "$f" ] && p="$(tr -cd '0-9' <"$f")" && [ -n "$p" ] && alive "$p"; then LIVE_BEFORE="$LIVE_BEFORE $p"; fi
done

echo "mcp-hub-detach: каталог $TMP · хаб :$HUB_PORT · serena :$SERENA_PORT · боевые до теста:${LIVE_BEFORE:- нет}"

# ── а) pty и SIGHUP ─────────────────────────────────────────────────────────────────────────
step "а) pty: shell вышел → SIGHUP группе переднего плана (подставной node с обработчиком SIGHUP, как у 1mcp)"
JS="process.on('SIGHUP', () => { console.log('SIGHUP'); process.exit(0) }); setInterval(() => {}, 1000) // $TMP"
script -q /dev/null bash -c 'nohup node -e "$1" >"$2/a-old.log" 2>&1 & echo $! >"$2/a-old.pid"; sleep 1' \
  _ "$JS" "$TMP" </dev/null >/dev/null 2>&1
script -q /dev/null bash -c 'source "$1"; spawn_detached "$2/a-new.log" node -e "$3"; echo "$SPAWNED_PID" >"$2/a-new.pid"; sleep 1' \
  _ "$HUB_SH" "$TMP" "$JS" </dev/null >/dev/null 2>&1
OLD="$(cat "$TMP/a-old.pid")"
NEW="$(cat "$TMP/a-new.pid")"
wait_until 5 dead "$OLD" || fail "старый способ (nohup &): node pid $OLD пережил выход shell — проверка не воспроизводит поломку"
grep -q SIGHUP "$TMP/a-old.log" || fail "старый способ: node умер не от SIGHUP: $(cat "$TMP/a-old.log")"
ok "nohup &: node получил SIGHUP и умер вместе с shell (так умирал хаб)"
sleep 1
alive "$NEW" || fail "spawn_detached: node pid $NEW умер после выхода shell: $(cat "$TMP/a-new.log")"
[ "$(pgid_of "$NEW")" = "$NEW" ] || fail "spawn_detached: PGID $(pgid_of "$NEW") != PID $NEW"
[ "$(tty_of "$NEW")" = "??" ] || fail "spawn_detached: процесс привязан к терминалу $(tty_of "$NEW")"
grep -q SIGHUP "$TMP/a-new.log" && fail "spawn_detached: SIGHUP всё-таки дошёл"
ok "spawn_detached: node жив, своя сессия (PGID == PID $NEW, без терминала), SIGHUP не дошёл"
kill -KILL -- "-$NEW" 2>/dev/null || true

# ── б) настоящий 1mcp ───────────────────────────────────────────────────────────────────────
step "б) start под pty (настоящий 1mcp, подставная serena) → shell вышел → оба живы; «наблюдатели» не тронуты"
# «Наблюдатели»: в аргументах — полная командная строка serena/хаба, но сами они bash и python -c.
# Цикл, а не один sleep: одиночную команду bash -c exec-ает, и командная строка стала бы «sleep 600».
spawn_bg /dev/null bash -c 'while :; do sleep 1; done' _ "${SERENA_ARGS[@]}" "$TMP"
W_BASH="$BG_PID"
spawn_bg /dev/null python3 -c 'import time; time.sleep(600)' "${SERENA_ARGS[@]}" "$TMP"
W_PY="$BG_PID"
spawn_bg /dev/null bash -c 'while :; do sleep 1; done' _ 1mcp serve --host 127.0.0.1 --config "$TMP/config/mcp.json" \
  --port "$HUB_PORT" "$TMP"
W_HUB="$BG_PID"
guard
FAKE_SERENA_GROUP_ORPHAN=1 script -q /dev/null bash -c 'bash "$1" start >"$2/b-start.out" 2>&1; echo $? >"$2/b-start.rc"' \
  _ "$HUB_SH" "$TMP" </dev/null >/dev/null 2>&1
[ "$(cat "$TMP/b-start.rc")" = 0 ] || fail "start под pty: код $(cat "$TMP/b-start.rc")"
sleep 2 # SIGHUP уже разослан при выходе shell — даём ему дойти
HUB="$(cat "$HUB_PIDF")"
SER="$(cat "$SER_PIDF")"
alive "$HUB" || fail "хаб pid $HUB умер после выхода shell"
[ "$(pgid_of "$HUB")" = "$HUB" ] || fail "хаб: PGID $(pgid_of "$HUB") != PID $HUB"
[ "$(tty_of "$HUB")" = "??" ] || fail "хаб привязан к терминалу $(tty_of "$HUB")"
[ "$(listener "$HUB_PORT")" = "$HUB" ] || fail "хаб: :$HUB_PORT слушает не он ($(listener "$HUB_PORT"))"
curl -fsS --max-time 5 "http://127.0.0.1:$HUB_PORT/health/mcp" >"$TMP/b-health.json" || fail "хаб не отвечает на /health/mcp"
ok "хаб (настоящий 1mcp) пережил выход shell: pid $HUB, PGID == PID, без терминала, /health/mcp отвечает"
alive "$SER" || fail "serena pid $SER умерла после выхода shell"
[ "$(pgid_of "$SER")" = "$SER" ] || fail "serena: PGID $(pgid_of "$SER") != PID $SER"
SER_CHILD="$(listener "$SERENA_PORT")"
[ "$(ppid_of "$SER_CHILD")" = "$SER" ] || fail "serena: :$SERENA_PORT слушает не её ребёнок ($SER_CHILD)"
[ "$(pgid_of "$SER_CHILD")" = "$SER" ] || fail "serena: python-ребёнок не в её группе"
ok "serena пережила выход shell: обёртка $SER (лидер группы), python $SER_CHILD держит :$SERENA_PORT"
run_hub b-check check
[ "$RC" = 0 ] || fail "check после старта: код $RC"
ok "mcp-hub.sh check — код 0"
run_hub b-status status
grep -q "✓ serena: pid $SER" "$TMP/b-status.out" || fail "status не показывает serena"
grep -q "✓ hub: pid $HUB" "$TMP/b-status.out" || fail "status не показывает хаб"
grep -q "привязан к терминалу" "$TMP/b-status.out" && fail "status: процесс привязан к терминалу"
grep -qE "лишняя копия|без pid-файла" "$TMP/b-status.out" && fail "status принял «наблюдателя» за копию сервиса"
ok "status: оба ✓, предупреждений о терминале и лишних копиях нет"
MCP_HUB_PORT="$(free_port)" SERENA_HTTP_PORT="$(free_port)" run_hub b-stop-other stop
[ "$RC" = 0 ] || fail "stop с другими портами: код $RC"
alive "$HUB" && alive "$SER" || fail "stop с другими портами остановил эти сервисы"
[ "$(cat "$HUB_PIDF" 2>/dev/null)" = "$HUB" ] && [ "$(cat "$SER_PIDF" 2>/dev/null)" = "$SER" ] \
  || fail "stop с другими портами тронул pid-файлы этих сервисов"
ok "stop с другими портами (тот же каталог конфига): эти сервисы и их pid-файлы целы"

step "б) stop гасит группы целиком (python serena игнорирует SIGTERM — добивается KILL)"
LSP="$(first_pid "$LSP_PATTERN")"
[ -n "$LSP" ] && [ "$(pgid_of "$LSP")" = "$LSP" ] || fail "«LSP»-внук не найден в своей группе"
GO="$(first_pid "$GORPHAN_PATTERN")"
[ -n "$GO" ] && [ "$(pgid_of "$GO")" = "$SER" ] && [ "$(ppid_of "$GO")" = 1 ] \
  || fail "осиротевший член группы serena не найден (pid ${GO:-—}, pgid $(pgid_of "${GO:-0}"), ppid $(ppid_of "${GO:-0}"))"
run_hub b-stop stop
[ "$RC" = 0 ] || fail "stop: код $RC"
for p in "$HUB" "$SER" "$SER_CHILD" "$LSP" "$GO"; do alive "$p" && fail "stop: pid $p жив"; done
group_alive "$HUB" && fail "stop: в группе хаба $HUB остались процессы"
group_alive "$SER" && fail "stop: в группе serena $SER остались процессы"
for p in "$W_BASH" "$W_PY" "$W_HUB"; do alive "$p" || fail "start/stop убили «наблюдателя» pid $p"; done
kill -KILL "$W_BASH" "$W_PY" "$W_HUB" 2>/dev/null || true
ok "хаб, обёртка, python (TERM игнорировал), «LSP» из другой группы и осиротевший член группы $GO остановлены; «наблюдатели» живы"
assert_clean "stop"

step "б) два параллельных start (два окна VS Code) → один хаб и одна serena"
guard
bash "$HUB_SH" start >"$TMP/b-par1.out" 2>&1 &
P1=$!
bash "$HUB_SH" start >"$TMP/b-par2.out" 2>&1 &
P2=$!
RC1=0
RC2=0
wait "$P1" || RC1=$?
wait "$P2" || RC2=$?
[ "$RC1" = 0 ] && [ "$RC2" = 0 ] || fail "параллельный start: коды $RC1 и $RC2"
[ "$(count "$HUB_PATTERN")" = 1 ] || fail "параллельный start: хабов $(count "$HUB_PATTERN"), нужен 1"
[ "$(count "$WRAPPER_PATTERN")" = 1 ] || fail "параллельный start: обёрток serena $(count "$WRAPPER_PATTERN"), нужна 1"
[ "$(count "$CHILD_PATTERN")" = 1 ] || fail "параллельный start: python serena $(count "$CHILD_PATTERN"), нужен 1"
# Не `cat … | grep -q`: под pipefail grep, нашедший строку в первом файле, выходит раньше, чем cat допишет
# второй, — SIGPIPE (141) и ложное «никто не ждал».
grep -q "другой вызов" "$TMP/b-par1.out" "$TMP/b-par2.out" || fail "параллельный start: никто не ждал замок"
[ ! -d "$TMP/config/lifecycle.lock" ] || fail "параллельный start: замок не снят"
ok "по одному процессу; второй вызов ждал замок; замок снят"
run_hub b-stop2 stop
[ "$RC" = 0 ] || fail "stop: код $RC"
assert_clean "stop после параллельного старта"

# ── в) сироты ───────────────────────────────────────────────────────────────────────────────
step "в) сирота на порту → под управление; лишняя копия serena → остановлена"
spawn_orphan() { # <лог> <команда…>: своя сессия, ppid 1, pid-файла нет — как процесс, переживший старый stop
  local log="$1"
  shift
  spawn_bg "$log" python3 -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' "$@"
  ORPHAN="$BG_PID"
}
spawn_orphan "$TMP/logs/c-serena.log" "$TMP/bin/uvx" "${SERENA_ARGS[@]}"
C_SER="$ORPHAN"
wait_until 10 port_busy "$SERENA_PORT" || fail "сирота serena не открыла порт"
spawn_orphan "$TMP/logs/c-extra.log" "$TMP/bin/uvx" "${SERENA_ARGS[@]}"
C_EXTRA="$ORPHAN"
wait_until 10 grep -q "не открыть" "$TMP/logs/c-extra.log" || fail "лишняя копия serena не дошла до попытки занять порт"
spawn_orphan "$TMP/logs/c-hub.log" "$TMP/runtime/node_modules/.bin/1mcp" serve --config "$TMP/config/mcp.json" \
  --transport http --host 127.0.0.1 --port "$HUB_PORT" --enable-async-loading --async-background-retry \
  --health-info-level basic --log-level info
C_HUB="$ORPHAN"
wait_until 30 port_busy "$HUB_PORT" || fail "сирота-хаб не открыл порт"
run_hub c-start start
[ "$RC" = 0 ] || fail "start при сиротах: код $RC"
[ "$(cat "$SER_PIDF")" = "$C_SER" ] || fail "pid-файл serena: $(cat "$SER_PIDF"), а держит порт $C_SER"
[ "$(cat "$HUB_PIDF")" = "$C_HUB" ] || fail "pid-файл хаба: $(cat "$HUB_PIDF"), а держит порт $C_HUB"
grep -q "беру под управление" "$TMP/c-start.out" || fail "start не сказал, что усыновил сироту"
wait_until 5 dead "$C_EXTRA" || fail "лишняя копия serena pid $C_EXTRA жива"
[ "$(count "$WRAPPER_PATTERN")" = 1 ] || fail "обёрток serena $(count "$WRAPPER_PATTERN"), нужна 1"
[ "$(count "$CHILD_PATTERN")" = 1 ] || fail "python serena $(count "$CHILD_PATTERN"), нужен 1"
[ "$(count "$HUB_PATTERN")" = 1 ] || fail "хабов $(count "$HUB_PATTERN"), нужен 1"
ok "serena $C_SER и хаб $C_HUB усыновлены, новых не запущено; лишняя serena $C_EXTRA остановлена"
run_hub c-stop stop
[ "$RC" = 0 ] || fail "stop: код $RC"
assert_clean "stop усыновлённых"

# ── г) чужой процесс на порту ───────────────────────────────────────────────────────────────
step "г) чужой процесс на :serena — понятная ошибка, хаб всё равно стартует, чужой цел"
spawn_bg "$TMP/logs/d-foreign.log" python3 -m http.server "$SERENA_PORT" --bind 127.0.0.1 --directory "$TMP"
FOREIGN="$BG_PID"
wait_until 10 port_busy "$SERENA_PORT" || fail "чужой процесс не открыл порт"
run_hub d-start start
[ "$RC" = 1 ] || fail "start при чужом порте: код $RC, нужен 1"
grep -q "занят чужим процессом — pid $FOREIGN" "$TMP/d-start.out" || fail "нет понятной ошибки про чужой процесс"
grep -q "занят чужим процессом (pid ${FOREIGN})" "$TMP/d-start.out" || fail "status не показал, кто держит порт"
D_HUB="$(cat "$HUB_PIDF" 2>/dev/null || true)"
[ -n "$D_HUB" ] && alive "$D_HUB" && [ "$(listener "$HUB_PORT")" = "$D_HUB" ] || fail "хаб не стартовал после сбоя serena"
alive "$FOREIGN" || fail "чужой процесс убит"
ok "код 1, «:$SERENA_PORT занят чужим процессом — pid ${FOREIGN}», хаб $D_HUB поднят, чужой жив"
run_hub d-stop stop
alive "$FOREIGN" || fail "stop убил чужой процесс"
grep -q "держит не процесс этого сервиса (pid $FOREIGN)" "$TMP/d-stop.out" || fail "stop не сказал, что порт держит чужой"
kill -KILL "$FOREIGN" 2>/dev/null || true
wait_until 5 dead "$FOREIGN" || fail "не удалось убрать чужой процесс теста"
assert_clean "stop при чужом процессе (чужой не тронут)"

# ── д) запуск по-старому ────────────────────────────────────────────────────────────────────
step "д) serena, запущенная по-старому (в группе теста) — гасится по дереву, соседи по группе целы"
spawn_bg /dev/null sleep 300
SENTINEL="$BG_PID"
spawn_bg "$TMP/logs/e-legacy.log" "$TMP/bin/uvx" "${SERENA_ARGS[@]}"
LEG="$BG_PID"
echo "$LEG" >"$SER_PIDF"
wait_until 10 port_busy "$SERENA_PORT" || fail "serena по-старому не открыла порт"
[ "$(pgid_of "$LEG")" != "$LEG" ] || fail "предусловие: serena по-старому оказалась лидером группы"
[ "$(pgid_of "$LEG")" = "$(pgid_of "$SENTINEL")" ] || fail "предусловие: сосед не в той же группе"
LEG_CHILD="$(listener "$SERENA_PORT")"
wait_until 5 lsp_running || fail "«LSP»-внук не стартовал"
LEG_LSP="$(first_pid "$LSP_PATTERN")"
run_hub e-stop stop
[ "$RC" = 0 ] || fail "stop: код $RC"
for p in "$LEG" "$LEG_CHILD" "$LEG_LSP"; do alive "$p" && fail "stop по-старому: pid $p жив"; done
alive "$SENTINEL" || fail "stop убил соседа по группе теста"
ok "обёртка $LEG, python $LEG_CHILD и «LSP» $LEG_LSP остановлены; сосед по группе $SENTINEL жив"
kill -KILL "$SENTINEL" 2>/dev/null || true
SENTINEL=""
assert_clean "stop по-старому"

# ── е) протухший замок ──────────────────────────────────────────────────────────────────────
step "е) протухший замок (владелец умер) снимается"
mkdir "$TMP/config/lifecycle.lock"
echo "99999999|Thu Jan 1 00:00:00 1970" >"$TMP/config/lifecycle.lock/owner"
run_hub f-stop stop
[ "$RC" = 0 ] || fail "stop с протухшим замком: код $RC"
grep -q "снят протухший замок" "$TMP/f-stop.out" || fail "замок не снят"
[ ! -d "$TMP/config/lifecycle.lock" ] || fail "замок остался"
ok "замок умершего снят, команда выполнена"

# ── ж) упал или отпустил порт после старта ──────────────────────────────────────────────────
step "ж) serena упала через секунду после старта → код 1 и хвост её лога"
# Без «LSP»: глухой ко всему внук упавшей serena — артефакт подставки (настоящий LSP выходит по EOF
# на stdin, когда родитель умер), а не то, что здесь проверяется.
FAKE_SERENA_DIE_AFTER=1 FAKE_SERENA_NO_LSP=1 run_hub g-start start
[ "$RC" = 1 ] || fail "start с падающей serena: код $RC, нужен 1"
grep -q "упал после старта" "$TMP/g-start.out" || fail "нет сообщения о падении"
grep -q "fake serena: падаю" "$TMP/g-start.out" || fail "нет хвоста лога serena"
G_HUB="$(cat "$HUB_PIDF" 2>/dev/null || true)"
[ -n "$G_HUB" ] && alive "$G_HUB" || fail "хаб не стартовал после падения serena"
ok "код 1, «упал после старта» и хвост лога; хаб $G_HUB поднят"
step "ж) serena жива, но через 4 с закрыла порт → код 1, «перестал слушать», процесс остановлен"
# Окно «порт открыт» — 4 с, перепроверка — через 8 с после того, как start увидел порт: под нагрузкой
# (load average 20+) один круг ожидания (ps + lsof) идёт дольше секунды, и узкое окно он пропускал.
MCP_HUB_SETTLE_WAIT=8 FAKE_SERENA_CLOSE_AFTER=4 FAKE_SERENA_NO_LSP=1 run_hub g-start2 start
[ "$RC" = 1 ] || fail "start с serena, отпустившей порт: код $RC, нужен 1"
grep -q "перестал слушать :$SERENA_PORT" "$TMP/g-start2.out" || fail "нет сообщения «перестал слушать»"
grep -q "fake serena: порт закрыт" "$TMP/g-start2.out" || fail "нет хвоста лога serena"
wait_until 5 none_running "$CHILD_PATTERN" || fail "serena, отпустившая порт, оставлена жить без управления"
[ ! -f "$SER_PIDF" ] || fail "pid-файл serena остался"
ok "код 1, «перестал слушать» и хвост лога; процесс остановлен, pid-файла нет"
run_hub g-stop stop
assert_clean "stop после падения"

# ── з) замок и локаль ───────────────────────────────────────────────────────────────────────
step "з) замок: владелец под ru_RU.UTF-8, второй вызов под C и другим TZ — ждёт, а не снимает «протухший»"
LOCK="$TMP/config/lifecycle.lock"
LC_ALL=ru_RU.UTF-8 LANG=ru_RU.UTF-8 TZ=Europe/Moscow bash -c 'source "$1"; lock_acquire "$2"; sleep 4; lock_release' \
  _ "$LIB" "$LOCK" >"$TMP/h-owner.out" 2>&1 &
H_OWNER=$!
wait_until 5 test -s "$LOCK/owner" || fail "владелец под ru_RU не взял замок"
LC_ALL=C grep -q '[^ -~]' "$LOCK/owner" && fail "время старта владельца записано не в C: $(cat "$LOCK/owner")"
LC_ALL=C LANG=C.UTF-8 TZ=Asia/Tokyo run_hub h-stop stop
wait "$H_OWNER" || fail "владелец замка завершился с ошибкой: $(cat "$TMP/h-owner.out")"
[ "$RC" = 0 ] || fail "stop под C: код $RC"
grep -q "протухший" "$TMP/h-stop.out" && fail "второй вызов снял замок живого владельца (другая локаль/TZ)"
grep -q "другой вызов" "$TMP/h-stop.out" || fail "второй вызов не ждал замок"
[ ! -d "$LOCK" ] || fail "замок остался после обоих"
ok "владелец под ru_RU и TZ Москвы, второй под C и TZ Токио: второй ждал, замок снят владельцем"
bash -c 'source "$1"; lock_acquire "$2"; printf "%s|%s\n" "$3" "$(proc_start "$3")" >"$2/owner"; lock_release; [ -d "$2" ]' \
  _ "$LIB" "$LOCK" "$$" || fail "lock_release удалил замок, который уже принадлежит другому"
rm -rf "$LOCK"
ok "чужой замок (владелец сменился) при выходе не удаляется"

# ── и) serena другой копии ──────────────────────────────────────────────────────────────────
step "и) в pid-файле serena удалённого worktree → start и check: код 1 с причиной; stop её гасит"
GONE="$TMP/worktrees/removed"
serena_args "$GONE"
spawn_orphan "$TMP/logs/i-serena.log" "$TMP/bin/uvx" "${SARGS[@]}"
I_SER="$ORPHAN"
echo "$I_SER" >"$SER_PIDF"
wait_until 10 port_busy "$SERENA_PORT" || fail "serena удалённого worktree не открыла порт"
run_hub i-start start
[ "$RC" = 1 ] || fail "start при serena чужой копии: код $RC, нужен 1"
grep -q "индексирует $GONE, а не $ROOT (этого каталога уже нет)" "$TMP/i-start.out" || fail "start не назвал причину"
run_hub i-check check
[ "$RC" = 1 ] || fail "check при serena чужой копии: код $RC, нужен 1"
grep -q "✗ serena: pid $I_SER индексирует $GONE" "$TMP/i-check.out" || fail "check не назвал причину"
alive "$I_SER" || fail "start молча убил serena чужой копии"
ok "start и check — код 1: «индексирует $GONE, а не <этот репо> (этого каталога уже нет)»; молча не убита"
run_hub i-stop stop
[ "$RC" = 0 ] || fail "stop: код $RC"
assert_clean "stop serena чужой копии (по pid-файлу)"

# ── к) worktree ─────────────────────────────────────────────────────────────────────────────
step "к) из связанного worktree start/restart/init отказывают: общие сервисы — из основной папки"
FAKE_WT="$TMP/wt"
mkdir -p "$TMP/main/.git/worktrees/wt" "$FAKE_WT/infra/scripts/dev-ai"
cp -R "$(dirname "$HUB_SH")/mcp-hub.sh" "$(dirname "$HUB_SH")/lib" "$FAKE_WT/infra/scripts/dev-ai/"
echo "gitdir: $TMP/main/.git/worktrees/wt" >"$FAKE_WT/.git"
guard
for c in start restart init; do
  RC=0
  env -u MCP_HUB_ALLOW_WORKTREE bash "$FAKE_WT/infra/scripts/dev-ai/mcp-hub.sh" "$c" >"$TMP/k-$c.out" 2>&1 || RC=$?
  [ "$RC" = 1 ] || fail "$c из worktree: код $RC, нужен 1"
  grep -q "(cd $TMP/main && npm run mcp-hub:$c)" "$TMP/k-$c.out" || fail "$c из worktree: нет подсказки про основную папку"
done
none_running "$FAKE_WT" && ! port_busy "$SERENA_PORT" && ! port_busy "$HUB_PORT" || fail "из worktree что-то запустилось"
env -u MCP_HUB_ALLOW_WORKTREE bash "$FAKE_WT/infra/scripts/dev-ai/mcp-hub.sh" status >"$TMP/k-status.out" 2>&1 || true
grep -q "обслуживают основную папку $TMP/main" "$TMP/k-status.out" || fail "status из worktree не сказал, какую папку обслуживают"
ok "start, restart и init из worktree — код 1 и «(cd <основная> && npm run mcp-hub:…)»; ничего не запущено"

# ── боевые не тронуты ───────────────────────────────────────────────────────────────────────
step "боевые процессы на месте"
for p in $LIVE_BEFORE; do alive "$p" || fail "боевой процесс pid $p пропал во время теста"; done
ok "боевые pid-файлы:${LIVE_BEFORE:- (не было живых)} — живы, как до теста"

echo
echo "mcp-hub-detach: все проверки пройдены"
