#!/usr/bin/env python3
"""AI Council — сервис ревью: очередь из Notion, постановка, dry-run, итог на карточку.

Один код для трёх входов — вкладка «Ревью» (gateway), CLI/MCP (review_cli.py) и
council_worker. Запись в Notion — только отсюда и только двумя операциями:
комментарий с итогом (outputs.notion_writeback.comments) и переход статуса
(NotionClient.review_transition, разрешённые цели — из политики доски).
"""
from __future__ import annotations

import json
import time

import notion as notion_mod
import review_catalog as cat
from review_context import REVIEW_COMMENT_MARK, build_dossier, card_comments
from review_plan import build_plan
from review_store import ReviewStore
from store import sha16

VERDICT_KEY = {"ACCEPT": "on_accept", "FAIL": "on_fail", "INCONCLUSIVE": "on_inconclusive",
               "NEEDS_HUMAN": "on_needs_human"}
VERDICT_RU = {"ACCEPT": "ПРИНЯТО", "FAIL": "НА ДОРАБОТКУ", "NEEDS_HUMAN": "НУЖЕН ЧЕЛОВЕК",
              "INCONCLUSIVE": "НЕОДНОЗНАЧНО"}
_STATUS_CACHE: dict[str, tuple[float, list[str]]] = {}


def db_id(cfg, board: str) -> str:
    return cfg.get(f"sources.notion.databases.{board}.id") or ""


def cloud_models(cfg) -> set[str]:
    if not cfg.cloud_enabled():
        return set()
    out: set[str] = set()
    for node in (cfg.get("models.cloud.providers", {}) or {}).values():
        out.update(node.get("models") or [])
    return out


def board_statuses(cfg, board: str, client=None) -> tuple[list[str], str]:
    """Опции Status живьём из схемы базы (кэш 10 мин); фолбэк — rules/17."""
    hit = _STATUS_CACHE.get(board)
    if hit and time.time() - hit[0] < 600:
        return hit[1], "notion"
    try:
        client = client or notion_mod.build(cfg)
        node = client.database_schema(db_id(cfg, board)).get("Status") or {}
        kind = node.get("type") or "select"
        names = [o["name"] for o in (node.get(kind) or {}).get("options", []) if o.get("name")]
        if names:
            _STATUS_CACHE[board] = (time.time(), names)
            return names, "notion"
    except Exception:                                              # noqa: BLE001
        pass
    return list(cat.KNOWN_STATUSES[board]), "fallback"


def review_hash(card: dict) -> str:
    """Без собственных комментариев ревью: иначе наш же итог на карточке выглядел бы
    «изменением» и автозапуск ревьюил бы карточку по кругу."""
    own_free = "|".join(c.get("text", "") for c in card_comments(card, include_own=False))
    return sha16("|".join([card.get("title") or "", card.get("body") or "", card.get("report") or "",
                           card.get("priority") or "", card.get("severity") or "", own_free]))


# ── очередь ─────────────────────────────────────────────────────────────────
def sync_queue(cfg, rs: ReviewStore, client=None, boards: list[str] | None = None,
               verbose: bool = False) -> dict:
    client = client or notion_mod.build(cfg)
    stats = {"seen": 0, "fetched": 0, "left": 0, "errors": 0}
    policies = rs.boards()
    for board in boards or list(cat.BOARDS):
        policy = policies[board]
        if not policy.get("enabled") or not db_id(cfg, board):
            continue
        try:
            pages = client.query_database(db_id(cfg, board), [policy["review_status"]])
        except notion_mod.NotionError as exc:
            stats["errors"] += 1
            stats[f"{board}_error"] = str(exc)[:200]
            continue
        seen: set[str] = set()
        for page in pages:
            stats["seen"] += 1
            seen.add(page["id"])
            prev = rs.card(page["id"])
            edited = page.get("last_edited_time", "")
            if prev and prev.get("notion_edited_at") == edited and prev.get("body") is not None:
                body, comments = prev["body"], json.loads(prev.get("comments") or "[]")
            else:
                try:
                    body = client.page_text(page["id"], strip_council=False)
                    comments = client.comments(page["id"])
                except notion_mod.NotionError as exc:
                    stats["errors"] += 1
                    if verbose:
                        print(f"    ✗ {page['id'][:8]}: {exc}")
                    continue
                stats["fetched"] += 1
            base = notion_mod.page_to_card(page, board, body, comments)
            card = {**base, "board": board}
            card["review_hash"] = review_hash(card)
            rs.upsert_card(card)
        stats["left"] += rs.mark_left_queue(board, seen)
        if verbose:
            print(f"  ревью/{board}: {len(seen)} в статусе «{policy['review_status']}»")
    rs.s.event("review.synced", "", json.dumps(stats, ensure_ascii=False))
    return stats


