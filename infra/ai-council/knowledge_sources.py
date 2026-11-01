#!/usr/bin/env python3
"""AI Council — источники «единых знаний ИИ-сервисов». Только stdlib.

Канон: docs/specs/ai-council.md §6 «Единые знания ИИ-сервисов (2026-10-09)».

До 2026-10-09 консилиум читал из знаний проекта только `.claude/{rules,agents,skills,
memory/chunks}`. Остальные ИИ-клиенты (Claude Code, Continue, Copilot/Codex/Roo/Kimi через
MCP-хаб) живут ещё на четырёх слоях, которых консилиум не видел:

* `role` — карточки ролей `CLAUDE.md` по всему дереву + `AGENTS.md`: «кто ты в этом месте
  репозитория», логика решений и гейт каталога;
* `client_rule` — правила Continue `.continue/rules/*.md` (облачный бюджет, ротация моделей,
  адверсариальная проверка);
* `memory` — авто-память Claude Code проекта ВНЕ репозитория
  (`~/.claude/projects/<id>/memory/*.md`): решения и уроки прошлых сессий;
* `mem_obs` — решения из межсессионной памяти claude-mem (`~/.claude-mem/claude-mem.db`).

Два последних не проходили ревью коммита и могут содержать что угодно, а капсула в профиле
hybrid/cloud уходит в облако (Z.AI). Поэтому всё, что читается снаружи репозитория, проходит
`scrub()`, а из claude-mem берутся только решения этого проекта за окно — без типов
security_*/sensitive и без записей, где речь о PII, дампах, паролях и ключах (граница
приватности — knowledge_external.py).
"""
from __future__ import annotations

import fnmatch
import os
import re
from pathlib import Path

from knowledge_external import is_denied_type, read_observations, scrub
from store import REPO_ROOT, sha16

# Каталоги, которые не обходятся никогда. Обрезка — на входе в os.walk, а не фильтром
# результата: rglob от корня сначала обошёл бы node_modules и worktrees целиком.
DEFAULT_EXCLUDE_DIRS = frozenset({
    ".git", "node_modules", "worktrees", "prototipes", "artifacts", "dist", "build",
    "coverage", ".turbo", ".next", "__pycache__", ".venv", "venv", ".gradle", "Pods",
    "DerivedData", ".idea", ".serena", ".cache", "graphify-out", "test-results",
    ".playwright-mcp", ".ruff_cache",
})

# Виды, которые наполняются НЕ отсюда. Источник знаний с таким kind запрещён: чистка
# исчезнувших документов по виду стёрла бы карточки борда или закрытое.
RESERVED_KINDS = frozenset({"card", "done_md", "exemplar", "session", "graph_node"})

PRUNE_LIMIT = 200            # не больше стольких удалений за проход на вид — чистка ограничена


# ── пути ─────────────────────────────────────────────────────────────────────
def main_checkout_root(repo_root: Path = REPO_ROOT) -> Path:
    """Корень основного чекаута. В git worktree `.git` — файл `gitdir: <main>/.git/worktrees/<имя>`;
    без этого консилиум из worktree (selftest, разработка) искал бы память Claude Code под
    id worktree, которого у Claude Code обычно нет."""
    dot_git = repo_root / ".git"
    if not dot_git.is_file():
        return repo_root
    try:
        line = dot_git.read_text(encoding="utf-8").strip()
    except OSError:
        return repo_root
    if not line.startswith("gitdir:"):
        return repo_root
    gitdir = Path(line[len("gitdir:"):].strip())
    if not gitdir.is_absolute():
        gitdir = (repo_root / gitdir).resolve()
    if gitdir.parent.name == "worktrees" and gitdir.parent.parent.name == ".git":
        return gitdir.parent.parent.parent
    return repo_root


def claude_project_id(root: Path) -> str:
    """Id проекта Claude Code: абсолютный путь, где всё, кроме [A-Za-z0-9], заменено на `-`
    (`/Users/x/HR_Helper-v2` → `-Users-x-HR-Helper-v2` — подчёркивание тоже). Имя
    пользователя не зашивается в конфиг: оно выводится из пути репозитория."""
    return re.sub(r"[^A-Za-z0-9]", "-", str(root))


