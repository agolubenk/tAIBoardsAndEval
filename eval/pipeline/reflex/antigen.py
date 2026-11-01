"""П2: «антиген → урок». PreToolUse hook from the genome.

When a tool call matches a known trap, the lesson goes into the context once
per session; the memory files stay where they are, only MEMORY.md shrinks to
the bio. Table: genome/antigens.json. Silent when nothing matches.
Run: python3 -I antigen.py  (hook JSON on stdin)
"""

import json
import os
import re
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
TABLE = os.path.join(HERE, '..', 'genome', 'antigens.json')


def load_table(path=TABLE):
    with open(path, encoding='utf-8') as f:
        rows = json.load(f)
    return [dict(row, tool_re=re.compile(row['tool']), input_re=re.compile(row['pattern'], re.S)) for row in rows]


def matches(table, tool_name, tool_input):
    text = json.dumps(tool_input, ensure_ascii=False)
    return [row for row in table if row['tool_re'].fullmatch(tool_name) and row['input_re'].search(text)]


def state_file(session_id, state_dir=None):
    safe = re.sub(r'[^A-Za-z0-9_-]', '_', session_id or 'unknown')
    root = state_dir or os.path.join(tempfile.gettempdir(), 'supertick-antigen')
    os.makedirs(root, exist_ok=True)
    return os.path.join(root, safe)


def fresh_lessons(hits, path):
    seen = set()
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            seen = {line.strip() for line in f}
    new = [row for row in hits if row['id'] not in seen]
    if new:
        with open(path, 'a', encoding='utf-8') as f:
            f.writelines(row['id'] + '\n' for row in new)
    return new


def respond(event, state_dir=None, table=None):
    hits = matches(table or load_table(), event.get('tool_name', ''), event.get('tool_input', {}))
    if not hits:
        return None
    new = fresh_lessons(hits, state_file(event.get('session_id', ''), state_dir))
    if not new:
        return None
    text = ' '.join(f"Урок «{row['id']}»: {row['lesson']}" for row in new)
    return {'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'additionalContext': text}}


def main():
    try:
        event = json.load(sys.stdin)
    except ValueError:
        return 0
    out = respond(event)
    if out:
        print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
