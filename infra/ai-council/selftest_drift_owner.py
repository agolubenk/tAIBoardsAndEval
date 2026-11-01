#!/usr/bin/env python3
"""AI Council — самопроверка дрейфа M8 и M9 (council_closed.py, промпты; §17.10). Только stdlib, без моделей.

Вызывается из selftest.py: поиск записей о закрытии по полному Notion-id (дефисы, ссылка со слагом; короткие 8 hex
не совпадают), пометка первым блоком постановки, вопрос владельцу в итоге прогона с решением и с воздержанием без
повтора, единый формат вопроса в промптах и их длина (слабые 7–9B модели деградируют от длинного системного промпта).
"""
from __future__ import annotations

import re
import sys
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

CARD = "3fadd207-a825-81ea-9b37-d494a1502d97"
HEX = CARD.replace("-", "")


def _mentions(check, cc, tmp: Path) -> None:
    root = tmp / "done-m9"
    root.mkdir(exist_ok=True)
    (root / "ai-council.md").write_text(
        "# Консилиум\n"
        f"- 2026-10-16 · дрейф M4+M5 · #165 · [Notion](https://app.notion.com/p/Konsilium-80-{HEX})\n"
        f"- 2026-10-15 · соседняя задача · [Notion](https://app.notion.com/p/{HEX[-8:]})\n", encoding="utf-8")
    found = cc.done_mentions(CARD, root=root)
    check("M9: запись о закрытии найдена по полному id (с дефисами и в ссылке со слагом)",
          len(found) == 1 and found[0][1].startswith("2026-10-16 · дрейф M4+M5") and "https" not in found[0][1],
          str(found))
    check("M9: короткий id и неизвестная карточка не совпадают, нет папки — пусто",
          cc.done_mentions("00000000-0000-0000-0000-" + HEX[-12:], root=root) == []
          and cc.done_mentions(CARD, root=tmp / "нет") == [] and cc.done_mentions("T-35", root=root) == [])
    real = sorted({m for p in (cc.DONE_DIR.glob("*.md")) for m in re.findall(r"[0-9a-f]{32}", p.read_text(encoding="utf-8"))})
    check("M9: на настоящих docs/plans/done/ ищется хотя бы одна карточка",
          bool(real) and bool(cc.done_mentions(real[0])), f"{len(real)} id в done/")


def _question(check, cc) -> None:
    found = [("docs/plans/done/ai-council.md", "2026-10-16 · дрейф M4+M5 · #165")]
    question = cc.owner_question(found)
    check("M8/M9: вопрос владельцу в едином формате",
          question.startswith("Вопрос владельцу:") and "Варианты: А)" in question and "Рекомендую:" in question, question)
    capsule = SimpleNamespace(pinned="Постановка: поправить take")
    cc.annotate(capsule, found)
    untouched = SimpleNamespace(pinned="как было")
    cc.annotate(untouched, [])
    check("M9: пометка — первым блоком постановки; без записи — постановка не меняется",
          capsule.pinned.startswith("ВОЗМОЖНО, УЖЕ ЗАКРЫТО") and capsule.pinned.endswith("поправить take")
          and untouched.pinned == "как было")
    done = SimpleNamespace(status="done", payload={"open_questions": ["прежний вопрос"]}, open_questions=[])
    cc.add_question(done, found)
    cc.add_question(done, found)
    abstained = SimpleNamespace(status="abstained", payload=None, open_questions=["почему воздержались"])
    cc.add_question(abstained, found)
    check("M9: вопрос — в итог с решением и с воздержанием, первым и без повтора",
          done.payload["open_questions"] == [question, "прежний вопрос"]
          and abstained.open_questions == [question, "почему воздержались"])


def _prompts(check) -> None:
    prompts = {name: (HERE / "prompts" / f"{name}.md").read_text(encoding="utf-8")
               for name in ("arbiter", "critic", "proposer.code", "proposer.arch", "proposer.skeptic")}
    long = {n: len(t.splitlines()) for n, t in prompts.items() if len(t.splitlines()) > 50}
    check("M8: промпты не длиннее 50 строк", not long, str(long))
    unified = [n for n in ("arbiter", "proposer.code", "proposer.arch", "proposer.skeptic")
               if "Вопрос владельцу:" not in prompts[n] or "Рекомендую" not in prompts[n]]
    check("M8: единый формат развилки владельцу — арбитр и три proposer", not unified, str(unified))
    check("M8: арбитр — причина первым пунктом и конкретное значение; критик — класс дефекта; код — воспроизведение",
          "причины, а не симптома" in prompts["arbiter"] and "а не «оба варианта»" in prompts["arbiter"]
          and "КЛАСС ДЕФЕКТА" in prompts["critic"] and "воспроизвести:" in prompts["proposer.code"])


def run(tmp: Path, check) -> None:
    import council_closed as cc
    _mentions(check, cc, tmp)
    _question(check, cc)
    _prompts(check)
