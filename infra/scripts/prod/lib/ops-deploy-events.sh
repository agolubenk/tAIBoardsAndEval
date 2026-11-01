# shellcheck shell=bash
# События деплоя в Ops-консоль — живая карточка «Деплои»: фазы, длительности, проверки, rollback-prev, итог.
# Подключает contabo-deploy.sh во втором запуске (после exec, уже без DEPLOY_REF) и зовёт одну функцию:
#
#   ops_deploy_event <событие> [аргументы]
#
# Гарантии для деплоя (проверяет infra/scripts/prod/tests/contabo-deploy-sim.sh):
#   - ни строки в вывод: помощник ops-deploy-event.py зовётся с </dev/null >/dev/null 2>&1;
#   - коды возврата и порядок шагов прежние: функция всегда возвращает 0, вызов помощника — `|| true`, внутри —
#     только ${…:-} (у вызывающего set -u) и без массивов (bash 3.2 в харнессе на macOS);
#   - время: помощник под `timeout 5`, если команда есть, иначе — его собственный дедлайн 4 с; HTTP — 3 с;
#   - нет учётки агента (${OPS_AGENT_ENV_FILE:-/etc/hrh-ops-agent.env}), python3, помощника или git — событий нет,
#     вызовы пустые; секрет читает только помощник и не печатает.
# Сводка копится в памяти процесса и уходит целиком с каждым событием: консоль перезапускается на `up`, и
# потерянное событие карточку не портит. Итог (deploy_done с кодом выхода) шлёт trap EXIT — чужой trap EXIT не
# заменяется: если он уже стоит, итог не уходит (карточку закроет сверка с GitHub или «событий давно нет»).
#
# Строки сводки — формат --log помощника: «p <фаза> <статус> <unix> <код|->», «c <метка|-> <статус> <unix>
# <код|-> <адрес>», «r <сменились> <без rollback-prev> <pending не снят>».

# Повторное подключение состояние не сбрасывает.
: "${_ODE_INIT:=0}" "${_ODE_ON:=0}" "${_ODE_SEQ:=0}" "${_ODE_LOG:=}" "${_ODE_RUNNING:=}" "${_ODE_CHECK_URL:=}"
: "${_ODE_CHECKS_RC:=}" "${_ODE_TIMEOUT:=0}" "${_ODE_NOW:=0}" "${_ODE_LAST:=0}" "${_ODE_T0:=0}" "${_ODE_S0:=0}"
: "${_ODE_SHA:=}" "${_ODE_PY:=}" "${_ODE_HELPER:=}" "${_ODE_ENV:=}"
_ODE_NL='
'

# Пре-флайт прошёл, но с предупреждением (например, выключен необязательный короткий адрес очереди): фаза
# «preflight» в карточке деплоя консоли закроется статусом warn, а не ok.
ops_deploy_preflight_warn() {
  _ODE_PREFLIGHT_STATUS=warn
}

ops_deploy_event() {
  # Внутри `|| true`: сбой любой команды здесь не останавливает деплой (set -e вызывающего не действует).
  _ode_dispatch "$@" || true
  return 0
}

_ode_dispatch() {
  local event="${1:-}" st="" rc=""
  if [ "$event" = deploy_start ]; then
    _ode_init "${2:-}"
    return 0
  fi
  [ "$_ODE_ON" = 1 ] || return 0
  case "$event" in
    prepare)
      _ode_phase_end preflight "${_ODE_PREFLIGHT_STATUS:-ok}" 0
      _ode_phase_start prepare
      _ode_send prepare
      ;;
    build_start)
      _ode_phase_end prepare ok 0
      _ode_phase_start build
      _ode_send build_start
      ;;
    build_done)
      rc="$(_ode_code "${2:-}")"
      if [ "$rc" = 0 ]; then st=ok; else st=failed; fi
      _ode_phase_end build "$st" "$rc"
      _ode_send build_done
      ;;
    rollback_prev)
      # $2 — сервисов сменилось, $3 — без rollback-prev, $4 — с неснятым :rollback-pending.
      _ode_rec "r $(_ode_code "${2:-}") $(_ode_code "${3:-}") $(_ode_code "${4:-}")"
      if [ "${3:-0}" = 0 ] && [ "${4:-0}" = 0 ]; then st=ok; else st=warn; fi
      _ode_phase_end rollback_prev "$st" 0
      _ode_phase_start cleanup
      _ode_send rollback_prev
      ;;
    cleanup_done)
      _ode_phase_end cleanup ok 0
      ;;
    nginx_apply)
      rc="$(_ode_code "${2:-}")"
      if [ "$rc" = 0 ]; then st=ok; else st=failed; fi
      _ode_phase_end nginx "$st" "$rc"
      _ode_send nginx_apply
      ;;
    check)
      # $2 — метка проверки, $3 — адрес. Первая проверка открывает фазу.
      if [ "$_ODE_RUNNING" != checks ]; then _ode_phase_start checks; fi
      _ode_tick
      _ODE_CHECK_URL="${3:-}"
      _ode_rec "c ${2:--} running $_ODE_NOW - $_ODE_CHECK_URL"
      ;;
    check_done)
      # $2 — адрес, $3 — код проверки. Упавшая под set -e проверка сюда не доходит — её закроет trap EXIT.
      rc="$(_ode_code "${3:-}")"
      if [ "$rc" = 0 ]; then st=ok; else st=failed; fi
      if [ "$rc" != 0 ] && [ -z "$_ODE_CHECKS_RC" ]; then _ODE_CHECKS_RC="$rc"; fi
      _ode_tick
      _ode_rec "c - $st $_ODE_NOW $rc ${2:-}"
      _ODE_CHECK_URL=""
      ;;
    health_checks)
      if [ -z "$_ODE_CHECKS_RC" ]; then
        _ode_phase_end checks ok 0
      else
        _ode_phase_end checks failed "$_ODE_CHECKS_RC"
      fi
      _ode_send health_checks
      ;;
  esac
  return 0
}

