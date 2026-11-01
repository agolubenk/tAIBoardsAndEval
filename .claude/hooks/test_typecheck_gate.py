#!/usr/bin/env python3
"""Проверка выбора пакетов Stop-хука typecheck: npm-монорепо хоста (apps/*, packages/*) и pnpm-доски (boards/…).

Запуск: python3 -I .claude/hooks/test_typecheck_gate.py  (exit 1 при расхождении).
Typecheck не запускается — проверяются только разбор transcript и собранные команды.
"""
import importlib.util
import json
import sys
import tempfile
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "gate", Path(__file__).resolve().parent / "stop-typecheck-gate.py")
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

failed = 0


def check(name, cond):
    global failed
    if not cond:
        failed += 1
        print("FAIL:", name)


def edit(path):
    return json.dumps({"message": {"content": [
        {"type": "tool_use", "name": "Edit", "input": {"file_path": str(path)}}]}})


with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp).resolve()
    pkgs = {
        "apps/backend": {"typecheck": "tsc"},
        "boards/apps/api": {"typecheck": "vp run check:types"},
        "boards/packages/mcp": {},  # без скрипта typecheck — pnpm звать незачем
    }
    for rel, scripts in pkgs.items():
        (root / rel / "src").mkdir(parents=True)
        (root / rel / "package.json").write_text(json.dumps({"scripts": scripts}))
    (root / "eval").mkdir()
    transcript = root / "t.jsonl"
    transcript.write_text("\n".join([
        edit(root / "apps/backend/src/a.ts"),
        edit(root / "boards/apps/api/src/b.ts"),
        edit(root / "boards/packages/mcp/src/c.ts"),
        edit(root / "eval/x.py"),                  # не TS
        edit(root / "boards/docs/archive/d.ts"),   # не пакет
    ]) + "\n")

    dirs = gate.touched_top_level_dirs(transcript, root)
    check("пакеты хоста и досок", dirs == {"apps/backend", "boards/apps/api", "boards/packages/mcp"})

    cmds = gate.typecheck_commands(dirs, root)
    check("две команды: turbo и pnpm", len(cmds) == 2)
    check("turbo только для хоста", cmds[0][1] == ["npx", "turbo", "run", "typecheck", "--filter=./apps/backend"])
    check("pnpm только для пакетов досок со скриптом typecheck",
          cmds[1][1] == ["pnpm", "--dir", str(root / "boards"), "--filter", "./apps/api", "run", "typecheck"])
    check("только доски — одна команда pnpm", len(gate.typecheck_commands({"boards/apps/api"}, root)) == 1)
    check("пакет досок без скрипта — команд нет", gate.typecheck_commands({"boards/packages/mcp"}, root) == [])

print("typecheck_gate: %d failed" % failed)
sys.exit(1 if failed else 0)
