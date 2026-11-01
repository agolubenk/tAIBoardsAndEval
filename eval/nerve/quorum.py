# -*- coding: utf-8 -*-
"""Вердикты линз и кворум PR (П7). Чистые функции — без сети.

Формат вердикта в Т3 свободный: «**Бэкенд: approve на 46b9f87e1.**», «Линза DevOps (…), голова b55b246ec — approve».
Берётся первая непустая строка комментария: в ней слово approve или changes и SHA (7–40 hex).
Кворум: на текущую голову не меньше min_lenses разных линз с approve, ни одного changes, проверки CI не висят.
"""
import re

VERDICT_RE = re.compile(r"\b(approve|changes)\b", re.I)
SHA_RE = re.compile(r"\b([0-9a-f]{7,40})\b")
LENS_RE = re.compile(r"^[\s*_>#]*(?:Линза\s+)?([A-Za-zА-Яа-яЁё][\w .+-]{0,40}?)\s*(?:\(|:|,|—|\s-\s)", re.I)


def parse_verdict(body):
    """Возвращает {"lens", "verdict", "sha"} или None."""
    first = ""
    for line in (body or "").splitlines():
        if line.strip():
            first = line.strip()
            break
    if not first:
        return None
    v = VERDICT_RE.search(first)
    s = SHA_RE.search(first)
    if not v or not s:
        return None
    m = LENS_RE.match(first)
    lens = (m.group(1) if m else "?").strip(" *_").lower()
    return {"lens": lens, "verdict": v.group(1).lower(), "sha": s.group(1).lower()}


def on_head(sha, head):
    return bool(sha) and bool(head) and head.lower().startswith(sha.lower())


def ci_state(checks):
    """checks — список статусов/выводов. pending, если что-то не завершено; failure, если есть провал; иначе ok."""
    states = [str(c or "").upper() for c in checks]
    if any(s in ("PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "WAITING") for s in states):
        return "pending"
    if any(s in ("FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED") for s in states):
        return "failure"
    return "ok"


def quorum(verdicts, head, checks, min_lenses=3):
    """verdicts — разобранные вердикты по порядку. Последний вердикт линзы на голову перекрывает её прежние.
    Возвращает (собран ли, одобрившие линзы, линзы с changes, состояние CI)."""
    last = {}
    for v in verdicts:
        if v and on_head(v["sha"], head):
            last[v["lens"]] = v["verdict"]
    approved = sorted(k for k, x in last.items() if x == "approve")
    changes = sorted(k for k, x in last.items() if x == "changes")
    ci = ci_state(checks)
    return (len(approved) >= min_lenses and not changes and ci != "pending"), approved, changes, ci


def role_of_lens(lens, lens_roles):
    for pat, role in lens_roles:
        if pat in lens:
            return role
    return None


def author_role(files, path_roles, default="coord"):
    """Роль автора — по большинству изменённых файлов PR."""
    votes = {}
    for f in files:
        for prefix, role in path_roles:
            if f.startswith(prefix):
                votes[role] = votes.get(role, 0) + 1
                break
    if not votes:
        return default
    return max(sorted(votes), key=lambda r: votes[r])
