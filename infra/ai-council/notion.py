#!/usr/bin/env python3
"""AI Council — REST-клиент Notion и маппинг полей борда. Только stdlib.

Канон: docs/specs/ai-council.md §10 · docs/plans/notion-board.md · .claude/rules/17-notion-board.md

Ключевое отличие от `scripts/transfer-done-to-notion.js`: там разовый импорт, здесь — постоянно
работающий сервис с правом записи. Поэтому белый список операций (D2) продублирован **в коде**,
а не только в конфиге:

    HARD_FORBIDDEN_FIELDS — Status и Half-baked idea не пишутся никогда, независимо от конфига.

Конфиг может только сузить разрешённое, но не расширить сверх этого множества. Причина —
`.claude/rules/17-notion-board.md` §6: финальный статус ставит человек, флаг half-baked снимает
владелец. Ошибка в TOML не должна приводить к тому, что консилиум закрывает чужие карточки.
"""
from __future__ import annotations

import json
import re
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from netutil import SSL_CTX as _SSL_CTX                   # noqa: E402  — общий CA-bundle

API = "https://api.notion.com/v1"

# Никакой конфиг это не переопределяет (rules/17 §6, спека C4 и §7а).
HARD_FORBIDDEN_FIELDS = frozenset({"Status", "Half-baked idea"})

# Канонический словарь Module — новых опций не создаём (notion-sync.md).
CANONICAL_MODULES = frozenset({
    "backend", "frontend", "telegram", "extension", "mobile", "ai-tooling/mcp",
    "security/auth", "db/queues", "realtime", "ops/ci", "recruiting/ats",
    "huntflow", "hh.ru", "i18n", "ux", "docs",
})

VALID_PRIORITY = frozenset({"P0", "P1", "P2", "P3"})
VALID_SEVERITY = frozenset({"critical", "high", "medium", "low"})
VALID_TASK_TYPE = frozenset({"feature", "bugfix", "refactor", "spike", "idea"})

COUNCIL_BLOCK_BEGIN = "<!-- council:v1:begin -->"
COUNCIL_BLOCK_END = "<!-- council:v1:end -->"

# Notion режет rich_text на 2000 символов в одном объекте.
RICH_TEXT_LIMIT = 1900


class NotionError(Exception):
    pass


class NotionForbidden(NotionError):
    """Попытка записи в поле, запрещённое правилами борда. Это баг вызывающего кода."""




# ── извлечение значений из ответа API ───────────────────────────────────────
def plain(rich: list | None) -> str:
    return "".join(part.get("plain_text", "") for part in (rich or [])).strip()


def prop_text(props: dict, name: str) -> str:
    node = props.get(name) or {}
    kind = node.get("type")
    if kind == "title":
        return plain(node.get("title"))
    if kind == "rich_text":
        return plain(node.get("rich_text"))
    return ""


def prop_select(props: dict, name: str) -> str:
    node = props.get(name) or {}
    if node.get("type") in ("select", "status"):
        return ((node.get(node["type"]) or {}).get("name")) or ""
    return ""


def prop_multi(props: dict, name: str) -> list[str]:
    node = props.get(name) or {}
    if node.get("type") == "multi_select":
        return [o["name"] for o in node.get("multi_select") or []]
    return []


def prop_checkbox(props: dict, name: str) -> bool:
    node = props.get(name) or {}
    return bool(node.get("checkbox")) if node.get("type") == "checkbox" else False


def prop_relation(props: dict, name: str) -> list[str]:
    node = props.get(name) or {}
    if node.get("type") == "relation":
        return [r["id"] for r in node.get("relation") or []]
    return []


def chunk_rich_text(text: str) -> list[dict]:
    return [{"type": "text", "text": {"content": text[i:i + RICH_TEXT_LIMIT]}}
            for i in range(0, max(len(text), 1), RICH_TEXT_LIMIT)] or \
           [{"type": "text", "text": {"content": ""}}]


# Запросы, которые только читают: GET и два POST-поиска API. Всё прочее — запись.
_READ_POSTS = ("/query", "/search")


def is_read_request(method: str, path: str) -> bool:
    m = method.upper()
    return m == "GET" or (m == "POST" and path.split("?", 1)[0].endswith(_READ_POSTS))


