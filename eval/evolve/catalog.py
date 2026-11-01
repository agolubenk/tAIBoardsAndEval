#!/usr/bin/env python3
"""Catalog of the process layer: every skill, rule, agent, command, role card, launch prompt, hook and the genome
source with its version, its token weight and what it adds to the always-loaded context (L1) of each role genome.

    python3 -I eval/evolve/catalog.py              # versions, L1 per role vs budget
    python3 -I eval/evolve/catalog.py --check      # CI: no role's L1 grew past its budget (exit 1)
    python3 -I eval/evolve/catalog.py --ratchet    # set budgets to today's L1 + 5 % (a visible edit in the PR)
    python3 -I eval/evolve/catalog.py --json       # machine-readable, with every artifact

Versions are not kept by hand and not kept in a file: git already knows them. The version of an artifact is the
number of commits that changed it, `rev` is the last of them, `dirty` marks uncommitted edits — so every merged
change is a new version with no extra step, no hook and no merge conflict. A history of one artifact:
`git log --oneline -- <path>`; a diff between two versions: `git diff <rev1> <rev2> -- <path>`. In a shallow
clone (CI) counts are truncated; `--check` does not use them.

The only stored state is `budget.json` — L1 tokens per role. It is a ratchet: a change that makes some role's L1
grow past its budget fails CI until duplicates are cut (`dupes.py`) or the budget is raised on purpose.
Stdlib only (eval rule).
"""
import argparse
import hashlib
import json
import math
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tokens import est_tokens, front_matter  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
BUDGET = 'budget.json'
HEADROOM = 1.05
# The walk fallback (no git) skips what git ignores in this layer; with git, `ls-files` decides.
PRUNE = {'.git', 'node_modules', 'worktrees', '.worktrees', 'claude-plugins-official', '__pycache__', '.continue',
         '.agents', '.windsurf', 'dist', 'state', 'task'}


def tree_of(root):
    """The product tree that holds this toolkit: `eval` here, `supertick-eval` over the host incubator."""
    rel = os.path.relpath(HERE, root).replace(os.sep, '/')
    if not rel.startswith('..') and rel.endswith('/evolve'):
        return rel[:-len('/evolve')]
    return 'eval'


def _git(root, *args):
    out = subprocess.run(['git', '-C', root, *args], capture_output=True, text=True)
    return out.stdout if out.returncode == 0 else None


def listed_files(root):
    """Repo-relative files: tracked and untracked-but-not-ignored (git), or a pruned walk without git."""
    out = _git(root, 'ls-files', '-co', '--exclude-standard')
    if out is not None:
        return [p for p in out.splitlines() if p and os.path.isfile(os.path.join(root, p))]
    files = []
    for dirpath, dirs, names in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in PRUNE)
        for name in sorted(names):
            files.append(os.path.relpath(os.path.join(dirpath, name), root).replace(os.sep, '/'))
    return files


def kind_of(path, tree):
    parts = path.split('/')
    name = parts[-1]
    if len(parts) == 4 and parts[:2] == ['.claude', 'skills'] and name == 'SKILL.md':
        return 'skill'
    if len(parts) == 3 and parts[0] == '.claude' and name.endswith('.md'):
        return {'rules': 'rule', 'agents': 'agent', 'commands': 'command'}.get(parts[1])
    if len(parts) == 3 and parts[:2] == ['.claude', 'hooks'] and name.endswith(('.py', '.sh')) \
            and not name.startswith('test_'):
        return 'hook'
    if name.endswith('.md') and (path.startswith('process/prompts/') or path.startswith(tree + '/prompts/')):
        return 'prompt'
    if name == 'CLAUDE.md' and not any(p in PRUNE for p in parts[:-1]):
        return 'card'
    if path == tree + '/pipeline/genome/roles.json':
        return 'genome'
    return None


def discover(root):
    """[(path, kind)] of the layer's artifacts. Mirrors (.continue, .agents, .windsurf) are generated — not here."""
    tree = tree_of(root)
    found = [(p, kind_of(p, tree)) for p in listed_files(root)]
    return sorted((p, k) for p, k in found if k)


def _listing_line(fields, fallback):
    """How Claude Code lists a skill/agent/command at start: `- name: description`."""
    return '- %s: %s' % (fields.get('name') or fallback, fields.get('description', ''))