def resolve_cards(rs: ReviewStore, ref: str, board: str = "") -> list[dict]:
    ref = (ref or "next").strip()
    if ref in ("all", "next"):
        queue = [c for c in rs.queue(board) if not c.get("half_baked")]
        if ref == "next":
            fresh = [c for c in queue if not c.get("last_run")]
            return (fresh or queue)[:1]
        return queue
    found = rs.find_card(ref)
    return [found] if found else []


def enqueue(cfg, rs: ReviewStore, ref: str, profile_ref: str = "", requested_by: str = "ui",
            request: dict | None = None, board: str = "", priority: int = 5,
            force: bool = False) -> dict:
    request = {k: v for k, v in (request or {}).items() if v not in (None, "", [], {})}
    cards = resolve_cards(rs, ref, board)
    if not cards:
        return {"ok": False, "error": f"карточка «{ref}» не найдена в очереди ревью — "
                                      "обновите очередь (синхронизация с Notion)", "queued": []}
    queued, skipped = [], []
    policies = rs.boards()
    for card in cards:
        active = rs.active_run(card["card_id"])
        if active and not force:
            skipped.append({"card_id": card["card_id"], "title": card.get("title"),
                            "why": f"уже {active['status']} ({active['id']})"})
            continue
        prof = rs.profile(profile_ref or policies[card["board"]].get("profile_id") or None) \
            or rs.profile(None)
        if not prof:
            return {"ok": False, "error": "нет ни одного профиля ревью", "queued": queued}
        run_id = rs.enqueue(card, prof, requested_by, request,
                            priority + (1 if card["board"] == "bugs" else 0))
        queued.append({"run_id": run_id, "card_id": card["card_id"], "title": card.get("title"),
                       "profile": prof["name"]})
    return {"ok": True, "queued": queued, "skipped": skipped}


def autorun(cfg, rs: ReviewStore, verbose: bool = False) -> int:
    """Автопостановка для досок с auto_run: один прогон на цикл ревью карточки, повтор —
    только если исполнитель изменил содержимое (review_hash без наших комментариев)."""
    n = 0
    for board, policy in rs.boards().items():
        if not (policy.get("enabled") and policy.get("auto_run")):
            continue
        for card in rs.queue(board):
            if card.get("half_baked"):
                continue
            last = card.get("last_run")
            if last and last["status"] in ("queued", "running"):
                continue
            if last and last.get("card_hash") == card.get("review_hash") \
                    and (last.get("created_at") or 0) >= (card.get("first_seen_at") or 0):
                continue
            res = enqueue(cfg, rs, card["card_id"], policy.get("profile_id") or "", "auto",
                          priority=3)
            n += len(res.get("queued") or [])
    if n and verbose:
        print(f"  ревью: автопостановка {n}")
    return n


