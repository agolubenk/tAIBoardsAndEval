#!/usr/bin/env python3
"""AI Council — режим «всё на GLM 5.x». Только stdlib.

Канон: docs/specs/ai-council.md §17.6. Решение владельца 2026-10-09:

* в режиме КАЖДАЯ модельная роль прогона уходит в подписку Z.AI Coding Plan
  (`[models.cloud.providers.zai]`, `/api/coding/paas/v4`) на модели 5-го поколения —
  предложения, рецензии, скептик, арбитр, облачный судья тупика, расширение терминов поиска
  (extractor), агенты ревью. Платный контур General API в режиме закрыт (cloud.py). Локально
  остаётся только `embed`: у Coding API нет эмбеддингов, а вектор чужой модели несовместим
  с корпусом;
* включается двумя способами: глобальный тумблер в шапке UI (флаг в council_state —
  действует на прогоны, взятые ПОСЛЕ переключения, без рестарта воркера) и явная отметка
  на отдельной задаче (`runs.cloud_mode = 'glm5'`, у ревью — `cloud_mode` в запросе);
* пока режим действует, лимиты подписки — свои (`[models.glm_all]`, по умолчанию 500 вызовов
  за 10 ч): общий `[models.cloud.budget]` занижен намеренно — он держит фоновое облако
  (арбитраж тупиков, эскалацию), а не прогон, где облако — это весь консилиум;
* облако выключено (`cloud_enabled()`) → режим не исполняется: задача с явной отметкой
  завершается с причиной, а не молча уходит на локальные модели; тумблер шапки не действует.

Интерфейс ниже вызывает и движок ревью (review_*.py) — имена и сигнатуры стабильны.
"""
from __future__ import annotations

import json
import re
import time
from contextlib import contextmanager

STATE_KEY = "glm.mode"          # council_state: глобальный тумблер шапки
CLOUD_MODE = "glm5"             # runs.cloud_mode / request["cloud_mode"]
PROVIDER = "zai"                # только подписка Coding Plan; General API — не цель режима
LOCAL_ROLES = ("embed",)        # что не уходит в облако никогда
# Отложенная режимом задача (окно подписки занято) — runs.error / review_runs.error. По этому
# префиксу UI рисует «GLM 5.x ждёт окно», а выключение тумблера возвращает такие задачи.
DEFER_PREFIX = "GLM 5.x ждёт облако: "
# Ревью отмечается режимом в запросе (review_runs.request — JSON). json_valid — до json_extract:
# одна строка с битым JSON иначе роняла бы весь захват очереди ревью.
REVIEW_REQUESTED_SQL = ("COALESCE(CASE WHEN json_valid(request) THEN json_extract(request, "
                        "'$.cloud_mode') END, '') = 'glm5'")
# «5.x» и «объявлена у zai» проверяет config._validate_glm на старте и при правке из UI —
# здесь карта берётся как есть.

# Значения по умолчанию — на случай конфига без секции [models.glm_all]: тумблер в шапке
# не должен падать KeyError. Канон — config.toml, валидатор проверяет его, не эти числа.
DEFAULTS = {"window_hours": 10, "max_calls_per_window": 500, "max_calls_per_day": 1200,
            "max_calls_per_run": 40, "max_tokens_per_day": 20_000_000}
DEFAULT_MODELS = {"proposer.code": "glm-5", "proposer.arch": "glm-5.1",
                  "proposer.skeptic": "glm-5.3", "arbiter": "glm-5.2", "extractor": "glm-5",
                  "judge": "glm-5.2", "default": "glm-5"}


def settings(cfg) -> dict:
    """{"models": {роль: модель}, "window_hours", "max_calls_per_window", "max_calls_per_day",
    "max_calls_per_run", "max_tokens_per_day", "provider": "zai"}."""
    node = (cfg.get("models.glm_all", {}) if cfg is not None else {}) or {}
    models = {str(k): str(v) for k, v in (node.get("models") or {}).items() if v}
    out = {"models": models or dict(DEFAULT_MODELS), "provider": PROVIDER,
           "runs_on_glm": bool(node.get("runs_on_glm", False))}
    for key, default in DEFAULTS.items():
        try:
            out[key] = int(node.get(key, default))
        except (TypeError, ValueError):
            out[key] = default
    return out


