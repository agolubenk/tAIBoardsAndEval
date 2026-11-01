#!/usr/bin/env python3
"""
Quality-gate — PostToolUse hook (matcher: Write|Edit|MultiEdit).

Точечный ESLint по одному изменённому TS/TSX-файлу — быстрый, некритичный
хинт сразу после правки. Package-wide typecheck (per-file ESLint не покрывает
типы всей программы) — Stop-хук, см. stop-typecheck-gate.py.

Non-blocking: только additionalContext, никогда не блокирует Write/Edit.
Fail-safe: любая ошибка/таймаут → пустой вывод, exit 0 (см. post-tool-use.py).
"""
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

EXT = (".ts", ".tsx")
# Директории с собственным eslint.config.* — только они поддерживают точечный линт файла
LINTABLE_ROOTS = ("apps/backend", "apps/frontend", "apps/telegram-sessions", "apps/wiki-collab")
TIMEOUT_S = 25
MAX_OUTPUT = 1500


def find_app_root(rel):
    for root in LINTABLE_ROOTS:
        if rel.startswith(root + "/"):
            return root
    return None


def main():
    import dams_common as dc

    payload = json.load(sys.stdin)
    if payload.get("tool_name") not in ("Write", "Edit", "MultiEdit"):
        return
    tool_input = payload.get("tool_input") or {}
    fp = tool_input.get("file_path") or ""
    if not fp.endswith(EXT):
        return

    rel = dc.rel_path(fp)
    app_root = find_app_root(rel)
    if not app_root:
        return

    file_in_app = rel[len(app_root) + 1:]
    try:
        proc = subprocess.run(
            ["npx", "eslint", file_in_app, "--no-warn-ignored"],
            cwd=str(dc.REPO_ROOT / app_root),
            capture_output=True, text=True, timeout=TIMEOUT_S,
        )
    except (subprocess.TimeoutExpired, OSError):
        return

    if proc.returncode == 0:
        return  # чисто — хинт не нужен, не засоряем контекст

    out = (proc.stdout or proc.stderr or "").strip()
    if not out:
        return
    hint = "ESLint (%s): найдены проблемы —\n%s" % (rel, out[:MAX_OUTPUT])
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": hint,
        }
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
