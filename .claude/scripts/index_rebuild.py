#!/usr/bin/env python3
"""
DAMS — полный/частичный rebuild SQLite FTS5 RAG-индекса (.claude/rag/index.db).

Usage:
  python3 .claude/scripts/index_rebuild.py                      # полный rebuild
  python3 .claude/scripts/index_rebuild.py --clean              # drop + rebuild
  python3 .claude/scripts/index_rebuild.py --type prisma_model  # только Prisma
  python3 .claude/scripts/index_rebuild.py --type api_route,proto_rpc

doc_type: prisma_model | proto_rpc | api_route | rule_chunk | spec | openapi_endpoint
"""
import argparse
import hashlib
import json
import re
import sqlite3
import time
from pathlib import Path

from dams_common import REPO_ROOT, DB_PATH, est_tokens

SCHEMA = """
CREATE VIRTUAL TABLE IF NOT EXISTS rag_docs USING fts5(
  doc_id, doc_type, module, title, content, metadata UNINDEXED, tags, status,
  tokenize="porter unicode61"
);
CREATE TABLE IF NOT EXISTS rag_meta (
  doc_id TEXT PRIMARY KEY,
  doc_type TEXT,
  file_path TEXT NOT NULL,
  file_sha TEXT,
  last_indexed_at INTEGER,
  token_count INTEGER,
  version INTEGER DEFAULT 1,
  superseded_by TEXT
);
CREATE TABLE IF NOT EXISTS rag_query_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL,
  source TEXT,
  results_count INTEGER,
  top_doc_id TEXT,
  session_id TEXT,
  created_at INTEGER
);
"""

EXCLUDE_PARTS = {"node_modules", "_legacy", "dist", "generated", ".git", "worktrees"}

KNOWN_MODULE_DIRS = None  # ленивая инициализация из apps/backend/src/modules/*


def sha16(text):
    return hashlib.sha1(text.encode("utf-8", "replace")).hexdigest()[:16]


def excluded(path):
    return any(part in EXCLUDE_PARTS for part in path.parts)


def infer_module_from_name(name):
    n = name.lower()
    table = [
        (("candidate", "vacanc", "recruit", "ats", "applica", "sourcing", "hiring"), "recruiting"),
        (("telegram", "mtproto", "gram"), "telegram"),
        (("agent", "mcp", "automation", "trigger", "hitl"), "agents"),
        (("auth", "jwt", "token", "account", "user", "company", "rbac"), "auth"),
        (("interview", "calendar"), "interviews"),
        (("mobile", "android", "kotlin"), "mobile"),
        (("workflow", "flow"), "workflow"),
        (("wiki", "knowledge"), "wiki"),
        (("huntflow",), "huntflow"),
        (("okr", "evaluat", "survey", "learning", "onboard", "retention", "workforce", "benchmark", "payroll", "comp"), "hrops"),
        (("notification", "sse", "socket", "outbox", "realtime"), "realtime"),
        (("search",), "search"),
    ]
    for keys, module in table:
        if any(k in n for k in keys):
            return module
    return "core"


def infer_module_from_path(path):
    global KNOWN_MODULE_DIRS
    if KNOWN_MODULE_DIRS is None:
        mdir = REPO_ROOT / "apps/backend/src/modules"
        KNOWN_MODULE_DIRS = {p.name for p in mdir.iterdir() if p.is_dir()} if mdir.exists() else set()
    parts = Path(path).parts
    for i, part in enumerate(parts):
        if part == "modules" and i + 1 < len(parts) and parts[i + 1] in KNOWN_MODULE_DIRS:
            return parts[i + 1]
    return infer_module_from_name(str(path))


def init_db(conn):
    conn.executescript(SCHEMA)
    conn.commit()


def clear_type(conn, doc_type):
    conn.execute("DELETE FROM rag_docs WHERE doc_type = ?", (doc_type,))
    conn.execute("DELETE FROM rag_meta WHERE doc_type = ?", (doc_type,))