# ── глобальный тумблер ─────────────────────────────────────────────────────
def _state(store) -> dict | None:
    import queue_control
    value = queue_control.get_state(store, STATE_KEY)
    return value if isinstance(value, dict) else None


def is_on(store) -> bool:
    state = _state(store)
    return bool(state and state.get("on"))


def effective(store, cfg) -> bool:
    """Тумблер шапки действует: включён И облако включено. Одно определение на воркер, движок
    ревью, шлюз и отчёт — иначе шапка показывала бы одни лимиты, а воркер отказывал по другим."""
    return cfg is not None and bool(cfg.cloud_enabled()) and is_on(store)


def effective_for_runs(store, cfg) -> bool:
    """Тумблер шапки действует и на проработки карточек — только при `[models.glm_all] runs_on_glm = true`.

    Решение владельца 2026-10-15 (вариант «а» из плана 13.10): проработки — на локальных моделях строго по
    одной, ревью — на GLM. Квота Coding Plan — ~46 вызовов glm-5 за 5 ч, а проработка fast — ~15 вызовов: 474
    проработки на GLM — недели, при этом воркер стоял весь (ревью первыми, затем ожидание сброса квоты).
    Локальный fast — qwen2.5 7B + glm4 9B, ~7 мин на карточку: те же 474 — ~2 суток. Явная отметка
    задачи (`runs.cloud_mode`) по-прежнему решает сама — это не тумблер."""
    return effective(store, cfg) and bool(settings(cfg).get("runs_on_glm"))


UNAVAILABLE_KEY = "glm.unavailable"     # council_state: GLM не принял задачу по причине, которую не видно заранее
UNAVAILABLE_SECONDS = 600


def mark_unavailable(store, why: str, seconds: int = UNAVAILABLE_SECONDS) -> None:
    """Полоса не смогла начать GLM-задачу без отметки (preflight отказал: суточные токены, потолок прогона…) —
    GLM «недоступен» на `seconds`: полоса не берёт ту же задачу по кругу, основной воркер ведёт её локально."""
    import queue_control  # noqa: PLC0415
    queue_control.set_state(store, UNAVAILABLE_KEY, {"until": int(time.time()) + int(seconds), "why": why[:300]})


def available_now(cfg, cloud_client) -> tuple[bool, str]:
    """GLM 5.x можно звать прямо сейчас: облако включено, квота подписки не исчерпана, провайдер не помечен
    сбоем. Нет — задачи «только для GLM» ждут восстановления во второй очереди, остальные идут локально
    (решение владельца 2026-10-15: «консилиум должен работать всегда»)."""
    if cloud_client is None or cfg is None or not cfg.cloud_enabled():
        return False, "облако выключено"
    model = model_for(cfg, "arbiter")
    # Отметка квоты — напрямую, а не через quota_wait: тот молчит, пока лимиты режима не применены к клиенту
    # (тумблер выключен), и полоса перебирала бы отмеченные задачи по одной (ревью #156).
    provider = cloud_client.provider_of(model)
    until = cloud_client.quota_until(provider)
    if until:
        return False, f"квота подписки {provider} исчерпана до {time.strftime('%H:%M', time.localtime(until))}"
    ok, why = cloud_client.available(model)
    if not ok:
        return False, why
    if cloud_client.store is not None:
        import queue_control  # noqa: PLC0415
        mark = queue_control.get_state(cloud_client.store, UNAVAILABLE_KEY) or {}
        if isinstance(mark, dict) and int(mark.get("until") or 0) > time.time():
            return False, str(mark.get("why") or "GLM не принял задачу")
    return _window_room(cloud_client, cfg)


