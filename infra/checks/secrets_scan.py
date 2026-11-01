"""Secrets in tracked files: provider key formats, private keys, JWTs, credentials in URLs and literal passwords.

A line can carry the marker `checks: allow-secret` (a test fixture, a documented fake). Values that look like
placeholders (`example`, `changeme`, `xxx`, `${…}`, `<…>`, `***`) are skipped. The patterns follow the common
public formats of each provider; the same family of patterns redacts text in `boards/packages/redact` (TypeScript)
— that one cleans what leaves the product, this one stops what enters git.
"""
import math
import re

from common import Finding

PATTERNS = [
    ('aws-access-key', re.compile(r'\b(?:AKIA|ASIA)[0-9A-Z]{16}\b')),
    ('github-token', re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b')),
    ('slack-token', re.compile(r'\bxox[abposr]-[A-Za-z0-9-]{10,}\b')),
    ('private-key', re.compile(r'-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----')),
    ('anthropic-key', re.compile(r'\bsk-ant-[A-Za-z0-9_-]{20,}')),
    ('openrouter-key', re.compile(r'\bsk-or-v1-[a-f0-9]{40,}')),
    ('openai-key', re.compile(r'\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b')),
    ('google-api-key', re.compile(r'\bAIza[0-9A-Za-z_-]{35}\b')),
    ('telegram-bot-token', re.compile(r'\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b')),
    ('stripe-key', re.compile(r'\b[sr]k_live_[A-Za-z0-9]{20,}\b')),
    ('jwt', re.compile(r'\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}')),
    ('url-credentials', re.compile(r'\b[a-z][a-z0-9+.-]*://[^/\s:@"\'`]+:([^@\s/"\'`]{6,})@[^\s"\'`]+', re.I)),
]
ASSIGNED = re.compile(r'(?i)\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)'
                      r'\b\s*[:=]\s*["\']([^"\'\s]{12,})["\']')
PLACEHOLDER = re.compile(r'(?i)example|changeme|change-me|placeholder|dummy|sample|your[_-]|xxx|\*\*\*|<[^>]*>|\$\{|'
                         r'\{\{|\[[^\]]*\]|redacted|test|fake|ci-only|not-a-|secret123|password123|^\$|'
                         r'^(?:pass(?:word)?|secret|postgres|root|admin|user|kaneo)$')
MARKER = 'checks: allow-secret'
SKIP_SUFFIX = ('.lock', 'pnpm-lock.yaml', 'package-lock.json', '.svg', '.map', '.example', '.sample', '.template')
# Fixture code: fake keys of real formats are what tests are for. Findings there are warnings — visible, never a
# failed build; a real key pasted into a test still shows up in every run's output.
FIXTURE = re.compile(r'(^|/)(tests?|e2e|fixtures?|__mocks__|__tests__)/|(^|/)test_[^/]*$|\.test\.|\.spec\.|'
                     r'(^|/)selftest[^/]*$|(^|/)scripts/ci/')


def entropy(s):
    counts = {c: s.count(c) for c in set(s)}
    return -sum(n / len(s) * math.log2(n / len(s)) for n in counts.values())


def scan_text(path, text):
    out = []
    level = 'warning' if FIXTURE.search(path) else 'error'
    for n, line in enumerate(text.splitlines(), 1):
        if MARKER in line or len(line) > 4000:
            continue
        for name, rx in PATTERNS:
            for m in rx.finditer(line):
                value = m.group(1) if m.groups() else m.group(0)
                if name == 'url-credentials' and PLACEHOLDER.search(value):
                    continue
                if name != 'private-key' and PLACEHOLDER.search(value):
                    continue
                out.append(Finding('secrets', level, path, n, '%s: %s…' % (name, value[:6])))
        for m in ASSIGNED.finditer(line):
            value = m.group(2)
            if PLACEHOLDER.search(value) or entropy(value) < 3.5:
                continue
            out.append(Finding('secrets', level, path, n, 'literal %s: %s…' % (m.group(1).lower(), value[:4])))
    return out


def run(root, files, read_text):
    out = []
    for path in files:
        if path.endswith(SKIP_SUFFIX):
            continue
        text = read_text(root, path)
        if text:
            out += scan_text(path, text)
    return out
