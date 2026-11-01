"""П6: role capsule — what the next fresh session of a role needs, ≤ 2K tokens.

One unit of work → the session writes its notes (goal, decisions, next step,
"don't") as JSON, this script adds the mechanics it can read itself (branch,
head, dirty files, running stand) and writes capsules/<role>.md, which
`reflex/handoff_read.py <role>` prints first.

It also writes capsules/<role>.pack.txt — the same notes cut to ≤ 2000 characters for the card
field `contextPack` on t-boards (`forest_set_card_meta`, PIPELINE §8): goal, next step, "don't" and
links survive; decisions and mechanics are the first to go, since the card and git hold them.

Run: python3 -I capsule.py <role> --notes notes.json [--repo PATH ...] [--stand NAME_PREFIX ...] [--out DIR]
notes.json: {"goal": str, "acceptance": [str], "decisions": [{"text": str, "ref": str}],
             "next": str, "dont": [str], "refs": [str]}
"""

import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'capsules')
BUDGET_BYTES = 8000  # ≈ 2K tokens at ~4 bytes per token; Cyrillic is denser, so this errs short
DIRTY_SHOWN = 12
PACK_CHARS = 2000  # t-boards card_meta.context_pack limit (characters, not bytes)


def run(cmd):
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True)
    except OSError:
        return None
    return proc.stdout if proc.returncode == 0 else None


def repo_state(path):
    head = run(['git', '-C', path, 'rev-parse', '--short=9', 'HEAD'])
    if head is None:
        return {'path': path, 'error': 'not a git repository'}
    branch = (run(['git', '-C', path, 'branch', '--show-current']) or '').strip() or 'detached'
    status = run(['git', '-C', path, 'status', '--porcelain=v1', '--untracked-files=normal', '.']) or ''
    dirty = [line[3:] for line in status.splitlines() if line]
    return {'path': path, 'branch': branch, 'head': head.strip(), 'dirty': dirty}


def stand_state(prefix):
    out = run(['docker', 'ps', '--filter', f'name=^{prefix}', '--format', '{{.Names}} {{.Status}}'])
    if out is None:
        return [f'{prefix}: docker unavailable']
    return out.splitlines() or [f'{prefix}: nothing running']


def bullet(items):
    return [f'- {item}' for item in items] or ['- —']


def render(role, notes, repos, stands, dirty_shown=DIRTY_SHOWN):
    lines = [f'# Капсула: {role}', '', f"**Цель.** {notes.get('goal', '—')}", '', '**Приёмка.**']
    lines += bullet(notes.get('acceptance', []))
    lines += ['', '**Решения.**']
    lines += bullet([f"{d['text']} ({d['ref']})" if d.get('ref') else d['text'] for d in notes.get('decisions', [])])
    lines += ['', '**Механика.**']
    for repo in repos:
        if 'error' in repo:
            lines.append(f"- {repo['path']}: {repo['error']}")
            continue
        shown = repo['dirty'][:dirty_shown]
        more = f" +{len(repo['dirty']) - len(shown)}" if len(repo['dirty']) > len(shown) else ''
        lines.append(f"- {repo['path']} [{repo['branch']}] {repo['head']}, грязных {len(repo['dirty'])}")
        if shown:
            lines.append(f"  {', '.join(shown)}{more}")
    for stand in stands:
        lines.append(f'- стенд: {stand}')
    lines += ['', f"**Следующий шаг.** {notes.get('next', '—')}", '', '**Не делать.**']
    lines += bullet(notes.get('dont', []))
    lines += ['', '**Оригиналы.**']
    lines += bullet(notes.get('refs', []))
    return '\n'.join(lines) + '\n'


def fit(role, notes, repos, stands):
    """Shrink the mechanics first (they can be re-read), then refuse: notes are the session's job."""
    for shown in (DIRTY_SHOWN, 5, 0):
        text = render(role, notes, repos, stands, shown)
        if len(text.encode()) <= BUDGET_BYTES:
            return text
    raise ValueError(f'capsule is {len(text.encode())} bytes, budget {BUDGET_BYTES}: shorten the notes')


def pack(notes, limit=PACK_CHARS):
    """Card-sized capsule: drop decisions, then acceptance, then refs; refuse if goal + next + don't overflow."""
    def text(with_decisions, with_acceptance, with_refs):
        parts = [f"Цель: {notes.get('goal', '—')}", f"Дальше: {notes.get('next', '—')}"]
        if notes.get('dont'):
            parts.append('Не делать: ' + '; '.join(notes['dont']))
        if with_acceptance and notes.get('acceptance'):
            parts.append('Приёмка: ' + '; '.join(notes['acceptance']))
        if with_decisions and notes.get('decisions'):
            parts.append('Решения: ' + '; '.join(d['text'] for d in notes['decisions']))
        if with_refs and notes.get('refs'):
            parts.append('Оригиналы: ' + '; '.join(notes['refs']))
        return '\n'.join(parts)

    for flags in ((True, True, True), (False, True, True), (False, False, True), (False, False, False)):
        out = text(*flags)
        if len(out) <= limit:
            return out
    raise ValueError(f'context pack is {len(out)} characters, limit {limit}: shorten goal, next or dont')


def main(argv):
    ap = argparse.ArgumentParser(prog='capsule')
    ap.add_argument('role')
    ap.add_argument('--notes', required=True)
    ap.add_argument('--repo', action='append', default=[])
    ap.add_argument('--stand', action='append', default=[])
    ap.add_argument('--out', default=OUT)
    args = ap.parse_args(argv)
    with open(args.notes, encoding='utf-8') as f:
        notes = json.load(f)
    repos = [repo_state(os.path.abspath(p)) for p in args.repo]
    stands = [line for prefix in args.stand for line in stand_state(prefix)]
    try:
        text = fit(args.role, notes, repos, stands)
        card = pack(notes)
    except ValueError as err:
        print(f'capsule: {err}', file=sys.stderr)
        return 1
    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, f'{args.role.lower()}.md')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)
    pack_path = os.path.join(args.out, f'{args.role.lower()}.pack.txt')
    with open(pack_path, 'w', encoding='utf-8') as f:
        f.write(card)
    print(f'{path} ({len(text.encode())} bytes)')
    print(f'{pack_path} ({len(card)} chars → forest_set_card_meta contextPack)')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
