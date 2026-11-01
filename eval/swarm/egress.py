# -*- coding: utf-8 -*-
"""Фильтр исходящих данных роя (П9, d-pipe-swarm = free-code): что можно отдать внешней модели.

Код без секретов — можно. Запрещены пути с секретами и дампы. В тексте маскируются ключи, токены, пароли в URL и
присваиваниях, приватные ключи, e-mail и телефоны. Маскирование — до отправки, по месту: структура кода остаётся.
"""
import re

DENY_PATH = [re.compile(p, re.I) for p in (
    r"(^|/)\.env($|\.)", r"\.(pem|key|p12|pfx|kdbx|keystore|jks)$", r"(^|/)id_(rsa|dsa|ecdsa|ed25519)",
    r"\.(sql|dump|bak|sqlite3?|db)(\.gz)?$", r"(^|/)\.(ssh|aws|gnupg|claude-mem)/", r"(^|/)secrets?/",
    r"credentials", r"(^|/)\.state/", r"(^|/)\.mcp\.json$", r"settings\.local\.json$", r"(^|/)\.npmrc$",
    r"(^|/)\.netrc$", r"\.tfstate$",
)]

PRIVATE_KEY = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.S)
TOKENS = [re.compile(p) for p in (
    r"\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}",                       # JWT
    r"\bsk-(?:ant-|proj-|or-v1-)?[A-Za-z0-9_-]{16,}",               # Anthropic / OpenAI / OpenRouter
    r"\bgh[pousr]_[A-Za-z0-9]{20,}", r"\bgithub_pat_\w{20,}",
    r"\bxox[abprs]-[\w-]{10,}", r"\bAKIA[0-9A-Z]{16}\b", r"\bAIza[\w-]{30,}",
    r"\bgw-[\w-]{20,}", r"\b(?:ntn|secret)_[A-Za-z0-9]{20,}", r"\bglpat-[\w-]{20,}",
    r"\b\d{8,10}:AA[\w-]{30,}",                                     # токен Telegram-бота
)]
BEARER = re.compile(r"(\b(?:Bearer|Basic|Token)\s+)[\w\-.~+/=]{12,}", re.I)
URL_CRED = re.compile(r"(\b[a-z][\w+.-]*://[^:/\s@]+:)[^@\s/]+@", re.I)
ASSIGN = re.compile(r"""(\b[\w.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|private[_-]?key|"""
                    r"""client[_-]?secret|access[_-]?key)[\w.-]*["']?\s*[:=]\s*)(["']?)([^\s"',;)}]+)(["']?)""", re.I)
EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b", re.I)
PHONE = re.compile(r"(?<![\w+])\+\d[\d\s().-]{8,}\d\b")


def denied(path):
    p = path.replace("\\", "/")
    return next((r.pattern for r in DENY_PATH if r.search(p)), None)


TYPE_WORDS = {"string", "number", "boolean", "bool", "any", "unknown", "null", "none", "undefined", "true", "false",
              "str", "int", "bytes", "optional", "required", "object", "secret", "password", "token"}
STRICT_KEY = re.compile(r"pass|pwd|secret", re.I)


def _looks_secret(key, value, quoted):
    if value.startswith(("<", "$", "process.", "env.", "os.", "config", "self.", "this.")) or \
            value.lower().rstrip("|?") in TYPE_WORDS:
        return False
    if quoted:
        return len(value) >= 8
    if STRICT_KEY.search(key):
        return len(value) >= 6
    return len(value) >= 16 and re.search(r"\d", value) and re.search(r"[A-Za-z]", value)


def mask(text):
    """→ (текст, {вид: сколько}). Значение заменяется меткой, имя переменной остаётся."""
    n = {}

    def sub(rx, repl, s, kind):
        out, k = rx.subn(repl, s)
        if k:
            n[kind] = n.get(kind, 0) + k
        return out

    text = sub(PRIVATE_KEY, "<приватный ключ>", text, "private_key")
    for rx in TOKENS:
        text = sub(rx, "<токен>", text, "token")
    text = sub(BEARER, r"\1<токен>", text, "bearer")
    text = sub(URL_CRED, r"\1<пароль>@", text, "url_password")

    def assign(m):
        if not _looks_secret(m.group(1), m.group(3), bool(m.group(2))):
            return m.group(0)
        n["assignment"] = n.get("assignment", 0) + 1
        return f"{m.group(1)}{m.group(2)}<скрыто>{m.group(4)}"

    text = ASSIGN.sub(assign, text)
    text = sub(EMAIL, "<email>", text, "email")
    text = sub(PHONE, "<телефон>", text, "phone")
    return text, n
