#!/usr/bin/env python3
"""Catalog of the process layer: every skill, rule, agent, command, role card, launch prompt, hook and the genome
source gets a content hash, a version that grows by itself on each change, and its token weight — full and in the
always-loaded context (L1) of each role genome.

    python3 -I eval/evolve/catalog.py              # what changed since the lock, versions, L1 per role
    python3 -I eval/evolve/catalog.py --write      # bump versions of changed artifacts, append to history.jsonl
    python3 -I eval/evolve/catalog.py --check      # CI: lock is fresh and no role L1 grew past its budget (exit 1)
    python3 -I eval/evolve/catalog.py --json       # machine-readable report

Versions live in `catalog.lock.json` (one integer per artifact, +1 per changed hash), the evolution log in
`history.jsonl` (one line per new/changed/retired artifact with the token delta). Budgets in the lock are a
ratchet: L1 of a role may not grow past them; raising one is a visible edit of the lock in the PR.
Stdlib only (eval rule).
"""
import argparse
import datetime
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tokens import est_tokens, front_matter  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
LOCK = 'catalog.lock.json'
HISTORY = 'history.jsonl'
FOLDER = 'eval/evolve'  # the toolkit's folder in the tree it audits
PRUNE = {'.git', 'node_modules', 'worktrees', 'claude-plugins-official', '__pycache__', '.continue', '.agents',
         '.windsurf', 'dist', 'state'}


def _walk(root, rel, want):
    base = os.path.join(root, rel)
    if not os.path.isdir(base):
        return []
    out = []
    for dirpath, dirs, files in os.walk(base):
        dirs[:] = sorted(d for d in dirs if d not in PRUNE)
        for name in sorted(files):
            if want(name):
                out.append(os.path.relpath(os.path.join(dirpath, name), root).replace(os.sep, '/'))
    return out


def discover(root):
    """[(path, kind)] of the layer's artifacts. Mirrors (.continue, .agents, .windsurf) are generated — not here."""
    found = []
    skills = os.path.join(root, '.claude', 'skills')
    if os.path.isdir(skills):
        for name in sorted(os.listdir(skills)):
            if os.path.isfile(os.path.join(skills, name, 'SKILL.md')):
                found.append(('.claude/skills/%s/SKILL.md' % name, 'skill'))
    for rel, kind in (('.claude/rules', 'rule'), ('.claude/agents', 'agent'), ('.claude/commands', 'command')):
        found += [(p, kind) for p in _walk(root, rel, lambda n: n.endswith('.md'))]
    found += [(p, 'hook') for p in _walk(root, '.claude/hooks',
                                         lambda n: n.endswith(('.py', '.sh')) and not n.startswith('test_'))]
    for rel in ('process/prompts', 'eval/prompts'):
        found += [(p, 'prompt') for p in _walk(root, rel, lambda n: n.endswith('.md'))]
    found += [(p, 'card') for p in _walk(root, '.', lambda n: n == 'CLAUDE.md')]
    if os.path.isfile(os.path.join(root, 'eval/pipeline/genome/roles.json')):
        found.append(('eval/pipeline/genome/roles.json', 'genome'))
    seen, out = set(), []
    for path, kind in found:
        path = path[2:] if path.startswith('./') else path
        if path not in seen:
            seen.add(path)
            out.append((path, kind))
    return out


def _listing_line(fields, fallback):
    """How Claude Code lists a skill/agent/command at start: `- name: description`."""
    return '- %s: %s' % (fields.get('name') or fallback, fields.get('description', ''))


def describe(root, path, kind):
    with open(os.path.join(root, path), encoding='utf-8', errors='replace') as f:
        text = f.read()
    fields, _ = front_matter(text) if path.endswith('.md') else ({}, text)
    item = {
        'kind': kind,
        'sha': hashlib.sha256(text.encode('utf-8')).hexdigest()[:12],
        'tokens': est_tokens(text),
    }
    name = os.path.basename(os.path.dirname(path)) if kind == 'skill' else os.path.splitext(os.path.basename(path))[0]
    if kind in ('skill', 'agent', 'command'):
        item['name'] = fields.get('name') or name
        item['listing'] = est_tokens(_listing_line(fields, name))
        item['name_only'] = est_tokens('- %s' % item['name'])
    elif kind == 'rule':
        item['always'] = not fields.get('paths')
    elif kind == 'card':
        item['always'] = path == 'CLAUDE.md'
    return item


def scan(root):
    return {path: describe(root, path, kind) for path, kind in discover(root)}


def roles_of(root):
    """{role: skillOverrides} from the genome source, as build.py renders it; '(none)' — a session without genome."""
    path = os.path.join(root, 'eval/pipeline/genome/roles.json')
    out = {'(none)': {}}
    if not os.path.isfile(path):
        return out
    with open(path, encoding='utf-8') as f:
        src = json.load(f)
    base = src.get('base', {})
    for role, spec in src.get('roles', {}).items():
        on = set(spec.get('skills_on', []))
        overrides = {n: 'off' for n in base.get('skills_off', []) if n not in on}
        overrides.update({n: 'name-only' for n in base.get('skills_name_only', [])})
        out[role] = overrides
    return out