@dataclass
class NotionClient:
    api_key: str
    api_version: str = "2022-06-28"
    rate_limit_rps: float = 3.0
    timeout: int = 30
    dry_run: bool = False
    allowed_writes: dict = field(default_factory=dict)   # из config outputs.notion_writeback
    # sources.notion.read_only: Notion заморожен (канон — t-boards). Запрет в транспорте, а не в каждом
    # методе: переходы ревью и статус из UI шли мимо белого списка writeback.
    read_only: bool = False
    comment_errors: int = 0
    last_comment_error: str = ""
    _last_call: float = 0.0

    # ── транспорт ────────────────────────────────────────────────────────────
    def _throttle(self) -> None:
        gap = 1.0 / max(self.rate_limit_rps, 0.1)
        delta = time.time() - self._last_call
        if delta < gap:
            time.sleep(gap - delta)
        self._last_call = time.time()

    def call(self, path: str, method: str = "GET", body: dict | None = None,
             retries: int = 3) -> dict:
        if not self.api_key:
            raise NotionError("нет Notion-ключа (.claude/council/.notion-key или NOTION_API_KEY)")
        if self.read_only and not is_read_request(method, path):
            raise NotionForbidden(f"Notion только для чтения (sources.notion.read_only): {method} {path}")
        for attempt in range(retries + 1):
            self._throttle()
            req = urllib.request.Request(
                API + path,
                data=json.dumps(body).encode("utf-8") if body is not None else None,
                headers={
                    "Authorization": "Bearer " + self.api_key,
                    "Notion-Version": self.api_version,
                    "Content-Type": "application/json",
                },
                method=method,
            )
            try:
                with urllib.request.urlopen(req, timeout=self.timeout, context=_SSL_CTX) as resp:
                    return json.loads(resp.read().decode("utf-8", "replace"))
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode("utf-8", "replace")[:400]
                # 429 и 5xx — ретраим с backoff; 4xx — это наша ошибка, ретрай не поможет.
                if exc.code in (429, 502, 503, 504) and attempt < retries:
                    wait = float(exc.headers.get("Retry-After", 0) or (2 ** attempt))
                    time.sleep(min(wait, 30))
                    continue
                raise NotionError(f"HTTP {exc.code} {method} {path}: {detail}") from exc
            except (urllib.error.URLError, OSError, TimeoutError) as exc:
                if attempt < retries:
                    time.sleep(2 ** attempt)
                    continue
                raise NotionError(f"сеть {method} {path}: {exc}") from exc
        raise NotionError(f"исчерпаны попытки {method} {path}")

    def whoami(self) -> dict:
        return self.call("/users/me")

    # ── чтение ───────────────────────────────────────────────────────────────
    def database_schema(self, db_id: str) -> dict:
        return self.call(f"/databases/{db_id}").get("properties", {})

    def query_database(self, db_id: str, statuses: list[str] | None = None) -> list[dict]:
        """Все строки базы с курсорной пагинацией. Фильтр по статусу — на стороне Notion,
        чтобы не тянуть 239 страниц ради 99 открытых."""
        body: dict = {"page_size": 100}
        if statuses:
            body["filter"] = {"or": [{"property": "Status", "select": {"equals": s}}
                                     for s in statuses]}
        rows, cursor = [], None
        while True:
            if cursor:
                body["start_cursor"] = cursor
            data = self.call(f"/databases/{db_id}/query", "POST", body)
            rows += data.get("results", [])
            if not data.get("has_more"):
                return rows
            cursor = data["next_cursor"]

    def page_blocks(self, page_id: str, depth: int = 0) -> list[dict]:
        blocks, cursor = [], None
        while True:
            suffix = f"?start_cursor={cursor}&page_size=100" if cursor else "?page_size=100"
            data = self.call(f"/blocks/{page_id}/children{suffix}")
            for block in data.get("results", []):
                blocks.append(block)
                if block.get("has_children") and depth < 2:
                    blocks += self.page_blocks(block["id"], depth + 1)
            if not data.get("has_more"):
                return blocks
            cursor = data["next_cursor"]

    def page_text(self, page_id: str, strip_council: bool = True) -> str:
        """Плоский текст тела страницы. Блок консилиума вырезается — иначе прошлая
        проработка попадёт во вход следующей и модели начнут пересказывать сами себя.
        Ревью (strip_council=False) блок оставляет: прошлая проработка — контекст проверки."""
        lines = []
        for block in self.page_blocks(page_id):
            kind = block.get("type", "")
            node = block.get(kind) or {}
            text = plain(node.get("rich_text"))
            if not text:
                continue
            if kind.startswith("heading"):
                lines.append("#" * int(kind[-1]) + " " + text)
            elif kind in ("bulleted_list_item", "numbered_list_item", "to_do"):
                lines.append("- " + text)
            elif kind == "code":
                lines.append("```\n" + text + "\n```")
            else:
                lines.append(text)
        body = "\n".join(lines)
        if not strip_council:
            return body.strip()
        return re.sub(
            re.escape(COUNCIL_BLOCK_BEGIN) + r".*?" + re.escape(COUNCIL_BLOCK_END),
            "", body, flags=re.S,
        ).strip()

    def comments(self, page_id: str) -> list[dict]:
        """Пустой список при недоступности комментариев — но НЕ молча: по rules/17 §3
        обсуждение живёт именно в комментариях, и «у всех карточек их ноль» обязано
        отличаться от «интеграции не выдали доступ к комментариям»."""
        try:
            data = self.call(f"/comments?block_id={page_id}&page_size=100")
        except NotionError as exc:
            self.comment_errors += 1
            self.last_comment_error = str(exc)[:200]
            return []
        return [{"id": c["id"], "text": plain(c.get("rich_text")),
                 "at": c.get("created_time", "")} for c in data.get("results", [])]

    # ── запись: белый список ─────────────────────────────────────────────────
    def _guard(self, op: str, fields: list[str] | None = None) -> None:
        for f in fields or []:
            if f in HARD_FORBIDDEN_FIELDS:
                raise NotionForbidden(
                    f"поле `{f}` не пишется никогда (.claude/rules/17-notion-board.md §6, "
                    "docs/specs/ai-council.md §7а) — это баг вызывающего кода, не настройка"
                )
        if not self.allowed_writes.get(op, False):
            raise NotionForbidden(f"операция `{op}` выключена в outputs.notion_writeback")

    def update_properties(self, page_id: str, props: dict, op: str = "priority") -> dict:
        """props — уже в формате Notion API. Проверяются и операция, и имена полей."""
        self._guard(op, list(props.keys()))
        if self.dry_run:
            return {"__dry_run": True, "page_id": page_id, "properties": props}
        return self.call(f"/pages/{page_id}", "PATCH", {"properties": props})

    def add_comment(self, page_id: str, text: str) -> dict:
        self._guard("comments")
        if self.dry_run:
            return {"__dry_run": True, "page_id": page_id, "comment": text[:200]}
        return self.call("/comments", "POST", {
            "parent": {"page_id": page_id}, "rich_text": chunk_rich_text(text)})

    def review_transition(self, page_id: str, expected: str, target: str,
                          allowed: set[str]) -> dict:
        """Единственный путь, которым консилиум пишет Status, — переход по итогу ревью.

        HARD_FORBIDDEN_FIELDS не ослаблен: общий update_properties Status по-прежнему не
        пишет. Здесь — узкий канал с тремя проверками вместо одной: цель из политики доски,
        сохранённой владельцем (allowed), карточка ВСЁ ЕЩЁ в статусе ревью (expected —
        читается живьём, чтобы не перетереть решение человека, принятое за время прогона),
        свойство существует. rules/17 §6: политика доски = явное решение владельца."""
        if not target or target not in allowed:
            raise NotionForbidden(f"переход в «{target}» не разрешён политикой доски")
        if self.read_only:  # до чтения живого статуса: запрос впустую не тратим
            raise NotionForbidden("Notion только для чтения (sources.notion.read_only): переход ревью не пишется")
        page = self.call(f"/pages/{page_id}")
        node = (page.get("properties") or {}).get("Status") or {}
        kind = node.get("type") or "select"
        current = ((node.get(kind) or {}).get("name")) or ""
        if current != expected:
            raise NotionError(f"статус уже «{current}», ожидался «{expected}» — переход не применён")
        if self.dry_run:
            return {"__dry_run": True, "page_id": page_id, "from": current, "to": target}
        self.call(f"/pages/{page_id}", "PATCH", {"properties": {"Status": {kind: {"name": target}}}})
        return {"from": current, "to": target}

    def create_child_page(self, db_id: str, parent_card_id: str, title: str,
                          properties: dict | None = None) -> dict:
        """Создание дочерней карточки. Идемпотентность обеспечивает вызывающий
        (store.find_created_page по child_key) — здесь только транспорт и гварды."""
        self._guard("child_pages", list((properties or {}).keys()))
        payload = {
            "parent": {"database_id": db_id},
            "properties": {
                "Name": {"title": [{"text": {"content": title[:1900]}}]},
                "Parent task": {"relation": [{"id": parent_card_id}]},
                **(properties or {}),
            },
        }
        if self.dry_run:
            return {"__dry_run": True, "title": title, "parent": parent_card_id}
        return self.call("/pages", "POST", payload)

    def replace_council_block(self, page_id: str, markdown_lines: list[str]) -> dict:
        """Перезапись делимитированного блока проработки.

        Notion не умеет 'заменить диапазон блоков' — удаляем прежние блоки между маркерами
        поштучно, затем дописываем новые. Без этого каждый прогон удваивал бы тело страницы.
        """
        self._guard("elaboration_block")
        if self.dry_run:
            return {"__dry_run": True, "page_id": page_id, "lines": len(markdown_lines)}

        top = self.call(f"/blocks/{page_id}/children?page_size=100").get("results", [])
        inside, to_delete = False, []
        for block in top:
            text = plain(((block.get(block.get("type", "")) or {}).get("rich_text")))
            if COUNCIL_BLOCK_BEGIN in text:
                inside = True
            if inside:
                to_delete.append(block["id"])
            if COUNCIL_BLOCK_END in text:
                inside = False
        for block_id in to_delete:
            self.call(f"/blocks/{block_id}", "DELETE")

        children = [_para(COUNCIL_BLOCK_BEGIN)]
        children += [_para(line) for line in markdown_lines]
        children.append(_para(COUNCIL_BLOCK_END))
        # Notion принимает максимум 100 детей за запрос.
        for i in range(0, len(children), 90):
            self.call(f"/blocks/{page_id}/children", "PATCH", {"children": children[i:i + 90]})
        return {"deleted": len(to_delete), "appended": len(children)}


