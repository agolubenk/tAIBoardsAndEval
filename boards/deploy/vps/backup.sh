#!/bin/sh
# pg_dump every TB_BACKUP_EVERY seconds inside the backup container (AC-004).
# latest.dump is a hard link to the newest checked dump; the Mac pulls it over
# WireGuard, so a copy always exists off the VPS.
set -eu
umask 027

every="${TB_BACKUP_EVERY:-7200}"
keep_days="${TB_BACKUP_KEEP_DAYS:-3}"
PGPASSWORD="$(cat /run/tb-secrets/postgres_password)"
export PGPASSWORD

while :; do
  stamp="$(date -u +%Y%m%dT%H%MZ)"
  file="/backups/t-boards-$stamp.dump"
  # A dump counts only if pg_restore can read its table of contents.
  if pg_dump -Fc --no-owner -f "$file.part" &&
    pg_restore --list "$file.part" >/dev/null; then
    mv "$file.part" "$file"
    ln -f "$file" /backups/latest.dump.new
    mv /backups/latest.dump.new /backups/latest.dump
    echo "$stamp ok $(wc -c <"$file") bytes"
  else
    rm -f "$file.part"
    echo "$stamp FAILED" >&2
  fi
  find /backups -name 't-boards-*.dump' -mtime +"$keep_days" -delete
  sleep "$every"
done
