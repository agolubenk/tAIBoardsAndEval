"""П5: `pr-state <n>` — head, CI, review and mergeable of one PR in one line.

Replaces the 3–5 calls a role spends on `gh pr view` / `gh pr checks` per PR.
Run: python3 -I pr_state.py <n> [--repo owner/name]
"""

import json
import subprocess
import sys

FIELDS = 'number,title,state,isDraft,headRefOid,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup'

FAIL = {'FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'}
PASS = {'SUCCESS', 'NEUTRAL', 'SKIPPED'}


def check_outcome(check):
    """CheckRun has status/conclusion, StatusContext has state."""
    if check.get('__typename') == 'StatusContext':
        state = check.get('state', '')
        return 'pass' if state == 'SUCCESS' else 'fail' if state in FAIL else 'pending'
    if check.get('status') != 'COMPLETED':
        return 'pending'
    conclusion = check.get('conclusion') or ''
    return 'pass' if conclusion in PASS else 'fail' if conclusion in FAIL else 'pending'


def check_name(check):
    return check.get('name') or check.get('context') or '?'


def format_ci(rollup):
    if not rollup:
        return 'ci: none'
    groups = {'pass': [], 'fail': [], 'pending': []}
    for check in rollup:
        groups[check_outcome(check)].append(check_name(check))
    parts = [f"{len(groups['pass'])} ok"]
    for key in ('fail', 'pending'):
        names = groups[key]
        if names:
            shown = ', '.join(names[:3]) + (f' +{len(names) - 3}' if len(names) > 3 else '')
            parts.append(f'{len(names)} {key} ({shown})')
    return 'ci: ' + ', '.join(parts)


def format_pr(pr):
    state = pr.get('state', '?') + (' draft' if pr.get('isDraft') else '')
    head = (pr.get('headRefOid') or '')[:9]
    review = (pr.get('reviewDecision') or 'none').lower()
    merge = pr.get('mergeable', '?')
    merge_state = pr.get('mergeStateStatus')
    if merge_state and merge_state != 'UNKNOWN':
        merge += f'/{merge_state}'
    return (
        f"#{pr.get('number')} {state} head {head} · {format_ci(pr.get('statusCheckRollup'))} · "
        f"review: {review} · mergeable: {merge}"
    )


def main(argv):
    if not argv or not argv[0].lstrip('#').isdigit():
        print('usage: pr_state.py <n> [--repo owner/name]', file=sys.stderr)
        return 2
    cmd = ['gh', 'pr', 'view', argv[0].lstrip('#'), '--json', FIELDS, *argv[1:]]
    run = subprocess.run(cmd, capture_output=True, text=True)
    if run.returncode != 0:
        print(f'pr-state: gh failed: {run.stderr.strip()[:200]}', file=sys.stderr)
        return run.returncode
    print(format_pr(json.loads(run.stdout)))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
