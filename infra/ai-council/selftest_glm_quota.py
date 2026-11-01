"""AI Council — самопроверка: квота подписки (Z.AI 1308/1310) в режиме GLM 5.x.

Вызывается из selftest_glm.run. Сети не трогает: ответ провайдера подменён на уровне `_post`.
Инцидент 2026-10-14: 5-часовая квота кончилась посреди очереди — 284 отказа 1308 подряд, 28 ревью закончились
NEEDS_HUMAN с нулевой уверенностью и ушли комментариями в Notion. Теперь прогон ждёт сброса на своём месте.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from store import Store  # noqa: E402


def run(tmp: Path, check, cfg) -> None:
    import cloud as cloud_mod
    import glm_mode
    _client_mark(cfg, check, cloud_mod, glm_mode, tmp)
    _review_defer(cfg, check, cloud_mod, glm_mode, tmp)
    _worker_defer(cfg, check, cloud_mod, glm_mode, tmp)
    _review_keeps_fail(cfg, check, cloud_mod, glm_mode, tmp)


def _client(cfg, cloud_mod, glm_mode, store):
    client = cloud_mod.build(cfg, store)
    client.providers["zai"]["key"], client.budget.enabled, client.headroom = "test-key", True, {}
    glm_mode.apply_budget(client, cfg, True)
    return client


# ── клиент: отметка квоты, отказ без сети, общая отметка, preflight ─────────
def _client_mark(cfg, check, cloud_mod, glm_mode, tmp: Path) -> None:
    store = Store(tmp / "glm-quota.db")
    client = _client(cfg, cloud_mod, glm_mode, store)
    model = glm_mode.model_for(cfg, "arbiter")
    # Время сброса без зоны, как пишет Z.AI; прочтение «UTC» — единственное в будущем.
    reset = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(time.time() + 3600))
    posts: list[str] = []

    def fake_post(provider, url, body, headers, timeout):
        posts.append(url)
        return None, ('HTTP 429: {"error":{"code":"1308","message":"Usage limit reached for 5 hour. Your limit '
                      f'will reset at {reset}"}}}} [reset_at={reset}] — {cloud_mod.QUOTA_ERROR_MARK}. '
                      'Повторы не помогут, дорабатывать локально'), 429

    client._post = fake_post
    msgs = [{"role": "user", "content": "x"}]
    first = client.chat("run-q", "review.code_reviewer", model, msgs)
    until = client.quota_until("zai")
    second = client.chat("run-q", "review.dod_auditor", model, msgs)
    wait = client.quota_wait(model)
    check("квота GLM: 1308 ставит отметку со временем сброса, следующий вызов не уходит в сеть; "
          "клиент без raise_on_quota (шлюз, скрипты) получает Completion, а не исключение",
          not first.ok and abs(until - (time.time() + 3600)) < 120 and len(posts) == 1
          and not second.ok and wait is not None and abs(wait.until - until) < 1,
          f"posts={len(posts)} until={until - time.time():.0f}s second={second.error[:60]}")

    client.raise_on_quota = True
    try:
        client.chat("run-q", "review.qa_tester", model, msgs)
        raised = False
    except cloud_mod.CloudQuotaWait as exc:
        raised = abs(exc.until - until) < 1
    client.raise_on_quota = False
    check("квота GLM: клиент воркера (raise_on_quota) прерывает любой путь исключением до сброса", raised)

    # Недельная 1310: сброс через дни — отметка не дальше потолка (перепроверка), разбор тем же хвостом _post.
    weekly = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(time.time() + 3 * 86400))
    with Store(tmp / "glm-quota-weekly.db") as wstore:
        wclient = _client(cfg, cloud_mod, glm_mode, wstore)
        wclient._post = lambda *a, **k: (None, (
            'HTTP 429: {"error":{"code":"1310","message":"Weekly/Monthly Limit Exhausted. Your limit will reset at '
            f'{weekly}"}}}} [reset_at={weekly}] — {cloud_mod.QUOTA_ERROR_MARK}. Повторы не помогут'), 429)
        wclient.chat("run-w", "review.code_reviewer", model, msgs)
        wuntil = wclient.quota_until("zai")
        check("квота GLM: недельная 1310 — отметка ставится, срок не дальше потолка перепроверки (6 ч)",
              0 < wuntil - time.time() <= cloud_mod.QUOTA_MAX_WAIT_SECONDS + 5, f"{wuntil - time.time():.0f}s")
        # Процесс, не разобравший время сброса (+30 мин), не укорачивает чужую отметку.
        wclient._mark_quota("zai", "HTTP 429: квота без времени сброса")
        check("квота GLM: отметка только продлевается — неразобранный сброс не укорачивает её",
              abs(wclient.quota_until("zai") - wuntil) < 2, f"{wclient.quota_until('zai') - wuntil:.0f}s")
        soon = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(time.time() + 5))
        wstore.x("DELETE FROM council_state WHERE key LIKE 'cloud_quota:%'")
        wclient._mark_quota("zai", f"reset at {soon}")
        check("квота GLM: сброс «через секунды» — не меньше запаса, без цикла запросов",
              wclient.quota_until("zai") - time.time() >= cloud_mod.QUOTA_RESUME_GRACE_SECONDS - 2)

    with Store(tmp / "glm-quota.db") as other_store:
        other = _client(cfg, cloud_mod, glm_mode, other_store)
        check("квота GLM: отметку видит другой процесс консилиума (общая база)",
              other.quota_wait(model) is not None)

    ok, why, retry_at = glm_mode.preflight(client, cfg, "run-x")
    check("квота GLM: preflight откладывает прогон до сброса, а не завершает его",
          not ok and retry_at >= int(until) and "квота" in why, f"{ok} {retry_at - int(until)} {why[:60]}")

    glm_mode.apply_budget(client, cfg, False)
    check("квота GLM: вне режима отметка не действует — эскалация и второй контур работают как раньше",
          client.quota_wait(model) is None)
    glm_mode.apply_budget(client, cfg, True)

    from review_engine import ReviewEngine
    client.raise_on_quota = True
    engine = ReviewEngine(cfg, store, SimpleNamespace(), SimpleNamespace(), client, logger=lambda m: None)
    try:
        engine._call("rv-q", 1, "independent", "code_reviewer", model,  # noqa: SLF001
                     {"cloud": True, "options": {}}, "system", "user", {})
        raised = False
    except cloud_mod.CloudQuotaWait:
        raised = True
    check("квота GLM: движок ревью прерывает прогон, а не идёт дальше без голоса", raised)
    store.close()


# ── ревью: прерванное квотой — на место до сброса, без вердикта ─────────────
def _review_defer(cfg, check, cloud_mod, glm_mode, tmp: Path) -> None:
    from review_cli import process_run
    from review_store import ReviewStore

    store = Store(tmp / "glm-quota-review.db")
    rs = ReviewStore(store)
    prof = rs.profile(None)
    rs.upsert_card({"card_id": "q-card", "board": "tasks", "title": "q", "review_hash": "h",
                    "comments": "[]", "body": "", "modules": "[]", "tags": "[]"})
    rid = rs.enqueue(rs.card("q-card"), prof, "selftest", {"cloud_mode": "glm5"})
    run = rs.claim("w", [])
    until = time.time() + 1800

    def process(run, escalation=None):
        raise cloud_mod.CloudQuotaWait(until, "квота подписки zai исчерпана — прогон ждёт сброса")

    outcome, _why = process_run(cfg, SimpleNamespace(rs=rs, process=process), run, lambda m: None)
    row = store.q1("SELECT status, not_before, attempts, verdict, error FROM review_runs WHERE id = ?", (rid,))
    check("квота GLM: ревью «только для GLM», упёршееся в квоту, — на своё место до сброса, без вердикта и "
          "сожжённой попытки",
          outcome == "cloud_wait" and row["status"] == "queued" and (row["not_before"] or 0) >= int(until)
          and row["verdict"] is None and row["attempts"] == 0, dict(row))
    # Ревью по тумблеру (без отметки) сброса не ждёт: квота отмечена, следующий захват пойдёт локально (2026-10-15).
    rid2 = rs.enqueue(rs.card("q-card"), prof, "selftest", {})
    run2 = rs.claim("w", [])
    outcome2, _ = process_run(cfg, SimpleNamespace(rs=rs, process=process), run2, lambda m: None)
    row2 = store.q1("SELECT status, not_before, attempts, verdict FROM review_runs WHERE id = ?", (rid2,))
    check("квота GLM: ревью без отметки — назад в очередь без отсрочки, без вердикта и сожжённой попытки",
          run2 is not None and run2["id"] == rid2 and outcome2 == "cloud_wait" and row2["status"] == "queued"
          and row2["not_before"] is None and row2["verdict"] is None and row2["attempts"] == 0, dict(row2))
    store.close()


# ── проработка: прерванная квотой — на место до сброса ──────────────────────
def _worker_defer(cfg, check, cloud_mod, glm_mode, tmp: Path) -> None:
    import council_worker as worker

    store = Store(tmp / "glm-quota-worker.db")
    store.upsert_card({"card_id": "c-q", "db": "tasks", "title": "t", "content_hash": "h1",
                       "modules": "[]", "half_baked": 0})
    client = _client(cfg, cloud_mod, glm_mode, store)
    client.chat = lambda run_id, role, model, messages, **kw: cloud_mod.Completion(True, "items", None, model, 5, 1, 1)
    until = time.time() + 1800

    class _Retriever:
        ollama = SimpleNamespace(chat=lambda *a, **k: cloud_mod.Completion(True, "x", None, "qwen2.5:7b"))

        def build(self, card, user_constraints=""):
            return SimpleNamespace(tokens=lambda: {"total": 1}, evidence=[], terms=[])

    class _Council:
        def __init__(self):
            self.cloud, self.escalation, self.glm_mode = client, None, False
            self.ollama = SimpleNamespace(memory_check=lambda m: (True, ""))

        def roster(self, profile, card):
            return dict(cfg.roles(profile))

        def is_cloud_model(self, model):
            return bool(self.cloud.provider_of(model))

        def run_card(self, run_id, card, capsule, profile, track, roles_override=None):
            raise cloud_mod.CloudQuotaWait(until, "квота подписки zai исчерпана — прогон ждёт сброса")

    rid = store.enqueue("c-q", profile="fast", dedupe=False, cloud_mode="glm5")
    worker.process(cfg, store, _Council(), _Retriever(), store.claim_run("w"))
    row = store.q1("SELECT status, not_before, attempts, outcome FROM runs WHERE id = ?", (rid,))
    check("квота GLM: проработка, упёршаяся в квоту, — на своё место до сброса, не abstained",
          row["status"] == "queued" and row["not_before"] >= int(until) and row["attempts"] == 0
          and not row["outcome"], dict(row))
    store.close()


# ── ревью: квота после голоса «fail» — решение по политике, а не повтор с нуля ─
def _review_keeps_fail(cfg, check, cloud_mod, glm_mode, tmp: Path) -> None:
    import os
    import review_state
    import selftest_review as sr
    from review_cli import process_run
    from review_engine import ReviewEngine
    from review_store import ReviewStore

    store = Store(tmp / "glm-quota-keep.db")
    rs = ReviewStore(store)
    prof = rs.profile(None)
    local, canned = sr._E2EOllama(""), sr._E2EOllama("where: { companyId, deletedAt: null }")
    client = _client(cfg, cloud_mod, glm_mode, store)
    client.raise_on_quota = True
    state = {"left": 0}
    until = time.time() + 1800

    def cloud_chat(run_id, role, model, messages, schema=None, **_kw):
        if role == "extractor":
            return cloud_mod.Completion(True, "items, service", None, model, 5, 1, 1)
        if state["left"] <= 0:
            raise cloud_mod.CloudQuotaWait(until, "квота подписки zai исчерпана — прогон ждёт сброса")
        state["left"] -= 1
        return canned.chat(model, messages, schema=schema)    # участник голосует «fail» с critical
    client.chat = cloud_chat
    engine = ReviewEngine(cfg, store, local, SimpleNamespace(ollama=local), client, logger=lambda m: None)
    orig_dossier, prev_env = review_state.build_dossier, os.environ.get("AI_COUNCIL_CLOUD")

    def enq(card_id: str) -> str:
        rs.upsert_card({"card_id": card_id, "board": "tasks", "title": card_id, "review_hash": "h",
                        "comments": "[]", "body": "", "modules": "[]", "tags": "[]"})
        return rs.enqueue(rs.card(card_id), prof, "selftest", {"cloud_mode": "glm5"})

    try:
        review_state.build_dossier = lambda card, ctx, budget, retriever: (sr.DOS, {"tokens": 300})
        os.environ["AI_COUNCIL_CLOUD"] = "1"
        state["left"] = 1          # первый участник успел проголосовать «fail», дальше квота
        rid = enq("k-fail")
        outcome, _ = process_run(cfg, engine, rs.claim("w"), lambda m: None)
        row = rs.run(rid)
        check("квота GLM: голос «fail» до отказа квоты не теряется — ревью решено по политике (не ACCEPT), "
              "а не возвращено в очередь",
              outcome == "ok" and row["status"] == "done" and row["verdict"] == "FAIL"
              and "квота" in str(row.get("result") or ""), (outcome, row["status"], row["verdict"]))

        state["left"] = 0          # квота на первом же участнике: голосов нет — на место до сброса
        rid = enq("k-empty")
        outcome, _ = process_run(cfg, engine, rs.claim("w"), lambda m: None)
        row = rs.run(rid)
        check("квота GLM: без голосов «fail» ревью возвращается на место до сброса, без вердикта",
              outcome == "cloud_wait" and row["status"] == "queued" and row["verdict"] is None,
              (outcome, row["status"], row["verdict"]))
    finally:
        review_state.build_dossier = orig_dossier
        if prev_env is None:
            os.environ.pop("AI_COUNCIL_CLOUD", None)
        else:
            os.environ["AI_COUNCIL_CLOUD"] = prev_env
        store.close()