def describe(root, path, kind):
    with open(os.path.join(root, path), encoding='utf-8', errors='replace') as f:
        text = f.read()
    fields = front_matter(text)[0] if path.endswith('.md') else {}
    item = {'kind': kind, 'sha': hashlib.sha256(text.encode('utf-8')).hexdigest()[:12], 'tokens': est_tokens(text)}
    name = path.split('/')[-2] if kind == 'skill' else os.path.splitext(os.path.basename(path))[0]
    if kind in ('skill', 'agent', 'command'):
        item['name'] = fields.get('name') or name
        item['listing'] = est_tokens(_listing_line(fields, name))
        item['name_only'] = est_tokens('- %s' % item['name'])
    elif kind == 'rule':
        item['always'] = not fields.get('paths')
    elif kind == 'card':
        item['always'] = path == 'CLAUDE.md'
    return item


def versions(root, paths):
    """{path: (version, last rev)} from one `git log` pass; {} without git."""
    out = _git(root, 'log', '--format=@%h', '--name-only', '--', *paths) if paths else None
    if not out:
        return {}
    wanted, seen, rev = set(paths), {}, None
    for line in out.splitlines():
        if line.startswith('@'):
            rev = line[1:]
        elif line in wanted:
            count, last = seen.get(line, (0, rev))
            seen[line] = (count + 1, last)
    return seen


def scan(root, with_versions=False):
    items = {path: describe(root, path, kind) for path, kind in discover(root)}
    if with_versions:
        found = versions(root, list(items))
        dirty = set()
        status = _git(root, 'status', '--porcelain', '--', *items) if items else None
        for line in (status or '').splitlines():
            dirty.add(line[3:].split(' -> ')[-1])
        for path, item in items.items():
            v, rev = found.get(path, (0, None))
            item['v'], item['rev'] = v, rev
            if path in dirty:
                item['dirty'] = True
    return items


def roles_of(root):
    """{role: skillOverrides} from the genome source, as build.py renders it; '(none)' — a session without genome."""
    path = os.path.join(root, tree_of(root), 'pipeline/genome/roles.json')
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


def budget_path(root):
    return os.path.join(root, tree_of(root), 'evolve', BUDGET)


def load_budget(root):
    path = budget_path(root)
    if not os.path.isfile(path):
        return {}
    with open(path, encoding='utf-8') as f:
        return json.load(f).get('l1', {})


def save_budget(root, caps):
    path = budget_path(root)
    data = {'note': 'L1 tokens per role genome; a ratchet — raise a cap only on purpose (catalog.py --ratchet)',
            'l1': dict(sorted(caps.items()))}
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.write('\n')
    os.replace(tmp, path)  # atomic: a cut-off write never leaves half a JSON


def over_budget(caps, l1):
    return [(role, parts['total'], caps[role]) for role, parts in sorted(l1.items())
            if role in caps and parts['total'] > caps[role]]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--root', default=ROOT)
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--ratchet', action='store_true', help='set budgets to today\'s L1 + 5 %%')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args(argv)
    items = scan(args.root, with_versions=not args.check)
    l1 = {role: l1_of(items, ov) for role, ov in roles_of(args.root).items()}
    caps = load_budget(args.root)
    if args.ratchet:
        caps = {role: int(math.ceil(p['total'] * HEADROOM / 50) * 50) for role, p in l1.items()}
        save_budget(args.root, caps)
    over = over_budget(caps, l1)
    if args.json:
        print(json.dumps({'artifacts': items, 'l1': l1, 'budget': caps, 'over': over}, ensure_ascii=False, indent=1))
    elif not args.check:
        by_kind = {}
        for item in items.values():
            by_kind[item['kind']] = by_kind.get(item['kind'], 0) + 1
        changed = sorted((p for p, i in items.items() if i.get('dirty')))
        print('%d artifacts (%s)' % (len(items), ', '.join('%s %d' % kv for kv in sorted(by_kind.items()))))
        for path in changed[:20]:
            print('  uncommitted: %s (v%d → v%d)' % (path, items[path]['v'], items[path]['v'] + 1))
    if not args.json:
        print('L1 per role (tokens): cards+rules · skills · agents+commands = total / budget')
        for role, parts in sorted(l1.items()):
            print('  %-8s %6d · %5d · %5d = %6d / %s' % (role, parts['cards_rules'], parts['skills_listing'],
                                                       parts['agents_commands'], parts['total'], caps.get(role, '—')))
    for role, total, cap in over:
        print('catalog: L1 of %s is %d tokens, budget %d — cut duplicates (eval/evolve/dupes.py) or raise the '
              'budget on purpose (catalog.py --ratchet)' % (role, total, cap), file=sys.stderr)
    return 1 if args.check and over else 0


if __name__ == '__main__':
    sys.exit(main())
