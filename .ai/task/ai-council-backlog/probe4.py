#!/usr/bin/env python3
"""Финальный свип: заголовки с тулинг-лексикой (рус.), чтобы поймать ненайденное."""
import json
import re

raw = json.load(open('.ai/task/ai-council-backlog/raw.json'))
rx = re.compile(r"(?i)(инструмент|дашборд|пайплайн|тулинг|консили|верификат|супервизор|шлюз|ollama|llama|локальн\w+ модел|dev-ai|сесси\w+ контекст)")
for c in raw:
    t = c.get("title", "")
    if rx.search(t):
        print(f"[{c['db']}/{c.get('status')}] {str(c.get('priority') or c.get('severity')):8s} {t[:100]}")