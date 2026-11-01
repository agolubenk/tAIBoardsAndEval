#!/usr/bin/env bash
# Зависимости git worktree: свой node_modules по lock и собранные пакеты.
# Два вида дерева: pnpm-workspace досок (`boards/` в доме слоя, `t-boards/app/` в инстансе-инкубаторе; другое место —
# env BOARDS_TREE) и npm-монорепо хоста (package-lock.json в корне). Гейт из папки досок проверяет установку досок,
# из остального дерева — установку npm-монорепо (если она есть).
#   wt-deps.sh install [DIR]  — npm ci + build:packages хоста, если есть package-lock.json; иначе pnpm install
#                               --frozen-lockfile в папке досок; затем check
#   wt-deps.sh check [DIR]    — без установки: 0 — свои и свежие, 1 — нет (причина и команда в stderr)
# DIR — любой путь внутри worktree. Основной checkout и дерево без обоих lock-файлов не трогает: check → 0,
# install → отказ.
# Без своего node_modules Node молча поднимается к node_modules основного checkout, и гейты врут
# (чужая сборка @hr-helper/*, другая версия TypeScript). Канон — .claude/rules/07-worktrees.md.
set -uo pipefail

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

# Корень linked worktree, в котором лежит $1; пусто — основной checkout или не git.
wt_root() {
  local d
  d="$(cd "$1" 2>/dev/null && pwd -P)" || return 0
  while [ "$d" != "/" ]; do
    if [ -e "$d/.git" ]; then
      [ -f "$d/.git" ] && echo "$d"
      return 0
    fi
    d="$(dirname "$d")"
  done
}

fail() {
  echo "wt-deps: $ROOT — $1" >&2
  echo "wt-deps: почини: $SELF install $ROOT" >&2
  exit 1
}

# Папка pnpm-workspace досок в worktree; пусто — досок нет.
boards_dir() {
  local c
  for c in "${BOARDS_TREE:-}" boards t-boards/app; do
    [ -n "$c" ] && [ -f "$ROOT/$c/pnpm-lock.yaml" ] && { echo "$ROOT/$c"; return 0; }
  done
}

boards_fail() {
  echo "wt-deps: $BOARDS — $1" >&2
  echo "wt-deps: почини: (cd $BOARDS && pnpm install --frozen-lockfile)" >&2
  exit 1
}

check_boards() {
  local nm="$BOARDS/node_modules"
  [ -L "$nm" ] && boards_fail "node_modules — ссылка на чужую установку ($(readlink "$nm"))"
  [ -d "$nm" ] || boards_fail "нет своего node_modules: Node возьмёт чужой выше по дереву или не найдёт модули"
  [ -f "$nm/.modules.yaml" ] || boards_fail "установка pnpm не завершена (нет node_modules/.modules.yaml)"
  [ "$BOARDS/pnpm-lock.yaml" -nt "$nm/.modules.yaml" ] &&
    boards_fail "pnpm-lock.yaml новее установки (pull или rebase сменил lock)"
  return 0
}