def l1_of(items, overrides):
    """Always-loaded tokens of the layer for one role: root card + rules without `paths:` + the skill, agent and
    command listings (a skill switched off costs 0, a name-only one — its name)."""
    parts = {'cards_rules': 0, 'skills_listing': 0, 'agents_commands': 0}
    for item in items.values():
        kind = item['kind']
        if kind in ('rule', 'card') and item.get('always'):
            parts['cards_rules'] += item['tokens']
        elif kind == 'skill':
            mode = overrides.get(item['name'])
            parts['skills_listing'] += 0 if mode == 'off' else item['name_only'] if mode == 'name-only' else item['listing']
        elif kind in ('agent', 'command'):
            parts['agents_commands'] += item['listing']
    parts['total'] = sum(parts.values())
    return parts


def load_lock(root):
    path = os.path.join(root, FOLDER, LOCK)
    if not os.path.isfile(path):
        return {'artifacts': {}, 'budget': {}}
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def diff(lock, items):
    """[(event, path, old, new)] — new / changed / retired against the lock."""
    old = lock.get('artifacts', {})
    events = []
    for path, item in items.items():
        prev = old.get(path)
        if prev is None:
            events.append(('new', path, None, item))
        elif prev['sha'] != item['sha']:
            events.append(('changed', path, prev, item))
    events += [('retired', path, prev, None) for path, prev in old.items() if path not in items]
    return sorted(events, key=lambda e: (e[1], e[0]))


def over_budget(lock, l1):
    out = []
    for role, parts in l1.items():
        cap = lock.get('budget', {}).get(role)
        if cap is not None and parts['total'] > cap:
            out.append((role, parts['total'], cap))
    return out


def write(root, lock, items, events, date):
    arts = dict(lock.get('artifacts', {}))
    lines = []
    for event, path, prev, item in events:
        if event == 'retired':
            arts.pop(path, None)
            lines.append({'date': date, 'event': event, 'path': path, 'v': prev['v'], 'dtokens': -prev['tokens']})
            continue
        v = 1 if prev is None else prev['v'] + 1
        arts[path] = {k: item[k] for k in ('kind', 'sha', 'tokens')}
        arts[path]['v'] = v
        lines.append({'date': date, 'event': event, 'path': path, 'v': v, 'sha': item['sha'],
                      'tokens': item['tokens'], 'dtokens': item['tokens'] - (prev['tokens'] if prev else 0)})
    lock = {
        'version': 1,
        'note': 'written by eval/evolve/catalog.py --write; budgets are a ratchet: raise one only on purpose',
        'budget': lock.get('budget', {}),
        'artifacts': dict(sorted(arts.items())),
    }
    folder = os.path.join(root, FOLDER)
    with open(os.path.join(folder, LOCK), 'w', encoding='utf-8') as f:
        json.dump(lock, f, ensure_ascii=False, indent=1, sort_keys=False)
        f.write('\n')
    if lines:
        with open(os.path.join(folder, HISTORY), 'a', encoding='utf-8') as f:
            for line in lines:
                f.write(json.dumps(line, ensure_ascii=False) + '\n')
    return lock


def report(root):
    items = scan(root)
    lock = load_lock(root)
    l1 = {role: l1_of(items, ov) for role, ov in roles_of(root).items()}
    return items, lock, diff(lock, items), l1


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--root', default=ROOT)
    ap.add_argument('--write', action='store_true')
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--date', default=datetime.date.today().isoformat())
    args = ap.parse_args(argv)
    items, lock, events, l1 = report(args.root)
    if args.write:
        lock = write(args.root, lock, items, events, args.date)
    over = over_budget(lock, l1)
    if args.json:
        print(json.dumps({'events': [(e, p) for e, p, _, _ in events], 'l1': l1,
                          'budget': lock.get('budget', {}), 'over': over}, ensure_ascii=False, indent=1))
    else:
        for event, path, prev, item in events:
            v = '' if event == 'retired' else ' v%d' % (1 if prev is None else prev['v'] + 1)
            dt = (item['tokens'] if item else 0) - (prev['tokens'] if prev else 0)
            print('%-8s %s%s  %+d tok' % (event, path, v, dt))
        print('%d artifacts, %d %s' % (len(items), len(events), 'written' if args.write else 'pending'))
        print('L1 per role (tokens): cards+rules · skills · agents+commands = total / budget')
        for role, parts in sorted(l1.items()):
            cap = lock.get('budget', {}).get(role, '—')
            print('  %-8s %6d · %5d · %5d = %6d / %s' % (role, parts['cards_rules'], parts['skills_listing'],
                                                       parts['agents_commands'], parts['total'], cap))
    if args.check:
        bad = False
        if events and not args.write:
            print('catalog: lock is stale — run python3 -I eval/evolve/catalog.py --write and commit the lock '
                  'and history.jsonl', file=sys.stderr)
            bad = True
        for role, total, cap in over:
            print('catalog: L1 of %s is %d tokens, budget %d — cut duplicates (eval/evolve/dupes.py) or raise the '
                  'budget in the lock on purpose' % (role, total, cap), file=sys.stderr)
            bad = True
        return 1 if bad else 0
    return 0


if __name__ == '__main__':
    sys.exit(main())
