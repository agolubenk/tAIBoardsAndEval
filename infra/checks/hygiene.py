"""Repository hygiene (`.claude/rules/01-base.md` «Запреты»): files that must not be in git, conflict markers,
oversized files, CRLF in scripts, and — for changed code only — files over the 500-line limit."""
import fnmatch
import os

from common import Finding, VENDORED

FORBIDDEN = ('*.zip', 'db_dump.sql', '*.sql.gz', '*.env', '.env', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa',
             'id_ed25519', '*.sqlite', '*.db', '.secrets/*', '*/.secrets/*')
ENV_OK = ('.env.example', '.env.sample', '.env.template', '.env.test.example')
MAX_BYTES = 1_000_000
CODE = ('.ts', '.tsx', '.js', '.mjs', '.py', '.sh', '.go', '.swift', '.kt')
MAX_LINES = 500  # 01-base: a service/hook/component over 500 lines must be split
GENERATED = ('pnpm-lock.yaml', 'package-lock.json', 'openapi.json', '_journal.json', '_snapshot.json', '.gen.ts',
             'routeTree.gen.ts', '.min.js')


def forbidden(path):
    name = os.path.basename(path)
    if name in ENV_OK or name.endswith(ENV_OK):
        return False
    return any(fnmatch.fnmatch(path, g) or fnmatch.fnmatch(name, g) for g in FORBIDDEN)


def run(root, files, read_text, changed=None):
    out = []
    changed = set(changed or ())
    for path in files:
        full = os.path.join(root, path)
        if forbidden(path):
            out.append(Finding('hygiene', 'error', path, 0, 'must not be in git (01-base: archives, dumps, env, keys)'))
        size = os.path.getsize(full)
        if size > MAX_BYTES and not path.endswith(GENERATED):
            out.append(Finding('hygiene', 'error', path, 0, 'file is %d KB (> %d KB): keep binaries out of git'
                               % (size // 1024, MAX_BYTES // 1000)))
        text = read_text(root, path)
        if text is None:
            continue
        for n, line in enumerate(text.splitlines(), 1):
            if line.startswith(('<<<<<<< ', '>>>>>>> ')) or line == '<<<<<<<':
                out.append(Finding('hygiene', 'error', path, n, 'merge conflict marker'))
                break
        if path.endswith(('.sh', '.py', '.mjs')) and '\r\n' in text:
            out.append(Finding('hygiene', 'error', path, 0, 'CRLF line endings break the interpreter line'))
        if path in changed and path.endswith(CODE) and not path.endswith(GENERATED) \
                and not path.startswith(VENDORED) and '/test' not in path and '.test.' not in path:
            lines = text.count('\n') + 1
            if lines > MAX_LINES:
                out.append(Finding('hygiene', 'warning', path, 0, '%d lines (> %d): split by responsibility (01-base)'
                                   % (lines, MAX_LINES)))
    return out