# ── dry-run ─────────────────────────────────────────────────────────────────
def prepare(cfg, rs: ReviewStore, ref: str, profile_ref: str = "", request: dict | None = None,
            live: bool = True) -> dict:
    import ollama as ollama_mod
    request = request or {}
    cards = resolve_cards(rs, ref)
    if not cards:
        return {"ok": False, "checks": [{"ok": False, "text": f"карточка «{ref}» не в очереди ревью"}]}
    card = cards[0]
    policy = rs.boards()[card["board"]]
    prof = rs.profile(profile_ref or policy.get("profile_id") or None) or rs.profile(None)
    checks: list[dict] = []
    add = lambda ok, text, level="": checks.append({"ok": ok, "text": text, "level": level})  # noqa: E731
    if not prof:
        add(False, "нет профиля ревью")
        return {"ok": False, "checks": checks}
    client_o = ollama_mod.build(cfg)
    alive = client_o.alive()
    installed = set(client_o.installed_models()) if alive else set()
    clouds = cloud_models(cfg)
    plan = build_plan(card, prof, request, rs.agents(), rs.settings(),
                      int(cfg.get("models.num_ctx", 8192)),
                      client_o.context_length if alive else (lambda m: None),
                      lambda m: m in clouds)
    status_ok = card.get("status") == policy["review_status"]
    if live and cfg.notion_enabled():
        try:
            page = notion_mod.build(cfg).call(f"/pages/{card['card_id']}")
            node = page.get("properties", {}).get("Status") or {}
            live_status = ((node.get(node.get("type") or "select") or {}).get("name")) or ""
            status_ok = live_status == policy["review_status"]
            add(status_ok, f"статус в Notion сейчас: «{live_status}»"
                + ("" if status_ok else f" — ожидался «{policy['review_status']}»"))
        except Exception as exc:                                   # noqa: BLE001
            add(True, f"живой статус не прочитан ({type(exc).__name__}) — по снапшоту «{card.get('status')}»",
                "warn")
    else:
        add(status_ok, f"статус по снапшоту: «{card.get('status')}»")
    add(True, f"профиль «{prof['name']}» v{prof['version']}, метод {plan['method_label']}")
    if card.get("half_baked"):
        add(True, "карточка Half-baked — автозапуск её пропускает; ручной запуск — на ваше усмотрение", "warn")
    add(bool(plan["participants"]), f"участники: {len(plan['participants'])} "
        f"({', '.join(plan['participants']) or 'никого'})")
    add(alive, "Ollama отвечает" if alive else "Ollama не отвечает — локальные агенты не запустятся")
    for key, a in plan["agents"].items():
        if a["cloud"]:
            add(True, f"{key}: облачная модель {a['model']} (тратит окно подписки)", "warn")
        elif alive and a["model"] not in installed:
            add(False, f"{key}: модель {a['model']} не установлена в Ollama")
    if policy.get("allow_transition"):
        statuses, src = board_statuses(cfg, card["board"])
        for vkey in VERDICT_KEY.values():
            target = policy.get(vkey)
            if target:
                add(target in statuses, f"{vkey}: «{target}»" + ("" if target in statuses else " — нет на доске")
                    + (" (схема из Notion)" if src == "notion" else " (схема по rules/17)"))
        add(True, "переход потребует подтверждения человека" if policy.get("require_human_approval")
            else "переход применится автоматически по вердикту", "warn")
    else:
        add(True, "перевод статуса выключен политикой доски — итог будет рекомендацией", "")
    for w in plan["warnings"]:
        add(True, w, "warn")
    budget = min((a["input_budget"] for a in plan["agents"].values()), default=4000)
    text, meta = build_dossier(card, plan["spec"].get("context") or cat.DEFAULT_CONTEXT, budget, None)
    add(True, f"досье ≈ {meta['tokens']} токенов при бюджете {budget}; коммитов найдено: "
        f"{len(meta.get('commits') or [])}" + ("; DONE.md: есть" if meta.get("done_md") else ""))
    ok = all(c["ok"] for c in checks)
    return {"ok": ok, "checks": checks, "card": {k: card.get(k) for k in
            ("card_id", "board", "title", "url", "status", "backlog_id")},
            "profile": {"id": prof["id"], "name": prof["name"]}, "plan": plan,
            "dossier_preview": text[:6000], "dossier_meta": meta}


# ── итог на карточку ────────────────────────────────────────────────────────
REASON_RU = {
    "veto": "вето с уликами",
    "critical": "critical с опорой в диффе от голосующего fail или оппонента, подтверждён коллегой",
    "threshold": "порог голосов", "insufficient_evidence": "недостаточно доказательств",
    "unsupported_veto": "вето без улик — решение за человеком",
    "unverified_critical": "critical не подтверждён коллегой — решение за человеком",
    "open_evidence_gap": "critical-пробел аудитора доказательств не закрыт и не вернул карточку в работу — "
                         "решение за человеком",
    "critical_author_not_fail": "critical, но автор голосует не fail (часто подтверждение исправления) — "
                                "проверить, решение за человеком",
    "control_skipped": "оппонент/судья не успели", "major": "висят major-находки",
    "judge_against": "судья против принятия", "low_confidence": "низкая уверенность",
    "judge_vs_majority": "судья против большинства", "judge_tiebreak": "ничья, решил судья",
    "judge_fail_on_notes": "ничья, судья за FAIL, но опора только у находок голосующих не fail — "
                           "решение за человеком",
    "tie": "перевеса нет", "insufficient": "мало валидных выводов",
}
STANCE_RU = {"confirms": "подтвердил", "refutes": "оспорил", "unclear": "не смог решить"}


def _finding_mark(f: dict, notes=frozenset()) -> str:
    if f.get("grounding") in ("card", "none") and f.get("severity") == "critical":
        return " (без опоры в диффе)"
    if f.get("disputed"):
        return " (оспорено коллегой)"
    if f.get("confirmed_by"):
        # notes — подтверждённые critical, автор которых голосует не fail (review_policy._defect_claim)
        tail = "; автор голосует не fail — проверить, не подтверждение ли" if f.get("id") in notes else ""
        return f" (подтвердил {', '.join(f['confirmed_by'])}{tail})"
    return ""