def upsert_doc(conn, doc):
    conn.execute("DELETE FROM rag_docs WHERE doc_id = ?", (doc["doc_id"],))
    conn.execute(
        "INSERT INTO rag_docs (doc_id, doc_type, module, title, content, metadata, tags, status) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (doc["doc_id"], doc["doc_type"], doc["module"], doc["title"], doc["content"],
         json.dumps(doc.get("metadata", {}), ensure_ascii=False),
         " ".join(doc.get("tags", [])), doc.get("status", "active")),
    )
    conn.execute(
        "INSERT OR REPLACE INTO rag_meta (doc_id, doc_type, file_path, file_sha, last_indexed_at, token_count) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (doc["doc_id"], doc["doc_type"], doc.get("file_path", ""),
         sha16(doc["content"]), int(time.time()), est_tokens(doc["content"])),
    )


# ---------------------------------------------------------------- Prisma

def index_prisma(conn):
    schema_path = REPO_ROOT / "apps/backend/prisma/schema.prisma"
    if not schema_path.exists():
        print("  WARN: apps/backend/prisma/schema.prisma не найден")
        return
    content = schema_path.read_text(encoding="utf-8")
    rel = "apps/backend/prisma/schema.prisma"
    count = 0
    for kind, name, body in re.findall(r"(model|enum)\s+(\w+)\s*\{([^}]*)\}", content):
        module = infer_module_from_name(name)
        upsert_doc(conn, {
            "doc_id": "prisma:%s" % name,
            "doc_type": "prisma_model",
            "module": module,
            "title": "Prisma %s: %s" % (kind, name),
            "content": "%s %s {\n%s\n}" % (kind, name, body.strip()),
            "tags": [module, "database", "prisma", kind, name.lower()],
            "metadata": {"kind": kind, "name": name},
            "file_path": rel,
        })
        count += 1
    print("  Prisma: %d моделей/enum" % count)


# ---------------------------------------------------------------- Proto

def _service_blocks(content):
    """Выделяет service-блоки с учётом вложенных скобок."""
    for m in re.finditer(r"service\s+(\w+)\s*\{", content):
        depth, i = 1, m.end()
        while i < len(content) and depth:
            if content[i] == "{":
                depth += 1
            elif content[i] == "}":
                depth -= 1
            i += 1
        yield m.group(1), content[m.end():i - 1]


def index_proto(conn):
    proto_dir = REPO_ROOT / "packages/proto"
    if not proto_dir.exists():
        print("  WARN: packages/proto не найден")
        return
    count = 0
    rpc_re = re.compile(
        r"rpc\s+(\w+)\s*\(\s*(stream\s+)?([\w.]+)\s*\)\s*returns\s*\(\s*(stream\s+)?([\w.]+)\s*\)")
    for pf in sorted(proto_dir.rglob("*.proto")):
        if excluded(pf.relative_to(REPO_ROOT)):
            continue
        rel = str(pf.relative_to(REPO_ROOT))
        content = pf.read_text(encoding="utf-8")
        for service, block in _service_blocks(content):
            module = infer_module_from_name(service)
            for rm in rpc_re.finditer(block):
                rpc, req_s, req, res_s, res = rm.groups()
                sig = "rpc %s(%s%s) returns (%s%s)" % (
                    rpc, req_s or "", req, res_s or "", res)
                upsert_doc(conn, {
                    "doc_id": "proto:%s.%s" % (service, rpc),
                    "doc_type": "proto_rpc",
                    "module": module,
                    "title": "RPC %s.%s" % (service, rpc),
                    "content": "%s\nservice %s · %s" % (sig, service, rel),
                    "tags": [module, "rpc", "connect", service.lower(), rpc.lower()],
                    "metadata": {"service": service, "rpc": rpc,
                                 "request": req, "response": res},
                    "file_path": rel,
                })
                count += 1
    print("  Proto: %d RPC-методов" % count)


