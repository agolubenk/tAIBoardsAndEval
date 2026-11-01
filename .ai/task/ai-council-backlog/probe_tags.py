#!/usr/bin/env python3
import json

raw = json.load(open('.ai/task/ai-council-backlog/raw.json'))
for c in raw:
    tags = json.loads(c.get('tags', '[]') or '[]')
    if any(t in ('найдено-консилиумом', 'dams', 'ai-council', 'council') for t in tags):
        print(f"[{c['db']}/{c.get('status')}] {','.join(tags)} | {c.get('title')[:80]}")