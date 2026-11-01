#!/usr/bin/env python3
"""Висячие ссылки в слое документации (stdlib-only).

Проверяет относительные ссылки Markdown/HTML (`](path)`, `href=`, `src=`), якоря `файл.md#раздел` и `#раздел`
(по правилам слага заголовков GitHub) и упоминания путей `docs/...`. По умолчанию — слой документации: docs/
(кроме plans/archive/), все CLAUDE.md и AGENTS.md, .claude/, .continue/rules/, корневые README.md и
TARGET_REPO_STRUCTURE.md. `--all` — весь репозиторий, включая комментарии в коде. Строки с явным указателем на
историю (git log/show, «удалён», «git-история») пропускаются: они намеренно называют прежний путь.

Существующим считается только файл в индексе git: ссылка на созданный, но не добавленный файл — висячая (так
её и поймает CI). `--include-untracked` — черновой режим, пока новые файлы ещё не в `git add`.

    python3 .claude/scripts/docs_linkcheck.py                      # код 1, если есть висячие ссылки
    python3 .claude/scripts/docs_linkcheck.py --all                # отчёт по всему репозиторию
    python3 .claude/scripts/docs_linkcheck.py --include-untracked  # до git add

Слой общий для дома продукта и инстанса над host-проектом: законы предметной области хоста ссылаются на его
документы (`docs/api/`, `docs/plans/BACKLOG.md`, …), которых в доме нет. Префиксы таких путей — по одному на строку
в `.claude/scripts/docs_linkcheck.host-only.txt` (нет файла — проверяется всё): висячие ссылки на них печатаются
отдельной сводкой и код возврата не меняют. В инстансе файл не нужен — там эти документы есть.
"""
import posixpath
import re
import subprocess
import sys
import urllib.parse
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

SKIP = re.compile(r"^(graphify-out/|apps/backend/prisma/migrations/|apps/frontend/src/locales/|docs/plans/archive/)"
                  r"|package-lock\.json$")
BINARY = re.compile(r"\.(png|jpe?g|gif|webp|ico|mp4|mov|pdf|zip|gz|woff2?|ttf|otf|eot|jar|so|dylib|onnx|bin|db"
                    r"|sqlite|svg|kt|kts|swift)$", re.I)
DOC_LAYER = re.compile(r"^(docs/|\.claude/|\.continue/rules/)|(^|/)(CLAUDE|AGENTS)\.md$"
                       r"|^(README|TARGET_REPO_STRUCTURE)\.md$")
LINK_RE = re.compile(r'\]\((<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\)|(?:href|src)="([^"]+)"')
MENTION_RE = re.compile(r"(?<![A-Za-z0-9_\-.:/])(?:\.{1,2}/)*(docs/[A-Za-z0-9_\-./&%]*[A-Za-z0-9_\-/])")
EXTERNAL = re.compile(r"^(?:[a-z][a-z0-9+.-]*:|#|/|\{|\$|<%)", re.I)
# Генерируемое и устанавливаемое (скриншоты npm run screenshots:playwright, node_modules) в git не лежит — не висячие.
GENERATED = re.compile(r"^(artifacts/screenshots/|node_modules/)")
HISTORY = re.compile(r"git (log|show)|git-истори|удал[её]н|history|прежн|перенес[её]?н|были `docs/", re.I)


HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
EXPLICIT_ANCHOR_RE = re.compile(r'<a\s+(?:id|name)="([^"]+)"')
_slug_cache = {}


def tracked_files(include_untracked=False):
    cmd = ["git", "-c", "core.quotepath=off", "ls-files", "--cached", "--exclude-standard"]
    if include_untracked:
        cmd.insert(5, "--others")
    out = subprocess.run(cmd, cwd=REPO_ROOT, capture_output=True, text=True, check=True).stdout
    return [f for f in out.split("\n") if f and (REPO_ROOT / f).exists()]