# ---------------------------------------------------------------- NestJS routes

CTRL_RE = re.compile(
    r"@Controller\(\s*(?:['\"]([^'\"]*)['\"]|\{[^}]*?path\s*:\s*['\"]([^'\"]*)['\"][^}]*\})?\s*\)")
METHOD_RE = re.compile(r"@(Get|Post|Put|Delete|Patch)\s*\(\s*(?:['\"]([^'\"]*)['\"])?\s*\)")
DECOR_RE = re.compile(r"@\w+\s*\((?:[^()]|\([^()]*\))*\)\s*", re.DOTALL)
NAME_RE = re.compile(
    r"(?:public\s+|protected\s+|private\s+)?(?:async\s+)?([A-Za-z_]\w*)\s*[<(]")


def _global_prefix():
    boot = REPO_ROOT / "apps/backend/src/app/bootstrap/bootstrap-app.ts"
    if boot.exists():
        m = re.search(r"setGlobalPrefix\(['\"]([^'\"]+)['\"]", boot.read_text(encoding="utf-8"))
        if m:
            return m.group(1)
    return "api/v1"


def index_routes(conn):
    src = REPO_ROOT / "apps/backend/src"
    if not src.exists():
        print("  WARN: apps/backend/src не найден")
        return
    prefix = _global_prefix()
    count = 0
    for cf in sorted(src.rglob("*.controller.ts")):
        relp = cf.relative_to(REPO_ROOT)
        if excluded(relp):
            continue
        rel = str(relp)
        content = cf.read_text(encoding="utf-8")
        cm = CTRL_RE.search(content)
        base = (cm.group(1) or cm.group(2) or "") if cm else ""
        module = infer_module_from_path(rel)
        for m in METHOD_RE.finditer(content):
            method, sub = m.group(1).upper(), m.group(2) or ""
            tail = DECOR_RE.sub("", content[m.end(): m.end() + 800])
            nm = NAME_RE.search(tail)
            handler = nm.group(1) if nm else "?"
            full = "/" + "/".join(p for p in (prefix, base, sub) if p)
            full = re.sub(r"/{2,}", "/", full)
            upsert_doc(conn, {
                "doc_id": "route:%s %s" % (method, full),
                "doc_type": "api_route",
                "module": module,
                "title": "%s %s → %s" % (method, full, handler),
                "content": "%s %s\nhandler: %s\n%s" % (method, full, handler, rel),
                "tags": [module, "api", "rest", method.lower()] + ([base] if base else []),
                "metadata": {"method": method, "path": full, "handler": handler},
                "file_path": rel,
            })
            count += 1
    print("  Routes: %d REST-роутов (prefix /%s)" % (count, prefix))


# ---------------------------------------------------------------- Markdown (rules / specs / reference)

def _strip_frontmatter(content):
    if content.startswith("---"):
        end = content.find("\n---", 3)
        if end != -1:
            return content[end + 4:]
    return content


def _index_md_sections(conn, md_file, doc_type, id_prefix, extra_tags, max_len=1500, id_stem=None):
    rel = str(md_file.relative_to(REPO_ROOT))
    content = _strip_frontmatter(md_file.read_text(encoding="utf-8"))
    module = infer_module_from_name(md_file.stem)
    stem = id_stem or md_file.stem
    sections = re.split(r"^##\s+", content, flags=re.MULTILINE)
    count = 0
    for i, section in enumerate(sections):
        if not section.strip():
            continue
        nl = section.find("\n")
        title = section[:nl].strip().lstrip("#").strip() if nl > 0 else section[:60]
        body = section[nl:].strip() if nl > 0 else section
        if not body:
            continue
        upsert_doc(conn, {
            "doc_id": "%s:%s:%d" % (id_prefix, stem, i),
            "doc_type": doc_type,
            "module": module,
            "title": "[%s] %s" % (stem, title or stem),
            "content": body[:max_len],
            "tags": [module] + extra_tags + [md_file.stem],
            "file_path": rel,
        })
        count += 1
    return count