def _comment_text(run: dict, transition_line: str) -> str:
    res, snap = run.get("result") or {}, run.get("snapshot") or {}
    verdict = run.get("verdict") or "—"
    lines = [f"{REVIEW_COMMENT_MARK} — {VERDICT_RU.get(verdict, verdict)} ({verdict}, "
             f"уверенность {run.get('confidence') or 0:.2f})",
             f"Профиль «{run.get('profile_name')}» · метод {cat.METHODS.get(snap.get('method') or '', {}).get('label', snap.get('method'))}"
             f" · модели: {', '.join(sorted({a['model'] for a in (snap.get('agents') or {}).values()}))}",
             f"Итог: {run.get('summary') or '—'}"]
    policy = res.get("policy") or {}
    if policy.get("verdict_reason"):
        # Все сработавшие основания NEEDS_HUMAN (review_policy.decide, verdict_reasons; нет у прогонов до 20.10),
        # иначе владелец видит одно из них и не видит, что, например, FAIL снят из-за заметки автора.
        codes = policy.get("verdict_reasons") or [policy["verdict_reason"]]
        why = "; ".join(REASON_RU.get(c, c) for c in codes)
        legacy = policy.get("legacy_verdict")
        lines.append(f"Основание: {why}" + (f" (прежняя политика: {legacy})"
                                             if legacy and legacy != verdict else ""))
    top = [f for f in res.get("findings") or [] if not f.get("refuted")
           and f.get("severity") in ("critical", "major")][:6]
    notes = frozenset((policy.get("flags") or {}).get("crit_notes") or ())  # нет у прогонов до 20.10
    if top:
        lines.append("Главное:")
        lines += [f"• [{f['severity']}] {f['title']}" + _finding_mark(f, notes)
                  + (f" — {f['recommendation']}" if f.get("recommendation") else "")
                  for f in top]
    # Переписка — по строке на обращение; полный текст ответов — только в UI («Переписка агентов»).
    talk = [c for c in res.get("consults") or [] if c.get("stance")][:4]
    if talk:
        lines.append("Переписка агентов: " + "; ".join(
            f"{c.get('about') or ''} {c.get('from')} → {c.get('to')}: {STANCE_RU.get(c['stance'], c['stance'])}"
            .strip() for c in talk))
    judge = res.get("judge") or {}
    if judge.get("dissent"):
        lines.append(f"Особое мнение: {judge['dissent']}")
    if judge.get("next_steps"):
        lines.append("Шаги: " + "; ".join(judge["next_steps"][:5]))
    votes = res.get("votes") or {}
    if votes:
        lines.append("Голоса: " + ", ".join(f"{k}={v.get('vote')} ({(v.get('confidence') or 0):.2f})"
                                            for k, v in votes.items()))
    lines.append(f"Статус: {transition_line}")
    lines.append(f"run: {run['id']} · подробности — AI Council, вкладка «Ревью»")
    return "\n".join(lines)


def after_run(cfg, rs: ReviewStore, run_id: str, client=None, log=print) -> dict:
    """Политика доски по вердикту: рекомендация / предложение / автопереход + комментарий."""
    run = rs.run(run_id)
    if not run or run["status"] != "done" or not run.get("verdict"):
        return {"ok": False}
    card = rs.card(run["card_id"]) or {}
    policy = rs.boards().get(run["board"], {})
    target = policy.get(VERDICT_KEY.get(run["verdict"], ""), "")
    allowed = {policy.get(k) for k in VERDICT_KEY.values() if policy.get(k)}
    client = client or (notion_mod.build(cfg) if cfg.notion_enabled() else None)
    if not target:
        rs.set_transition(run_id, "none", "", f"для {run['verdict']} переход не настроен", "ai")
        line = "переход для этого вердикта не настроен — решает человек"
    elif not policy.get("allow_transition"):
        rs.set_transition(run_id, "none", target, "перевод выключен политикой доски — рекомендация", "ai")
        line = f"рекомендация «{policy['review_status']}» → «{target}» (автоперевод выключен)"
    elif policy.get("require_human_approval"):
        rs.set_transition(run_id, "proposed", target, "ждёт подтверждения человека", "ai")
        rs.audit(run_id, run["card_id"], "transition.proposed", "ai", policy["review_status"], target)
        line = f"предложен переход «{policy['review_status']}» → «{target}», ждёт подтверждения"
    else:
        res = _apply(cfg, rs, run, policy, target, allowed, "ai", client)
        line = (f"переход применён: «{policy['review_status']}» → «{target}»" if res["ok"]
                else f"переход не применён: {res['error']}")
    if policy.get("post_comment") and client is not None and getattr(client, "read_only", False):
        rs.set_comment_state(run_id, "skipped")  # Notion заморожен (R-084): не ошибка, а политика
    elif policy.get("post_comment") and client is not None:
        try:
            client.add_comment(run["card_id"], _comment_text(rs.run(run_id), line))
            rs.set_comment_state(run_id, "posted")
            rs.audit(run_id, run["card_id"], "comment.posted", "ai")
        except notion_mod.NotionError as exc:
            rs.set_comment_state(run_id, "failed")
            rs.audit(run_id, run["card_id"], "comment.failed", "ai", detail=str(exc))
            log(f"    ✗ комментарий в Notion: {exc}")
    elif not policy.get("post_comment"):
        rs.set_comment_state(run_id, "skipped")
    log(f"    ✎ {line}" + (f" · card «{(card.get('title') or '')[:40]}»" if card else ""))
    return {"ok": True, "transition": line}