def heading_slugs(rel):
    """Якоря заголовков файла по правилам GitHub: нижний регистр, пунктуация убирается (кроме `-` и `_`),
    пробел → `-`, повтор заголовка получает суффикс `-1`, `-2`… Заголовки внутри ``` не считаются."""
    if rel in _slug_cache:
        return _slug_cache[rel]
    slugs, seen, in_code = set(), Counter(), False
    try:
        text = (REPO_ROOT / rel).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        text = ""
    for line in text.split("\n"):
        if line.lstrip().startswith("```"):
            in_code = not in_code
            continue
        m = None if in_code else HEADING_RE.match(line)
        if not m:
            continue
        title = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", m.group(2))
        slug = re.sub(r"[^\w\- ]", "", title.lower()).replace(" ", "-")
        n = seen[slug]
        seen[slug] += 1
        slugs.add(slug if n == 0 else f"{slug}-{n}")
    slugs.update(EXPLICIT_ANCHOR_RE.findall(text))
    _slug_cache[rel] = slugs
    return slugs


def host_only_prefixes():
    path = REPO_ROOT / ".claude/scripts/docs_linkcheck.host-only.txt"
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return ()
    return tuple(ln.strip() for ln in lines if ln.strip() and not ln.lstrip().startswith("#"))


def main():
    scan_all = "--all" in sys.argv
    host_only = host_only_prefixes()
    files = tracked_files(include_untracked="--include-untracked" in sys.argv)
    fileset = set(files)
    dirs = set()
    for f in files:
        d = posixpath.dirname(f)
        while d:
            dirs.add(d)
            d = posixpath.dirname(d)

    def exists(p):
        p = p.rstrip("/")
        return p in fileset or p in dirs

    problems = []
    for f in files:
        if SKIP.search(f) or BINARY.search(f) or (not scan_all and not DOC_LAYER.search(f)):
            continue
        try:
            text = (REPO_ROOT / f).read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        lines = text.split("\n")

        def line_of(pos):
            return text.count("\n", 0, pos) + 1

        if f.endswith((".md", ".mdc", ".html")):
            for m in LINK_RE.finditer(text):
                target = m.group(1) or m.group(2)
                if not target or "*" in target or "{{" in target or "${" in target:
                    continue
                target = target[1:-1] if target.startswith("<") else target
                anchor = urllib.parse.unquote(target.split("#", 1)[1]) if "#" in target else ""
                if target.startswith("#"):  # якорь в этом же файле
                    if f.endswith(".md") and anchor and anchor not in heading_slugs(f):
                        ln = line_of(m.start())
                        if not HISTORY.search(lines[ln - 1]):
                            problems.append((f, ln, target, f))
                    continue
                if EXTERNAL.match(target):
                    continue
                path = urllib.parse.unquote(target.split("#")[0].split("?")[0])
                if not path or not re.search(r"[./]", path):
                    continue
                resolved = posixpath.normpath(posixpath.join(posixpath.dirname(f), path))
                if resolved.startswith("..") or GENERATED.match(resolved):
                    continue
                ok = exists(resolved)
                if ok and anchor and resolved.endswith(".md") and resolved in fileset:
                    ok = anchor in heading_slugs(resolved)
                if ok:
                    continue
                ln = line_of(m.start())
                if not HISTORY.search(lines[ln - 1]):
                    problems.append((f, ln, target, resolved))
        for m in MENTION_RE.finditer(text):
            p = m.group(1)
            # проверяем только то, что однозначно путь: файл с расширением или каталог со слешем
            if not re.search(r"(\.[A-Za-z0-9]+|/)$", p) or exists(p) or exists(p.rstrip(".")):
                continue
            ln = line_of(m.start())
            if not HISTORY.search(lines[ln - 1]):
                problems.append((f, ln, p, posixpath.normpath(p)))

    def of_host(path):
        return any(path == pre.rstrip("/") or path.startswith(pre) for pre in host_only)

    host = sorted({pr[:3] for pr in problems if of_host(pr[3])})
    real = sorted({pr[:3] for pr in problems if not of_host(pr[3])})
    for f, ln, target in real:
        print("%s:%d\t%s" % (f, ln, target))
    scope = "весь репозиторий" if scan_all else "слой документации"
    if host:
        print("— документы host-проекта (docs_linkcheck.host-only.txt): ссылок %d, код возврата не меняют" % len(host),
              file=sys.stderr)
    print("— %s: висячих ссылок %d" % (scope, len(real)), file=sys.stderr)
    return 1 if real else 0


if __name__ == "__main__":
    sys.exit(main())
