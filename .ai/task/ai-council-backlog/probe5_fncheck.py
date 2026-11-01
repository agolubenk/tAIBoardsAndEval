#!/usr/bin/env python3
"""Контрпримерная проверка на ЛОЖНЫЕ ПРОПУСКИ: карточки с предметным маркером консилиума."""
import json
import re

raw = json.load(open('.ai/task/ai-council-backlog/raw.json'))
SUBJ = re.compile(r"(?i)(ai[- ]council|консилиум|council[.]db|infra/ai-council|[.]claude/council|ai-council:plan|council:v1)")

count = 0
for c in raw:
    title = c.get("title", "")
    body = c.get("body", "") or ""
    comments = " | ".join(ct.get("text", "") for ct in c.get("comments_text", []))
    where = []
    for fname, text in (("title", title), ("body", body), ("comments", comments)):
        m = SUBJ.search(text)
        if m:
            s = max(0, m.start() - 60)
            where.append(f"{fname}: …{text[s:m.end() + 80]}…".replace(chr(10), " "))
    if where:
        count += 1
        print(f"[{c['db']}/{c.get('status')}] {c.get('title')[:75]}")
        for w in where[:2]:
            print(f"    {w[:170]}")
print(f"\nВсего карточек с предметным маркером: {count}")