def _window_room(cloud_client, cfg) -> tuple[bool, str]:
    """Окно и сутки режима вместят потолок прогона — по лимитам режима, а не текущим лимитам клиента (те зависят
    от тумблера). Иначе полоса брала бы задачу, preflight её отдавал, и так по кругу."""
    g = settings(cfg)
    need = max(1, min(g["max_calls_per_run"], g["max_calls_per_window"], g["max_calls_per_day"]))
    if cloud_client.store is None:
        return True, ""
    used = cloud_client._used_since(int(time.time()) - g["window_hours"] * 3600)["calls"]
    if g["max_calls_per_window"] - used < need:
        return False, f"окно плана: {used}/{g['max_calls_per_window']} вызовов за {g['window_hours']} ч"
    from cloud import day_start  # noqa: PLC0415
    day = cloud_client._used_since(int(day_start()))["calls"]
    if g["max_calls_per_day"] - day < need:
        return False, f"суточный лимит плана: {day}/{g['max_calls_per_day']} вызовов"
    return True, ""


def live(store, cfg, cloud_client) -> bool:
    """Тумблер шапки действует И GLM доступен сейчас — задачи без отметки идут в GLM; иначе — локально."""
    return effective(store, cfg) and available_now(cfg, cloud_client)[0]


def status(store, cfg=None) -> dict:
    """Для UI/MCP: тумблер, кто и когда переключил, действует ли (облако включено), лимиты."""
    state = _state(store) or {}
    on = bool(state.get("on"))
    cloud_on = bool(cfg.cloud_enabled()) if cfg is not None else True
    out = {"on": on, "effective": on and cloud_on, "cloud_enabled": cloud_on,
           "at": state.get("at"), "by": state.get("by", ""), "cloud_mode": CLOUD_MODE,
           "local_roles": list(LOCAL_ROLES)}
    if cfg is not None:
        out.update(settings(cfg))
    if on and not cloud_on:
        out["why"] = ("облако выключено (models.cloud.enabled / AI_COUNCIL_CLOUD) — режим не "
                      "действует, прогоны идут локально")
    # Квота подписки исчерпана — шапка объясняет, почему задачи «только для GLM» стоят: остальные идут локально.
    import queue_control  # noqa: PLC0415
    quota = queue_control.get_state(store, f"cloud_quota:{PROVIDER}")
    until = int(quota.get("until") or 0) if isinstance(quota, dict) else 0
    if until > time.time():
        out["quota_until"] = until
        out["waiting"] = (f"квота Coding Plan исчерпана до {time.strftime('%H:%M', time.localtime(until))} — "
                          "задачи «только для GLM» ждут, остальные идут локально")
    return out


def set_on(store, on: bool, actor: str = "ui") -> dict:
    """Переключить тумблер. Воркер читает флаг на каждом захвате — рестарт не нужен."""
    import queue_control
    queue_control.set_state(store, STATE_KEY, {"on": bool(on), "at": int(time.time()),
                                               "by": str(actor)[:40]})
    store.event("glm.mode", "on" if on else "off", json.dumps({"by": actor}, ensure_ascii=False))
    return {"ok": True, "on": bool(on), "by": actor}


def wanted(store, request: dict | None = None) -> bool:
    """Глобальный тумблер ИЛИ явная отметка задачи (`cloud_mode == "glm5"`)."""
    return requested(request) or is_on(store)


def requested(request: dict | None) -> bool:
    """Только отметка самой задачи (строка runs или запрос ревью) — без глобального тумблера."""
    return isinstance(request, dict) and str(request.get("cloud_mode") or "") == CLOUD_MODE


