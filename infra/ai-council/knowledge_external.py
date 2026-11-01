#!/usr/bin/env python3
"""AI Council — знания ВНЕ репозитория: scrub секретов/PII и чтение claude-mem. Только stdlib.

Канон: docs/specs/ai-council.md §6 «Единые знания ИИ-сервисов (2026-10-09)».

Отдельный модуль, потому что это граница приватности: всё, что здесь, не проходило ревью
коммита (авто-память Claude Code, межсессионная память claude-mem), а капсула в профиле
hybrid/cloud уходит в облако (Z.AI). Обход файлов и индексация — knowledge_sources.py.
"""
from __future__ import annotations

import functools
import json
import re
import sqlite3
import time
from pathlib import Path

# Пол приватности для claude-mem: эти типы не индексируются, что бы ни стояло в конфиге.
DENY_OBS_TYPES = frozenset({"security_alert", "security_note", "sensitive"})
# …и любой тип, где есть такая основа (подстрокой: `insecure_config` тоже): в живой БД ~250 разных
# типов (модель claude-mem придумывает их на ходу, есть и голый `security`), перечислением за
# словарём не угнаться. Ложное срабатывание здесь стоит одной невзятой записи — это дёшево.
_DENY_TYPE_STEMS = ("secur", "sensitiv", "secret", "credential", "privacy", "pii")


def is_denied_type(obs_type) -> bool:
    """Тип claude-mem, который не индексируется никогда (конфиг его не включит)."""
    text = str(obs_type or "")
    return text in DENY_OBS_TYPES or any(stem in text.lower() for stem in _DENY_TYPE_STEMS)


# Записи, где речь о PII, дампах, паролях и ключах, не индексируются целиком: scrub ловит
# значения, но не смысл («в дампе лежали паспорта кандидатов»). Список консервативный —
# на живой БД отсекает 21 % решений проекта (29 из 136 за 45 дней, замер 2026-10-09).
_OBS_DENY_RE = re.compile(
    r"(?i)(\bpii\b|персональн\w*\s+данн|паспорт|дамп|\bdumps?\b|парол|passw|"
    r"credential|учётн\w*\s+данн|учетн\w*\s+данн|секрет|\bsecrets?\b|private[ _-]?key|"
    r"приватн\w*\s+ключ|api[ _-]?keys?\b|\.env\b|утечк|\bleak)")


# ── scrub: секреты и PII ─────────────────────────────────────────────────────
# Порядок важен: специфичные шаблоны раньше общих, пароль в URL раньше почты
# (`user:pass@host.com` иначе выглядел бы как адрес).
_SECRET_VALUE = r"(?:(?=[^\s\"'`,;{}()]*\d)[^\s\"'`,;{}()]{8,}|[^\s\"'`,;{}()]{20,})"
_SCRUB_RULES: list[tuple[re.Pattern, str]] = [
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----",
                re.S), "[PRIVATE_KEY]"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}"), "[JWT]"),
    (re.compile(r"\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}"
                r"|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}"
                r"|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{16,}|hf_[A-Za-z0-9]{20,}"
                r"|ntn_[A-Za-z0-9]{20,}|secret_[A-Za-z0-9]{30,})"), "[TOKEN]"),
    # Z.AI / GLM: `<32 hex>.<16 символов>`
    (re.compile(r"\b[0-9a-f]{32}\.[A-Za-z0-9]{16}\b"), "[TOKEN]"),
    (re.compile(r"(?i)\b(bearer)\s+[A-Za-z0-9._~+/=-]{12,}"), r"\1 [REDACTED]"),
    (re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://)[^\s/@:]+:[^\s/@]+@"), r"\1[REDACTED]@"),
    # присваивания: api_key=…, "password": "…", NOTION_TOKEN: …, пароль: … — ключ остаётся,
    # значение нет; значение без цифр короче 20 символов — слово, а не секрет («token: rotation»)
    (re.compile(r"(?i)\b((?:[a-z0-9]+[_-])*(?:api[_-]?key|secret|token|passw(?:or)?d|pwd"
                r"|access[_-]?key|private[_-]?key|парол[ьяеи])s?)(\"?'?\s*[:=]\s*[\"']?)(?!\[)"
                + _SECRET_VALUE), r"\1\2[REDACTED]"),
    # длинный токен вида base64/случайной строки: заглавные + строчные + цифры, ≥ 32
    (re.compile(r"(?<![\w/.-])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])"
                r"(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}(?![\w/.-])"), "[TOKEN]"),
    (re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b"),
     "[EMAIL]"),
    # телефоны — только с международным `+` или в формах `8 (0xx) …` / `8 0xx xxx-xx-xx` (с
    # разделителями): голые цифры в техническом тексте — порты, id, эпохи, и их «чистка»
    # уничтожала бы улики
    (re.compile(r"(?<![\w+])(?:\+\d{1,3}[\s-]?\(?\d{2,4}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}"
                r"|\+\d{10,14}|8[\s-]?\(\d{3,4}\)[\s-]?\d{2,3}[\s-]?\d{2}[\s-]?\d{2}"
                r"|8[\s-]\d{3,4}[\s-]\d{2,3}[\s-]\d{2}[\s-]\d{2})(?!\d)"),
     "[PHONE]"),
]
_IPV4 = re.compile(r"(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}"
                   r"(?:25[0-5]|2[0-4]\d|1?\d?\d)(?!\d)(?!\.\d)")


