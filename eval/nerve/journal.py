# -*- coding: utf-8 -*-
"""Журнал Нерва (П7): append-only JSONL, ключ идемпотентности, запись до доставки.

Пишет только демон (один процесс — замок в nerve.py). Тапы ролей только читают и держат свой курсор.
Событие с уже виденным ключом не пишется второй раз — повторный проход по источникам безопасен.
"""
import fcntl
import json
import os
from datetime import datetime, timezone

NERVOUS = "nervous"
DIGEST = "digest"
ALL = "all"


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Journal:
    def __init__(self, path):
        self.path = path
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.keys = set()
        self.seq = 0
        for rec in read_from(path, 0)[0]:
            self.keys.add(rec.get("key"))
            self.seq = max(self.seq, int(rec.get("seq", 0)))

    def emit(self, key, kind, cls, to, text, src="", **extra):
        """Пишет событие, если ключа ещё не было. Возвращает True, если записано."""
        if key in self.keys:
            return False
        self.seq += 1
        rec = {"seq": self.seq, "ts": now_iso(), "key": key, "kind": kind, "class": cls,
               "to": sorted(set(to)), "text": text, "src": src}
        rec.update(extra)
        line = json.dumps(rec, ensure_ascii=False) + "\n"
        with open(self.path, "a", encoding="utf-8") as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            try:
                f.write(line)
                f.flush()
                os.fsync(f.fileno())
            finally:
                fcntl.flock(f, fcntl.LOCK_UN)
        self.keys.add(key)
        return True


def read_from(path, offset):
    """Читает записи с байта offset. Возвращает (записи, новый offset). Недописанная последняя строка не читается."""
    try:
        with open(path, "rb") as f:
            f.seek(offset)
            data = f.read()
    except OSError:
        return [], offset
    end = data.rfind(b"\n")
    if end < 0:
        return [], offset
    out = []
    for raw in data[: end + 1].splitlines():
        try:
            out.append(json.loads(raw))
        except ValueError:
            continue
    return out, offset + end + 1


def addressed(rec, role):
    to = rec.get("to") or []
    return role in to or ALL in to
