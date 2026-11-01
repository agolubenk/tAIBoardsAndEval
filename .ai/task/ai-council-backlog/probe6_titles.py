#!/usr/bin/env python3
import json
import re

raw = json.load(open('.ai/task/ai-council-backlog/raw.json'))
rx = re.compile(r"(?i)(gateway|supervisor|planner|dashboard|дашборд|шлюз|супервизор|verifier|верификатор|провайдер)")
for c in raw:
    if rx.search(c.get("title", "")):
        print(f"[{c['db']}/{c.get('status')}] {c.get('title')[:100]}")