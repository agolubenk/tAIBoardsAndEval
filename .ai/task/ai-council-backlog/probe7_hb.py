#!/usr/bin/env python3
import json

raw = json.load(open('.ai/task/ai-council-backlog/raw.json'))
print('half_baked=1 сейчас:')
for c in raw:
    if c.get('half_baked'):
        print(f"  [{c['db']}/{c.get('status')}] {c.get('title')[:90]}")
print('\nagent-reach точно:')
for c in raw:
    if 'agent-reach' in c.get('title', ''):
        print(f"  half_baked={c.get('half_baked')} status={c.get('status')} edited={c.get('notion_edited_at')}")