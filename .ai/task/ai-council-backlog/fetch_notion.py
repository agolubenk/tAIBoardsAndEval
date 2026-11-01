#!/usr/bin/env python3
"""Одноразовая выгрузка карточек Notion для перечня AI Council (task ai-council-backlog).

Только чтение: allowed_writes пуст → любой write через NotionClient кидает NotionForbidden.
Переиспользует транспорт/маппинг infra/ai-council/notion.py (троттлинг 3 rps, ретраи, пагинация).

Выход:
  raw.json     — все карточки обеих баз (все статусы): поля, тело, комментарии
  matches.json — карточки, прошедшие regex-фильтр, с уликами (какие слова где нашли)
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "infra" / "ai-council"))

import config as config_mod  # noqa: E402
from notion import NotionClient, page_to_card  # noqa: E402

OUT_DIR = Path(__file__).resolve().parent

# ── критерий «связан с консилиумом / экосистемой» ────────────────────────────
CORE = [
    r"\bконсилиум", r"\bcouncil\b", r"ai[- ]council",
    r"\bverifier\b", r"верификатор", r"\bnotion[- ]sync\b",
    r"\bproposer\b", r"\barbiter\b", r"\bskeptic\b",
    r"модельн\w* лок", r"ростер", r"проработк\w+ постановк",
]
ECOSYSTEM = [
    # DAMS / RAG
    r"\bdams\b", r"\brag\b", r"\bfts5\b", r"pgvector", r"эмбеддинг", r"\bembedding",
    # Headroom
    r"headroom",
    # Ollama / модели / провайдеры
    r"\bollama\b", r"\bglm\b", r"\bz\.ai\b", r"\bqwen\w*\b", r"\bmistral\w*\b",
    r"\bgemini\b", r"\bdeepseek\b", r"\bllm\b",
    # graphify / pipeline / tooling / MCP
    r"graphify", r"ai[- ]pipeline", r"ai[- ]tooling", r"\bmcp\b",
    # AI-инфраструктура агентов/тулинга (контекстно, отсеется вручную)
    r"\bclaude\b", r"\bcontinue\b",
    r"промпт", r"\brubric\b", r"рубрик", r"облачн", r"\bsupervisor\b",
    r"\bgateway\b", r"\bplanner\b", r"\blearning\b",
]

COMBINED = [(name, re.compile(p, re.I)) for pats, name in ((CORE, "core"), (ECOSYSTEM, "eco"))
            for p in pats]


def search_evidence(text: str) -> list[dict]:
    ev = []
    for group, rx in COMBINED:
        hits = rx.findall(text or "")
        if hits:
            ev.append({"group": group, "pattern": rx.pattern, "count": len(hits),
                       "sample": hits[:3]})
    return ev


def main() -> None:
    cfg = config_mod.load(strict=False)
    client = NotionClient(
        api_key=cfg.notion_key(),
        api_version=cfg.get("sources.notion.api_version", "2022-06-28"),
        rate_limit_rps=cfg.get("sources.notion.rate_limit_rps", 3),
        dry_run=False,
        allowed_writes={},  # только чтение
    )

    raw_cards = []
    matches = []

    for label in ("tasks", "bugs"):
        db_id = cfg.get(f"sources.notion.databases.{label}.id")
        pages = client.query_database(db_id, statuses=None)  # ВСЁ, включая закрытые
        print(f"[{label}] {db_id}: получено страниц {len(pages)}", flush=True)
        for page in pages:
            body = client.page_text(page["id"])
            comments = client.comments(page["id"])  # [{id, text, at}] — уже плоский текст
            card = page_to_card(page, db=label, body=body, comments=comments)
            card["comments_text"] = [{"at": c.get("at", ""), "text": c.get("text", "")}
                                     for c in comments]
            raw_cards.append(card)

            title = card.get("title", "")
            modules = json.loads(card.get("modules", "[]") or "[]")
            tags = json.loads(card.get("tags", "[]") or "[]")
            blob = " | ".join(filter(None, [
                title, body,
                " | ".join(c["text"] for c in card["comments_text"]),
                card.get("report") or "",
                " ".join(modules), " ".join(tags),
            ]))
            core_hits = [e for e in search_evidence(blob) if e["group"] == "core"]
            eco_hits = [e for e in search_evidence(blob) if e["group"] == "eco"]

            if core_hits:
                verdict = "core"
            elif any(m == "ai-tooling/mcp" for m in modules):
                verdict = "module"
            elif eco_hits:
                verdict = "eco"
            else:
                continue

            matches.append({
                "verdict": verdict,
                "card_id": card["card_id"],
                "db": label,
                "title": title,
                "url": card.get("url", ""),
                "status": card.get("status"),
                "priority": card.get("priority"),
                "severity": card.get("severity"),
                "task_type": card.get("task_type"),
                "modules": modules,
                "tags": tags,
                "half_baked": bool(card.get("half_baked")),
                "backlog_id": card.get("backlog_id"),
                "evidence_core": core_hits,
                "evidence_eco": eco_hits,
                "body_first_600": (body or "")[:600],
            })

    (OUT_DIR / "raw.json").write_text(
        json.dumps(raw_cards, ensure_ascii=False, indent=1), encoding="utf-8")
    (OUT_DIR / "matches.json").write_text(
        json.dumps(matches, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\nВсего карточек: {len(raw_cards)}; матчнутых: {len(matches)}")
    by_verdict: dict[str, int] = {}
    for m in matches:
        by_verdict[m["verdict"]] = by_verdict.get(m["verdict"], 0) + 1
    print("Разбивка:", json.dumps(by_verdict, ensure_ascii=False))


if __name__ == "__main__":
    main()