#!/usr/bin/env python3
"""Порог наследника (context-threshold.py) и пусковой скрипт spawn_session.sh — без сети и без окон.

Запуск: python3 -I .claude/hooks/test_context_threshold.py  (exit 1 при расхождении).
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HOOKS = Path(__file__).resolve().parent
REPO = HOOKS.parents[1]
spec = importlib.util.spec_from_file_location("ct", HOOKS / "context-threshold.py")
ct = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ct)
bad = []
done = [0]


def check(name, got, want):
    done[0] += 1
    if got != want:
        bad.append((name, got, want))


def line(kind, tokens, sidechain=False):
    usage = {"input_tokens": 2, "cache_read_input_tokens": tokens - 102, "cache_creation_input_tokens": 50,
             "output_tokens": 50}
    return json.dumps({"type": kind, "isSidechain": sidechain, "message": {"usage": usage}}) + "\n"


# decide(): уровни 0 → 1 (80%) → 2 (90%), сброс после сжатия, без повторов
W, T = 250_000, 0.8
check("ниже порога", ct.decide(150_000, W, T, 0), (0, None))
check("80% — инструкция", ct.decide(200_000, W, T, 0), (1, ct.MESSAGE))
check("80% повторно — тишина", ct.decide(205_000, W, T, 1), (1, None))
check("84% — напоминание (сжатие на 213–221K)", ct.decide(211_000, W, T, 1), (2, ct.REMINDER))
check("сразу 86% — инструкция, без второго", ct.decide(215_000, W, T, 0), (2, ct.MESSAGE))
check("после 90% — тишина", ct.decide(240_000, W, T, 2), (2, None))
check("после сжатия — сброс", ct.decide(90_000, W, T, 2), (0, None))
check("ручной /compact на 85% до 60% — сброс", ct.decide(150_000, W, T, 1), (0, None))
check("окно 200K: после сжатия 55% — сброс", ct.decide(110_000, 200_000, T, 2), (0, None))

with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    tr = tmp / "t.jsonl"
    # последний ответ основной цепочки, а не субагента и не реплика пользователя
    tr.write_text(line("assistant", 120_000) + line("assistant", 205_000) + line("assistant", 30_000, True)
                  + json.dumps({"type": "user", "message": {"content": "x"}}) + "\n", encoding="utf-8")
    check("usage основной цепочки", ct.last_context_tokens(tr), 205_000)
    (tmp / "garbage.jsonl").write_text('{"usage": oops\n', encoding="utf-8")
    check("битый хвост", ct.last_context_tokens(tmp / "garbage.jsonl"), None)

    # окно из настроек проекта
    (tmp / ".claude").mkdir()
    (tmp / ".claude/settings.local.json").write_text('{"autoCompactWindow": 300000}', encoding="utf-8")
    os.environ["CLAUDE_PROJECT_DIR"] = str(tmp)
    for knob in ("SUCCESSOR_WINDOW_TOKENS", "SUCCESSOR_THRESHOLD", "SUCCESSOR_AUTO", "T3_ROLE_KEY"):
        os.environ.pop(knob, None)  # экспортированные в оболочке ручки не должны менять ожидания теста
    check("окно из settings.local", ct.window_tokens(), 300_000)
    os.environ["SUCCESSOR_WINDOW_TOKENS"] = "200000"
    check("окно из env", ct.window_tokens(), 200_000)
    del os.environ["SUCCESSOR_WINDOW_TOKENS"]

    # хук целиком (окно 300K из settings.local выше): один раз на 80%, тишина без прироста; 6 параллельных — один текст
    big = tmp / "big.jsonl"
    big.write_text(("x" * 30_000) + "\n" + line("assistant", 245_000), encoding="utf-8")
    sids = ["test-ct-%d-%d" % (os.getpid(), i) for i in range(3)]

    def start(sid):
        return subprocess.Popen([sys.executable, "-I", str(HOOKS / "context-threshold.py")],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
                                env=dict(os.environ, CLAUDE_PROJECT_DIR=str(tmp),
                                         SUCCESSOR_STATE_DIR=str(tmp / "successor")))

    def run(sid):
        proc = start(sid)
        return proc.communicate(json.dumps({"session_id": sid, "transcript_path": str(big)}), timeout=10)[0]

    if True:  # состояние — в tmp (SUCCESSOR_STATE_DIR): живые сессии тест не задевает
        first = run(sids[0])
        check("хук: инструкция на 80%", "successor-threshold" in first and "82%" in first, True)
        check("хук: повтор без прироста — тишина", run(sids[0]), "")
        os.environ["SUCCESSOR_AUTO"] = "off"
        check("хук: выключатель", run(sids[1]), "")
        del os.environ["SUCCESSOR_AUTO"]
        procs = [start(sids[2]) for _ in range(6)]
        outs = [pr.communicate(json.dumps({"session_id": sids[2], "transcript_path": str(big)}), timeout=10)[0]
                for pr in procs]
        check("хук: 6 параллельных вызовов — один текст", sum("successor-threshold" in o for o in outs), 1)
        check("хук: состояние не в репозитории", any(ct.STATE_DIR.glob("test-ct-%d-*" % os.getpid())), False)

    # spawn_session.sh: dry-run печатает пусковой скрипт, ничего не открывает
    spawn = REPO / "supertick-eval/tools/spawn_session.sh"  # инстанс HR_Helper-v2
    if not spawn.exists():
        spawn = REPO / "eval/tools/spawn_session.sh"  # канонический дом продукта
    tree = spawn.parent.parent.name
    handoff = tmp / "handoff.md"
    handoff.write_text("# handoff\n", encoding="utf-8")
    (tmp / tree / "pipeline/genome").mkdir(parents=True)
    (tmp / tree / "pipeline/genome/release.json").write_text("{}", encoding="utf-8")
    (tmp / "roles").mkdir()
    (tmp / "roles/5-release.md").write_text("x", encoding="utf-8")

    def sh(*args, env=None):
        return subprocess.run(["/bin/bash", str(spawn), "--cwd", str(tmp), "--dry-run", *args],
                              capture_output=True, text=True, timeout=10, env=env)

    r = sh("--handoff", str(handoff))
    check("spawn: наследник без роли", (r.returncode, "Наследник сессии" in r.stdout, "--settings" in r.stdout),
          (0, True, False))
    check("spawn: пусковая папка удаляется после чтения текста", "; rm -rf '" in r.stdout, True)
    odd = tmp / "a\\b"
    odd.mkdir()
    r2 = subprocess.run(["/bin/bash", str(spawn), "--cwd", str(odd), "--dry-run", "--handoff", str(handoff)],
                        capture_output=True, text=True, timeout=10)
    check("spawn: обратный слэш в пути — отказ", r2.returncode, 2)
    r2 = subprocess.run(["/bin/bash", str(spawn), "--help"], capture_output=True, text=True, timeout=10)
    check("spawn: --help без строки кода", (r2.returncode, "set -euo" in r2.stdout), (0, False))
    r = sh("--handoff", str(handoff), "--role", "release")
    check("spawn: наследник роли", (r.returncode, "ключ реестра release, роль 5, наследник" in r.stdout,
                                     "genome/release.json" in r.stdout), (0, True, True))
    r = sh("--launch", "--role", "release", "--prompt-dir", str(tmp / "roles"))
    check("spawn: запуск роли", (r.returncode, "Пусковой файл" in r.stdout), (0, True))
    check("spawn: неизвестная роль", sh("--handoff", str(handoff), "--role", "nope").returncode, 2)
    check("spawn: нет handoff", sh("--handoff", str(tmp / "missing.md")).returncode, 2)
    check("spawn: нет генома", sh("--launch", "--role", "coord", "--prompt-dir", str(tmp / "roles")).returncode, 2)
    no_tmpdir = {k: v for k, v in os.environ.items() if k != "TMPDIR"}
    check("spawn: без TMPDIR", sh("--handoff", str(handoff), env=no_tmpdir).returncode, 0)
    r = subprocess.run(["/bin/bash", str(spawn), "--dry-run", "--handoff", str(handoff)], cwd=tmp,
                       capture_output=True, text=True, timeout=10)
    check("spawn: по умолчанию — текущая папка", "cd '%s'" % tmp.resolve() in r.stdout or "cd '%s'" % tmp in r.stdout,
          True)

for b in bad:
    print("MISMATCH", b)
print("context_threshold: %d/%d" % (done[0] - len(bad), done[0]))
sys.exit(1 if bad else 0)