def index_rules(conn):
    rules_dir = REPO_ROOT / ".claude/rules"
    count = 0
    for rf in sorted(rules_dir.glob("*.md")):
        count += _index_md_sections(conn, rf, "rule_chunk", "rule", ["rule"])
    print("  Rules: %d секций" % count)


# Ролевые папки docs/ (карта — docs/README.md). recursive=True — с подпапками; подпапки,
# индексируемые своей строкой (architecture/reference), исключаются из родителя.
# Не индексируются: ролевые CLAUDE.md (это инструкции, не знания), plans/DONE.md,
# plans/BACKLOG.md и plans/archive/ (история/снимки), legal/, design/ (макеты HTML).
DOC_DIRS = (
    ("docs/specs", "spec", False),
    ("docs/architecture/reference", "reference", False),
    ("docs/agents", "agents", False),
    ("docs/architecture", "architecture", True),
    ("docs/engineering", "engineering", True),
    ("docs/ops", "ops", True),
    ("docs/qa", "qa", False),
    ("docs/plans/roadmap", "roadmap", False),
    ("docs/i18n", "i18n", False),
    ("docs/ai", "ai", False),
)


def index_specs(conn):
    count = 0
    own_dirs = {REPO_ROOT / d for d, _, _ in DOC_DIRS}
    for d_rel, tag, recursive in DOC_DIRS:
        d = REPO_ROOT / d_rel
        if not d.exists():
            continue
        files = d.rglob("*.md") if recursive else d.glob("*.md")
        for mf in sorted(files):
            if mf.name == "CLAUDE.md":
                continue
            if recursive and any(o != d and o in mf.parents for o in own_dirs):
                continue
            id_stem = str(mf.relative_to(d).with_suffix("")) if recursive else None
            count += _index_md_sections(conn, mf, "spec", tag, [tag], max_len=1200, id_stem=id_stem)
    print("  Docs (specs/reference/agents/architecture/engineering/ops/qa/roadmap/i18n/ai): %d секций" % count)


def index_openapi(conn):
    api_dir = REPO_ROOT / "docs/api"
    if not api_dir.exists():
        return
    count = 0
    ep_re = re.compile(r"#{2,4}\s+`?(GET|POST|PUT|DELETE|PATCH)\s+(/[^\s\n`]+)`?")
    for mf in sorted(api_dir.rglob("*.md")):
        rel = str(mf.relative_to(REPO_ROOT))
        content = mf.read_text(encoding="utf-8")
        source = "huntflow" if "huntflow" in mf.name.lower() else "hh"
        for m in ep_re.finditer(content):
            method, path = m.group(1), m.group(2)
            snippet = content[m.start(): m.start() + 600]
            upsert_doc(conn, {
                "doc_id": "%s:%s %s" % (source, method, path),
                "doc_type": "openapi_endpoint",
                "module": source,
                "title": "%s API: %s %s" % (source.upper(), method, path),
                "content": snippet,
                "tags": [source, "external", "api", method.lower()],
                "metadata": {"method": method, "path": path, "source": source},
                "file_path": rel,
            })
            count += 1
        # Markdown-доки docs/api (README, tokens/sync canon) — ещё и посекционно
        count_sections = _index_md_sections(conn, mf, "openapi_endpoint", "apidoc", ["external", source], max_len=1200)
        count += count_sections
    print("  External API docs: %d записей" % count)