def release_deferred(store) -> int:
    """Тумблер выключен: задачи, отложенные режимом до окна подписки ПО ТУМБЛЕРУ (без своей
    отметки), — обратно на свои места без ожидания: без режима они идут локально. Задачи с
    отметкой режима ждут дальше — их облачность решена при постановке."""
    pattern = DEFER_PREFIX + "%"
    n = store.x("UPDATE runs SET not_before=NULL, error=NULL WHERE status='queued' "
                "AND COALESCE(cloud_mode, '') != ? AND error LIKE ?", (CLOUD_MODE, pattern)).rowcount
    n2 = store.x("UPDATE review_runs SET not_before=NULL, error=NULL WHERE status='queued' "
                 f"AND NOT ({REVIEW_REQUESTED_SQL}) AND error LIKE ?", (pattern,)).rowcount
    return int(n or 0) + int(n2 or 0)


# ── модели ─────────────────────────────────────────────────────────────────
def _slot(role: str) -> str:
    """critic(proposer.code) рецензирует моделью proposer.code, arbiter(revise) — арбитр
    (та же разметка, что council._role_slot)."""
    m = re.match(r"^critic\((.+)\)$", role or "")
    return m.group(1) if m else (role or "").split("(", 1)[0]


def model_for(cfg, role: str) -> str:
    """Роль → модель 5.x; неизвестная роль (агент ревью и т. п.) → models.default."""
    models = settings(cfg)["models"]
    return str(models.get(role) or models.get(_slot(role)) or models.get("default")
               or DEFAULT_MODELS["default"])


def roles_override(cfg, roster: dict) -> dict:
    """Тот же ростер, каждая роль, кроме embed, — моделью 5.x своей роли."""
    return {role: (model if role in LOCAL_ROLES else model_for(cfg, role))
            for role, model in (roster or {}).items()}


class _TermsViaCloud:
    """Клиент Ollama для Retriever на время прогона режима: `chat` — это расширение терминов
    поиска (роль extractor, Retriever._llm_terms) — уходит в Coding Plan моделью режима; всё
    остальное (embed, alive, …) — локальному клиенту: эмбеддинги в режиме остаются локальными."""

    def __init__(self, local, cloud_client, model: str, run_id: str):
        self._local, self._cloud, self._model, self._run_id = local, cloud_client, model, run_id

    def chat(self, _model, messages, temperature: float = 0.1, **_kw):
        # max_tokens локального вызова (80) не переносится: «мысли» GLM идут в счёт output и
        # съели бы его до ответа — облаку свой потолок (models.cloud.budget.max_tokens_out).
        return self._cloud.chat(self._run_id, "extractor", self._model, messages,
                                temperature=temperature)

    def __getattr__(self, name):
        return getattr(self._local, name)


def route_extractor(retriever, cloud_client, cfg, run_id: str):
    """Направить расширение терминов поиска (extractor) прогона режима в Coding Plan; вернуть
    функцию отката. Retriever общий на воркер (проработки и ревью) — откат обязателен, звать его
    в finally. Обёртка, оставшаяся от прошлого прогона, снимается, а не оборачивается ещё раз."""
    local = getattr(retriever, "ollama", None)
    if local is None or cloud_client is None:
        return lambda: None
    if isinstance(local, _TermsViaCloud):
        local = local._local
    retriever.ollama = _TermsViaCloud(local, cloud_client, model_for(cfg, "extractor"), run_id)

    def restore() -> None:
        retriever.ollama = local
    return restore


@contextmanager
def cloud_terms(retriever, cloud_client, cfg, run_id: str, on: bool = True):
    """route_extractor как контекст: `with cloud_terms(...): retriever.build(card)`."""
    restore = route_extractor(retriever, cloud_client, cfg, run_id) if on else (lambda: None)
    try:
        yield
    finally:
        restore()


