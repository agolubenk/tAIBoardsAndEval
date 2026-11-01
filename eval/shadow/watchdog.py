#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""shadow/watchdog.py — теневой сторож команды сессий (прототип, задание B KIMI.md).

Только читает хвосты журналов сессий и печатает сигналы строками на stdout.
Без модели, без сети, без записи вне --state-dir. stdlib only, python3 -I.

Детекты:
  LIMIT_SHARED  >= 2 ролей с «hit your … limit» / apiError=usage_limit_reached за --window сек
  LIMIT_SINGLE  ровно 1 роль за --window
  AUTH          «Not logged in» за --window
  STALE         журнал не писался дольше --stale сек (тишина, не доказательство смерти)
  DISK          свободно < 10 ГиБ (только живой режим)
  MEM           memory_pressure: free < 10% (только живой режим, macOS)

Режимы:
  живой:   python3 -I watchdog.py --journal role=path …
  переигровка: --at 2026-10-26T11:29:00Z (читает журналы целиком, системные детекты выключены)
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timedelta, timezone

LIMIT_RE = re.compile(r"hit your .*limit", re.I | re.S)
RESET_RE = re.compile(r"resets\s+([^\n·]+)")
AUTH_RE = re.compile(r"^\s*Not logged in", re.I)
MEM_RE = re.compile(r"free percentage:\s*(\d+)%")

SEV = {"LIMIT_SHARED": "CRITICAL", "AUTH": "CRITICAL", "LIMIT_SINGLE": "WARNING",
       "DISK": "WARNING", "MEM": "WARNING", "STALE": "INFO", "APIERR": "INFO"}


def parse_ts(s):
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def scan_journal(path, t_end, window_s, tail):
    """Читает журнал (хвост tail байт; при t_end заданном явно — целиком, это переигровка).
    Возвращает (last_ts, events): events = [(ts, kind, detail)] в окне [t_end-window, t_end]."""
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        if size > tail:
            f.seek(size - tail)
            data = f.read().split(b"\n", 1)[1]  # отбросить обрезанную первую строку
        else:
            data = f.read()
    last_ts = None
    events = []
    t_start = t_end - timedelta(seconds=window_s)
    for raw in data.decode("utf-8", "replace").splitlines():
        if '"timestamp"' not in raw:
            continue
        try:
            rec = json.loads(raw)
        except ValueError:
            continue
        ts = parse_ts(rec.get("timestamp") or "")
        if ts is None:
            continue
        if last_ts is None or ts > last_ts:
            last_ts = ts
        if not rec.get("isApiErrorMessage"):
            continue
        if ts < t_start or ts > t_end:
            continue
        text = ""
        content = (rec.get("message") or {}).get("content")
        if isinstance(content, list) and content and isinstance(content[0], dict):
            text = str(content[0].get("text", ""))
        if rec.get("apiError") == "usage_limit_reached" or LIMIT_RE.search(text):
            m = RESET_RE.search(text)
            events.append((ts, "LIMIT", ("resets " + m.group(1).strip()) if m else ""))
        elif AUTH_RE.match(text):
            events.append((ts, "AUTH", ""))
        else:
            events.append((ts, "APIERR", text[:40].replace("\n", " ")))
    return last_ts, events


def load_state(d):
    try:
        with open(os.path.join(d, "watchdog.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(d, st):
    os.makedirs(d, exist_ok=True)
    tmp = os.path.join(d, "watchdog.json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False, indent=1)
    os.replace(tmp, os.path.join(d, "watchdog.json"))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--journal", action="append", required=True, metavar="ROLE=PATH")
    p.add_argument("--at", default="", help="момент переигровки ISO; пусто = сейчас")
    p.add_argument("--window", type=int, default=600)
    p.add_argument("--stale", type=int, default=1800)
    p.add_argument("--tail", type=int, default=262144)
    p.add_argument("--state-dir", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "state"))
    p.add_argument("--repeat-after", type=int, default=3600, help="повтор печати того же сигнала, сек")
    p.add_argument("--no-state", action="store_true")
    a = p.parse_args()

    live = not a.at
    t_now = datetime.now(timezone.utc) if live else parse_ts(a.at)
    if t_now is None:
        print("bad --at", file=sys.stderr)
        return 2
    # переигровка: журналы могут быть длинными, читаем целиком
    tail = a.tail if live else 1 << 62

    signals = []  # (detect, key, detail)
    limit_roles = []
    limit_detail = ""
    for spec in a.journal:
        role, _, path = spec.partition("=")
        try:
            last_ts, events = scan_journal(path, t_now, a.window, tail)
        except OSError as e:
            signals.append(("STALE", role, f"journal unreadable: {e.strerror or e}"))
            continue
        for ts, kind, detail in events:
            if kind == "LIMIT":
                limit_roles.append(role)
                limit_detail = limit_detail or detail
            elif kind == "AUTH":
                signals.append(("AUTH", role, "Not logged in"))
            else:
                signals.append(("APIERR", role, detail))
        if last_ts is None or (t_now - last_ts).total_seconds() > a.stale:
            age = "never" if last_ts is None else f"{int((t_now - last_ts).total_seconds() // 60)} min"
            signals.append(("STALE", role, f"silent {age}"))
    if len(set(limit_roles)) >= 2:
        signals.append(("LIMIT_SHARED", ",".join(sorted(set(limit_roles))),
                        f"{len(set(limit_roles))} roles {limit_detail}".strip()))
    elif limit_roles:
        signals.append(("LIMIT_SINGLE", limit_roles[0], limit_detail))

    if live:
        free = shutil.disk_usage("/").free
        if free < 10 * (1 << 30):
            signals.append(("DISK", "-", f"free {free >> 30} GiB"))
        mp = shutil.which("memory_pressure")
        if mp:
            try:
                out = subprocess.run([mp], capture_output=True, text=True, timeout=10).stdout
                m = MEM_RE.search(out)
                if m and int(m.group(1)) < 10:
                    signals.append(("MEM", "-", f"free {m.group(1)}%"))
            except (OSError, subprocess.SubprocessError):
                pass

    st = {} if a.no_state else load_state(a.state_dir)
    printed = 0
    for detect, key, detail in signals:
        skey = f"{detect}|{key}|{detail}"
        last = st.get(skey, 0.0)
        now = t_now.timestamp()
        if last and now - last < a.repeat_after:
            continue
        st[skey] = now
        printed += 1
        print(f"WATCH {t_now.isoformat(timespec='seconds')} {SEV[detect]:8s} {detect:12s} {key:40s} {detail}")
    if not a.no_state:
        save_state(a.state_dir, st)
    return 1 if printed else 0


if __name__ == "__main__":
    sys.exit(main())
