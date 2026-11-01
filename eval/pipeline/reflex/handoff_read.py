"""П5: `handoff-read <role>` — what a fresh session of a role reads first.

Prints the role's capsule in full (П6 keeps it ≤ 2K tokens) and only the
section map of the role card, so the session opens the one section it needs
with offset/limit instead of reading the whole card.
Run: python3 -I handoff_read.py <role> [--team DIR] [--capsules DIR]
"""

import argparse
import glob
import os
import re
import sys

HOME = os.path.expanduser('~')
TEAM = os.path.join(HOME, '.claude/projects/-Users-agolubenko-Desktop-Development-HR-Helper-v2/handoff/2026-10-25/team')
CAPSULES = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'capsules'))


def find_card(team_dir, role):
    pattern = re.compile(rf'TEAM-\d+-{re.escape(role)}\.md', re.I)
    hits = [p for p in sorted(glob.glob(os.path.join(team_dir, 'TEAM-*.md'))) if pattern.fullmatch(os.path.basename(p))]
    return hits[0] if hits else None


def section_map(text):
    return [(n, line.strip()) for n, line in enumerate(text.splitlines(), 1) if line.startswith('#')]


def render(role, team_dir=TEAM, capsule_dir=CAPSULES):
    out = []
    capsule = os.path.join(capsule_dir, f'{role.lower()}.md')
    if os.path.exists(capsule):
        with open(capsule, encoding='utf-8') as f:
            out += [f'capsule {capsule}:', f.read().rstrip()]
    else:
        out.append(f'capsule: none ({capsule})')
    card = find_card(team_dir, role)
    if not card:
        out.append(f'card: none for role {role!r} in {team_dir}')
        return '\n'.join(out)
    with open(card, encoding='utf-8') as f:
        text = f.read()
    out.append(f'card {card} ({len(text.splitlines())} lines, ≈{len(text.encode()) // 4} tokens), sections:')
    out += [f'  L{n} {title}' for n, title in section_map(text)]
    return '\n'.join(out)


def main(argv):
    ap = argparse.ArgumentParser(prog='handoff-read')
    ap.add_argument('role')
    ap.add_argument('--team', default=TEAM)
    ap.add_argument('--capsules', default=CAPSULES)
    args = ap.parse_args(argv)
    print(render(args.role, args.team, args.capsules))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