def index_done(conn):
    """Канон закрытого: docs/plans/done/<модуль>.md (оглавление docs/plans/DONE.md записей не содержит).

    Одна запись «- **…** (…) — …» = один документ: запрос «делали ли уже» должен вернуть 1–3 записи, а не
    секцию на десятки килобайт. Контекст — модуль (имя файла) и ближайший заголовок ##–####; продолжение
    записи — строки с отступом под ней.
    """
    done_dir = REPO_ROOT / "docs/plans/done"
    if not done_dir.exists():
        return
    total = 0
    for path in sorted(done_dir.rglob("*.md")):
        rel = str(path.relative_to(REPO_ROOT))
        module_name = path.stem if path.parent == done_dir else "%s/%s" % (path.parent.name, path.stem)
        section, entry, entries = "", None, []
        for line in path.read_text(encoding="utf-8").split("\n"):
            heading = re.match(r"^(#{2,4})\s+(.+)$", line)
            if heading:
                if entry:
                    entries.append(entry)
                    entry = None
                section = heading.group(2).strip()
                continue
            if line.startswith("- **"):
                if entry:
                    entries.append(entry)
                entry = {"section": section, "lines": [line[2:]]}
            elif entry and line.startswith("  ") and line.strip():
                entry["lines"].append(line.strip())
            elif entry and not line.strip():
                entries.append(entry)
                entry = None
        if entry:
            entries.append(entry)
        seen = {}
        for e in entries:
            text = " ".join(e["lines"])
            m = re.match(r"\*\*(.+?)\*\*", text)
            title = m.group(1) if m else text[:80]
            key = hashlib.sha1((module_name + "|" + e["section"] + "|" + title).encode("utf-8")).hexdigest()[:10]
            seen[key] = seen.get(key, 0) + 1
            module = infer_module_from_name(module_name + " " + e["section"] + " " + title)
            upsert_doc(conn, {
                "doc_id": "done:%s:%d" % (key, seen[key]),
                "doc_type": "done_entry",
                "module": module,
                "title": "[DONE · %s · %s] %s" % (module_name, e["section"][:40], title[:160]),
                "content": text[:1500],
                "tags": [module, "done", module_name],
                "file_path": rel,
            })
        total += len(entries)
    print("  DONE (docs/plans/done): %d записей" % total)


# ---------------------------------------------------------------- main

INDEXERS = {
    "prisma_model": index_prisma,
    "proto_rpc": index_proto,
    "api_route": index_routes,
    "rule_chunk": index_rules,
    "spec": index_specs,
    "openapi_endpoint": index_openapi,
    "done_entry": index_done,
}


def main():
    parser = argparse.ArgumentParser(description="DAMS RAG index rebuild")
    parser.add_argument("--type", help="Comma-separated doc types (default: все)")
    parser.add_argument("--clean", action="store_true", help="Drop и пересоздать БД")
    args = parser.parse_args()

    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))

    if args.clean:
        conn.executescript(
            "DROP TABLE IF EXISTS rag_docs; DROP TABLE IF EXISTS rag_meta;")
    init_db(conn)

    types = set(args.type.split(",")) if args.type else set(INDEXERS)
    unknown = types - set(INDEXERS)
    if unknown:
        parser.error("Неизвестные типы: %s. Доступны: %s" % (unknown, sorted(INDEXERS)))

    for t in sorted(types):
        clear_type(conn, t)
        INDEXERS[t](conn)

    conn.execute("INSERT INTO rag_docs(rag_docs) VALUES('optimize')")
    conn.commit()

    total = conn.execute("SELECT COUNT(*) FROM rag_docs WHERE status='active'").fetchone()[0]
    by_type = conn.execute(
        "SELECT d.doc_type, COUNT(*), COALESCE(SUM(m.token_count),0) FROM rag_docs d "
        "JOIN rag_meta m ON m.doc_id = d.doc_id WHERE d.status='active' "
        "GROUP BY d.doc_type ORDER BY 2 DESC").fetchall()
    conn.close()

    print("\nRAG index готов: %d активных документов (%s)" % (total, DB_PATH))
    for dt, cnt, tok in by_type:
        print("  %-18s %5d docs  ~%dk tokens" % (dt, cnt, tok // 1000))


if __name__ == "__main__":
    main()
