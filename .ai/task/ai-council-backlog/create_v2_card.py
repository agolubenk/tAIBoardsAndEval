#!/usr/bin/env python3
"""Карточка «AI Council v2 (P1–P4)» в базу Задачи — канон постановки.

Корневая карточка: гвардируемый create_child_page не годится (он создаёт ДОЧЕРНЮЮ с
Parent task), поэтому транспортный POST /pages — тот же путь, которым работал перенос
DONE.md (scripts/transfer-done-to-notion.js). Ограничения соблюдаются строже гвардов:
- свойств, которых нет в белом списке D2 (приоритет/теги/module/task type/backlog id/report), — нет;
- Status и Half-baked idea НЕ задаём вообще (HARD_FORBIDDEN_FIELDS, rules/17 §3/§6) —
  карточка рождается в дефолтном статусе базы, статус переведёт владелец;
- тело — через гвардируемый replace_council_block (elaboration_block), это штатный блок машинной записи.
"""
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "infra" / "ai-council"))

import config as config_mod  # noqa: E402
from notion import NotionClient  # noqa: E402

cfg = config_mod.load(strict=False)
client = NotionClient(
    api_key=cfg.notion_key(),
    allowed_writes={"child_pages": True, "elaboration_block": True, "priority": True,
                    "module_augment": True, "task_type": True, "backlog_id_if_empty": True,
                    "tags": True, "council_readiness": True},
)

page = client.call("/pages", "POST", {
    "parent": {"database_id": cfg.get("sources.notion.databases.tasks.id")},
    "properties": {
        "Name": {"title": [{"text": {"content": "AI Council v2: главная форма, сессии, граф, знания (P1–P4)"}}]},
        "Backlog ID": {"rich_text": [{"text": {"content": "AI-COUNCIL-V2"}}]},
        "Module": {"multi_select": [{"name": "ai-tooling/mcp"}]},
        "Source": {"select": {"name": "Notion"}},
        "Task Type": {"select": {"name": "feature"}},
        "Priority": {"select": {"name": "P1"}},
        "Tags": {"multi_select": [{"name": "ai-council"}]},
        "Report": {"rich_text": [{"text": {"content": "План утверждён 2026-08-16 (решения A–D: .ai/task/ai-council-v2/decision.md); спека v1 закрыта полностью (§14, 2026-08-14); P0-схема уже в schema.sql. Реализуются P1→P4; по фазе — selftest + адверсариальное ревью."}}]},
    },
})
print("PAGE:", page["url"])

BODY = [
    "## Постановка",
    "Реализация утверждённого плана v2 (4 фичи, решения владельца A–D от 2026-08-16). v1 закрыта полностью;",
    "P0-миграции уже применены (schema.sql: sessions/session_runs/session_contexts, cards.linked_card_ids).",
    "",
    "## Фазы и оценка",
    "1. P1 · Ф4 Знания: каталог корпуса с пагинацией (page/page_size, потолок 100), фильтр kind;",
    "   FTS-поиск не ломается. ~0.5–1 д.",
    "2. P2 · Ф1 Главная: форма задачи с @[упоминаниями] карточек, локальный черновик db='draft',",
    "   в Notion не пишем (решение A); капсула-источник linked; POST /api/tasks + autocomplete. ~2–3 д.",
    "3. P3 · Ф3 Граф: prisma-модели в графе (Part A2), фильтр rel=, шкала 150…25000/все,",
    "   LOD по сообществам + ленивый drill-down (решение D). ~3–4 д.",
    "4. P4 · Ф2 Сессии: сессия = рабочая сессия владельца (решение B), свёртка контекста на",
    "   закрытии (S-модель extractor), pinned-наследование в новой сессии; MCP-сервер для",
    "   внешних агентов с Headroom-сжатием (решение C). ~4–5 д.",
    "",
    "## DoD (по фазам)",
    "- npm run ai-council:selftest — pass, расширенный проверками фазы.",
    "- Инварианты: шлюз пишет вердикты/очередь/черновики (расширение контракта задокументировано);",
    "  Notion-гварды Status/Half-baked не тронуты; миграции только additive.",
    "- Адверсариальное ревью фазы — review-<фаза>.md до отчёта о закрытии.",
]
client.replace_council_block(page["id"], BODY)
print("BODY OK")
