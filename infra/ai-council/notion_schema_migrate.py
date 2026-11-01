#!/usr/bin/env python3
"""AI Council — миграция схемы борда Notion (шаг S1). Только stdlib.

Канон: docs/specs/ai-council.md §10 «Чего в схеме нет» · §15 S1.

    python3 infra/ai-council/notion_schema_migrate.py            # dry-run: что будет сделано
    python3 infra/ai-council/notion_schema_migrate.py --apply    # выполнить
    python3 infra/ai-council/notion_schema_migrate.py --verify   # только проверить итог

Зачем отдельный файл, а не разовый скрипт: правится ЖИВОЙ борд владельца. Операция обязана
быть идемпотентной (повторный запуск ничего не ломает), проверяемой (--verify) и
отслеживаемой в git. Свойства Notion не удаляются этим скриптом ни при каких флагах —
откат делается руками в UI.

Три пункта расширенных прав записи (D2) без этих свойств физически невыразимы:
теги, негерархические связи, дочерние карточки для Ошибок.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import config as config_mod          # noqa: E402
import notion as notion_mod          # noqa: E402

# Простые свойства: имя → определение Notion API. Создаются независимо в каждой базе.
SIMPLE_PROPS: dict[str, dict] = {
    # Свободный словарь консилиума. Опции Notion создаёт сама при первой записи имени —
    # поэтому пустой список здесь, а лимит на новые опции живёт в config.toml.
    "Tags": {"multi_select": {"options": []}},
    # readiness из §7 — доля 0..1, percent отображается человекочитаемо.
    "Council readiness": {"number": {"format": "percent"}},
    # Бакет трудоёмкости для раскладки по времени §8.
    "Est": {"select": {"options": [
        {"name": "S", "color": "green"},
        {"name": "M", "color": "yellow"},
        {"name": "L", "color": "orange"},
        {"name": "XL", "color": "red"},
    ]}},
}

# Связи. dual_property → Notion сама создаёт парное свойство во второй базе;
# имя ей даёт автоматически, поэтому после создания парную переименовываем.
# (source_db, prop_name, target_db, ожидаемое_имя_парного_в_target)
RELATIONS = [
    ("tasks", "Related",       "tasks", "Related (обратная)"),
    ("tasks", "Related bugs",  "bugs",  "Related tasks"),
    ("bugs",  "Parent bug",    "bugs",  "Sub-bugs"),
]


def existing(client: notion_mod.NotionClient, db_id: str) -> dict:
    return client.database_schema(db_id)


def add_property(client: notion_mod.NotionClient, db_id: str, name: str,
                 definition: dict, apply: bool) -> str:
    if not apply:
        return "будет создано"
    client.call(f"/databases/{db_id}", "PATCH", {"properties": {name: definition}})
    return "создано"


def rename_property(client: notion_mod.NotionClient, db_id: str, old: str, new: str,
                    apply: bool) -> str:
    if not apply:
        return f"будет переименовано «{old}» → «{new}»"
    client.call(f"/databases/{db_id}", "PATCH", {"properties": {old: {"name": new}}})
    return f"переименовано «{old}» → «{new}»"


def main() -> int:
    parser = argparse.ArgumentParser(description="AI Council — миграция схемы борда (S1)")
    parser.add_argument("--apply", action="store_true", help="выполнить (иначе dry-run)")
    parser.add_argument("--verify", action="store_true", help="только проверить итоговую схему")
    args = parser.parse_args()

    cfg = config_mod.load(strict=False)
    if not cfg.notion_key():
        print("❌ нет Notion-ключа", file=sys.stderr)
        return 1
    # dry_run клиента отключаем: миграция схемы идёт через call() напрямую и
    # не проходит через белый список записи в карточки (это правка БД, не карточки).
    client = notion_mod.build(cfg, dry_run=False)

    dbs = {label: cfg.get(f"sources.notion.databases.{label}.id") for label in ("tasks", "bugs")}
    schemas = {label: existing(client, db_id) for label, db_id in dbs.items()}

    if args.verify:
        ok = True
        for label, schema in schemas.items():
            print(f"\n{label} ({len(schema)} свойств):")
            wanted = list(SIMPLE_PROPS) + [
                p for src, p, _, _ in RELATIONS if src == label
            ] + [pair for _, _, tgt, pair in RELATIONS if tgt == label]
            for name in wanted:
                present = name in schema
                ok = ok and present
                kind = schema[name]["type"] if present else "—"
                print(f"  {'✓' if present else '✗'} {name:22} {kind}")
        return 0 if ok else 1

    mode = "ПРИМЕНЕНИЕ" if args.apply else "DRY-RUN (для применения: --apply)"
    print(f"=== Миграция схемы борда — {mode} ===\n")
    changes = 0

    # 1. Простые свойства
    for label, db_id in dbs.items():
        print(f"{label}:")
        for name, definition in SIMPLE_PROPS.items():
            if name in schemas[label]:
                print(f"  · {name:22} уже есть ({schemas[label][name]['type']}) — пропуск")
                continue
            print(f"  + {name:22} {add_property(client, db_id, name, definition, args.apply)}")
            changes += 1
        print()

    # 2. Связи. Парное свойство создаётся Notion автоматически — его имя неизвестно
    #    заранее, поэтому сверяем схему целевой базы до и после.
    for src, prop, tgt, pair_name in RELATIONS:
        src_id, tgt_id = dbs[src], dbs[tgt]
        if prop in schemas[src]:
            print(f"связь {src}.{prop:14} уже есть — пропуск")
            continue

        before = set(existing(client, tgt_id)) if args.apply else set()
        definition = {"relation": {"database_id": tgt_id,
                                   "type": "dual_property", "dual_property": {}}}
        print(f"связь {src}.{prop:14} → {tgt}: "
              f"{add_property(client, src_id, prop, definition, args.apply)}")
        changes += 1

        if not args.apply:
            print(f"       парное в {tgt} будет названо «{pair_name}»")
            continue

        after = set(existing(client, tgt_id))
        created = after - before
        # При self-relation парное свойство появляется в той же базе — оно тоже в created.
        created.discard(prop)
        if not created:
            print(f"       ⚠ парное свойство в {tgt} не обнаружено — проверьте руками")
            continue
        auto_name = created.pop()
        if auto_name != pair_name:
            print(f"       {rename_property(client, tgt_id, auto_name, pair_name, True)}")
        else:
            print(f"       парное «{pair_name}» создано")

    print(f"\nизменений: {changes}")
    if not args.apply and changes:
        print("Ничего не записано. Для применения: --apply")
    return 0


if __name__ == "__main__":
    sys.exit(main())