# ── бюджет ─────────────────────────────────────────────────────────────────
def apply_budget(cloud_client, cfg, on: bool) -> None:
    """Переключить лимиты клиента: окно, сутки, токены за сутки и потолок на прогон —
    на лимиты режима (on) или обратно на [models.cloud.budget] (off). `enabled` не трогается:
    включено ли облако, решает конфиг/env, а не режим. `budget.glm_mode` закрывает платный
    контур General API (cloud.CloudClient). Клиент общий на воркер (консилиум, ревью,
    эскалация), поэтому вызывать на КАЖДОМ прогоне — иначе лимиты прошлого прогона достанутся
    следующему."""
    if cloud_client is None:
        return
    import cloud as cloud_mod
    b = cloud_client.budget
    if on:
        s = settings(cfg)
        b.window_hours = s["window_hours"]
        b.max_calls_per_window = s["max_calls_per_window"]
        b.max_calls_per_day = s["max_calls_per_day"]
        b.max_tokens_per_day = s["max_tokens_per_day"]
        b.run_cap = s["max_calls_per_run"]
    else:
        base = cloud_mod.Budget.from_cfg(cfg)
        b.window_hours = base.window_hours
        b.max_calls_per_window = base.max_calls_per_window
        b.max_calls_per_day = base.max_calls_per_day
        b.max_tokens_per_day = base.max_tokens_per_day
        b.run_cap = 0
    b.glm_mode = bool(on)


def quota_gate(cloud_client, cfg):
    """Квота подписки режима исчерпана → CloudQuotaWait (до сброса), иначе None. Режим идёт только в подписку
    Coding Plan, поэтому достаточно провайдера модели арбитра; один источник для preflight и цикла воркера."""
    if cloud_client is None:
        return None
    return cloud_client.quota_wait(model_for(cfg, "arbiter"))


def preflight(cloud_client, cfg, run_id: str) -> tuple[bool, str, int]:
    """Можно ли начинать прогон в режиме: (да, причина, повторить не раньше). retry_at = 0 —
    ожиданием не лечится (облако выключено, нет ключа подписки, модель не объявлена): прогон
    завершается с причиной. Иначе — вернуть на место в очереди до retry_at: прогон, где
    каждая роль облачная, при исчерпанном окне воздержался бы на пустых раундах, испортив
    статистику обучения ложным «консилиум не справился». Поэтому окно и сутки должны вместить
    ПОТОЛОК прогона, а не один вызов (тот же расчёт, что у облачной эскалации). Звать после
    apply_budget(…, True): проверяются лимиты режима. Попытка считается с нуля — счётчик
    вызовов прогона сбрасывается (как у эскалации при откладывании)."""
    if cloud_client is None or not cfg.cloud_enabled():
        return False, ("режим GLM 5.x требует облака: models.cloud.enabled=true или "
                       "AI_COUNCIL_CLOUD=1 — локально прогон не подменяется"), 0
    cloud_client._calls_this_run.pop(run_id, None)
    model = model_for(cfg, "arbiter")
    wait = quota_gate(cloud_client, cfg)
    if wait is not None:                  # квота подписки исчерпана: ждём сброса, прогон на своём месте
        from cloud import QUOTA_RESUME_GRACE_SECONDS  # noqa: PLC0415
        return False, wait.why, int(wait.until) + QUOTA_RESUME_GRACE_SECONDS
    ok, why = cloud_client.available(model)
    if not ok:
        if "кэш-маркер сбоя" in why:
            return False, why, int(time.time()) + 300
        return False, f"GLM 5.x: {why}", 0
    ok, why = cloud_client.check_budget(run_id, model)
    if ok:
        return _room(cloud_client)
    low = why.lower()
    if "окно плана" in low:
        return False, why, int(window_free_at(cloud_client, _need(cloud_client)))
    if "суточн" in low:
        from cloud import day_start
        return False, why, day_start() + 86400
    return False, why, int(time.time()) + 600


def _need(cloud_client) -> int:
    b = cloud_client.budget
    return max(1, min(cloud_client.run_allowance(), b.max_calls_per_window, b.max_calls_per_day))