check() {
  local nm="$ROOT/node_modules" link target name
  if [ -n "$BOARDS" ]; then
    # Гейт из папки досок — проверяем установку досок; вне её — npm-монорепо хоста ниже (в доме слоя его нет).
    case "$TARGET/" in
      "$BOARDS/"*) check_boards; return $? ;;
    esac
  fi
  # Чужой репозиторий (pnpm и т.п.) — не наш npm-монорепо, проверять нечего.
  [ -f "$ROOT/package-lock.json" ] || return 0
  [ -L "$nm" ] && fail "node_modules — ссылка на чужую установку ($(readlink "$nm"))"
  [ -d "$nm" ] || fail "нет своего node_modules: Node возьмёт чужой выше по дереву (основного checkout) или не найдёт модули"
  [ -f "$nm/.package-lock.json" ] || fail "установка не завершена (упавший npm ci откатывает node_modules)"
  [ "$ROOT/package-lock.json" -nt "$nm/.package-lock.json" ] &&
    fail "package-lock.json новее установки (pull или rebase сменил lock)"
  [ -d "$nm/@hr-helper" ] || fail "нет ссылок на пакеты workspace (node_modules/@hr-helper)"
  for link in "$nm"/@hr-helper/*; do
    target="$(cd -P "$link" 2>/dev/null && pwd)"
    case "$target" in
      "$ROOT"/*) ;;
      *) fail "@hr-helper/$(basename "$link") ведёт вне worktree (${target:-битая ссылка})" ;;
    esac
  done
  # Не собранный пакет — не ложь, а явная ошибка резолва; turbo build/typecheck/test соберёт сам.
  for pkg in "$ROOT"/packages/*/package.json; do
    name="$(basename "$(dirname "$pkg")")"
    if grep -q '"main": *"\./dist/' "$pkg" && [ ! -d "$ROOT/packages/$name/dist" ]; then
      echo "wt-deps: packages/$name не собран — прямой vitest/tsc без turbo: npm run build:packages" >&2
    fi
  done
  return 0
}

install_boards() {
  local started rc
  [ -L "$BOARDS/node_modules" ] && rm "$BOARDS/node_modules"
  started=$(date +%s)
  echo "→ pnpm install --frozen-lockfile в $BOARDS (WT_DEPS=0 у make wt-add — пропустить)"
  (cd "$BOARDS" && pnpm install --frozen-lockfile)
  rc=$?
  [ "$rc" -eq 0 ] || { echo "wt-deps: pnpm install упал (код $rc), node_modules досок не готов" >&2; exit "$rc"; }
  TARGET="$BOARDS"
  check
  echo "→ зависимости готовы за $(( $(date +%s) - started )) с"
}

install() {
  local started rc
  if [ ! -f "$ROOT/package-lock.json" ]; then
    install_boards
    return $?
  fi
  [ -L "$ROOT/node_modules" ] && rm "$ROOT/node_modules"
  started=$(date +%s)
  echo "→ npm ci в $ROOT (≈ 2 ГБ; WT_DEPS=0 у make wt-add — пропустить)"
  # postinstall бэкенда (prisma generate) без DATABASE_URL падает, и npm ci откатывает весь node_modules.
  (cd "$ROOT" && DATABASE_URL="${DATABASE_URL:-postgresql://u:p@127.0.0.1:5432/db}" npm ci --no-audit --no-fund)
  rc=$?
  [ "$rc" -eq 0 ] || { echo "wt-deps: npm ci упал (код $rc), node_modules не готов" >&2; exit "$rc"; }
  (cd "$ROOT" && npm run build:packages)
  rc=$?
  [ "$rc" -eq 0 ] || { echo "wt-deps: build:packages упал (код $rc)" >&2; exit "$rc"; }
  check
  echo "→ зависимости готовы за $(( $(date +%s) - started )) с"
}

main() {
  ROOT="$(wt_root "${2:-.}")"
  TARGET="$(cd "${2:-.}" 2>/dev/null && pwd -P)"
  BOARDS=""
  [ -n "$ROOT" ] && BOARDS="$(boards_dir)"
  case "${1:-}" in
    check)
      [ -n "$ROOT" ] || return 0
      check ;;
    install)
      [ -n "$ROOT" ] || { echo "wt-deps: ${2:-.} — не linked worktree; основной checkout не переустанавливаю" >&2; return 2; }
      [ -f "$ROOT/package-lock.json" ] || [ -n "$BOARDS" ] ||
        { echo "wt-deps: $ROOT — нет ни package-lock.json, ни pnpm-lock.yaml досок; ставить нечего" >&2; return 2; }
      install ;;
    *)
      echo "usage: $(basename "$SELF") install|check [DIR]" >&2
      return 2 ;;
  esac
}

# Одной строкой: bash читает скрипт по ходу выполнения, а pull за 10 минут npm ci может его переписать.
main "$@"; exit $?