def expand_path(raw: str, repo_root: Path = REPO_ROOT) -> list[Path]:
    """Кандидаты пути источника по порядку предпочтения. `~` и абсолютные — как есть,
    относительные — от корня репозитория. `{claude_project_id}` раскрывается сначала для
    основного чекаута (память проекта копится там; у worktree своя обычно пуста или
    отсутствует), затем для текущего корня."""
    raw = str(raw or "").strip()
    if not raw:
        return []
    roots = [repo_root]
    if "{claude_project_id}" in raw:
        main = main_checkout_root(repo_root)
        if main != repo_root:
            roots.insert(0, main)
    out: list[Path] = []
    for root in roots:
        p = Path(os.path.expanduser(raw.replace("{claude_project_id}", claude_project_id(root))))
        p = p if p.is_absolute() else repo_root / p
        if p not in out:
            out.append(p)
    return out


def resolve_root(raw: str, repo_root: Path = REPO_ROOT) -> Path | None:
    candidates = expand_path(raw, repo_root)
    for p in candidates:
        if p.exists():
            return p
    return candidates[0] if candidates else None


def is_external(path: Path, repo_root: Path = REPO_ROOT) -> bool:
    try:
        path.resolve().relative_to(repo_root.resolve())
        return False
    except ValueError:
        return True


def display_ref(path: Path, repo_root: Path = REPO_ROOT) -> str:
    """Стабильная ссылка на файл — основа doc_id. В репозитории — относительный путь (как
    было: doc_id существующих видов не меняется, эмбеддинги не пересчитываются), снаружи —
    абсолютный с `~` вместо домашнего каталога."""
    try:
        return path.relative_to(repo_root).as_posix()
    except ValueError:
        pass
    home, text = Path.home().as_posix(), path.as_posix()
    return "~" + text[len(home):] if text == home or text.startswith(home + "/") else text


def _as_list(value) -> list[str]:
    if value is None or value == "":
        return []
    if isinstance(value, str):
        return [value]
    return [str(v) for v in value]


def _int(spec: dict, key: str, default: int) -> int:
    try:
        return max(0, int(spec.get(key, default)))
    except (TypeError, ValueError):
        return default


def iter_source_files(root: Path, globs=("*.md",), exclude=(), recursive: bool = True,
                      max_files: int = 2000) -> tuple[list[Path], bool]:
    """Файлы источника (отсортированы) и признак «обрезано по max_files».

    `glob` — шаблоны fnmatch по ИМЕНИ файла (`CLAUDE.md`, `*.md`); `exclude` — шаблоны по
    имени каталога/файла или по пути относительно корня источника. DEFAULT_EXCLUDE_DIRS
    отрезаются всегда, симлинки не обходятся (os.walk по умолчанию — защита от циклов)."""
    if root.is_file():
        return [root], False
    if not root.is_dir():
        return [], False
    patterns = _as_list(globs) or ["*.md"]
    excludes = _as_list(exclude)

    def excluded(name: str, rel: str) -> bool:
        return any(fnmatch.fnmatch(name, p) or fnmatch.fnmatch(rel, p) for p in excludes)

    found: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root):
        base = Path(dirpath)
        rel_dir = base.relative_to(root).as_posix()
        rel_dir = "" if rel_dir == "." else rel_dir + "/"
        if recursive:
            dirnames[:] = [d for d in dirnames if d not in DEFAULT_EXCLUDE_DIRS
                           and not excluded(d, rel_dir + d)]
        else:
            dirnames[:] = []
        for name in filenames:
            if any(fnmatch.fnmatch(name, g) for g in patterns) \
                    and not excluded(name, rel_dir + name):
                found.append(base / name)
    found.sort()
    return found[:max_files], len(found) > max_files


