#!/usr/bin/env python3
"""AI Council — улики находок ревью, посчитанные КОДОМ. Только stdlib, без моделей.

Канон: docs/specs/ai-council.md §17.5.

Зачем. Замер 2026-10-08 по 162 прогонам: 58 из 65 FAIL дало правило «неснятая critical =
FAIL», и 60 из 68 таких critical написал dod_auditor на qwen2.5:7b — «Изменения не прошли
узкий чек» с уликой «typecheck — 0 ошибок», «тесты покрывают не все сценарии». Самооценке
модели верить нельзя: confidence 1.0 в 112 из 159 ответов, 119 из 125 путей в находках
существуют, 64 из 77 critical цитируют досье дословно. Поэтому «на чём держится находка»
решает этот модуль, а метка модели (`evidence_kind`) может только понизить находку.

Опора находки (`grounding`), от сильной к слабой:

    patch — цитата из изменённых строк диффа (+/-) или место внутри ханка изменённого файла;
    file  — файл, который трогает дифф, но место вне изменённых строк;
    repo  — файл есть в репозитории, но этим изменением не затронут (вне скоупа работы);
    card  — цитата только из карточки/комментариев: это заявление исполнителя, не наблюдение;
    none  — ни цитаты, ни существующего места.

Решающей (может дать FAIL) бывает только находка с опорой patch|file. Путь из ответа
модели никогда не открывается: существование проверяется по `git ls-files` (множество
строк), иначе `/dev/zero` или FIFO повесили бы единственный воркер, а «есть ли .env»
утекало бы в ответ.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

DECISIVE = ("patch", "file")
GROUNDINGS = ("patch", "file", "repo", "card", "none")

_DIFF_FILE = re.compile(r"(?m)^diff --git a/(\S+) b/(\S+)")
_STAT_FILE = re.compile(r"(?m)^\s*(\S+?)\s+\|\s+(?:\d+|Bin)")
_HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")
_LOC = re.compile(r"((?:[\w@.-]+/)*[\w@.-]+\.[A-Za-z][A-Za-z0-9]{0,7})"
                  r"(?:(?::|#L|:L| line |, строка )(\d{1,6}))?")
_BARE_FILE = re.compile(r"[\w@-]+(?:\.[\w@-]+)*\.[A-Za-z][A-Za-z0-9]{0,7}")
_WS = re.compile(r"\s+")

# Результаты проверок в досье: «typecheck — 0 ошибок», «tests passed», «262/262», «✓».
_CHECK_NAMES = (r"typecheck|type-check|tsc|lint|eslint|prettier|test(?::run)?|tests|vitest|jest|"
                r"pytest|selftest|build|сборк\w*|тест\w*|линт\w*|проверк\w*|madge|e2e|playwright")
_PASS = re.compile(
    rf"(?i)\b({_CHECK_NAMES})\b[^\n]{{0,120}}?(\b0 (?:ошиб\w*|errors?|warnings?|problems?)\b|"
    r"\bpass(?:ed)?\b|\bok\b|\bзел[её]н\w*|\bуспешн\w*|прош[её]л\w*|\b(?P<n>\d+)/(?P=n)\b|✓|✅)")
_FAIL = re.compile(
    rf"(?i)\b({_CHECK_NAMES})\b[^\n]{{0,120}}?(\bfail(?:ed|ing)?\b|\bупал\w*|\bкрасн\w*|"
    r"\b[1-9]\d* (?:ошиб\w*|errors?)\b|✗|❌)")
# Находка «узкие проверки не прогнаны / результата нет»: отрицание и ИМЯ проверки рядом
# (≤ 50 символов), иначе «не выполнен базовый критерий DoD» или «нет проверки на проде»
# снимались бы результатом typecheck — это другие утверждения.
_NEG = (r"(?:не (?:был[аио]? )?(?:прогнан|пройден|запущен|выполнен|проверен)\w*|без (?:прогона|результат\w*)|"
        r"нет (?:прогона|результат\w*)|отсутств\w* (?:прогон\w*|результат\w*)|not (?:run|executed|passed))")
_NARROW = r"(?:typecheck|type-check|tsc|lint|eslint|тест\w*|tests?|vitest|jest|pytest|selftest|узк\w* (?:чек|провер)\w*)"
_NO_CHECK = re.compile(rf"(?i){_NEG}[^.\n]{{0,50}}?{_NARROW}|{_NARROW}[^.\n]{{0,50}}?{_NEG}")

SEVERITY_ORDER = {"critical": 0, "major": 1, "minor": 2, "info": 3}


def norm(text: str) -> str:
    return _WS.sub(" ", (text or "").strip().lower())


@dataclass
class Dossier:
    """Разобранное досье: изменённые строки по файлам, ханки, текст карточки."""
    text: str = ""
    card: str = ""
    changed: dict[str, list[str]] = field(default_factory=dict)   # путь → нормализованные +/- строки
    hunks: dict[str, list[tuple[int, int]]] = field(default_factory=dict)
    files: set[str] = field(default_factory=set)
    changed_blob: str = ""
    checks: list[dict] = field(default_factory=list)


def parse(text: str) -> Dossier:
    """Досье ревью (review_context.build_dossier) → структура для проверок.

    Карточка — всё до «## Улики исполнения (git)»; RAG-раздел («## Правила и знания») —
    знания проекта, не наблюдение за этой работой, в опору не идёт."""
    d = Dossier(text=text or "")
    git_at = d.text.find("## Улики исполнения (git)")
    rag_at = d.text.find("## Правила и знания проекта")
    d.card = d.text[:git_at] if git_at >= 0 else (d.text[:rag_at] if rag_at >= 0 else d.text)
    git = d.text[git_at:rag_at if rag_at > git_at else len(d.text)] if git_at >= 0 else ""
    d.files.update(m.group(1) for m in _STAT_FILE.finditer(git) if "/" in m.group(1) or "." in m.group(1))
    current = ""
    line_no = 0
    blob: list[str] = []
    for raw in git.splitlines():
        m = _DIFF_FILE.match(raw)
        if m:
            current = m.group(2)
            d.files.add(current)
            d.files.add(m.group(1))
            continue
        h = _HUNK.match(raw)
        if h and current:
            start, length = int(h.group(1)), int(h.group(2) or 1)
            d.hunks.setdefault(current, []).append((start, start + max(length, 1) - 1))
            line_no = start
            continue
        if not current:
            continue
        if raw.startswith(("+++", "---")):
            continue
        if raw.startswith(("+", "-")):
            body = norm(raw[1:])
            if len(body) >= 8:
                d.changed.setdefault(current, []).append(body)
                blob.append(body)
            if raw.startswith("+"):
                line_no += 1
        elif raw.startswith(" "):
            line_no += 1
    d.changed_blob = "\n".join(blob)
    d.checks = checks_seen(d.card + "\n" + git)
    return d


def checks_seen(text: str, limit: int = 6) -> list[dict]:
    """Проверки, РЕЗУЛЬТАТ которых есть в досье. Предложенная/написанная проверка сюда не
    попадает — только строка с результатом (pass/fail)."""
    out: list[dict] = []
    seen: set[str] = set()
    for line in (text or "").splitlines():
        if len(out) >= limit:
            break
        for rx, result in ((_FAIL, "fail"), (_PASS, "pass")):
            m = rx.search(line)
            if m:
                snippet = norm(line)[:160]
                if snippet not in seen:
                    seen.add(snippet)
                    out.append({"check": m.group(1).lower(), "result": result, "line": snippet})
                break
    return out


def _windows(text: str, size: int = 28, step: int = 9) -> list[str]:
    text = norm(text)
    if len(text) <= size:
        return [text] if len(text) >= 16 else []
    return [text[i:i + size] for i in range(0, len(text) - size + 1, step)]


def _quotes_in(evidence: str, haystack: str) -> bool:
    if not evidence or not haystack:
        return False
    hay = norm(haystack)
    return any(w in hay for w in _windows(evidence))


def _quotes_changed(evidence: str, d: Dossier) -> bool:
    ev = norm(evidence)
    if not ev or not d.changed_blob:
        return False
    # Изменённая строка целиком в улике (модели часто цитируют строку диффа) — или
    # окно улики внутри изменённых строк.
    for lines in d.changed.values():
        if any(len(ln) >= 16 and ln in ev for ln in lines):
            return True
    return any(w in d.changed_blob for w in _windows(ev))


def safe_path(raw: str) -> str:
    """Относительный путь репозитория или ''. Абсолютные, `..`, схемы URL — отклоняются."""
    p = (raw or "").strip().strip("`'\"()[]<>,;").replace("\\", "/")
    if p.startswith("./"):
        p = p[2:]
    if not p or p.startswith("/") or "://" in p or ".." in p.split("/") or "*" in p:
        return ""
    return p


def locations(finding: dict) -> list[tuple[str, int | None]]:
    """Места из `location`, затем из улики и заголовка: (путь, строка|None)."""
    out: list[tuple[str, int | None]] = []
    for src in (finding.get("location"), finding.get("evidence"), finding.get("title")):
        for m in _LOC.finditer(str(src or "")):
            path = safe_path(m.group(1))
            if path and ("/" in path or _BARE_FILE.fullmatch(path)):
                pair = (path, int(m.group(2)) if m.group(2) else None)
                if pair not in out:
                    out.append(pair)
        if out:
            break
    return out[:4]


def _match_file(path: str, files: set[str]) -> str:
    if path in files:
        return path
    tails = [f for f in files if f.endswith("/" + path)] if "/" in path or "." in path else []
    return tails[0] if len(tails) == 1 else ""


def _in_hunk(line: int | None, ranges: list[tuple[int, int]], slack: int = 3) -> bool:
    return line is not None and any(a - slack <= line <= b + slack for a, b in ranges)


def ground(finding: dict, d: Dossier, tracked: set[str] | None = None) -> tuple[str, str]:
    """(опора, пояснение). Чистая функция: досье + множество отслеживаемых файлов."""
    evidence = str(finding.get("evidence") or "")
    if _quotes_changed(evidence, d):
        return "patch", "цитата из изменённых строк диффа"
    locs = locations(finding)
    best = ""
    for path, line in locs:
        hit = _match_file(path, d.files)
        if hit:
            if _in_hunk(line, d.hunks.get(hit, [])):
                return "patch", f"{hit}:{line} — внутри изменённого ханка"
            best = best or "file"
            why_file = f"{hit} — файл изменения" + (f", строка {line} вне ханков" if line else "")
    if best == "file":
        return "file", why_file
    if tracked:
        for path, _line in locs:
            if _match_file(path, tracked):
                return "repo", f"{path} есть в репозитории, но изменением не затронут"
    if _quotes_in(evidence, d.card):
        return "card", "цитата только из карточки/комментариев — заявление исполнителя"
    return "none", "ни цитаты из диффа, ни места в изменённых файлах"


def contradicted_by_checks(finding: dict, d: Dossier) -> str:
    """Находка «проверки не прогнаны», а в досье есть их результат → причина снятия."""
    text = f"{finding.get('title') or ''} {finding.get('evidence') or ''}"
    if not _NO_CHECK.search(text):
        return ""
    passed = [c for c in d.checks if c["check"] not in ("проверка", "проверки", "проверк")]
    if not passed:
        return ""
    return f"досье содержит результат проверки: «{passed[0]['line'][:120]}»"


def cap_severity(severity: str, cap: str) -> str:
    if cap in SEVERITY_ORDER and SEVERITY_ORDER.get(severity, 3) < SEVERITY_ORDER[cap]:
        return cap
    return severity


def annotate(finding: dict, d: Dossier, tracked: set[str] | None = None) -> dict:
    """Находка + посчитанные кодом поля. Метка модели может только понизить."""
    g, why = ground(finding, d, tracked)
    kind = str(finding.get("evidence_kind") or "").lower()
    if kind == "hypothesis" and g in DECISIVE:
        why += "; сам автор пометил как гипотезу"
    finding = {**finding, "grounding": g, "grounding_why": why}
    finding["decisive"] = g in DECISIVE and kind != "hypothesis"
    return finding
