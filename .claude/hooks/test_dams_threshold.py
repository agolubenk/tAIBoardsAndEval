#!/usr/bin/env python3
"""Порог L2 и session-latest в user-prompt-submit.py (R4 Ф0.2–0.3, 30.10).

Запуск: python3 -I .claude/hooks/test_dams_threshold.py  (exit 1 при расхождении).
Берётся настоящий capital.json: тест ловит и правку кода, и правку ключей.
"""
import importlib.util
import json
import sys
import tempfile
from pathlib import Path

HOOKS = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("ups", HOOKS / "user-prompt-submit.py")
ups = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ups)
capital = json.loads((HOOKS.parent / "memory/capital.json").read_text(encoding="utf-8"))


def chunks(prompt):
    return {c["id"] for c in ups.match_chunks(prompt, capital) if c.get("load_condition") != "always"}


CASES = [
    # одно общее слово — чужой чанк больше не грузится (замер 30.10 по 200 репликам: 237 → 105 загрузок)
    ("сколько токенов уходит на первый вызов роли", set()),
    ("поставь пункт в очередь владельца", set()),
    ("какой agentBy у пункта", set()),
    ("сборка Т3 стартует утром", set()),
    ("в сценариях scenarios нет ios", set()),          # латинский ключ — с начала слова
    # сильный ключ или два общих — грузится
    ("почини prisma-запрос в отчёте", {"arch-db"}),
    ("findMany без take в сервисе", {"arch-db"}),
    ("сессия telegram отваливается", {"domain-telegram"}),
    ("синк huntflow упал", {"integrations-huntflow"}),
    ("вебхук без проверки подписи", {"arch-security"}),
    ("refresh token и auth cookie", {"arch-security"}),
    ("redis cache для очереди отчётов", {"arch-db"}),
    ("собери ворктри под фикс", {"ops-worktrees"}),
    ("parse_mode теряется в caption", {"domain-telegram"}),
    ("тг-бот отправляет сырые теги в подписи к файлу", {"domain-telegram"}),   # путь parse_mode из Never
    # доска задач (#451): «карточка» домена — не доска (грузится домен, не notion-board); t-boards/тиборд — сильные ключи
    ("открой карточку кандидата", {"domain-recruiting"}),
    ("карточка вакансии не сохраняется", {"domain-recruiting"}),
    ("переведи карточку на t-boards", {"notion-board"}),
    ("в тиборде нет колонки", {"notion-board"}),
]

bad = []
for prompt, want in CASES:
    got = chunks(prompt)
    if got != want:
        bad.append((prompt, want, got))

with tempfile.TemporaryDirectory() as tmp:
    latest = Path(tmp) / "latest.md"
    latest.write_text("# Session memory — 2026-10-30 20:10 · 3496a95a\n\nитог", encoding="utf-8")
    for sid, want in (("3496a95a-d984-4055", True), ("77fe3a74-0000", False), ("unknown", False), ("", False)):
        if ups.own_session_latest(latest, sid) != want:
            bad.append(("own_session_latest", sid, want))
    if ups.own_session_latest(Path(tmp) / "missing.md", "3496a95a"):
        bad.append(("own_session_latest", "missing file", False))
    tr = Path(tmp) / "t.jsonl"
    tr.write_text('{"type":"user"}\n', encoding="utf-8")
    before = tr.stat().st_size
    if ups.compacted_since(tr, 0):
        bad.append(("compacted_since", "до сжатия", False))
    with tr.open("a", encoding="utf-8") as fh:
        fh.write('{"type":"system","subtype":"compact_boundary"}\n')
    if not ups.compacted_since(tr, before):
        bad.append(("compacted_since", "после сжатия", True))
    if ups.compacted_since(tr, tr.stat().st_size):
        bad.append(("compacted_since", "уже вставлено", False))

for b in bad:
    print("MISMATCH", b)
print("dams_threshold: %d/%d" % (len(CASES) + 8 - len(bad), len(CASES) + 8))
sys.exit(1 if bad else 0)
