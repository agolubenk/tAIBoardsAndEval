#!/usr/bin/env python3
"""Deterministic checks of the whole repository — no model, no tokens, seconds to run.

    python3 -I infra/checks/run.py                    # all checks over all tracked files
    python3 -I infra/checks/run.py --base origin/board-agents   # size limits for files changed since the base
    python3 -I infra/checks/run.py --only secrets,data --json

Checks: `secrets` (provider key formats, private keys, JWTs, credentials in URLs, literal passwords) · `hygiene`
(forbidden files, conflict markers, > 1 MB, CRLF in scripts, > 500 lines in changed code) · `data` (JSON/JSONL
validity, board plans, owner-decision ledger, drizzle migration journal) · `syntax` (Python, shell). Exit 1 on any
error that `infra/checks/allow.txt` does not allow; warnings never fail. What each external gate adds in CI
(shellcheck, actionlint, OSV, integration tests) — `infra/checks/README.md`. Stdlib only.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402
import data  # noqa: E402
import hygiene  # noqa: E402
import secrets_scan  # noqa: E402
import syntax  # noqa: E402

CHECKS = ('secrets', 'hygiene', 'data', 'syntax')


def collect(root, only=CHECKS, base=None):
    files = common.git_files(root)
    changed = common.git_files(root, base) if base else []
    found = []
    if 'secrets' in only:
        found += secrets_scan.run(root, files, common.read_text)
    if 'hygiene' in only:
        found += hygiene.run(root, files, common.read_text, changed)
    if 'data' in only:
        found += data.run(root, files, common.read_text)
    if 'syntax' in only:
        found += syntax.run(root, files, common.read_text)
    rules = common.load_allow(root)
    return [f for f in found if not common.allowed(f, rules)], len(files)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--root', default=common.ROOT)
    ap.add_argument('--only', default=','.join(CHECKS))
    ap.add_argument('--base', help='git ref: line limits apply to files changed since it')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args(argv)
    only = tuple(c.strip() for c in args.only.split(',') if c.strip())
    unknown = set(only) - set(CHECKS)
    if unknown:
        ap.error('unknown checks: %s' % ', '.join(sorted(unknown)))
    findings, total = collect(args.root, only, args.base)
    errors = [f for f in findings if f.level == 'error']
    if args.json:
        print(json.dumps([{'check': f.check, 'level': f.level, 'where': f.where(), 'message': f.message}
                          for f in findings], ensure_ascii=False, indent=1))
    else:
        for f in sorted(findings, key=lambda f: (f.level != 'error', f.check, f.path, f.line)):
            print('%-7s %-8s %s  %s' % (f.level, f.check, f.where(), f.message))
        print('checks (%s) over %d files: %d errors, %d warnings' % (', '.join(only), total, len(errors),
                                                                     len(findings) - len(errors)))
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