# ── файловые источники ───────────────────────────────────────────────────────
def parse_frontmatter(text: str) -> tuple[dict, str]:
    """YAML-шапка `---…---` → (плоский словарь ключ→строка, тело без шапки). Вложенные
    ключи (`metadata:\\n  type: feedback`) поднимаются наверх, если такого ключа там нет;
    блочное значение (`description: >-` + строки с отступом, как в `.continue/rules`)
    склеивается в строку — иначе заголовком документа стал бы сам маркер `>-`."""
    if not text.startswith("---"):
        return {}, text
    lines = text.splitlines()
    for end in range(1, min(len(lines), 120)):
        if lines[end].strip() == "---":
            meta: dict = {}
            head, i = lines[1:end], 0
            while i < len(head):
                m = re.match(r"^(\s*)([A-Za-z_][\w-]*)\s*:\s*(.*)$", head[i])
                i += 1
                if not m:
                    continue
                value = m.group(3).strip()
                if value[:1] in (">", "|") and len(value) <= 2:      # блочное значение
                    block = []
                    while i < len(head) and (not head[i].strip() or len(head[i]) - len(
                            head[i].lstrip()) > len(m.group(1))):
                        block.append(head[i].strip())
                        i += 1
                    value = " ".join(b for b in block if b)
                if m.group(2) not in meta:
                    meta[m.group(2)] = value.strip("\"'")
            return meta, "\n".join(lines[end + 1:]).lstrip("\n")
    return {}, text


def _file_label(path: Path, repo_root: Path, title_from: str, meta: dict) -> str:
    if title_from == "frontmatter":
        return meta.get("description") or meta.get("name") or path.stem
    if title_from == "dir":
        # 37 файлов `CLAUDE.md` с меткой «CLAUDE» неразличимы: роль — это каталог
        try:
            rel = path.parent.relative_to(repo_root).as_posix()
        except ValueError:
            rel = path.parent.name
        return f"{'корень репозитория' if rel in ('', '.') else rel}/{path.name}"
    return path.stem


def index_file_source(store, spec: dict, upsert, split, repo_root: Path = REPO_ROOT) -> dict:
    """Один `[[sources.knowledge.paths]]`: файлы → секции → upsert. Возвращает статистику
    и множество увиденных doc_id (для чистки исчезнувших)."""
    kind = str(spec.get("kind") or "knowledge")
    stat = {"kind": kind, "enabled": True, "ok": False, "files": 0, "docs": 0,
            "changed": 0, "skipped": 0, "truncated": False, "seen": set()}
    root = resolve_root(str(spec.get("path") or ""), repo_root)
    if root is None or not root.exists():
        return stat
    external = is_external(root, repo_root)
    do_scrub = external or bool(spec.get("scrub", False))      # снаружи — всегда
    files, truncated = iter_source_files(
        root, spec.get("glob") or "*.md", spec.get("exclude") or (),
        recursive=bool(spec.get("recursive", True)), max_files=_int(spec, "max_files", 2000))
    max_docs = _int(spec, "max_docs", 1500)
    max_bytes = _int(spec, "max_file_bytes", 256 * 1024)
    skip_types = {t.lower() for t in _as_list(spec.get("skip_types"))}
    title_from = str(spec.get("title_from") or "stem")
    for path in files:
        if stat["docs"] >= max_docs:
            truncated = True
            break
        try:
            if path.stat().st_size > max_bytes:
                stat["skipped"] += 1
                continue
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            stat["skipped"] += 1
            continue
        meta: dict = {}
        if spec.get("frontmatter"):
            meta, text = parse_frontmatter(text)
            if str(meta.get("type", "")).lower() in skip_types:
                stat["skipped"] += 1
                continue
        stat["files"] += 1
        ref = display_ref(path, repo_root)
        label = _file_label(path, repo_root, title_from, meta)
        if do_scrub:
            label = scrub(label)
        for index, (section, body) in enumerate(split(text)):
            if stat["docs"] >= max_docs:
                truncated = True
                break
            if do_scrub:
                section, body = scrub(section), scrub(body)
            doc_id = f"{kind}:{sha16(ref)}:{index}"
            title = f"[{kind}] {label}" + (f" — {section}" if section else "")
            stat["seen"].add(doc_id)
            stat["docs"] += 1
            if upsert(store, doc_id, kind, title, body, source_ref=f"{ref}#{index}"):
                stat["changed"] += 1
    stat["ok"], stat["truncated"] = True, truncated
    return stat


