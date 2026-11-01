#!/usr/bin/env python3
"""stop-catalog.py: a changed skill gets its next version at Stop; no lock → no action; over budget → one message.
Run: python3 -I .claude/hooks/test_stop_catalog.py   (exit 1 on mismatch)"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
HOOK = HERE / 'stop-catalog.py'
EVOLVE = HERE.parents[1] / 'eval' / 'evolve'


def run(root, payload=None):
    env = {**os.environ, 'CLAUDE_PROJECT_DIR': str(root)}
    return subprocess.run([sys.executable, str(HOOK)], input=json.dumps(payload or {}), capture_output=True,
                          text=True, env=env, timeout=60)


def skill(root, body):
    path = root / '.claude/skills/x/SKILL.md'
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('---\nname: x\ndescription: a skill\n---\n%s\n' % body, encoding='utf-8')


failed = 0


def check(name, ok, detail=''):
    global failed
    if not ok:
        failed += 1
        print('FAIL:', name, detail)


tmp = Path(tempfile.mkdtemp())
try:
    (tmp / 'eval/evolve').mkdir(parents=True)
    for name in ('catalog.py', 'tokens.py'):
        shutil.copy(EVOLVE / name, tmp / 'eval/evolve' / name)
    skill(tmp, 'v1')
    proc = run(tmp)
    check('no lock → no action', proc.returncode == 0 and not (tmp / 'eval/evolve/catalog.lock.json').exists(),
          proc.stdout + proc.stderr)

    subprocess.run([sys.executable, '-I', str(tmp / 'eval/evolve/catalog.py'), '--root', str(tmp), '--write'],
                   capture_output=True, check=True)
    skill(tmp, 'v2')
    proc = run(tmp)
    lock = json.loads((tmp / 'eval/evolve/catalog.lock.json').read_text(encoding='utf-8'))
    check('changed skill → v2', lock['artifacts']['.claude/skills/x/SKILL.md']['v'] == 2, json.dumps(lock))
    check('silent within budget', proc.stdout.strip() == '', proc.stdout)

    run_again = run(tmp, {'stop_hook_active': True})
    check('stop_hook_active → no second pass', run_again.stdout == '')

    lock['budget'] = {'(none)': 1}
    (tmp / 'eval/evolve/catalog.lock.json').write_text(json.dumps(lock), encoding='utf-8')
    proc = run(tmp)
    msg = json.loads(proc.stdout or '{}').get('systemMessage', '')
    check('over budget → systemMessage', 'over budget' in msg, proc.stdout)
finally:
    shutil.rmtree(tmp)

print('stop-catalog: %d failed' % failed)
sys.exit(1 if failed else 0)
