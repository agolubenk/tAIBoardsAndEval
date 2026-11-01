#!/usr/bin/env python3
"""Проверка классификатора подсказки grill-task в user-prompt-submit.py.

Запуск: python3 -I .claude/hooks/test_grill_hint.py  (exit 1 при расхождении).
Хук не исполняется целиком — импортируется только функция, state и сеть не трогаются.
"""
import importlib.util
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "ups", Path(__file__).resolve().parent / "user-prompt-submit.py")
ups = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ups)

HINT, SKIP = True, False
CASES = [
    # новые задачи — подсказка нужна (пропуск здесь — опасное направление ошибки)
    ("Нужно добавить такое в нашу работу, чтобы обеспечить лучшее качество", HINT),
    ("/grill-task должен автоматически подключаться", HINT),
    ("Давай добавим экспорт в Excel", HINT),
    ("давай сделаем экспорт кандидатов в csv", HINT),
    ("Ок, теперь сделай отчёт", HINT),
    ("Дальше - реализуй новую фичу X", HINT),
    ("Делай новый отчёт по найму", HINT),
    ("ошибка D-100 в логе, исправь", HINT),
    ("Fix bug\n[Subagent hand-back] pasted log", HINT),
    ("Почини падение логина на мобиле", HINT),
    ("в мейне из того, что ты делал?", HINT),  # модель сама решит, что это вопрос без деливерабла
    # продолжения, ответы, системные реплики — без подсказки
    ("продолжай", SKIP),
    ("— продолжай", SKIP),
    ('"продолжай"', SKIP),
    ("Давай сразу в мейн", SKIP),
    ("закончи", SKIP),
    ("доделай", SKIP),
    ("да, закрывай", SKIP),
    ("ок, дальше", SKIP),
    ("Q-003: вариант A, Q-004 пропустить", SKIP),
    ("принимаю рекомендацию Q-002", SKIP),
    ("Another Claude session sent a message:\n<agent-message from=\"x\">[Subagent hand-back]", SKIP),
    ("<task-notification><task-id>1</task-id></task-notification>", SKIP),
    ("/code-review high", SKIP),
    # сообщение другой сессии в payload хука — без префикса транскрипта (Ф-1, 30.10: 604 из 640 с подсказкой)
    ('<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="hr-helper-v2-37">Сделай отчёт', SKIP),
    ('  \n<cross-session-message from="uds:x">Процесс Т3 на 19:58', SKIP),
    ('[Cross-session idle notice] "hr-helper-v2-db" is idle', SKIP),
    ('[Cross-session delivery notice] held for approval', SKIP),
    ('<teammate-message teammate_id="a">добавь тест', SKIP),
    ("Вот что прислала сессия, разберись и почини:\n" + "лог " * 120 + "<cross-session-message from=\"x\">", HINT),
    # граница окна SYSTEM_MARKER_HEAD = 300: тег целиком внутри — реплика сессии, за краем — задача владельца
    (("Разберись и почини разбор:\n" + "лог " * 80)[:270] + "<cross-session-message from=\"x\">", SKIP),
    (("Разберись и почини разбор:\n" + "лог " * 80)[:290] + "<cross-session-message from=\"x\">", HINT),
]

bad = [(p, exp) for p, exp in CASES if (ups.grill_hint(p) is not None) != exp]
for p, exp in bad:
    print("MISMATCH expected %s: %r" % ("hint" if exp else "skip", p))
print("grill_hint: %d/%d" % (len(CASES) - len(bad), len(CASES)))
sys.exit(1 if bad else 0)