def read_claude_mem(mem_cfg: dict, repo_root: Path = REPO_ROOT,
                    now_s: float | None = None) -> tuple[list[dict], str]:
    """`[sources.knowledge.claude_mem]` → документы. Проект по умолчанию — имя основного
    чекаута (так claude-mem называет проект), путь — с `~`. Чтение — knowledge_external."""
    if not mem_cfg or not mem_cfg.get("enabled", False):
        return [], "disabled"
    path = resolve_root(str(mem_cfg.get("path") or "~/.claude-mem/claude-mem.db"), repo_root)
    if path is None:
        return [], "absent"
    return read_observations(
        path, str(mem_cfg.get("project") or main_checkout_root(repo_root).name),
        _as_list(mem_cfg.get("types") or ["decision"]),
        window_days=_int(mem_cfg, "window_days", 45), max_docs=_int(mem_cfg, "max_docs", 120),
        timeout=float(mem_cfg.get("timeout_seconds", 2) or 2), now_s=now_s)


# ── всё вместе ───────────────────────────────────────────────────────────────
def prune_kind(store, kind: str, seen: set, limit: int = PRUNE_LIMIT) -> int:
    """Удалить документы вида, которых не было в полном проходе. Ограничено `limit` за проход
    и запрещено для видов, которые наполняются не отсюда (карточки, закрытое, граф)."""
    if kind in RESERVED_KINDS:
        return 0
    rows = store.q("SELECT doc_id FROM corpus_meta WHERE kind = ?", (kind,))
    stale = [r["doc_id"] for r in rows if r["doc_id"] not in seen][:max(limit, 0)]
    for doc_id in stale:
        for table in ("corpus", "corpus_meta", "corpus_vec"):
            store.x(f"DELETE FROM {table} WHERE doc_id = ?", (doc_id,))
    return len(stale)


def index_knowledge(store, cfg, upsert, split, repo_root: Path = REPO_ROOT) -> dict:
    """Все источники знаний + чистка исчезнувших. → {kind: {docs, changed, pruned, …}}.

    Чистка вида — только когда проход по нему полный и надёжный: все включённые источники
    вида доступны и увидено хоть что-то (временно недоступный путь или пустой разбор не
    стирает корпус). Выключенный (`enabled = false`) источник уходит из корпуса целиком:
    владелец, выключивший память, ждёт, что она перестанет попадать в облачную капсулу."""
    by_kind: dict[str, list[dict]] = {}
    for spec in (cfg.get("sources.knowledge.paths") or []):
        kind = str(spec.get("kind") or "knowledge")
        if kind in RESERVED_KINDS:
            continue                                   # валидатор конфига ругается; здесь — страховка
        if spec.get("enabled", True):
            stat = index_file_source(store, spec, upsert, split, repo_root)
        else:
            stat = {"kind": kind, "enabled": False, "ok": False, "docs": 0, "changed": 0,
                    "seen": set()}
        stat["path"] = str(spec.get("path") or "")
        by_kind.setdefault(kind, []).append(stat)

    mem_cfg = cfg.get("sources.knowledge.claude_mem") or {}
    if mem_cfg:
        kind = str(mem_cfg.get("kind") or "mem_obs")
        if kind not in RESERVED_KINDS:
            docs, state = read_claude_mem(mem_cfg, repo_root)
            stat = {"kind": kind, "enabled": state != "disabled", "ok": state == "ok",
                    "docs": len(docs), "changed": 0, "seen": set(), "state": state,
                    "path": str(mem_cfg.get("path") or "")}
            for doc in docs:
                stat["seen"].add(doc["doc_id"])
                if upsert(store, doc["doc_id"], kind, doc["title"], doc["content"],
                          source_ref=doc["source_ref"]):
                    stat["changed"] += 1
            by_kind.setdefault(kind, []).append(stat)

    report: dict = {}
    for kind, stats in by_kind.items():
        active = [s for s in stats if s.get("enabled", True)]
        seen: set = set().union(*(s["seen"] for s in stats))
        pruned = 0
        if not active:
            pruned = prune_kind(store, kind, set())
        elif all(s.get("ok") for s in active) and seen:
            pruned = prune_kind(store, kind, seen)
        report[kind] = {
            "docs": sum(s.get("docs", 0) for s in stats),
            "files": sum(s.get("files", 0) for s in stats),
            "changed": sum(s.get("changed", 0) for s in stats),
            "pruned": pruned,
            "truncated": any(s.get("truncated") for s in stats),
            "state": ", ".join(s.get("state", "ok" if s.get("ok") else
                                     ("disabled" if not s.get("enabled", True) else "absent"))
                               for s in stats),
        }
    return report


