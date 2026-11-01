#!/bin/bash
# Открыть новую сессию Claude Code в отдельном окне терминала: наследник по handoff или запуск роли Т3.
#
#   bash supertick-eval/tools/spawn_session.sh --handoff FILE [--role KEY]     наследник (порог 80%, хук context-threshold)
#   bash supertick-eval/tools/spawn_session.sh --launch --role KEY             запуск роли по её пусковому файлу
#   bash supertick-eval/tools/spawn_session.sh --launch --roles all|coord,release,…   несколько ролей, по порядку 1→5→4→3→2→6
#
# Опции: --cwd DIR (по умолчанию текущая папка: наследник открывается в том же worktree) · --terminal terminal|iterm|print (print — только напечатать
# команду для вкладки терминала VS Code) · --prompt-dir DIR (пусковые файлы ролей) · --dry-run (ничего не открывать).
# Роль Т3 получает свой геном (--settings genome/<ключ>.json) и первое сообщение «Сборка Т3, ключ реестра <ключ>…» —
# по нему включается правило 90 и Нерв узнаёт роль. Окно открывает osascript: первый раз macOS спросит разрешение
# на управление Terminal. Только bash 3.2 (системный на macOS): без ассоциативных массивов.
set -euo pipefail

TOOLS="$(cd "$(dirname "$0")" && pwd)"
CWD="$PWD"
TERMINAL="${SPAWN_TERMINAL:-terminal}"
PROMPT_DIR=""
HANDOFF="" ROLE="" ROLES="" LAUNCH=0 DRY=0
ORDER="coord release backend frontend plan boards"

die() { echo "spawn_session: $*" >&2; exit 2; }
sq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }  # строка в одинарных кавычках для bash

while [ $# -gt 0 ]; do
  case "$1" in
    --handoff) HANDOFF="${2:?}"; shift 2 ;;
    --role) ROLE="${2:?}"; shift 2 ;;
    --roles) ROLES="${2:?}"; shift 2 ;;
    --launch) LAUNCH=1; shift ;;
    --cwd) CWD="${2:?}"; shift 2 ;;
    --terminal) TERMINAL="${2:?}"; shift 2 ;;
    --prompt-dir) PROMPT_DIR="${2:?}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) die "неизвестный аргумент: $1" ;;
  esac
done

[ -d "$CWD" ] || die "нет папки $CWD"
CWD="$(cd "$CWD" && pwd)"
# Геномы и пусковые файлы — из рабочей папки, иначе из основного checkout (в свежем worktree их может не быть).
MAIN="$(git -C "$CWD" rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's#/\.git$##')" || MAIN=""
in_tree() { if [ -e "$CWD/$1" ] || [ -z "$MAIN" ]; then echo "$CWD/$1"; else echo "$MAIN/$1"; fi; }
PROMPT_DIR="${PROMPT_DIR:-$(in_tree supertick-eval/prompts/launch-3010/roles)}"
case "$TERMINAL" in terminal|iterm|print) ;; *) die "--terminal: terminal, iterm или print" ;; esac

role_num() {
  case "$1" in
    coord) echo 1 ;; plan) echo 2 ;; frontend) echo 3 ;; backend) echo 4 ;; release) echo 5 ;; boards) echo 6 ;;
    *) return 1 ;;
  esac
}

# Первое сообщение новой сессии → stdout.
first_message() {
  local role="$1" num file
  if [ -n "$HANDOFF" ]; then
    if [ -n "$role" ]; then
      num="$(role_num "$role")" || die "неизвестная роль: $role (coord plan frontend backend release boards)"
      printf 'Сборка Т3, ключ реестра %s, роль %s, наследник. Handoff: %s — прочитай его первым, сверь факты с живыми источниками (скилл successor-handoff) и действуй по нему. Предшественнику подтверди приём через SendMessage.' "$role" "$num" "$HANDOFF"
    else
      printf 'Наследник сессии. Handoff: %s — прочитай его первым, сверь факты с живыми источниками (скилл successor-handoff) и действуй по нему. Предшественнику подтверди приём через SendMessage.' "$HANDOFF"
    fi
    return
  fi
  num="$(role_num "$role")" || die "неизвестная роль: $role (coord plan frontend backend release boards)"
  file="$PROMPT_DIR/$num-$role.md"
  [ -f "$file" ] || die "нет пускового файла $file"
  printf 'Сборка Т3, ключ реестра %s, роль %s. Пусковой файл: %s — прочитай его первым и действуй по нему.' \
    "$role" "$num" "$file"
}

