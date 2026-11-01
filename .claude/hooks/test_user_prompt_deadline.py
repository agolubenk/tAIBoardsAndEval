#!/usr/bin/env python3
"""Дедлайн UserPromptSubmit-хука: зазор до таймаута settings.json и поведение glm_call.

Запуск: python3 -I .claude/hooks/test_user_prompt_deadline.py  (exit 1 при расхождении).
Хук не исполняется целиком — импортируется модуль, сеть не трогается: вместо glm_client
подставляется заглушка в sys.modules.
"""
import importlib.util
import json
import sys
import time
import types
from pathlib import Path

HOOKS = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("ups", HOOKS / "user-prompt-submit.py")
ups = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ups)

failures = []


def check(name, ok, detail=""):
    if not ok:
        failures.append("%s %s" % (name, detail))


# 1. Зазор: хук обязан закончить до того, как Claude Code его убьёт (вместе со всем собранным).
settings = json.loads((HOOKS.parent / "settings.json").read_text(encoding="utf-8"))
timeouts = [h.get("timeout") for group in settings["hooks"]["UserPromptSubmit"]
            for h in group.get("hooks", []) if "user-prompt-submit.py" in h.get("command", "")]
check("settings: хук зарегистрирован с таймаутом", len(timeouts) == 1 and timeouts[0], repr(timeouts))
if timeouts and timeouts[0]:
    gap = timeouts[0] - ups.HOOK_DEADLINE_S
    check("зазор до таймаута ≥ 2.5 с (старт интерпретатора и выход)", gap >= 2.5, "gap=%.1f" % gap)


# 2. glm_call — заглушка glm_client с управляемой задержкой.
calls = []


def fake(delay=0.0, result="ok", boom=False):
    def fn(prompt, timeout):
        calls.append(timeout)
        if boom:
            raise RuntimeError("сеть")
        time.sleep(delay)
        return result
    return fn


stub = types.ModuleType("glm_client")
sys.modules["glm_client"] = stub


def run(fn, budget, own=12, min_budget=0.1):
    stub.rewrite_query = fn
    calls.clear()
    t0 = time.monotonic()
    out = ups.glm_call("rewrite_query", "промпт", t0 + budget, own, min_budget)
    return out, time.monotonic() - t0


out, took = run(fake(), budget=2.0)
check("быстрый ответ возвращается", out == "ok", repr(out))
check("таймаут вызова = min(свой, остаток)", calls and calls[0] <= 2.0, repr(calls))

out, took = run(fake(delay=1.5), budget=0.3)
check("медленный вызов брошен по дедлайну", out is None, repr(out))
check("ожидание не дольше остатка", took < 0.8, "took=%.2f" % took)

out, took = run(fake(), budget=0.05, min_budget=1.5)
check("остаток меньше минимума — вызов не запускается", out is None and not calls, repr((out, calls)))

out, took = run(fake(boom=True), budget=1.0)
check("исключение клиента — None, не падение хука", out is None, repr(out))

out, took = run(fake(), budget=30.0, own=4)
check("собственный потолок ниже остатка — берётся он", calls and calls[0] <= 4, repr(calls))

# 3. Системные уведомления не обрабатываются: раньше они съедали лимит брифов сессии.
check("уведомление о фоновой задаче — системное",
      ups.is_system_message("<task-notification>\n<task-id>b1</task-id>\n<summary>Background job</summary>"))
check("системное уведомление харнесса — системное",
      ups.is_system_message("  [SYSTEM NOTIFICATION - NOT USER INPUT] задача завершена"))
check("реплика владельца — не системная", not ups.is_system_message("настрой headroom под консилиум"))

# 4. Термины L3: короткая русская реплика без идентификатора не ищется; длинный русский промпт
# берёт английские термины из брифа; идентификатор в короткой реплике — ищется.
sys.path.insert(0, str(HOOKS.parent / "scripts"))
import dams_common as dc  # noqa: E402

check("короткая реплика без идентификатора — без поиска",
      ups.l3_terms(dc, "на каком у нас все этапе?") == [], repr(ups.l3_terms(dc, "на каком у нас все этапе?")))
short = ups.l3_terms(dc, "почини candidates.proto")
check("короткая реплика с идентификатором — ищется", "candidates.proto" in short, repr(short))
long_ru = "необходимо, чтобы ты сделал так, чтобы всё работало быстрее и лучше, " * 5
from_brief = ups.l3_terms(dc, long_ru, "GOAL: Configure Headroom proxy caching\nCONSTRAINTS: none stated\n"
                                       "ACCEPTANCE: none stated")
check("длинный русский промпт — термины из брифа", "headroom" in from_brief, repr(from_brief))
check("метки формата брифа — не термины", not {"goal", "constraints", "acceptance"} & set(from_brief),
      repr(from_brief))

for f in failures:
    print("FAIL", f)
print("user-prompt deadline: %d failed" % len(failures))
sys.exit(1 if failures else 0)
