"""Shared helpers of the evolution toolkit: a token estimate and a front-matter reader.

Stdlib only. The estimate is the one `eval/tools/context_audit.py` has always used (calibrated on Claude Code
transcripts): Latin text ~3.5 chars per token, Cyrillic ~2.2. It is an estimate for comparing versions and budgets,
not a tokenizer.
"""
import re

FRONT = re.compile(r'\A---\n(.*?)\n---\n?', re.S)


def est_tokens(text):
    if not text:
        return 0
    extra = len(text.encode('utf-8', 'ignore')) - len(text)
    return int((len(text) - extra) / 3.5 + extra / 2.2)


def front_matter(text):
    """(fields, body) of a markdown file with `---` front matter. Only what the layer reads: scalar `key: value`
    lines, folded `key: >` / literal `key: |` blocks and `key:` followed by `  - item` lists.
    Missing front matter → ({}, text)."""
    m = FRONT.match(text)
    if not m:
        return {}, text
    fields, key, block = {}, None, None
    for line in m.group(1).splitlines():
        if block and (line.startswith((' ', '\t')) or not line.strip()):
            # folded `>` / literal `|` scalar: indented continuation lines belong to the key
            sep = '\n' if block == '|' else ' '
            fields[key] = (fields[key] + sep + line.strip()).strip() if fields[key] else line.strip()
            continue
        block = None
        item = re.match(r'\s+-\s+(.*)', line)
        if item and key:
            if not isinstance(fields.get(key), list):
                fields[key] = []
            fields[key].append(item.group(1).strip().strip('"\''))
            continue
        kv = re.match(r'([A-Za-z_][\w-]*):\s*(.*)', line)
        if kv:
            key = kv.group(1)
            value = kv.group(2).strip()
            if value in ('>', '|', '>-', '|-', '>+', '|+'):
                block, fields[key] = value[0], ''
            else:
                fields[key] = value.strip('"\'')
    return fields, text[m.end():]