def source_listing(cfg, store=None, repo_root: Path = REPO_ROOT) -> list[dict]:
    """Источники знаний для вкладки настроек: путь, есть ли, сколько файлов и документов
    в корпусе. Файлы считаются тем же обходом, что и индексация (с исключениями)."""
    docs_by_kind: dict[str, int] = {}
    if store is not None:
        for row in store.q("SELECT kind, COUNT(*) n FROM corpus_meta GROUP BY kind"):
            docs_by_kind[row["kind"]] = row["n"]
    out: list[dict] = []
    for spec in (cfg.get("sources.knowledge.paths") or []):
        kind = str(spec.get("kind") or "knowledge")
        root = resolve_root(str(spec.get("path") or ""), repo_root)
        exists = bool(root and root.exists())
        files = len(iter_source_files(root, spec.get("glob") or "*.md", spec.get("exclude") or (),
                                      recursive=bool(spec.get("recursive", True)),
                                      max_files=_int(spec, "max_files", 2000))[0]) if exists else 0
        out.append({"kind": kind, "path": spec.get("path"), "exists": exists, "files": files,
                    "unit": "файлов", "docs": docs_by_kind.get(kind, 0),
                    "enabled": bool(spec.get("enabled", True)),
                    "external": bool(root and is_external(root, repo_root))})
    mem_cfg = cfg.get("sources.knowledge.claude_mem") or {}
    if mem_cfg:
        kind = str(mem_cfg.get("kind") or "mem_obs")
        path = resolve_root(str(mem_cfg.get("path") or "~/.claude-mem/claude-mem.db"), repo_root)
        out.append({"kind": kind, "path": mem_cfg.get("path"),
                    "exists": bool(path and path.is_file()), "files": 0, "unit": "БД",
                    "docs": docs_by_kind.get(kind, 0),
                    "enabled": bool(mem_cfg.get("enabled", False)), "external": True})
    return out


def validate(cfg) -> list[str]:
    """Проверки конфига источников знаний (вызывается из config._validate)."""
    problems: list[str] = []
    for i, spec in enumerate(cfg.get("sources.knowledge.paths") or []):
        kind = str(spec.get("kind") or "")
        where = f"sources.knowledge.paths[{i}]"
        if not re.fullmatch(r"[a-z][a-z0-9_]{1,30}", kind):
            problems.append(f"{where}.kind=`{kind}` — нужен идентификатор [a-z0-9_]")
        elif kind in RESERVED_KINDS:
            problems.append(f"{where}.kind=`{kind}` зарезервирован (чистка по виду стёрла бы "
                            f"корпус, который наполняется не отсюда)")
        if not str(spec.get("path") or "").strip():
            problems.append(f"{where}.path не задан")
        for key in ("max_docs", "max_files", "max_file_bytes"):
            if key in spec and (not isinstance(spec[key], int) or spec[key] <= 0):
                problems.append(f"{where}.{key} должен быть целым > 0")
    mem_cfg = cfg.get("sources.knowledge.claude_mem") or {}
    banned = sorted({t for t in _as_list(mem_cfg.get("types")) if is_denied_type(t)})
    if banned:
        problems.append(f"sources.knowledge.claude_mem.types: {banned} не индексируются "
                        f"никогда (приватность) — уберите из списка")
    if str(mem_cfg.get("kind") or "mem_obs") in RESERVED_KINDS:
        problems.append("sources.knowledge.claude_mem.kind зарезервирован")
    return problems
