#!/usr/bin/env python3
"""Dependency vulnerabilities as a ratchet: known advisories are written down, a new one fails.

    python3 -I infra/checks/audit.py                  # CI: exit 1 on a high/critical advisory not in the baseline
    python3 -I infra/checks/audit.py --prune          # drop fixed advisories from the baseline
    python3 -I infra/checks/audit.py --write-baseline # accept today's list (a visible, reviewed edit)

Sources: `pnpm audit --prod` in `boards/` and `npm audit --omit=dev` in every `infra/*/` with a `package-lock.json`
— production dependencies only, the registry's advisory database, no model. Each advisory is identified by its
GHSA id. The baseline `infra/checks/audit-baseline.json` is debt, not permission: every entry is an open bug on the
board («Ошибки»), and an upgrade that fixes it shrinks the file (`--prune`). Without network (the registry does not
answer) the check says so and exits 0 — an outage of the registry must not block delivery; CI has network.
Stdlib only.
"""
import argparse
import datetime
import json
import os
import re
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
BASELINE = 'infra/checks/audit-baseline.json'
FAIL_AT = {'high', 'critical'}
GHSA = re.compile(r'GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}')


def targets(root):
    out = []
    if os.path.isfile(os.path.join(root, 'boards', 'pnpm-lock.yaml')):
        out.append(('boards', ['pnpm', 'audit', '--prod', '--json']))
    infra = os.path.join(root, 'infra')
    for name in sorted(os.listdir(infra)) if os.path.isdir(infra) else []:
        if os.path.isfile(os.path.join(infra, name, 'package-lock.json')):
            out.append(('infra/' + name, ['npm', 'audit', '--omit=dev', '--json']))
    return out


def parse(data):
    """{ghsa: {module, severity, title}} from pnpm (advisories) or npm ≥ 7 (vulnerabilities[].via) audit JSON."""
    found = {}
    for adv in (data.get('advisories') or {}).values():
        ident = adv.get('github_advisory_id') or (GHSA.search(adv.get('url', '')) or [None])[0] or str(adv.get('id'))
        found[ident] = {'module': adv.get('module_name'), 'severity': adv.get('severity'),
                        'title': (adv.get('title') or '')[:120]}
    for name, vuln in (data.get('vulnerabilities') or {}).items():
        for via in vuln.get('via', []):
            if isinstance(via, dict):
                m = GHSA.search(via.get('url', ''))
                ident = m.group(0) if m else str(via.get('source'))
                found[ident] = {'module': via.get('name') or name, 'severity': via.get('severity'),
                                'title': (via.get('title') or '')[:120]}
    return found


def audit(root, where, cmd):
    """(advisories, error) — error is a string when the audit could not run."""
    try:
        proc = subprocess.run(cmd, cwd=os.path.join(root, where), capture_output=True, text=True, timeout=300)
    except (OSError, subprocess.TimeoutExpired) as e:
        return None, str(e)
    try:
        data = json.loads(proc.stdout or '{}')
    except ValueError:
        return None, (proc.stderr or proc.stdout).strip()[:200]
    if data.get('error'):
        return None, str(data['error'])[:200]
    return parse(data), None


def load(root):
    path = os.path.join(root, BASELINE)
    if not os.path.isfile(path):
        return {}
    with open(path, encoding='utf-8') as f:
        return json.load(f).get('accepted', {})


def save(root, accepted):
    path = os.path.join(root, BASELINE)
    data = {'note': 'known advisories of production dependencies — debt, each one a bug on the board; '
                    'a new high/critical one fails CI (infra/checks/audit.py)',
            'accepted': {k: dict(sorted(v.items())) for k, v in sorted(accepted.items())}}
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.write('\n')
    os.replace(tmp, path)


def compare(current, accepted):
    """(new failing, new below threshold, fixed) for one target."""
    new = {k: v for k, v in current.items() if k not in accepted}
    failing = {k: v for k, v in new.items() if v.get('severity') in FAIL_AT}
    minor = {k: v for k, v in new.items() if k not in failing}
    fixed = [k for k in accepted if k not in current]
    return failing, minor, fixed


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--root', default=ROOT)
    ap.add_argument('--write-baseline', action='store_true')
    ap.add_argument('--prune', action='store_true')
    args = ap.parse_args(argv)
    baseline = load(args.root)
    today = datetime.date.today().isoformat()
    bad, changed = False, False
    for where, cmd in targets(args.root):
        current, error = audit(args.root, where, cmd)
        if error:
            print('audit %-24s skipped: %s' % (where, error))
            continue
        accepted = baseline.get(where, {})
        failing, minor, fixed = compare(current, accepted)
        if args.write_baseline:
            baseline[where] = {k: dict(v, since=accepted.get(k, {}).get('since', today)) for k, v in current.items()}
            changed = True
        elif args.prune and fixed:
            baseline[where] = {k: v for k, v in accepted.items() if k not in fixed}
            changed = True
        print('audit %-24s %d known, %d new high/critical, %d new lower, %d fixed'
              % (where, len(current) - len(failing) - len(minor), len(failing), len(minor), len(fixed)))
        for k, v in sorted(failing.items()):
            print('  NEW %-8s %s %s — %s' % (v['severity'], k, v['module'], v['title']))
        for k, v in sorted(minor.items()):
            print('  new %-8s %s %s — %s' % (v['severity'], k, v['module'], v['title']))
        for k in fixed:
            print('  fixed %s %s — run --prune' % (k, accepted[k].get('module')))
        bad = bad or (bool(failing) and not args.write_baseline)
    if changed:
        save(args.root, baseline)
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
