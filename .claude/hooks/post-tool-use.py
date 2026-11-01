#!/usr/bin/env python3
"""
DAMS — PostToolUse hook (matcher: Write|Edit|MultiEdit|NotebookEdit).

Инкрементальная инвалидация RAG-индекса: после реального изменения файла
помечает его записи как stale (точечно, по rag_meta.file_path) и подсказывает
команду частичного rebuild. Инвалидация именно Post (а не Pre) — до успешной
записи индекс актуален.

Fail-safe: любая ошибка → пустой вывод, exit 0.
"""
import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

# Маппинг: паттерн пути → doc_type для подсказки rebuild
INVALIDATION_MAP = [
    ("schema.prisma", "prisma_model"),
    (".proto", "proto_rpc"),
    (".controller.ts", "api_route"),
    (".claude/rules/", "rule_chunk"),
    ("docs/api/", "openapi_endpoint"),
    ("docs/plans/done/", "done_entry"),
    # ролевые папки docs/, которые индексирует index_rebuild.py (DOC_DIRS) — всё как doc_type "spec"
    ("docs/specs/", "spec"),
    ("docs/architecture/", "spec"),
    ("docs/agents/", "spec"),
    ("docs/engineering/", "spec"),
    ("docs/ops/", "spec"),
    ("docs/qa/", "spec"),
    ("docs/plans/roadmap/", "spec"),
    ("docs/i18n/", "spec"),
    ("docs/ai/", "spec"),
]


def main():
    import dams_common as dc

    payload = json.load(sys.stdin)
    if payload.get("tool_name") not in ("Write", "Edit", "MultiEdit", "NotebookEdit"):
        return
    tool_input = payload.get("tool_input") or {}
    fp = tool_input.get("file_path") or tool_input.get("notebook_path") or ""
    if not fp:
        return
    rel = dc.rel_path(fp)

    doc_types = sorted({dt for pattern, dt in INVALIDATION_MAP if pattern in rel})
    if not doc_types:
        return

    conn = dc.open_db()
    if conn is None:
        return  # индекса нет — нечего инвалидировать, hint был бы шумом

    stale = 0
    try:
        cur = conn.execute(
            "UPDATE rag_docs SET status = 'stale' WHERE doc_id IN "
            "(SELECT doc_id FROM rag_meta WHERE file_path = ?) AND status = 'active'",
            (rel,))
        stale = cur.rowcount
        conn.commit()
    except sqlite3.Error:
        pass  # lock/битая БД — не роняем хук, hint всё равно полезен
    finally:
        conn.close()

    # дедуп hint'а: повторные правки того же файла в сессии не раздувают контекст
    session_id = payload.get("session_id") or "unknown"
    state = dc.load_state()
    hinted = state.setdefault(session_id, {}).setdefault("hints", [])
    if rel in hinted and stale == 0:
        dc.save_state(state)
        return
    if rel not in hinted:
        hinted.append(rel)
    dc.save_state(state)

    hint = ("DAMS: %s изменён (%d записей индекса помечено stale). "
            "Обновить срез: `python3 .claude/scripts/index_rebuild.py --type %s`"
            % (rel, stale, ",".join(doc_types)))
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": hint,
        }
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
