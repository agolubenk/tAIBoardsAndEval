"""Shared pieces of the deterministic checks: the file list, findings, the allowlist. Stdlib only."""
import fnmatch
import os
import subprocess

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
ALLOW = 'infra/checks/allow.txt'
# Vendored or upstream trees: their own maintainers check them; we only watch secrets and hygiene there.
VENDORED = ('claude-plugins-official/', 'eval/context/supertick-src/')


class Finding:
    __slots__ = ('check', 'level', 'path', 'line', 'message')

    def __init__(self, check, level, path, line, message):
        self.check, self.level, self.path, self.line, self.message = check, level, path, line, message

    def where(self):
        return '%s:%d' % (self.path, self.line) if self.line else self.path

    def __repr__(self):
        return '%s %s %s %s' % (self.level, self.check, self.where(), self.message)


def git_files(root, base=None):
    """Tracked files (all, or only those changed since `base`), repo-relative, existing on disk."""
    if base:
        cmd = ['git', '-C', root, 'diff', '--name-only', '--diff-filter=ACMR', '%s...HEAD' % base]
    else:
        cmd = ['git', '-C', root, 'ls-files']
    out = subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
    return [p for p in out.splitlines() if p and os.path.isfile(os.path.join(root, p))]


def read_text(root, path, limit=2_000_000):
    """Text of a file, or None for binary/huge files."""
    full = os.path.join(root, path)
    if os.path.getsize(full) > limit:
        return None
    with open(full, 'rb') as f:
        data = f.read()
    if b'\0' in data[:8192]:
        return None
    return data.decode('utf-8', errors='replace')


def load_allow(root):
    """[(check, path glob, needle)] — `check  glob  [needle]` per line, `#` comments. A finding is allowed when its
    check and path match and the needle (if any) occurs in its message."""
    path = os.path.join(root, ALLOW)
    rules = []
    if os.path.isfile(path):
        with open(path, encoding='utf-8') as f:
            for line in f:
                line = line.split('#', 1)[0].strip()
                if line:
                    parts = line.split(None, 2)
                    rules.append((parts[0], parts[1] if len(parts) > 1 else '*', parts[2] if len(parts) > 2 else ''))
    return rules


def allowed(finding, rules):
    return any((check == '*' or check == finding.check) and fnmatch.fnmatch(finding.path, glob)
               and (not needle or needle in finding.message) for check, glob, needle in rules)
