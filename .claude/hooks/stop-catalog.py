#!/usr/bin/env python3
"""
Stop hook: the layer versions itself. At the end of a turn, if a skill, rule, agent, command, role card, launch
prompt, hook or the genome source changed, `eval/evolve/catalog.py --write` bumps its version in
`catalog.lock.json` and appends the change with its token delta to `history.jsonl` — the files go into the same
commit as the change, and CI (`catalog.py --check`) stays green without a manual step.

When the always-loaded context (L1) of a role grows past its budget in the lock, the hook says so once
(`systemMessage`): cut duplicates (`eval/evolve/dupes.py`) or raise the budget on purpose.

Acts only where the toolkit and its lock exist (`eval/evolve/` or, over a host project, `<tree>/evolve/`).
Fail-safe: any error → no output, exit 0 (the session is never blocked).
"""
import json
import os
import subprocess
import sys
from pathlib import Path

TIMEOUT_S = 20


def find_catalog(root):
    for tree in ('eval', 'supertick-eval'):
        script = root / tree / 'evolve' / 'catalog.py'
        if script.is_file() and (script.parent / 'catalog.lock.json').is_file():
            return script
    return None


def main():
    payload = json.load(sys.stdin)
    if payload.get('stop_hook_active'):
        return
    root = Path(os.environ.get('CLAUDE_PROJECT_DIR') or payload.get('cwd') or '.').resolve()
    script = find_catalog(root)
    if script is None:
        return
    out = subprocess.run([sys.executable, '-I', str(script), '--root', str(root), '--write', '--json'],
                         capture_output=True, text=True, timeout=TIMEOUT_S)
    if out.returncode != 0:
        return
    report = json.loads(out.stdout)
    over = report.get('over') or []
    if over:
        roles = ', '.join('%s %d/%d' % (role, total, cap) for role, total, cap in over)
        print(json.dumps({'systemMessage': 'catalog: L1 over budget (%s) — cut duplicates with eval/evolve/dupes.py '
                                           'or raise the budget in eval/evolve/catalog.lock.json on purpose' % roles},
                         ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception:  # noqa: BLE001 — a hook must never break the session
        pass
    sys.exit(0)
