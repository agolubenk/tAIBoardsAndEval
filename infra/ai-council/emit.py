#!/usr/bin/env python3
"""AI Council — раунд R5: вынос результата на борд. Только stdlib.

Канон: docs/specs/ai-council.md §7 (контракт вывода), §10 (белый список записи).

    python3 infra/ai-council/emit.py --run <run_id>          # dry-run, только показать
    python3 infra/ai-council/emit.py --card <card_id|BID>    # последний done-прогон карточки
    python3 infra/ai-council/emit.py --pending               # всё, что ещё не вынесено
    python3 infra/ai-council/emit.py --pending --apply       # реальная запись на борд

До этого модуля результат консилиума жил только в `council.db` — то есть система
разговаривала сама с собой. Здесь он превращается в блок проработки, комментарий с диффом
относительно прошлого прогона и обновление свойств карточки.

Три правила, которые здесь не настройки, а инварианты:

1. **Dry-run по умолчанию.** Запись наружу требует явного `--apply`. Причина не в
   осторожности ради осторожности: борд — чужой рабочий инструмент, и цена ошибочного
   массового прохода по 125 карточкам несопоставима с ценой лишнего флага.
2. **Идемпотентность по содержимому.** Повторный вынос того же результата не пишет ничего:
   ключ — sha16 блока. Иначе каждый прогон плодил бы комментарии и версии блока, а удаления
   у консилиума нет (см. C4).
3. **Status и Half-baked не трогаются никогда** — за этим следит `_guard` в notion.py, но
   здесь они и не собираются: потолок агента «предложить», решение принимает человек.

Чего этот модуль НЕ делает и почему: `relations` из §7 не пишутся — арбитр их не производит
(`MERGED_SCHEMA` в council.py не содержит поля `relations`), поэтому писать нечего. Это
пробел контракта арбитра, а не забытая ветка кода.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import config as config_mod                              # noqa: E402
import notion as notion_mod                              # noqa: E402
from store import Store, sha16                           # noqa: E402

EST_ORDER = ("S", "M", "L", "XL")
# Свойство Council readiness создано шагом S1 в формате percent → Notion ждёт 0..100.
READINESS_SCALE = 100


def log(msg: str) -> None:
    print(msg, flush=True)


@dataclass
class EmitResult:
    card_id: str
    skipped: str = ""                       # непусто = ничего не писали, причина здесь
    block_hash: str = ""
    ops: list = field(default_factory=list)  # [(op, detail, ok, error)]

    @property
    def wrote(self) -> bool:
        return any(ok for _, _, ok, _ in self.ops)


# ── тело блока проработки ───────────────────────────────────────────────────
def render_block(card: dict, payload: dict, run: dict) -> list[str]:
    """Плоский список строк-параграфов: Notion-блоки создаются по одному на строку,
    вложенных списков намеренно нет — они усложняют перезапись без выигрыша."""
    statement = payload.get("statement") or {}
    lines: list[str] = [
        f"🤖 Проработка консилиума · readiness {payload.get('readiness', 0):.2f} · "
        f"confidence {payload.get('confidence', 0):.2f} · профиль {payload.get('profile', '?')}",
        "",
        f"ЦЕЛЬ: {statement.get('goal') or '—'}",
    ]

    non_goals = [g for g in (statement.get("non_goals") or []) if str(g).strip()]
    if non_goals:
        lines.append("НЕ ДЕЛАЕМ: " + "; ".join(str(g) for g in non_goals))

    if payload.get("track") == "half_baked":
        lines += ["", "⚠️ Карточка помечена Half-baked idea. Это разбор постановки, а не план "
                      "работ: в рабочее окно она не планируется, флаг снимает владелец."]

    steps = payload.get("decomposition") or []
    if steps:
        lines += ["", "ДЕКОМПОЗИЦИЯ:"]
        for i, step in enumerate(steps, 1):
            if not isinstance(step, dict):
                continue
            files = ", ".join(str(f) for f in (step.get("files") or [])[:6])
            depends = ", ".join(str(d) for d in (step.get("depends_on") or []))
            tail = f" [{step.get('est', '?')}]"
            if files:
                tail += f" · {files}"
            if depends:
                tail += f" · после: {depends}"
            lines.append(f"{i}. {step.get('what') or '—'}{tail}")

    touched = payload.get("touched") or {}
    touched_parts = [f"{key}: {', '.join(str(v) for v in (touched.get(key) or [])[:8])}"
                     for key in ("files", "routes", "prisma_models", "rpcs", "modules")
                     if touched.get(key)]
    if touched_parts:
        lines += ["", "ЗАТРАГИВАЕТ — " + " · ".join(touched_parts)]

    risks = [r for r in (payload.get("risks") or []) if isinstance(r, dict)]
    if risks:
        lines += ["", "РИСКИ:"]
        for risk in risks[:6]:
            sev = f" ({risk['severity']})" if risk.get("severity") else ""
            lines.append(f"— {risk.get('what') or '—'}{sev} → {risk.get('mitigation') or '—'}")

    acceptance = [a for a in (payload.get("acceptance") or []) if str(a).strip()]
    if acceptance:
        lines += ["", "КРИТЕРИИ ПРИЁМКИ:"]
        lines += [f"— {a}" for a in acceptance[:8]]

    if payload.get("verification_cmd"):
        lines += ["", f"ПРОВЕРКА: {payload['verification_cmd']}"]

    questions = [q for q in (payload.get("open_questions") or []) if str(q).strip()]
    if questions:
        lines += ["", "ОТКРЫТЫЕ ВОПРОСЫ (нужно решение человека):"]
        lines += [f"— {q}" for q in questions[:8]]

    removed = payload.get("removed_by_verifier") or []
    if removed:
        lines += ["", f"Верификатор вырезал неподтверждённого: {len(removed)} шт. — "
                      "модели ссылались на то, чего в репозитории нет."]

    provenance = payload.get("provenance") or {}
    models = ", ".join(provenance.get("models") or [])
    cloud = provenance.get("cloud") or {}
    footer = (f"Прогон {run['id']} · {time.strftime('%Y-%m-%d %H:%M')} · модели: {models or '—'}")
    if cloud.get("model"):
        verdict = "принят" if cloud.get("accepted") or cloud.get("resolved_deadlock") else "отклонён"
        footer += f" · облачный арбитр {cloud['model']} ({verdict})"
    # Доп. раунд и неудачный языковой повтор — видно владельцу: согласие после показа чужих ответов (сверка) или
    # правки по возражениям (дожим) — не то же, что согласие с первого раза.
    if provenance.get("extra_round_kind"):
        footer += (f" · доп. раунд: {provenance['extra_round_kind']}"
                   + (f" ({', '.join(sorted(provenance.get('extra_round') or {}))})"
                      if provenance.get("extra_round") else ""))
    if provenance.get("language_retry_failed"):
        footer += " · чужой язык остался у: " + ", ".join(provenance["language_retry_failed"])
    lines += ["", footer,
              "Статус карточки консилиум не меняет — это решение человека."]
    return lines


def render_comment(payload: dict, previous: dict | None) -> str:
    """Комментарий — это дифф, а не копия блока. Копия в комментарии бесполезна: она
    дублирует тело страницы и превращает обсуждение в свалку."""
    readiness = payload.get("readiness", 0)
    confidence = payload.get("confidence", 0)
    if previous is None:
        head = (f"Консилиум проработал карточку впервые: readiness {readiness:.2f}, "
                f"confidence {confidence:.2f}.")
        changes: list[str] = []
    else:
        head = (f"Консилиум перепроработал карточку: readiness "
                f"{previous.get('readiness', 0):.2f} → {readiness:.2f}, confidence "
                f"{previous.get('confidence', 0):.2f} → {confidence:.2f}.")
        changes = _diff_lines(previous, payload)

    questions = [q for q in (payload.get("open_questions") or []) if str(q).strip()]
    parts = [head]
    if changes:
        parts.append("Изменилось: " + "; ".join(changes))
    if questions:
        parts.append("Требует решения человека: " + "; ".join(str(q) for q in questions[:5]))
    else:
        parts.append("Открытых вопросов нет.")
    parts.append("Подробности — в блоке проработки в теле карточки.")
    return "\n".join(parts)


def _diff_lines(previous: dict, current: dict) -> list[str]:
    changes: list[str] = []
    old_steps = len(previous.get("decomposition") or [])
    new_steps = len(current.get("decomposition") or [])
    if old_steps != new_steps:
        changes.append(f"пунктов декомпозиции {old_steps} → {new_steps}")
    for key in ("files", "modules"):
        old = set(str(v) for v in ((previous.get("touched") or {}).get(key) or []))
        new = set(str(v) for v in ((current.get("touched") or {}).get(key) or []))
        added, gone = sorted(new - old), sorted(old - new)
        if added:
            changes.append(f"добавлено в {key}: {', '.join(added[:4])}")
        if gone:
            changes.append(f"убрано из {key}: {', '.join(gone[:4])}")
    old_q = set(str(q) for q in (previous.get("open_questions") or []))
    new_q = set(str(q) for q in (current.get("open_questions") or []))
    if new_q - old_q:
        changes.append(f"новых открытых вопросов: {len(new_q - old_q)}")
    if old_q - new_q:
        changes.append(f"снято вопросов: {len(old_q - new_q)}")
    return changes


# ── свойства карточки ───────────────────────────────────────────────────────
def est_bucket(payload: dict) -> str:
    """Общая трудоёмкость карточки из бакетов пунктов: берём максимум, а не сумму.
    Сумма ломается на длинных списках мелких шагов — десять S не равны XL."""
    buckets = [str(s.get("est")) for s in (payload.get("decomposition") or [])
               if isinstance(s, dict) and str(s.get("est")) in EST_ORDER]
    if not buckets:
        return ""
    return max(buckets, key=lambda b: EST_ORDER.index(b))


def build_properties(cfg, card: dict, payload: dict) -> tuple[dict, list[str]]:
    """Возвращает (props для Notion API, заметки о том, что НЕ стали писать).

    Принцип: заполняем пустое, не переписываем заполненное владельцем. Приоритет,
    поставленный человеком, — решение, а не черновик; расхождение с мнением консилиума
    уходит в комментарий, а не молча затирает поле.
    """
    props: dict = {}
    notes: list[str] = []
    is_bug = card["db"] == "bugs"

    # Council readiness — поле консилиума: его никто кроме него не заполняет, поэтому
    # перезапись здесь корректна по смыслу, а не «затирание чужого значения».
    if cfg.writeback("council_readiness"):
        props["Council readiness"] = {
            "number": round(float(payload.get("readiness") or 0) * READINESS_SCALE, 1)}

    # Est НЕ пишем, хотя свойство создано шагом S1 и оценка у нас есть. Причина не в
    # осторожности: снапшот `cards` не хранит текущее значение Est (нет колонки, и
    # page_to_card его не читает), поэтому отличить «пусто» от «владелец уже оценил»
    # невозможно — а значит любая запись рискует затереть чужую оценку. Разблокируется
    # добавлением колонки `est` в cards + чтением в page_to_card; до тех пор — в комментарий.
    bucket = est_bucket(payload)
    if bucket:
        notes.append(f"Est по декомпозиции — {bucket} (в свойство не пишу: снапшот не хранит "
                     "текущее значение, рискнул бы затереть твою оценку)")

    if cfg.writeback("module_augment"):
        current = set(json.loads(card.get("modules") or "[]"))
        proposed = {m for m in ((payload.get("touched") or {}).get("modules") or [])
                    if m in config_mod.CANONICAL_MODULES}
        merged = current | proposed
        if merged != current:
            # Только добавляем: снятие модуля — это переклассификация, решение человека.
            props["Module"] = {"multi_select": [{"name": m} for m in sorted(merged)]}

    if cfg.writeback("backlog_id_if_empty") and not card.get("backlog_id"):
        notes.append("Backlog ID пуст, но генерировать его консилиум не должен — "
                     "идентификатор задаёт владелец")

    if cfg.writeback("task_type") and not is_bug and not card.get("task_type"):
        notes.append("Task Type пуст: консилиум не выводит тип из декомпозиции — "
                     "это продуктовое решение")

    if cfg.writeback("priority"):
        field_name = "Severity" if is_bug else "Priority"
        existing = card.get("severity") if is_bug else card.get("priority")
        if existing:
            notes.append(f"{field_name} уже задан ({existing}) — не переписываю")
        else:
            notes.append(f"{field_name} пуст: консилиум не назначает его сам — "
                         "приоритет определяет владелец, а не оценка готовности")

    return props, notes


def build_tags(cfg, card: dict, payload: dict) -> list[dict] | None:
    """Тег `найдено-консилиумом` + `dams`, если уместно. Новых тегов не изобретаем:
    лимит `max_new_tags_per_run` существует, чтобы борд не оброс словарём из моделей."""
    if not cfg.writeback("tags"):
        return None
    current = set(json.loads(card.get("tags") or "[]"))
    limit = int(cfg.get("outputs.limits.max_new_tags_per_run", 5))
    wanted = {"найдено-консилиумом"} if payload.get("readiness", 0) >= 0.5 else set()
    added = sorted(wanted - current)[:limit]
    if not added:
        return None
    return [{"name": t} for t in sorted(current | set(added))]


# ── вынос ───────────────────────────────────────────────────────────────────
class Emitter:
    def __init__(self, cfg, store: Store, client: notion_mod.NotionClient, logger=log):
        self.cfg = cfg
        self.store = store
        self.client = client
        self.log = logger

    def previous_payload(self, card_id: str, run_id: str) -> dict | None:
        row = self.store.q1(
            "SELECT payload FROM runs WHERE card_id = ? AND id <> ? AND status = 'done' "
            "AND payload IS NOT NULL ORDER BY finished_at DESC LIMIT 1", (card_id, run_id))
        if not row or not row["payload"]:
            return None
        try:
            return json.loads(row["payload"])
        except ValueError:
            return None

    def already_emitted(self, card_id: str, block_hash: str) -> bool:
        """Идемпотентность по содержимому: тот же блок — второй раз не пишем.
        Учитываются только реальные записи, dry-run не считается выносом."""
        row = self.store.q1(
            "SELECT 1 FROM notion_writes WHERE page_id = ? AND op = 'elaboration_block' "
            "AND after = ? AND ok = 1 AND dry_run = 0 LIMIT 1", (card_id, block_hash))
        return row is not None

    def _record(self, result: EmitResult, run_id: str, page_id: str, op: str,
                detail: str, fn) -> None:
        """Одна операция записи: выполнить, залогировать в аудит, не уронить остальные.
        Отказ по белому списку (`NotionForbidden`) — это нормальный путь, а не сбой."""
        try:
            fn()
            result.ops.append((op, detail, True, ""))
            self.store.log_notion_write(run_id, page_id, op, field=detail,
                                        after=detail[:200], ok=True,
                                        dry_run=self.client.dry_run)
            self.log(f"      {'· ' if self.client.dry_run else '✓ '}{op}: {detail}")
        except notion_mod.NotionForbidden as exc:
            result.ops.append((op, detail, False, str(exc)))
            self.log(f"      ⊘ {op}: {exc}")
        except notion_mod.NotionError as exc:
            result.ops.append((op, detail, False, str(exc)))
            self.store.log_notion_write(run_id, page_id, op, field=detail, ok=False,
                                        dry_run=self.client.dry_run, error=str(exc))
            self.log(f"      ✗ {op}: {exc}")

    def emit(self, run: dict, card: dict) -> EmitResult:
        payload = json.loads(run["payload"]) if run.get("payload") else {}
        result = EmitResult(card_id=card["card_id"])
        if card.get("db") == "draft":
            # Черновик главной формы (Ф1/P2) — локальная карточка, никогда не
            # существовавшая в Notion. Писать в неё блок проработки нечем: нет page_id.
            result.skipped = "черновик главной формы — не выносится в Notion"
            return result
        if not payload:
            result.skipped = "у прогона нет payload"
            return result

        lines = render_block(card, payload, run)
        result.block_hash = sha16("\n".join(lines))
        if self.already_emitted(card["card_id"], result.block_hash):
            result.skipped = "тот же результат уже вынесен ранее"
            return result

        label = "Ошибка" if card["db"] == "bugs" else "Задача"
        mode = "DRY-RUN" if self.client.dry_run else "ЗАПИСЬ"
        self.log(f"  ▶ [{mode}] {label}: {card['title'][:66]}")

        page_id = card["card_id"]
        self._record(result, run["id"], page_id, "elaboration_block",
                     f"блок проработки, {len(lines)} строк",
                     lambda: self.client.replace_council_block(page_id, lines))

        previous = self.previous_payload(card["card_id"], run["id"])
        props, notes = build_properties(self.cfg, card, payload)
        tags = build_tags(self.cfg, card, payload)
        if tags is not None:
            props["Tags"] = {"multi_select": tags}

        if props:
            self._record(result, run["id"], page_id, "priority",
                         ", ".join(sorted(props)),
                         lambda: self.client.update_properties(page_id, props, op="priority"))

        comment = render_comment(payload, previous)
        if notes:
            comment += "\n\nЧего консилиум сознательно не менял: " + "; ".join(notes)
        self._record(result, run["id"], page_id, "comments",
                     f"комментарий, {len(comment)} симв.",
                     lambda: self.client.add_comment(page_id, comment))
        return result


def pending_runs(store: Store, limit: int = 200) -> list[dict]:
    """Прогоны, чей результат ещё не на борду. `notion_writes` — источник правды о том,
    что уже вынесено; поле в `runs` для этого не завели намеренно, чтобы не было двух."""
    return store.q(
        "SELECT r.* FROM runs r WHERE r.status = 'done' AND r.payload IS NOT NULL "
        "AND NOT EXISTS (SELECT 1 FROM notion_writes w WHERE w.run_id = r.id "
        "AND w.op = 'elaboration_block' AND w.ok = 1 AND w.dry_run = 0) "
        "ORDER BY r.finished_at DESC LIMIT ?", (limit,))


def main() -> int:
    parser = argparse.ArgumentParser(description="AI Council — вынос результата на борд")
    parser.add_argument("--run", help="конкретный прогон")
    parser.add_argument("--card", help="card_id или Backlog ID — берём последний done-прогон")
    parser.add_argument("--pending", action="store_true", help="всё, что ещё не вынесено")
    parser.add_argument("--limit", type=int, default=200)
    parser.add_argument("--apply", action="store_true",
                        help="реальная запись на борд (по умолчанию dry-run)")
    args = parser.parse_args()

    if not (args.run or args.card or args.pending):
        parser.error("нужен один из: --run, --card, --pending")

    cfg = config_mod.load(strict=False)
    if not cfg.notion_enabled():
        log("Notion выключен или нет ключа — выносить некуда")
        return 1

    with Store() as store:
        client = notion_mod.build(cfg, dry_run=not args.apply)
        emitter = Emitter(cfg, store, client)

        if args.run:
            runs = store.q("SELECT * FROM runs WHERE id = ?", (args.run,))
        elif args.card:
            card = store.get_card(args.card) or store.q1(
                "SELECT * FROM cards WHERE backlog_id = ? OR title LIKE ? LIMIT 1",
                (args.card, f"%{args.card}%"))
            if not card:
                log(f"карточка {args.card} не найдена в снапшоте")
                return 1
            runs = store.q(
                "SELECT * FROM runs WHERE card_id = ? AND status = 'done' AND payload IS NOT NULL "
                "ORDER BY finished_at DESC LIMIT 1", (card["card_id"],))
        else:
            runs = pending_runs(store, args.limit)

        if not runs:
            log("нечего выносить")
            return 0

        allowed = [k for k, v in (cfg.get("outputs.notion_writeback") or {}).items() if v]
        if client.read_only or not allowed:
            # Заморозка Notion (R-084): выносить некуда — это не ошибка прогона, а политика.
            log(f"Notion только для чтения или запись выключена — не выносим; прогонов в ожидании: {len(runs)}")
            return 0
        log(f"{'DRY-RUN — ничего не пишем' if client.dry_run else '⚠️ ЗАПИСЬ НА ЖИВОЙ БОРД'}; "
            f"прогонов: {len(runs)}; разрешено: {', '.join(allowed) or '— всё выключено'}")

        wrote, skipped, failed = 0, 0, 0
        for run in runs:
            card = store.get_card(run["card_id"]) if run.get("card_id") else None
            if not card:
                log(f"  ⊘ прогон {run['id']}: карточки нет в снапшоте")
                skipped += 1
                continue
            result = emitter.emit(run, card)
            if result.skipped:
                log(f"  ⊘ {card['title'][:60]}: {result.skipped}")
                skipped += 1
            elif any(not ok for _, _, ok, err in result.ops if err):
                failed += 1
            else:
                wrote += 1

        log(f"\nитого: вынесено {wrote}, пропущено {skipped}, с ошибками {failed}")
        if client.dry_run and wrote:
            log("это был dry-run — для реальной записи добавь --apply")
        return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