def _ip_sub(match: re.Match) -> str:
    """Локальные адреса (loopback, RFC 1918, 0.0.0.0) — знание о dev-окружении, не утечка;
    публичный адрес (VPS, сторонний хост) заменяется."""
    ip = match.group(0)
    a, b = (int(x) for x in ip.split(".")[:2])
    if a in (0, 10, 127) or (a == 192 and b == 168) or (a == 172 and 16 <= b <= 31):
        return ip
    return "[IP]"


@functools.lru_cache(maxsize=4)
def _home_rules(home: str) -> tuple:
    """Домашний каталог → `~`: имя пользователя ОС (обычно производное от имени владельца) в
    облачной капсуле ни к чему, а путь от `~` остаётся уликой. Две формы: путь и id проекта
    Claude Code (`-Users-<имя>-…`). Ключ кэша — сам путь: selftest подменяет HOME."""
    if len(home.strip("/")) < 2:
        return ()
    dashed = re.sub(r"[^A-Za-z0-9]", "-", home)
    return ((re.compile(re.escape(home) + r"(?![\w-])"), "~"),
            (re.compile(re.escape(dashed) + r"(?=-|$)"), "~"))


def scrub(text: str) -> str:
    """Секреты и PII → плейсхолдеры. Применяется ко всему, что читается вне репозитория.
    Домашний каталог заменяется первым: иначе id проекта с именем пользователя, стоящий
    после пробела, целиком ушёл бы под [TOKEN] вместе с путём-уликой."""
    if not text:
        return text
    try:
        home = str(Path.home())
    except RuntimeError:                               # нет HOME и записи в passwd
        home = ""
    for pattern, replacement in _home_rules(home):
        text = pattern.sub(replacement, text)
    for pattern, replacement in _SCRUB_RULES:
        text = pattern.sub(replacement, text)
    return _IPV4.sub(_ip_sub, text)


# ── claude-mem ───────────────────────────────────────────────────────────────
def read_observations(path: Path, project: str, types: list[str], window_days: int,
                      max_docs: int, timeout: float = 2.0,
                      now_s: float | None = None) -> tuple[list[dict], str]:
    """Решения проекта из claude-mem → документы корпуса. Состояние: ok | absent | disabled |
    error: …. Строго read-only (`mode=ro`) с коротким таймаутом: claude-mem — чужая живая БД,
    писать в неё или ждать её блокировок консилиум не должен. Нет файла — не ошибка."""
    types = [t for t in types if not is_denied_type(t)]
    if not types:
        return [], "disabled"
    if not path.is_file():
        return [], "absent"
    since_s = int((now_s if now_s is not None else time.time()) - window_days * 86400)
    try:
        conn = sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True, timeout=timeout)
    except sqlite3.Error as exc:
        return [], f"error: {exc}"
    try:
        conn.row_factory = sqlite3.Row
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(observations)")}
        if not {"id", "project", "type", "title", "created_at_epoch"} <= cols:
            return [], "error: неизвестная схема observations"
        opt = ", ".join(c if c in cols else f"NULL AS {c}"
                        for c in ("subtitle", "facts", "narrative"))
        merged = " OR merged_into_project = ? COLLATE NOCASE" \
            if "merged_into_project" in cols else ""
        # эпоха у claude-mem в миллисекундах; секунды тоже принимаем
        sql = (f"SELECT id, type, title, {opt}, created_at_epoch FROM observations "
               f"WHERE (project = ? COLLATE NOCASE{merged}) "
               f"AND type IN ({','.join('?' * len(types))}) "
               f"AND (CASE WHEN created_at_epoch > 100000000000 THEN created_at_epoch / 1000 "
               f"ELSE created_at_epoch END) >= ? "
               f"ORDER BY created_at_epoch DESC LIMIT ?")
        params = [project] + ([project] if merged else []) + types + [since_s, max_docs * 3]
        rows = conn.execute(sql, params).fetchall()
    except sqlite3.Error as exc:
        return [], f"error: {exc}"
    finally:
        conn.close()
    return observation_docs(rows, max_docs), "ok"


def observation_docs(rows, max_docs: int) -> list[dict]:
    """Строки observations → документы: фильтр приватности, дедуп по заголовку, scrub."""
    docs: list[dict] = []
    titles: set[str] = set()
    for row in rows:
        if len(docs) >= max_docs:
            break
        if is_denied_type(row["type"]):
            continue
        try:
            facts = json.loads(row["facts"] or "[]")
        except (TypeError, ValueError):
            facts = [row["facts"]]
        facts = [str(f) for f in facts] if isinstance(facts, list) else [str(facts)]
        raw = "\n".join(filter(None, [row["subtitle"] or "",
                                      "\n".join(f"- {f}" for f in facts[:8]),
                                      row["narrative"] or ""]))
        title = (row["title"] or "").strip()
        if not title or _OBS_DENY_RE.search(f"{title}\n{raw}"):
            continue
        norm = re.sub(r"\W+", " ", title.lower()).strip()
        if norm in titles:
            continue                                   # переформулированный дубль
        titles.add(norm)
        epoch = int(row["created_at_epoch"] or 0)
        day = time.strftime("%Y-%m-%d", time.localtime(epoch / 1000 if epoch > 1e11 else epoch))
        docs.append({"doc_id": f"mem_obs:{row['id']}",
                     "title": f"[решение {day}] {scrub(title)}",
                     "content": scrub(raw)[:1500],
                     "source_ref": f"claude-mem#{row['id']}"})
    return docs
