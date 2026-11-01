#!/bin/sh
# Pulls the newest t-boards dump from the VPS over WireGuard: the copy off the
# VPS that AC-004 asks for. The VPS key only allows `cat latest.dump`.
# Runs from ~/.t-boards-backup (launchd cannot run scripts from ~/Desktop).
set -eu

home="$HOME/.t-boards-backup"
dir="${TB_BACKUP_DIR:-$HOME/t-boards-backups}"
keep_days="${TB_BACKUP_KEEP_DAYS:-14}"
stamp="$(date -u +%Y%m%dT%H%MZ)"
mkdir -p "$dir"
tmp="$dir/.pull-$stamp"

if ! ssh -i "$home/id_ed25519" -o IdentitiesOnly=yes -o BatchMode=yes \
  -o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new \
  -o UserKnownHostsFile="$home/known_hosts" root@10.77.0.1 >"$tmp"; then
  rm -f "$tmp"
  echo "$stamp FAILED: ssh (туннель выключен?)" >&2
  exit 1
fi
# pg_dump's custom format starts with PGDMP.
if [ "$(head -c 5 "$tmp")" != "PGDMP" ]; then
  rm -f "$tmp"
  echo "$stamp FAILED: not a pg_dump file" >&2
  exit 1
fi
newest="$(ls -t "$dir"/t-boards-*.dump 2>/dev/null | head -1 || true)"
if [ -n "$newest" ] && cmp -s "$tmp" "$newest"; then
  rm -f "$tmp"
  echo "$stamp same as $(basename "$newest")"
else
  mv "$tmp" "$dir/t-boards-$stamp.dump"
  echo "$stamp ok $(wc -c <"$dir/t-boards-$stamp.dump" | tr -d ' ') bytes"
fi
find "$dir" -name 't-boards-*.dump' -mtime +"$keep_days" -delete
