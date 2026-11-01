#!/usr/bin/env python3
"""Точные поля финального набора карточек для BACKLOG.md (без фабрикаций)."""
import json

raw = json.load(open('.ai/task/ai-council-backlog/raw.json'))
WANT = [
    "DAMS RAG",
    "Notion integration token",
    "agent-reach",
    "Баг Telegram",
    "Безопасность файлового контура",
    "Link Builder",
    "Поиск продуктового развития",
    "background check",
    "Workflow Run Detail",
    "WorkflowChatAgentBridge",
    "Native crash",
]
for c in raw:
    t = c.get("title", "")
    if not any(w.lower() in t.lower() for w in WANT):
        continue
    print(json.dumps({
        "db": c["db"], "title": t, "status": c.get("status"),
        "pr": c.get("priority") or c.get("severity"), "task_type": c.get("task_type"),
        "modules": json.loads(c.get("modules", "[]") or "[]"),
        "tags": json.loads(c.get("tags", "[]") or "[]"),
        "half_baked": c.get("half_baked"), "backlog_id": c.get("backlog_id"),
        "edited": c.get("notion_edited_at"), "url": c.get("url"),
    }, ensure_ascii=False))