"""ИИ-консилиум, дрейф рубрики M9 (2026-10-16): «карточка, возможно, уже закрыта» — только вопросом владельцу.

Если запись в docs/plans/done/*.md ссылается на Notion-id карточки, консилиум узнаёт об этом первым блоком постановки,
а в итог прогона — и с решением, и с воздержанием — добавляется вопрос владельцу в едином формате (M8): закрыть или
назвать, что осталось. Сам консилиум карточку не закрывает и работу не пропускает: совпадение по done/ даёт ложные
«закрыто» — запись о соседней задаче или о части карточки (ревью дизайна дрейфа, 15.10). Ищется полный id из 32 hex:
так записаны все 92 ссылки на Notion в done/ (16.10), короткие 8 hex дали бы случайные совпадения.
Канон — docs/specs/ai-council.md §17.10.
"""
from __future__ import annotations

import re
from pathlib import Path

from verifier import REPO_ROOT

DONE_DIR = REPO_ROOT / "docs/plans/done"
_LINK_RE = re.compile(r"\]\(https?://[^)]+\)")


def done_mentions(card_id: str, root: Path = DONE_DIR, limit: int = 3) -> list[tuple[str, str]]:
    """[(путь от корня репозитория, строка записи без адресов ссылок)] — где done/ ссылается на эту карточку."""
    hex_id = re.sub(r"[^0-9a-f]", "", (card_id or "").lower())
    if len(hex_id) != 32 or not root.is_dir():
        return []
    found: list[tuple[str, str]] = []
    for path in sorted(root.glob("*.md")):
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for line in lines:
            if hex_id in line.replace("-", "").lower():
                try:
                    rel = str(path.relative_to(REPO_ROOT))
                except ValueError:
                    rel = path.name
                found.append((rel, _LINK_RE.sub("]", line).strip(" -*")[:200]))
                if len(found) >= limit:
                    return found
    return found


def capsule_note(mentions: list[tuple[str, str]]) -> str:
    where = "; ".join(f"{path}: «{text}»" for path, text in mentions)
    return ("ВОЗМОЖНО, УЖЕ ЗАКРЫТО — записи о закрытии ссылаются на эту карточку: " + where + ". Сверь с кодом. "
            "Сделанное не повторяй: дай план проверки закрытия и что осталось, если осталось.")


def owner_question(mentions: list[tuple[str, str]]) -> str:
    path, text = mentions[0]
    return (f"Вопрос владельцу: карточка, возможно, уже закрыта — запись {path}: «{text[:120]}». Варианты: "
            "А) закрыть — запись подтверждает сделанное; Б) оставить открытой — назовите, что осталось. "
            "Рекомендую: проверить запись и выбрать А или Б.")


def annotate(capsule, mentions: list[tuple[str, str]]) -> None:
    """Пометка первым блоком постановки: модели видят её до улик и до текста карточки."""
    if mentions:
        capsule.pinned = capsule_note(mentions) + "\n\n" + (capsule.pinned or "")


def add_question(outcome, mentions: list[tuple[str, str]]) -> None:
    """Вопрос — в итог прогона с решением (payload) и с воздержанием (open_questions), без повтора."""
    if not mentions or outcome is None:
        return
    question = owner_question(mentions)
    if outcome.status == "done" and isinstance(outcome.payload, dict):
        questions = outcome.payload.setdefault("open_questions", [])
        if question not in questions:
            questions.insert(0, question)
        outcome.open_questions = questions
    elif question not in (outcome.open_questions or []):
        outcome.open_questions = [question] + list(outcome.open_questions or [])