def _apply(cfg, rs: ReviewStore, run: dict, policy: dict, target: str, allowed: set[str],
           actor: str, client) -> dict:
    if client is None:
        return {"ok": False, "error": "Notion выключен или нет ключа"}
    try:
        client.review_transition(run["card_id"], policy["review_status"], target, allowed)
    except notion_mod.NotionForbidden as exc:
        rs.set_transition(run["id"], "failed", target, str(exc), actor)
        rs.audit(run["id"], run["card_id"], "transition.failed", actor, policy["review_status"], target, str(exc))
        return {"ok": False, "error": str(exc)}
    except notion_mod.NotionError as exc:
        rs.set_transition(run["id"], "skipped", target, str(exc), actor)
        rs.audit(run["id"], run["card_id"], "transition.skipped", actor, policy["review_status"], target, str(exc))
        return {"ok": False, "error": str(exc)}
    rs.set_transition(run["id"], "applied", target, "", actor)
    rs.audit(run["id"], run["card_id"], "transition.applied", actor, policy["review_status"], target)
    rs.s.log_notion_write(run["id"], run["card_id"], "review_status", "Status",
                          policy["review_status"], target, True)
    rs.s.x("UPDATE review_cards SET status = ?, in_queue = 0 WHERE card_id = ?", (target, run["card_id"]))
    return {"ok": True}


def decide_transition(cfg, rs: ReviewStore, run_id: str, approve: bool, actor: str,
                      comment: str = "") -> dict:
    """Решение человека по предложенному переходу. Применение — только при разрешённом
    политикой доски переводе; рекомендацию (прогон прошёл, пока перевод был выключен)
    применить можно только из UI — это действие владельца, не агента."""
    run = rs.run(run_id)
    if not run:
        return {"ok": False, "error": "прогон не найден"}
    state, target = run.get("transition_state"), run.get("transition_target") or ""
    if not target:
        return {"ok": False, "error": "у прогона нет цели перехода"}
    if state not in ("proposed", "none", "failed", "skipped"):
        return {"ok": False, "error": f"переход уже в состоянии «{state}»"}
    policy = rs.boards().get(run["board"], {})
    if approve and not policy.get("allow_transition"):
        return {"ok": False, "error": "перевод статуса выключен политикой доски — сначала "
                                      "разрешите его во вкладке «Ревью» → «Доски и переходы»"}
    if approve and state != "proposed" and actor != "ui":
        return {"ok": False, "error": "применить рекомендацию (без предложения политики) можно "
                                      "только из UI владельцем"}
    if not approve:
        rs.set_transition(run_id, "rejected", target, comment or "отклонено", actor)
        rs.audit(run_id, run["card_id"], "transition.rejected", actor, policy.get("review_status", ""),
                 target, comment)
        return {"ok": True, "state": "rejected"}
    allowed = {policy.get(k) for k in VERDICT_KEY.values() if policy.get(k)} | {target}
    client = notion_mod.build(cfg) if cfg.notion_enabled() else None
    res = _apply(cfg, rs, run, policy, target, allowed, actor, client)
    if res["ok"] and client is not None and policy.get("post_comment"):
        try:
            client.add_comment(run["card_id"], f"{REVIEW_COMMENT_MARK}: переход «{policy['review_status']}» → "
                               f"«{target}» подтверждён ({actor}). run: {run_id}"
                               + (f"\nКомментарий: {comment}" if comment else ""))
        except notion_mod.NotionError:
            pass
    return {**res, "state": "applied" if res["ok"] else rs.run(run_id)["transition_state"]}
