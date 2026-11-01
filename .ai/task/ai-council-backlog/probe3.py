#!/usr/bin/env python3
"""Контекст упоминаний экосистемных маркеров в телах карточек."""
import json
import re

raw = json.load(open('.ai/task/ai-council-backlog/raw.json'))
MARKERS = [
    r"headroom", r"\bollama\b", r"\bz\.ai\b", r"\bglm\b", r"\bqwen", r"mistral",
    r"\bgemini\b", r"ai-pipeline", r"ai_pipeline", r"dev-ai", r"8788", r"8790",
    r"council\.db", r"supervisor\.py", r"verifier\.py", r"graphify", r"\bdams\b",
    r"rag/index\.db", r"модельн\w* лок", r"keep_alive",
]
for c in raw:
    body = c.get("body", "") or ""
    for pat in MARKERS:
        rx = re.compile(pat, re.I)
        m = rx.search(body)
        if m:
            s = max(0, m.start() - 80)
            ctx = body[s:m.end() + 100].replace(chr(10), " ")
            print(f"[{pat}][{c['db']}/{c.get('status')}] {c.get('title')[:60]}")
            print(f"   …{ctx}…")
            break