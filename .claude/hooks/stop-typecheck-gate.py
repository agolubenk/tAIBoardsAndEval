#!/usr/bin/env python3
"""
Quality-gate — Stop hook: best-effort typecheck затронутых пакетов.

Парсит хвост transcript на Write/Edit/MultiEdit по TS/TSX-файлам, определяет
затронутые top-level пакеты (apps/*, packages/*) и запускает `turbo run
typecheck --filter=./<pkg>` только для них — turbo-кэш держит повторный
запуск (без новых правок) почти бесплатным. Пакеты pnpm-workspace досок
(boards/apps/*, boards/packages/* — дом слоя) проверяются
`pnpm --dir boards --filter ./<pkg> run typecheck`, если у пакета есть такой скрипт.

Non-blocking: только additionalContext (см. `hidekazu-konishi.com/.../hooks`,
Claude Code v2.1.163+) — никогда не "decision":"block" и не мешает Stop.
Жёсткий гейт — `npm run ci` / pre-commit, не этот хук.
Fail-safe: любая ошибка/таймаут → пустой вывод, exit 0.
В worktree без своих зависимостей typecheck не запускается: результат был бы ложным
(Node берёт node_modules основного checkout) — вместо него хинт с командой починки.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

EDIT_TOOLS = {"Write", "Edit", "MultiEdit"}
TOP_LEVEL_DIRS = ("apps", "packages")
BOARDS = "boards"
TAIL_BYTES = 2 * 1024 * 1024
SUBPROCESS_TIMEOUT_S = 90
MAX_OUTPUT = 2000


def touched_top_level_dirs(transcript_path, repo_root):
    size = transcript_path.stat().st_size
    with transcript_path.open("rb") as fh:
        if size > TAIL_BYTES:
            fh.seek(size - TAIL_BYTES)
        raw = fh.read()
    if size > TAIL_BYTES:
        raw = raw[raw.find(b"\n") + 1:]

    dirs = set()
    for line in raw.decode("utf-8", "replace").splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict):
            continue
        content = (entry.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            if block.get("name") not in EDIT_TOOLS:
                continue
            fp = (block.get("input") or {}).get("file_path")
            if not fp or not fp.endswith((".ts", ".tsx")):
                continue
            try:
                rel = Path(fp).resolve().relative_to(repo_root)
            except ValueError:
                continue
            parts = rel.parts
            if len(parts) >= 3 and parts[0] == BOARDS and parts[1] in TOP_LEVEL_DIRS:
                parts = parts[1:]
                prefix = BOARDS + "/"
            else:
                prefix = ""
            if len(parts) >= 2 and parts[0] in TOP_LEVEL_DIRS:
                d = "%s%s/%s" % (prefix, parts[0], parts[1])
                if (repo_root / d / "package.json").exists():
                    dirs.add(d)
    return dirs


def has_typecheck_script(pkg_dir):
    try:
        data = json.loads((pkg_dir / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return "typecheck" in (data.get("scripts") or {})


def typecheck_commands(dirs, repo_root):
    """(cwd, argv) на каждый прогон: один turbo на пакеты npm-монорепо, один pnpm на пакеты досок."""
    host = sorted(d for d in dirs if not d.startswith(BOARDS + "/"))
    boards = sorted(d[len(BOARDS) + 1:] for d in dirs
                    if d.startswith(BOARDS + "/") and has_typecheck_script(repo_root / d))
    cmds = []
    if host:
        cmds.append((repo_root, ["npx", "turbo", "run", "typecheck"] + ["--filter=./%s" % d for d in host]))
    if boards:
        argv = ["pnpm", "--dir", str(repo_root / BOARDS)]
        for d in boards:
            argv += ["--filter", "./%s" % d]
        cmds.append((repo_root, argv + ["run", "typecheck"]))
    return cmds


def deps_problem(repo_root, target=None):
    """Причина, по которой typecheck здесь соврёт (`wt-deps.sh check` → 1), иначе None."""
    script = repo_root / "infra/scripts/dev/wt-deps.sh"
    if os.environ.get("WT_DEPS_CHECK") == "0" or not script.exists():
        return None
    try:
        proc = subprocess.run(
            ["bash", str(script), "check", str(target or repo_root)],
            capture_output=True, text=True, timeout=10,
        )
    except (subprocess.TimeoutExpired, OSError):
        return None
    return (proc.stderr or "").strip() if proc.returncode == 1 else None


def emit(hint):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "Stop",
            "additionalContext": hint,
        }
    }, ensure_ascii=False))


def main():
    import dams_common as dc

    payload = json.load(sys.stdin)
    # избегаем повторного запуска, если предыдущий Stop-хук уже продолжил цикл
    if payload.get("stop_hook_active"):
        return
    tp = payload.get("transcript_path")
    if not tp or not Path(tp).exists():
        return

    dirs = touched_top_level_dirs(Path(tp), dc.REPO_ROOT)
    if not dirs:
        return

    target = dc.REPO_ROOT / BOARDS if any(d.startswith(BOARDS + "/") for d in dirs) else None
    problem = deps_problem(dc.REPO_ROOT, target)
    if problem:
        emit("Typecheck skipped for %s — зависимости worktree не свои, результат был бы ложным:\n%s"
             % (", ".join(sorted(dirs)), problem))
        return

    failed = []
    for cwd, args in typecheck_commands(dirs, dc.REPO_ROOT):
        try:
            proc = subprocess.run(
                args, cwd=str(cwd), capture_output=True, text=True,
                timeout=SUBPROCESS_TIMEOUT_S,
            )
        except (subprocess.TimeoutExpired, OSError):
            continue
        if proc.returncode != 0:
            failed.append((proc.stdout or proc.stderr or "").strip()[-MAX_OUTPUT:])

    if failed:  # пусто — всё чисто, хинт не нужен
        emit("Typecheck FAILED for %s:\n%s" % (", ".join(sorted(dirs)), "\n---\n".join(failed)[-MAX_OUTPUT:]))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
