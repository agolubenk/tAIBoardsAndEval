#!/usr/bin/env bash
# Renders tls.conf.template: install.sh and selftest.sh both call this, so the
# selftest exercises the same substitution and the same leftover check.
# Usage: render-tls.sh <template> <out> <listen> <domain> <upstream>
set -euo pipefail

template="$1" out="$2" listen="$3" domain="$4" upstream="$5"
sed -e "s|\${TLS_LISTEN}|$listen|g" \
  -e "s|\${TLS_DOMAIN}|$domain|g" \
  -e "s|\${TLS_UPSTREAM}|$upstream|g" \
  "$template" >"$out"
# Only a real placeholder counts: comments may name ${TLS_*} as a pattern.
if left="$(grep -nE '[$][{]TLS_[A-Z0-9_]+[}]' "$out")"; then
  echo "tls.conf не отрендерился: $left" >&2
  exit 1
fi