# Одна сессия: пусковой скрипт в $TMPDIR, затем окно терминала (или печать команды).
spawn_one() {
  local role="$1" msg genome="" dir launcher cmd stamp
  msg="$(first_message "$role")"
  if [ -n "$role" ]; then
    genome="$(in_tree "supertick-eval/pipeline/genome/$role.json")"
    [ -f "$genome" ] || die "нет генома $genome (build.py собирает его из roles.json)"
  fi
  # Своя папка 700 через mktemp: в общем /tmp предсказуемое имя дало бы чужому процессу подменить скрипт.
  dir="$(umask 077 && mktemp -d "${TMPDIR:-/tmp}/claude-spawn.XXXXXX")" || die "mktemp не создал папку"
  launcher="$dir/${role:-successor}.sh"
  # Текст — отдельным файлом: printf %q в bash 3.2 режет кириллицу по байтам.
  printf '%s' "$msg" > "$launcher.msg"
  {
    echo '#!/bin/bash'
    echo "cd $(sq "$CWD") || exit 1"
    # текст прочитан — папка больше не нужна: временные пусковые файлы не копятся
    echo "m=\"\$(cat $(sq "$launcher.msg"))\"; rm -rf $(sq "$dir")"
    if [ -n "$genome" ]; then
      echo "exec \"\${CLAUDE_BIN:-claude}\" --settings $(sq "$genome") \"\$m\""
    else
      echo "exec \"\${CLAUDE_BIN:-claude}\" \"\$m\""
    fi
  } > "$launcher"
  chmod 700 "$launcher"
  chmod 600 "$launcher.msg"
  cmd="/bin/bash $(sq "$launcher")"
  if [ "$TERMINAL" != print ] && [ "$DRY" = 0 ] && ! command -v osascript >/dev/null 2>&1; then
    echo "# osascript нет (Linux/SSH) — окно не открыть, команда ниже" >&2
    TERMINAL=print
  fi
  if [ "$TERMINAL" = print ] || [ "$DRY" = 1 ]; then
    echo "# ${role:-наследник}: вставить в новую вкладку терминала"
    echo "$cmd"
    if [ "$DRY" = 1 ]; then sed -n '2,$p' "$launcher"; cat "$launcher.msg"; echo; rm -rf "$dir"; fi
    return
  fi
  if [ "$TERMINAL" = iterm ]; then
    osascript -e "tell application \"iTerm\" to create window with default profile command \"$cmd\"" >/dev/null
  else
    osascript -e "tell application \"Terminal\" to do script \"$cmd\"" -e 'tell application "Terminal" to activate' >/dev/null
  fi
  echo "открыто: ${role:-наследник} → $launcher"
}

case "${TMPDIR:-}$CWD" in *\"*|*\\*) die "кавычка или обратный слэш в пути — osascript не примет" ;; esac

if [ -n "$HANDOFF" ]; then
  [ "$LAUNCH" = 0 ] && [ -z "$ROLES" ] || die "--handoff не сочетается с --launch/--roles"
  [ -f "$HANDOFF" ] || die "нет файла handoff: $HANDOFF"
  HANDOFF="$(cd "$(dirname "$HANDOFF")" && pwd)/$(basename "$HANDOFF")"
  spawn_one "$ROLE"
elif [ "$LAUNCH" = 1 ]; then
  if [ -n "$ROLES" ]; then
    [ "$ROLES" = all ] && ROLES="$ORDER"
    first=1
    for r in $(echo "$ROLES" | tr ',' ' '); do
      [ "$first" = 1 ] || [ "$TERMINAL" = print ] || [ "$DRY" = 1 ] || sleep 3  # окна не стартуют разом: MCP и индексация не толкаются
      first=0
      spawn_one "$r"
    done
  else
    [ -n "$ROLE" ] || die "--launch: нужен --role KEY или --roles LIST"
    spawn_one "$ROLE"
  fi
else
  die "нужен --handoff FILE или --launch (см. --help)"
fi
