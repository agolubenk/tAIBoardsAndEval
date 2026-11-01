"""П5: `wt-state` — every live worktree of a repo in one line each.

Branch, head, dirty files, ahead/behind upstream. Prunable entries (deleted
scratchpad copies) are counted, not listed. Uses `git -C` only.
Run: python3 -I wt_state.py [repo ...]   (default: the current directory)
"""

import os
import subprocess
import sys


def git(path, *args):
    run = subprocess.run(['git', '-C', path, *args], capture_output=True, text=True)
    return run.stdout if run.returncode == 0 else None


def parse_worktrees(porcelain):
    """`git worktree list --porcelain` → [{path, head, branch, prunable, detached}]."""
    trees, cur = [], {}
    for line in porcelain.splitlines() + ['']:
        if not line:
            if cur:
                trees.append(cur)
            cur = {}
            continue
        key, _, value = line.partition(' ')
        if key == 'worktree':
            cur = {'path': value, 'head': '', 'branch': '', 'prunable': False, 'detached': False}
        elif key == 'HEAD':
            cur['head'] = value
        elif key == 'branch':
            cur['branch'] = value.removeprefix('refs/heads/')
        elif key == 'detached':
            cur['detached'] = True
        elif key == 'prunable':
            cur['prunable'] = True
    return trees


def parse_status(porcelain_v2):
    """`git status --porcelain=v2 --branch` → (dirty, ahead, behind, has_upstream)."""
    dirty, ahead, behind, upstream = 0, 0, 0, False
    for line in porcelain_v2.splitlines():
        if line.startswith('# branch.upstream '):
            upstream = True
        elif line.startswith('# branch.ab '):
            a, b = line.split()[2:4]
            ahead, behind = int(a.lstrip('+')), int(b.lstrip('-'))
        elif line and not line.startswith('#'):
            dirty += 1
    return dirty, ahead, behind, upstream


def format_tree(tree, status, home=os.path.expanduser('~')):
    path = tree['path'].replace(home, '~', 1)
    branch = tree['branch'] or ('detached' if tree['detached'] else '?')
    line = f"{path} [{branch}] {tree['head'][:9]}"
    if status is None:
        return line + ' · status: unreadable'
    dirty, ahead, behind, upstream = status
    line += f' · dirty {dirty}'
    if upstream:
        line += f' · ↑{ahead} ↓{behind}'
    elif tree['branch']:
        line += ' · no upstream'
    return line


def report(repo):
    porcelain = git(repo, 'worktree', 'list', '--porcelain')
    if porcelain is None:
        return [f'{repo}: not a git repository']
    trees = parse_worktrees(porcelain)
    live = [t for t in trees if not t['prunable']]
    lines = []
    for tree in live:
        out = git(tree['path'], 'status', '--porcelain=v2', '--branch')
        lines.append(format_tree(tree, parse_status(out) if out is not None else None))
    pruned = len(trees) - len(live)
    if pruned:
        lines.append(f'(+{pruned} prunable)')
    return lines


def main(argv):
    for repo in argv or ['.']:
        print('\n'.join(report(repo)))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
