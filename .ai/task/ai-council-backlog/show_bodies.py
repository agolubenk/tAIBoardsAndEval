#!/usr/bin/env python3
"""Тела выбранных карточек-кандидатов для кураторского решения."""
import json
import sys

raw = json.load(open('.ai/task/ai-council-backlog/raw.json'))
WANT = [
    "Поиск продуктового развития",
    "background check",
    "agent-reach",
    "MCP Server",
    "DAMS RAG",
    "Notion integration token",
    "TG-AI-CHECK",
    "MI-11",
    "MI-13",
    "TG-RAG-VAC",
    "Workflow Run Detail",
    "WorkflowChatAgentBridge",
    "Native crash",
    "AGT: AI Agents",
    "AGT-ENV",
    "Huntflow migration",
    "RAG-QR",
    "Phase 7 — AI-чат",
    "Phase 11 — MCP",
    "SRC-AI",
    "TG-STT",
    "MI-6",
]
for c in raw:
    t = c.get("title", "")
    if not any(w.lower() in t.lower() for w in WANT):
        continue
    print("=" * 100)
    print(f"[{c['db']}/{c.get('status')}] pr={c.get('priority') or c.get('severity')} hb={c.get('half_baked')} | {t}")
    print(f"URL: {c.get('url')}")
    body = (c.get("body", "") or "")[:1500]
    print(f"BODY: {body}")
    for cm in c.get("comments_text", [])[:3]:
        print(f"  COMMENT: {cm.get('text', '')[:220]}")