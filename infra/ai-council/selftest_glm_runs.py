#!/usr/bin/env python3
"""AI Council — самопроверка режима «всё на GLM 5.x»: прогоны (§17.6). Только stdlib.

Продолжение selftest_glm.py (вызывается из его run(), вынесено ради лимита 500 строк):
ревью в режиме — захват мимо блоков памяти, явная отметка без облака, окно не вместит прогон,
нет ключа подписки, тумблер (агенты и extractor в Coding Plan, лимиты после прогона), — и
проработка через council_worker.process на заглушках консилиума, плюс облачный судья тупика.
Сети нет: `chat` клиента подменён; Notion не трогается: process_run зовётся только на исходах
без итога «done» (после «done» он пишет итог на карточку).
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from selftest_glm import PAID        # noqa: E402
from store import Store              # noqa: E402


def run(tmp: Path, check, cfg) -> None:
    import glm_mode
    _review_runs(cfg, check, glm_mode, tmp)
    _worker_process(cfg, check, glm_mode, tmp)
    _claim_local_only(check, tmp, cfg)
    _arbitrate(cfg, check, glm_mode)


# ── ревью в режиме: очередь, явная отметка, окно, ключ, тумблер (b–e) ───────
def _review_runs(cfg, check, glm_mode, tmp: Path) -> None:
    import cloud as cloud_mod
    import council_worker as worker
    import queue_control as qc
    import review_state
    import selftest_review as sr
    from review_cli import process_run
    from review_engine import ReviewEngine
    from review_store import ReviewStore

    store = Store(tmp / "glm-review.db")
    rs, blocks = ReviewStore(store), qc.MemoryBlocks(store)
    local, canned = sr._E2EOllama(""), sr._E2EOllama("where: { companyId, deletedAt: null }")
    client = cloud_mod.build(cfg, store)
    client.providers["zai"]["key"] = "test-key"
    calls: list[tuple[str, str]] = []

    def cloud_chat(run_id, role, model, messages, schema=None, **_kw):
        calls.append((role, model))
        if role == "extractor":
            return cloud_mod.Completion(True, "items, service", None, model, 5, 1, 1)
        return canned.chat(model, messages, schema=schema)
    client.chat = cloud_chat
    retr = SimpleNamespace(ollama=local)
    engine = ReviewEngine(cfg, store, local, retr, client, logger=lambda m: None)
    prof = rs.profile(None)

    def enq(card_id: str, request: dict) -> str:
        rs.upsert_card({"card_id": card_id, "board": "tasks", "title": card_id, "review_hash": "h",
                        "comments": "[]", "body": "", "modules": "[]", "tags": "[]"})
        return rs.enqueue(rs.card(card_id), prof, "selftest", request)

    # b) захват: отметка проходит блок памяти профиля; битый JSON не роняет захват; тумблер — без блоков
    blocks.block("review", prof["id"], "нет памяти")
    loc, glm_r = enq("q-local", {}), enq("q-glm", {"cloud_mode": "glm5"})
    store.x("INSERT INTO review_runs (id, card_id, board, status, profile_id, request, created_at) "
            "VALUES ('rv_bad', 'q-bad', 'tasks', 'queued', ?, 'не json', 1)", (prof["id"],))
    got, nxt = rs.claim("w", blocks.active("review")), rs.claim("w", blocks.active("review"))
    blocked_any = worker._claim_review(SimpleNamespace(rs=rs), "w", blocks, "any", False)
    glob = worker._claim_review(SimpleNamespace(rs=rs), "w", blocks, "any", True)
    check("ревью: маршрут any без живого режима блоки памяти соблюдает — иначе захват по кругу (ревью #156)",
          blocked_any is None or blocked_any["id"] not in (loc,), blocked_any and blocked_any["id"])
    if blocked_any is not None:
        store.x("UPDATE review_runs SET status='queued', claimed_by=NULL WHERE id=?", (blocked_any["id"],))
        glob = worker._claim_review(SimpleNamespace(rs=rs), "w", blocks, "any", True)
    check("GLM 5.x ревью: отметка проходит блок памяти профиля, локальное ждёт; битый JSON запроса "
          "захват не роняет; при действующем тумблере блоки памяти не действуют",
          got is not None and got["id"] == glm_r and nxt is None
          and glob is not None and glob["id"] in (loc, "rv_bad"),
          (got and got["id"], nxt, glob and glob["id"]))
    store.x("UPDATE review_runs SET status='cancelled' WHERE status IN ('queued', 'running')")
    blocks.clear("review", prof["id"])
    loc2, glm2 = enq("q-local2", {}), enq("q-glm2", {"cloud_mode": "glm5"})
    only_local = rs.claim("w", [], route="local")
    none_left = rs.claim("w", [], route="local")
    only_glm = rs.claim("w", [], route="glm")
    check("ревью: маршрут local берёт неотмеченное, отмеченное «только для GLM» ждёт; glm — отмеченное",
          (only_local or {}).get("id") == loc2 and none_left is None and (only_glm or {}).get("id") == glm2,
          (only_local and only_local["id"], none_left, only_glm and only_glm["id"]))
    store.x("UPDATE review_runs SET status='cancelled' WHERE status IN ('queued', 'running')")
    blocks.block("review", prof["id"], "нет памяти")       # дальше проверки рассчитывают на блок профиля

    orig_dossier, seen = review_state.build_dossier, []

    def dossier(card, ctx, budget, retriever):
        if retriever is not None:          # так Retriever._llm_terms расширяет термины поиска
            seen.append(retriever.ollama.chat("qwen2.5:7b", [{"role": "user", "content": "x"}],
                                              temperature=0.1, max_tokens=80, retries=0).model)
        return sr.DOS, {"tokens": 300}
    review_state.build_dossier = dossier
    try:
        # c) тумблер без облака не действует; явная отметка без облака — итог с причиной
        os.environ["AI_COUNCIL_CLOUD"] = "0"
        glm_mode.set_on(store, True, "selftest")
        enq("c1", {})
        plan = engine.plan(rs.card("c1"), prof, {}, "")
        check("GLM 5.x ревью: тумблер без облака не действует — агенты по профилю, без отказа",
              not plan.get("glm") and not plan.get("glm_blocked")
              and not any(a["cloud"] for a in plan["agents"].values()))
        glm_mode.set_on(store, False, "selftest")
        store.x("UPDATE review_runs SET status='cancelled' WHERE status='queued'")
        rid = enq("c2", {"cloud_mode": "glm5"})
        outcome, _ = process_run(cfg, engine, rs.claim("w"), lambda m: None)
        row = rs.run(rid)
        check("GLM 5.x ревью: явная отметка без облака — «failed» с причиной, локальными не подменяется",
              outcome == "failed" and row["status"] == "failed" and "облак" in (row["error"] or "")
              and not rs.steps(rid) and not local.calls and not calls, (outcome, row["error"]))

        # d) окно не вместит потолок прогона — на своё место; нет ключа подписки — итог с причиной
        os.environ["AI_COUNCIL_CLOUD"] = "1"
        client.budget.enabled = True
        g, ts = glm_mode.settings(cfg), int(time.time())
        store.conn.executemany(
            "INSERT INTO cloud_usage (run_id, role, provider, model, tokens_in, tokens_out, usd, ms, "
            "ok, refused, error, created_at) VALUES ('x', 'r', 'zai', 'glm-5', 0, 0, 0, 0, 1, '', '', ?)",
            [(ts - 3600,)] * (g["max_calls_per_window"] - g["max_calls_per_run"] + 1))
        rid = enq("d1", {"cloud_mode": "glm5"})
        run = rs.claim("w")
        outcome, _ = process_run(cfg, engine, run, lambda m: None)
        row = rs.run(rid)
        worker.process_review, orig_proc = (lambda *a, **k: ("cloud_wait", "окно")), worker.process_review
        try:
            worker._run_review(cfg, engine, run, blocks)
        finally:
            worker.process_review = orig_proc
        check("GLM 5.x ревью: окно не вместит прогон — на своё место до освобождения окна: попытка не "
              "сожжена, транскрипта нет, сразу не берётся, профиль не блокируется",
              outcome == "cloud_wait" and row["status"] == "queued" and row["attempts"] == 0
              and (row["not_before"] or 0) > ts + 600 and row["error"].startswith(glm_mode.DEFER_PREFIX)
              and not rs.steps(rid) and rs.claim("w") is None and blocks.active("review") == [prof["id"]]
              and not client.budget.glm_mode, (outcome, row["status"], row["attempts"], row["error"]))
        store.x("DELETE FROM cloud_usage")
        store.x("UPDATE review_runs SET status='cancelled' WHERE status='queued'")
        zai = client.providers["zai"]
        zai["key"], zai["fallback"] = "", dict(PAID)
        rid = enq("d2", {"cloud_mode": "glm5"})
        outcome, _ = process_run(cfg, engine, rs.claim("w"), lambda m: None)
        row = rs.run(rid)
        zai["key"] = "test-key"
        check("GLM 5.x ревью: нет ключа подписки — итог с причиной, на платный контур не уходит",
              outcome == "failed" and row["status"] == "failed"
              and "только в подписку" in (row["error"] or "") and not calls, row["error"])

        # e) тумблер с облаком: все агенты и extractor — Coding Plan; после прогона лимиты по тумблеру
        glm_mode.set_on(store, True, "selftest")
        rid = enq("e1", {})
        run = rs.claim("w")

        def flip(*a, **k):              # облако выключили посреди прогона (правка конфига/env)
            os.environ["AI_COUNCIL_CLOUD"] = "0"
            return cloud_chat(*a, **k)
        client.chat = flip
        out = engine.process(run)
        row = rs.run(rid)
        models = {s["model"] for s in rs.steps(rid)}
        check("GLM 5.x ревью: тумблер — все агенты и расширение терминов досье в Coding Plan на 5.x, "
              "локальных вызовов нет, клиент Retriever возвращён",
              out.get("status") == "done" and models and all(m.startswith("glm-5") for m in models)
              and not local.calls and seen and set(seen) == {glm_mode.model_for(cfg, "extractor")}
              and ("extractor", glm_mode.model_for(cfg, "extractor")) in calls
              and retr.ollama is local and (row.get("snapshot") or {}).get("glm"), (out, models, seen))
        check("GLM 5.x ревью: после прогона лимиты — по тумблеру с учётом облака (выключено → обычные)",
              not client.budget.glm_mode and client.budget.run_cap == 0
              and client.budget.max_calls_per_window == cloud_mod.Budget.from_cfg(cfg).max_calls_per_window)
        worker.process_review, orig_proc = (lambda *a, **k: ("ok", "")), worker.process_review
        try:
            worker._run_review(cfg, engine, run, blocks)
        finally:
            worker.process_review = orig_proc
        check("GLM 5.x ревью: облачный прогон не снимает блок памяти профиля (стаж локальных цел)",
              blocks.active("review") == [prof["id"]] and worker._ran_on_glm(engine, run))
    finally:
        review_state.build_dossier = orig_dossier
        glm_mode.set_on(store, False, "selftest")
        os.environ["AI_COUNCIL_CLOUD"] = "1"
        store.close()


# ── проработка в режиме: отметка задачи, тумблер, облако выключено ──────────
def _worker_process(cfg, check, glm_mode, tmp: Path) -> None:
    import cloud as cloud_mod
    import council as council_mod
    import council_worker as worker

    store = Store(tmp / "glm-worker.db")
    store.upsert_card({"card_id": "c-glm", "db": "tasks", "title": "t", "content_hash": "h1",
                       "modules": "[]", "half_baked": 0})
    client = cloud_mod.build(cfg, store)
    client.providers["zai"]["key"], client.budget.enabled = "test-key", True
    calls: list[tuple[str, str]] = []
    client.chat = lambda run_id, role, model, messages, **kw: (
        calls.append((role, model)) or cloud_mod.Completion(True, "items", None, model, 5, 1, 1))
    local = SimpleNamespace(chat=lambda *a, **k: cloud_mod.Completion(True, "x", None, "qwen2.5:7b"))

    class _Retriever:
        ollama = local

        def build(self, card, user_constraints=""):
            res = self.ollama.chat("qwen2.5:7b", [{"role": "user", "content": "t"}],
                                   temperature=0.1, max_tokens=80, retries=0)
            return SimpleNamespace(tokens=lambda: {"total": 1}, evidence=[], terms=[res.model])

    class _Council:
        def __init__(self):
            self.cloud, self.escalation, self.glm_mode, self.seen = client, None, False, None
            self.ollama = SimpleNamespace(memory_check=lambda m: (True, ""))

        def roster(self, profile, card):
            return dict(cfg.roles(profile))

        def is_cloud_model(self, model):
            return bool(self.cloud.provider_of(model))

        def run_card(self, run_id, card, capsule, profile, track, roles_override=None):
            self.seen = {"roles": roles_override, "glm": self.glm_mode, "terms": capsule.terms,
                         "budget": (self.cloud.budget.glm_mode, self.cloud.run_allowance())}
            return council_mod.Outcome("done", payload={"ok": 1}, confidence=0.9, readiness=0.9)

    council, retr = _Council(), _Retriever()

    def go(cloud_mode: str = "") -> dict:
        council.seen = None
        rid = store.enqueue("c-glm", profile="fast", dedupe=False, cloud_mode=cloud_mode)
        worker.process(cfg, store, council, retr, store.claim_run("w"))
        return store.q1("SELECT status, error, cloud_mode FROM runs WHERE id = ?", (rid,))

    try:
        g = glm_mode.settings(cfg)
        row = go("glm5")
        roles = (council.seen or {}).get("roles") or {}
        check("GLM 5.x проработка: отметка задачи — роли 5.x (embed локально), extractor капсулы в "
              "Coding Plan, лимиты режима на прогон, клиент Retriever возвращён",
              row["status"] == "done" and row["cloud_mode"] == "glm5" and council.seen["glm"]
              and roles.get("embed") == cfg.roles("fast")["embed"]
              and all(m.startswith("glm-5") for r, m in roles.items() if r != "embed")
              and council.seen["terms"] == [g["models"]["extractor"]]
              and council.seen["budget"] == (True, g["max_calls_per_run"])
              and ("extractor", g["models"]["extractor"]) in calls and retr.ollama is local, council.seen)
        os.environ["AI_COUNCIL_CLOUD"], client.budget.enabled = "0", False
        row = go("glm5")
        check("GLM 5.x проработка: облако выключено — задача с отметкой «failed» с причиной, "
              "консилиум не запускался",
              row["status"] == "failed" and "облак" in (row["error"] or "") and council.seen is None,
              row["error"])
        glm_mode.set_on(store, True, "selftest")
        row = go()
        check("GLM 5.x проработка: тумблер при выключенном облаке не действует — ростер профиля",
              row["status"] == "done" and council.seen and council.seen["roles"] is None
              and not council.seen["glm"] and not row["cloud_mode"], council.seen)
        os.environ["AI_COUNCIL_CLOUD"], client.budget.enabled = "1", True
        glm_all = cfg.data.setdefault("models", {}).setdefault("glm_all", {})
        runs_on_glm = glm_all.get("runs_on_glm")
        glm_all["runs_on_glm"] = False
        row = go()
        # Решение владельца 2026-10-15: тумблер шапки — для ревью; проработки локально (квоты Coding Plan не хватает).
        check("GLM 5.x проработка: тумблер с облаком, runs_on_glm=false — прогон без отметки локально, не помечен",
              row["status"] == "done" and not council.seen["glm"] and not row["cloud_mode"], council.seen)
        glm_all["runs_on_glm"] = True
        row = go()
        check("GLM 5.x проработка: тумблер с облаком, runs_on_glm=true — прогон без отметки идёт в режиме и помечается",
              row["status"] == "done" and council.seen["glm"] and row["cloud_mode"] == "glm5")
        glm_all["runs_on_glm"] = runs_on_glm
    finally:
        glm_mode.set_on(store, False, "selftest")
        os.environ["AI_COUNCIL_CLOUD"] = "1"
        store.close()


# ── квота подписки исчерпана: облачные ждут, локальные проработки идут ──────
def _claim_local_only(check, tmp: Path, cfg=None) -> None:
    """2026-10-15: в ожидании сброса квоты воркер спал целиком — 474 проработки fast стояли сутки, хотя
    локальным моделям квота не нужна. Теперь в ожидании берутся только прогоны без отметки режима."""
    store = Store(tmp / "glm-local-only.db")
    try:
        for card in ("c-cloud", "c-local"):
            store.upsert_card({"card_id": card, "db": "tasks", "title": card, "content_hash": card,
                               "modules": "[]", "half_baked": 0})
        cloud_id = store.enqueue("c-cloud", priority=9, cloud_mode="glm5")
        local_id = store.enqueue("c-local", priority=1)
        first = store.claim_run("w", route="local")
        second = store.claim_run("w", route="local")
        check("GLM 5.x: маршрут local берёт локальную проработку, отмеченную режимом — нет",
              first is not None and first["id"] == local_id and second is None, f"{first} {second}")
        check("GLM 5.x: маршрут glm (облачная полоса) берёт отмеченную режимом",
              (store.claim_run("w", route="glm") or {}).get("id") == cloud_id)
        if cfg is not None:
            import cloud as cloud_mod
            import glm_mode
            import queue_control as qc_mod
            client = cloud_mod.build(cfg, store)
            client.providers["zai"]["key"], client.budget.enabled = "test-key", True
            glm_mode.apply_budget(client, cfg, False)          # тумблер выключен — лимиты режима не применены
            ok_before = glm_mode.available_now(cfg, client)[0]
            qc_mod.set_state(store, "cloud_quota:zai", {"until": int(time.time()) + 3600, "why": "1308"})
            ok_after, why = glm_mode.available_now(cfg, client)
            store.x("DELETE FROM council_state WHERE key LIKE 'cloud_quota:%'")
            g = glm_mode.settings(cfg)
            store.conn.executemany(
                "INSERT INTO cloud_usage (run_id, role, provider, model, tokens_in, tokens_out, usd, ms, ok, refused, "
                "error, created_at) VALUES ('x', 'r', 'zai', 'glm-5', 0, 0, 0, 0, 1, '', '', ?)",
                [(int(time.time()) - 60,)] * (g["max_calls_per_window"] - g["max_calls_per_run"] + 1))
            glm_mode.mark_unavailable(store, "суточный лимит токенов", seconds=60)
            marked_off, why_mark = glm_mode.available_now(cfg, client)
            store.x("DELETE FROM council_state WHERE key = ?", (glm_mode.UNAVAILABLE_KEY,))
            check("GLM 5.x: отказ preflight по невидимой заранее причине — GLM «недоступен» на время, полоса не "
                  "крутит ту же задачу", not marked_off and "токенов" in why_mark, why_mark)
            full, why_full = glm_mode.available_now(cfg, client)
            check("GLM 5.x доступен: квота видна и при выключенном тумблере; полное окно режима — недоступен",
                  ok_before and not ok_after and "квота" in why and not full and "окно" in why_full,
                  (ok_before, ok_after, why, full, why_full))
    finally:
        store.close()

    import council_worker as worker
    r = worker.plan_routes
    check("маршруты: GLM недоступен — основной воркер берёт локальное, полоса ждёт",
          r(True, False, False, False, True) == ("local", "local", False)
          and r(True, False, False, True, True).idle)
    check("маршруты: GLM доступен, полоса поднята — облачное у полосы, основной не простаивает на локальном",
          r(True, True, False, False, True) == ("", "local", False)
          and r(True, True, False, True, True) == ("any", "glm", False))
    check("маршруты: без полосы и при доступном GLM — всё, как раньше; облако выключено — всё основному",
          r(True, True, False, False, False) == ("any", "any", False)
          and r(True, False, False, False, True, cloud_on=False) == ("any", "any", False)
          and r(True, False, False, True, True, cloud_on=False).idle)
    from types import SimpleNamespace as _NS
    lane_cfg = _NS(get=lambda key, default=None: ["council", "council-cloud-1"]
                   if key == "supervisor.services" else default)
    no_lane_cfg = _NS(get=lambda key, default=None: ["council"] if key == "supervisor.services" else default)
    lane_db = Store(tmp / "lanes.db")
    try:
        silent = not worker.lanes_alive(lane_db, lane_cfg)
        worker.lane_beat(lane_db, "council-cloud-p1")
        beating = worker.lanes_alive(lane_db, lane_cfg) and not worker.lanes_alive(lane_db, no_lane_cfg)
        qc_state = __import__("queue_control")
        qc_state.set_state(lane_db, worker.LANE_STATE_KEY, {"worker": "x", "at": int(time.time()) - 300})
        stale = not worker.lanes_alive(lane_db, lane_cfg)
        lane_db.upsert_card({"card_id": "c-lane", "db": "tasks", "title": "c", "content_hash": "c",
                             "modules": "[]", "half_baked": 0})
        rid = lane_db.enqueue("c-lane")
        lane_db.claim_run("council-cloud-p1")
        lane_db.x("UPDATE runs SET heartbeat_at = ? WHERE id = ?", (int(time.time()), rid))
        busy = worker.lanes_alive(lane_db, lane_cfg)
    finally:
        lane_db.close()
    check("полоса: живость по пульсу — нет пульса или устарел → GLM-работу берёт основной; длинная задача "
          "полосы со свежим пульсом — жива; не объявлена в services — не жива",
          silent and beating and stale and busy)
    check("маршруты: тумблер выключен — отмеченное у полосы, неотмеченное локально",
          r(False, True, False, True, True) == ("glm", "glm", False)
          and r(False, True, False, False, True) == ("local", "local", False))


# ── облачный судья тупика в режиме — модель режима, не лестница ─────────────
def _arbitrate(cfg, check, glm_mode) -> None:
    import cloud as cloud_mod
    import council as council_mod

    class _Cfg:                         # лестница/судья облака — 4.x (владелец мог поставить и так)
        def get(self, key, default=None):
            return ["glm-4.6", "glm-4.7"] if key == "models.cloud.roles.ladder" else cfg.get(key, default)

        def cloud_role(self, _role):
            return "glm-4.6"

    used: list[str] = []
    cloud = SimpleNamespace(check_budget=lambda *a: (True, ""), chat=lambda run_id, role, model, msgs, **k: (
        used.append(model) or cloud_mod.Completion(True, "{}", {"goal": "g"}, model, 1, 1, 1)))
    stub = SimpleNamespace(cfg=_Cfg(), glm_mode=True, cloud=cloud, log=lambda m: None,
                           store=SimpleNamespace(log_message=lambda *a, **k: None),
                           _arbitration_package=lambda capsule, proposals: "пакет")
    _, model_on = council_mod.Council.cloud_arbitrate(stub, "run-arb", None, [], "тупик")
    stub.glm_mode = False
    _, model_off = council_mod.Council.cloud_arbitrate(stub, "run-arb", None, [], "тупик")
    check("GLM 5.x: облачный судья тупика — модель режима, а не лестница [models.cloud.roles]",
          model_on == glm_mode.model_for(cfg, "judge") and model_off == "glm-4.6", used)