def _para(text: str) -> dict:
    return {"object": "block", "type": "paragraph",
            "paragraph": {"rich_text": chunk_rich_text(text)}}


# ── маппинг страницы Notion → строка таблицы cards ──────────────────────────
def page_to_card(page: dict, db: str, body: str = "", comments: list | None = None) -> dict:
    from store import sha16

    props = page.get("properties", {})
    modules = prop_multi(props, "Module")
    tags = prop_multi(props, "Tags")            # свойства может не быть до шага S1
    parents = prop_relation(props, "Parent task")
    comments = comments or []

    # Хэш считаем только по значимому: правка Last edited time сама по себе не повод
    # перепрорабатывать карточку, а изменение тела или приоритета — повод.
    significant = "|".join([
        prop_text(props, "Name"), prop_select(props, "Status"),
        prop_select(props, "Priority"), prop_select(props, "Severity"),
        prop_select(props, "Task Type"), ",".join(sorted(modules)), ",".join(sorted(tags)),
        prop_text(props, "Report"), str(prop_checkbox(props, "Half-baked idea")),
        body, "|".join(c["text"] for c in comments),
    ])

    return {
        "card_id": page["id"],
        "db": db,
        "title": prop_text(props, "Name"),
        "url": page.get("url", ""),
        "status": prop_select(props, "Status"),
        "priority": prop_select(props, "Priority") or None,
        "severity": prop_select(props, "Severity") or None,
        "task_type": prop_select(props, "Task Type") or None,
        "source": prop_select(props, "Source") or None,
        "backlog_id": prop_text(props, "Backlog ID") or None,
        "modules": json.dumps(modules, ensure_ascii=False),
        "tags": json.dumps(tags, ensure_ascii=False),
        "half_baked": 1 if prop_checkbox(props, "Half-baked idea") else 0,
        "parent_card_id": parents[0] if parents else None,
        "subtask_ids": json.dumps(prop_relation(props, "Subtasks")),
        "report": prop_text(props, "Report") or None,
        "body": body,
        "comments": json.dumps(comments, ensure_ascii=False),
        "content_hash": sha16(significant),
        "notion_edited_at": page.get("last_edited_time", ""),
        "fetched_at": int(time.time()),
    }