_ode_init() {
  local root="${1:-}" env_file="${OPS_AGENT_ENV_FILE:-/etc/hrh-ops-agent.env}" py="" sha="" t0=""
  [ "$_ODE_INIT" = 0 ] || return 0
  _ODE_INIT=1
  [ -n "$root" ] && [ -r "$env_file" ] && [ -r "$root/infra/scripts/prod/ops-deploy-event.py" ] || return 0
  py="$(command -v python3 2>/dev/null)" || return 0
  sha="$(git -C "$root" rev-parse HEAD </dev/null 2>/dev/null)" || return 0
  t0="$(date +%s </dev/null 2>/dev/null)" || return 0
  case "$sha" in *[!0-9a-f]* | '') return 0 ;; esac
  case "$t0" in *[!0-9]* | '') return 0 ;; esac
  _ODE_PY="$py"
  _ODE_HELPER="$root/infra/scripts/prod/ops-deploy-event.py"
  _ODE_ENV="$env_file"
  _ODE_SHA="$sha"
  _ODE_T0="$t0"
  _ODE_S0="$SECONDS"
  _ODE_LAST="$t0"
  if command -v timeout >/dev/null 2>&1; then _ODE_TIMEOUT=1; fi
  _ODE_ON=1
  # Итог — из trap EXIT: деплой под set -e выходит где угодно (упавшая проверка, nginx 40, пре-флайт).
  if [ -z "$(trap -p EXIT)" ]; then trap '_ode_on_exit' EXIT; fi
  _ode_phase_start preflight
  _ode_send deploy_start
  return 0
}

_ode_on_exit() {
  local rc=$?
  # Сбой команды внутри обработчика под set -e сменил бы код выхода деплоя — здесь его нет.
  set +eu
  _ode_finish "$rc" || true
  return 0
}

_ode_finish() {
  local rc="${1:-1}" st=failed
  [ "$_ODE_ON" = 1 ] || return 0
  _ode_tick
  if [ "$rc" = 0 ]; then st=ok; fi
  if [ -n "$_ODE_CHECK_URL" ]; then
    _ode_rec "c - $st $_ODE_NOW $rc $_ODE_CHECK_URL"
    _ODE_CHECK_URL=""
  fi
  if [ -n "$_ODE_RUNNING" ]; then
    if [ "$rc" = 0 ]; then
      _ode_phase_end "$_ODE_RUNNING" ok 0
    else
      _ode_phase_end "$_ODE_RUNNING" failed "$rc"
    fi
  fi
  _ode_send deploy_done "$rc"
  _ODE_ON=0
  return 0
}

# Код выхода из аргумента: число или «-».
_ode_code() {
  case "${1:-}" in
    '' | *[!0-9]*) echo - ;;
    *) echo "$1" ;;
  esac
}

_ode_tick() {
  _ODE_NOW=$((_ODE_T0 + SECONDS - _ODE_S0))
}

_ode_rec() {
  _ODE_LOG="$_ODE_LOG$1$_ODE_NL"
}

_ode_phase_start() {
  _ode_tick
  _ode_rec "p $1 running $_ODE_NOW -"
  _ODE_RUNNING="$1"
  _ODE_LAST="$_ODE_NOW"
}

# Фаза без явного начала (rollback-prev, nginx) начинается там, где кончилась предыдущая.
_ode_phase_end() {
  _ode_tick
  if [ "$_ODE_RUNNING" != "$1" ]; then _ode_rec "p $1 running $_ODE_LAST -"; fi
  _ode_rec "p $1 $2 $_ODE_NOW ${3:--}"
  _ODE_RUNNING=""
  _ODE_LAST="$_ODE_NOW"
}

_ode_send() {
  local event="$1" rc="${2:-}"
  _ode_tick
  _ODE_SEQ=$((_ODE_SEQ + 1))
  set -- "$_ODE_PY" -I "$_ODE_HELPER" --env-file "$_ODE_ENV" --event "$event" --seq "$_ODE_SEQ" --sha "$_ODE_SHA" \
    --started "$_ODE_T0" --now "$_ODE_NOW" --log "$_ODE_LOG" ${rc:+--rc "$rc"}
  if [ "$_ODE_TIMEOUT" = 1 ]; then set -- timeout 5 "$@"; fi
  "$@" </dev/null >/dev/null 2>&1 || true
  return 0
}

# Последней строкой: contabo-deploy.sh ставит заглушку, если файл не догрузился.
_ODE_LOADED=1
