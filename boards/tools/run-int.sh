#!/bin/zsh
# Runs t-boards API integration tests against <POSTGRES_DB>_test without
# printing the password: DATABASE_URL lives only in this process's env.
# Usage: zsh boards/tools/run-int.sh [<filter> ...] (vitest file filters,
# relative to apps/api). No args = the whole suite.
# T_BOARDS_APP picks the checkout (default: the boards/ workspace next to this
# script; a worktree reuses the default checkout's .env when it has none).
# Every checkout shares one test database, so runs take a lock and go one at a time
# (lockf on macOS, flock on Linux).
set -e
setopt pipefail
root="${0:A:h:h}"
app="${T_BOARDS_APP:-$root}"
if [[ -z "$T_BOARDS_INT_LOCKED" ]]; then
  echo "run-int: waiting for the test database lock" >&2
  if command -v lockf >/dev/null; then
    T_BOARDS_INT_LOCKED=1 exec lockf -t 3600 /tmp/t-boards-int.lock zsh "$0" "$@"
  else
    T_BOARDS_INT_LOCKED=1 exec flock -w 3600 /tmp/t-boards-int.lock zsh "$0" "$@"
  fi
fi
env_file="$app/.env"
[[ -f "$env_file" ]] || env_file="$root/.env"
while IFS='=' read -r k v; do
  case "$k" in POSTGRES_HOST|POSTGRES_PORT|POSTGRES_DB|POSTGRES_USER|POSTGRES_PASSWORD_FILE) export "$k=$v" ;; esac
done < "$env_file"
pw_file="$POSTGRES_PASSWORD_FILE"
[[ "$pw_file" = /* ]] || pw_file="$(dirname "$env_file")/$pw_file"
export DATABASE_URL="$(PW_FILE="$pw_file" node -e '
const fs=require("fs");const e=process.env;
const pw=encodeURIComponent(fs.readFileSync(e.PW_FILE,"utf8").trim());
process.stdout.write(`postgresql://${encodeURIComponent(e.POSTGRES_USER)}:${pw}@${e.POSTGRES_HOST}:${e.POSTGRES_PORT}/${e.POSTGRES_DB}`);')"
unset POSTGRES_PASSWORD_FILE
cd "$app/apps/api"
pnpm exec vp test run --config vitest.integration.config.ts "$@" 2>&1 | sed -E 's#postgresql://[^@ ]*@#postgresql://***@#g'