def _room(cloud_client) -> tuple[bool, str, int]:
    """Вместят ли окно и сутки потолок прогона (вызовов, а не токенов — их держит check_budget)."""
    b, need = cloud_client.budget, _need(cloud_client)
    used = cloud_client.spent_in_window()["calls"]
    if b.max_calls_per_window - used < need:
        return (False, f"окно плана не вместит прогон: {used}/{b.max_calls_per_window} вызовов "
                       f"за {b.window_hours} ч, потолок прогона {need}",
                int(window_free_at(cloud_client, need)))
    day = cloud_client.spent_today()["calls"]
    if b.max_calls_per_day - day < need:
        from cloud import day_start
        return (False, f"суточный лимит не вместит прогон: {day}/{b.max_calls_per_day} вызовов, "
                       f"потолок прогона {need}", day_start() + 86400)
    return True, "", 0


def window_free_at(cloud_client, need: int = 1) -> float:
    """Когда в скользящем окне освободится `need` вызовов (по журналу cloud_usage)."""
    b, store, now_ts = cloud_client.budget, cloud_client.store, time.time()
    if store is None:
        return now_ts + 600
    rows = store.q("SELECT created_at FROM cloud_usage WHERE ok = 1 AND created_at >= ? "
                   "ORDER BY created_at", (int(now_ts) - b.window_hours * 3600,))
    excess = len(rows) + need - b.max_calls_per_window
    if excess <= 0 or not rows:
        return now_ts + 60
    return float(rows[min(excess, len(rows)) - 1]["created_at"] + b.window_hours * 3600 + 30)


# ── ревью в режиме (§17.6) ─────────────────────────────────────────────────
def review_gate(engine, run_id: str, plan: dict) -> dict | None:
    """Ревью в режиме — до стадий, как _glm_gate воркера у проработок. None — начинать можно
    (лимиты клиента уже режима). Иначе прогон обработан здесь, возвращается итог для
    review_cli.process_run: `deferred` — окно подписки занято, прогон на своём месте до
    retry_at (без сожжённой попытки и частичного транскрипта, ReviewStore.release); `failed` —
    ожиданием не лечится (облако выключено при явной отметке, нет ключа подписки), итог с
    причиной записан, локально не подменяется."""
    blocked = plan.get("glm_blocked")
    if blocked:
        engine.rs.finish(run_id, "failed", error=blocked)
        engine.log(f"    ✗ GLM 5.x: {blocked}")
        return {"status": "failed", "why": blocked}
    if not plan.get("glm"):
        return None
    apply_budget(engine.cloud, engine.cfg, True)
    ok, why, retry_at = preflight(engine.cloud, engine.cfg, run_id)
    if ok:
        return None
    apply_budget(engine.cloud, engine.cfg, effective(engine.store, engine.cfg))
    if not plan.get("glm_requested"):
        # Ревью без отметки (по тумблеру, в полосе): ни ждать GLM, ни заканчиваться без него ему не нужно — назад в
        # очередь без отсрочки; пока GLM недоступен (available_now), его возьмёт основной воркер локально
        # (решение владельца 2026-10-15).
        engine.rs.release(run_id, why, not_before=None)
        # Без отметки «GLM недоступен» полоса взяла бы его снова сразу же: available_now эту причину не видит.
        mark_unavailable(engine.store, why)
        engine.log(f"    ↩ GLM 5.x: {why} — ревью без отметки вернул в очередь: пойдёт локально")
        return {"status": "deferred", "why": why, "retry_at": 0}
    if retry_at:
        engine.rs.release(run_id, DEFER_PREFIX + why, not_before=int(retry_at))
        engine.store.event("glm.deferred", run_id, why[:300])
        engine.log(f"    ⏸ GLM 5.x: {why} — ревью на своём месте, повтор в "
                   f"{time.strftime('%H:%M', time.localtime(retry_at))}")
        return {"status": "deferred", "why": why, "retry_at": int(retry_at)}
    engine.rs.finish(run_id, "failed", error=why)
    engine.log(f"    ✗ GLM 5.x: {why}")
    return {"status": "failed", "why": why}
