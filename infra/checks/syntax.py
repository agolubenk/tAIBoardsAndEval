"""Syntax of scripts that no other gate compiles: Python (compile without writing bytecode) and shell (`bash -n`,
`zsh -n` when zsh is installed). TypeScript is covered by `pnpm typecheck` in boards CI."""
import shutil
import subprocess

from common import Finding, VENDORED


def shell_of(text):
    first = text.split('\n', 1)[0]
    if 'zsh' in first:
        return 'zsh'
    if first.startswith('#!') and 'sh' not in first:
        return None
    return 'bash'


def run(root, files, read_text):
    out = []
    zsh = shutil.which('zsh')
    for path in files:
        if path.startswith(VENDORED):
            continue
        if path.endswith('.py'):
            text = read_text(root, path)
            if text is None:
                continue
            try:
                compile(text, path, 'exec', dont_inherit=True)
            except SyntaxError as e:
                out.append(Finding('syntax', 'error', path, e.lineno or 0, 'python: %s' % e.msg))
        elif path.endswith('.sh'):
            text = read_text(root, path)
            shell = shell_of(text or '')
            if shell == 'zsh' and not zsh:
                continue
            if shell:
                proc = subprocess.run([shell if shell == 'bash' else zsh, '-n', path], cwd=root,
                                      capture_output=True, text=True)
                if proc.returncode != 0:
                    out.append(Finding('syntax', 'error', path, 0, '%s -n: %s' % (shell, proc.stderr.strip()[:200])))
    return out
