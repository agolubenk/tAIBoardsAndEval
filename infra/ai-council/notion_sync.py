#!/usr/bin/env python3
"""AI Council — сервис синхронизации борда Notion → локальный снапшот. Только stdlib.

Канон: docs/specs/ai-council.md §10 · §3.

    python3 infra/ai-council/notion_sync.py            # сервис (цикл по poll_interval_min)
    python3 infra/ai-council/notion_sync.py --once     # один проход и выход
    python3 infra/ai-council/notion_sync.py --once --enqueue   # + поставить изменённое в очередь

Направление здесь только одно — чтение. Запись на борд делает council-воркер по итогам
проработки (фаза P3), а не этот сервис: разделение нужно, чтобы падение синхронизации
никогда не приводило к записи полуфабриката в чужие карточки.

Стоимость полного прохода: 2 запроса на список + по 2 запроса (тело, комментарии) на карточку,
которая изменилась с прошлого раза. Первый проход по 125 открытым карточкам — ~1.5 минуты при
лимите 3 rps; последующие — секунды, потому что тело тянется только при смене last_edited_time.
"""
from __future__ import annotations

import argparse
import json
import signal
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import config as config_mod                              # noqa: E402
import notion as notion_mod                              # noqa: E402
from store import REPO_ROOT, Store, git_sha              # noqa: E402

_stopping = False


def _handle_stop(_signum, _frame):
    global _stopping
    _stopping = True


def sync_once(cfg, store: Store, client: notion_mod.NotionClient,
              enqueue: bool = False, verbose: bool = True) -> dict:
    stats = {"seen": 0, "changed": 0, "queued": 0, "errors": 0, "skipped_body": 0}
    config_hash, sha = cfg.config_hash(), git_sha()
    half_baked_mode = cfg.get("sources.notion.half_baked", "elaborate_only")
    excluded_modules = set(cfg.get("sources.notion.exclude.modules", []) or [])
    excluded_ids = set(cfg.get("sources.notion.exclude.backlog_ids", []) or [])

    for label in ("bugs", "tasks"):            # Ошибки первыми — rules/17 §2
        db_conf = cfg.get(f"sources.notion.databases.{label}") or {}
        db_id, statuses = db_conf.get("id"), db_conf.get("statuses")
        if not db_id:
            continue
        try:
            pages = client.query_database(db_id, statuses)
        except notion_mod.NotionError as exc:
            stats["errors"] += 1
            if verbose:
                print(f"  ✗ {label}: {exc}")
            continue

        if verbose:
            print(f"  {label}: {len(pages)} открытых карточек")

        for page in pages:
            stats["seen"] += 1
            card_id = page["id"]
            props = page.get("properties", {})

            backlog_id = notion_mod.prop_text(props, "Backlog ID")
            modules = set(notion_mod.prop_multi(props, "Module"))
            if backlog_id in excluded_ids or (modules & excluded_modules):
                continue
            if half_baked_mode == "skip" and notion_mod.prop_checkbox(props, "Half-baked idea"):
                continue

            # Тело и комментарии — 2 запроса на карточку. Тянем только если страница
            # действительно менялась: иначе каждый polling-цикл стоил бы 250 вызовов.
            prev = store.get_card(card_id)
            edited = page.get("last_edited_time", "")
            if prev and prev.get("notion_edited_at") == edited:
                stats["skipped_body"] += 1
                body = prev.get("body") or ""
                comments = json.loads(prev.get("comments") or "[]")
            else:
                try:
                    body = client.page_text(card_id)
                    comments = client.comments(card_id)
                except notion_mod.NotionError as exc:
                    stats["errors"] += 1
                    if verbose:
                        print(f"    ✗ {card_id[:8]}: {exc}")
                    continue

            card = notion_mod.page_to_card(page, label, body, comments)
            changed = store.upsert_card(card)
            if not changed:
                continue

            stats["changed"] += 1
            store.event("card.changed", card_id, card["title"][:120])
            if verbose:
                print(f"    ~ {card['title'][:70]}")

            if enqueue:
                track = "half_baked" if card["half_baked"] else "elaborate"
                profile = "fast" if cfg.get("models.profile") in ("adaptive", "fast") else "deep"
                run_id = store.enqueue(
                    card_id, track=track, profile=profile,
                    priority=2 if label == "bugs" else 1,
                    config_hash=config_hash, git_sha=sha,
                    card_hash=card["content_hash"],
                )
                if run_id:
                    stats["queued"] += 1

    # Недоступность комментариев — не «их нет», а потеря входа для проработки (rules/17 §3).
    if client.comment_errors:
        stats["comment_errors"] = client.comment_errors
        if verbose:
            print(f"  ⚠ комментарии недоступны для {client.comment_errors} карточек: "
                  f"{client.last_comment_error}")
        store.event("sync.comment_errors", "", client.last_comment_error)
        client.comment_errors, client.last_comment_error = 0, ""

    store.event("sync.done", "", json.dumps(stats))
    return stats


def main() -> int:
    parser = argparse.ArgumentParser(description="AI Council — Notion sync")
    parser.add_argument("--once", action="store_true", help="один проход и выход")
    parser.add_argument("--enqueue", action="store_true",
                        help="ставить изменённые карточки в очередь проработки")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    signal.signal(signal.SIGTERM, _handle_stop)
    signal.signal(signal.SIGINT, _handle_stop)

    cfg = config_mod.load(strict=False)
    if not cfg.notion_enabled():
        print("Notion выключен или нет ключа — сервис в офлайне, снапшот не обновляется.")
        if args.once:
            return 1
        while not _stopping:                  # не крутим CPU, но и не падаем в restart-цикл
            time.sleep(30)
        return 0

    client = notion_mod.build(cfg)
    interval = max(int(cfg.get("sources.notion.poll_interval_min", 15)), 1) * 60
    verbose = not args.quiet

    with Store() as store:
        while True:
            started = time.time()
            if verbose:
                print(f"[{time.strftime('%H:%M:%S')}] синхронизация борда…", flush=True)
            try:
                stats = sync_once(cfg, store, client, enqueue=args.enqueue, verbose=verbose)
            except Exception as exc:                       # noqa: BLE001
                print(f"  ✗ проход упал: {exc}", flush=True)
                stats = {"errors": 1}
            # Очередь «на ревью» — тем же проходом и тем же клиентом (лимит 3 rps общий).
            # Отдельная таблица review_cards: в cards её не кладём — планировщик читает
            # cards целиком. Сбой ревью-синхронизации не роняет основную.
            try:
                import review_service as review_svc
                from review_store import ReviewStore
                rstats = review_svc.sync_queue(cfg, ReviewStore(store), client, verbose=verbose)
                queued = review_svc.autorun(cfg, ReviewStore(store), verbose=verbose)
                if verbose:
                    print(f"  ревью: {rstats}" + (f", автозапуск {queued}" if queued else ""),
                          flush=True)
            except Exception as exc:                       # noqa: BLE001
                print(f"  ✗ синхронизация ревью упала: {type(exc).__name__}: {exc}", flush=True)
            if verbose:
                print(f"  итог: {stats} за {time.time() - started:.1f}s", flush=True)
            if args.once or _stopping:
                return 1 if stats.get("errors") and not stats.get("seen") else 0
            for _ in range(interval):
                if _stopping:
                    return 0
                time.sleep(1)


if __name__ == "__main__":
    sys.exit(main())
