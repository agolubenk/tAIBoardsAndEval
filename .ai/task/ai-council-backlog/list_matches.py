#!/usr/bin/env python3

import json

ms = json.load(open('.ai/task/ai-council-backlog/matches.json'))
for i, m in enumerate(ms):
    ev = ','.join(sorted({e['pattern'] for e in m['evidence_core'] + m['evidence_eco']})[:6])
    print(f"{i:2d} [{m['verdict']:6s}] {m['db']:5s} {str(m['status'])[:18]:18s} {str(m['priority'] or m['severity']):4s} {m['title'][:80]}")
    print(f"    модули={','.join(m['modules']) or '-'} | улики: {ev[:150]}")