def build(cfg, dry_run: bool = False) -> NotionClient:
    return NotionClient(
        api_key=cfg.notion_key(),
        api_version=cfg.get("sources.notion.api_version", "2022-06-28"),
        rate_limit_rps=cfg.get("sources.notion.rate_limit_rps", 3),
        dry_run=dry_run,
        allowed_writes=cfg.get("outputs.notion_writeback", {}) or {},
        read_only=bool(cfg.get("sources.notion.read_only", False)),
    )


if __name__ == "__main__":
    # Диагностика: python3 infra/ai-council/notion.py
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import config as config_mod

    cfg = config_mod.load(strict=False)
    client = build(cfg, dry_run=True)
    try:
        me = client.whoami()
        print(f"интеграция: {me.get('name')} ({me.get('type')})")
    except NotionError as exc:
        print("❌", exc)
        sys.exit(1)

    for label in ("tasks", "bugs"):
        db_id = cfg.get(f"sources.notion.databases.{label}.id")
        schema = client.database_schema(db_id)
        missing = [p for p in ("Tags", "Council readiness", "Est") if p not in schema]
        print(f"\n{label}: {len(schema)} свойств")
        print(f"  отсутствуют (шаг S1): {', '.join(missing) if missing else '—'}")

    print("\nгварды записи:")
    for field_name in sorted(HARD_FORBIDDEN_FIELDS):
        try:
            client.update_properties("fake", {field_name: {}}, op="priority")
            print(f"  ✗ {field_name} — ЗАПИСЬ ПРОШЛА, это баг")
        except NotionForbidden as exc:
            print(f"  ✓ {field_name} заблокировано: {str(exc)[:70]}…")
