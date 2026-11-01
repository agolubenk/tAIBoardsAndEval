#!/usr/bin/env python3
"""AI Council — исполнение прогона ревью. Только stdlib.

Канон: docs/specs/ai-council.md §17.

Вызовы моделей одного прогона — строго последовательно. Локальный инференс на машине — по одному
во всех процессах (файловый лок `ollama.local_inference_slot`): параллельный кладёт ноутбук
(CLAUDE.local.md). Параллельно идут только облачные прогоны полос воркера в режиме GLM 5.x
(`council_worker --lane cloud`). «Независимость» стадии independent — это видимость ответов
(участник не видит коллег), а не параллелизм.

Вердикт решает КОД по политике профиля (вето, critical, пороги), судья — только в её
рамках: модель не может перекрыть вето security-ревьюера красноречием.
"""
from __future__ import annotations

import time

import review_catalog as cat
from cloud_escalation import CloudUnavailable
from cloud import CloudQuotaWait
from ollama import MemoryUnavailable
import review_prompts as P
from review_consult import stage_consult, stage_crosscheck
from review_plan import build_plan
from review_policy import clamp01 as _clamp01, decide, decide_legacy  # noqa: F401 — реэкспорт для selftest/CLI
from review_state import Cancelled, OutOfTime, _RunState, tracked_files  # noqa: F401 — реэкспорт
from review_store import ReviewStore
from store import git_sha, sha16

try:                                    # режим «всё на GLM 5.x» (§17.6) — модуль может отсутствовать
    import glm_mode
except ImportError:                     # pragma: no cover
    glm_mode = None




class ReviewEngine:
    def __init__(self, cfg, store, ollama_client, retriever=None, cloud_client=None, logger=None):
        self.cfg = cfg
        self.store = store
        self.rs = ReviewStore(store)
        self.ollama = ollama_client
        self.retriever = retriever
        self.cloud = cloud_client
        self.glm_only = False   # облачная полоса воркера: ревью только в GLM 5.x (иначе откладывается, не локально)
        self.log = logger or (lambda msg: None)
        self.escalation = None          # облачная эскалация текущего прогона (§17.4)

    def is_cloud(self, model: str) -> bool:
        return self.cloud is not None and bool(self.cloud.provider_of(model))

    def ctx_of(self, model: str) -> int | None:
        return self.ollama.context_length(model) if self.ollama else None

    # ── план ─────────────────────────────────────────────────────────────────
    def plan(self, card: dict, profile: dict, request: dict, run_id: str = "") -> dict:
        catalog = self.rs.agents()
        settings = self.rs.settings()
        base_ctx = int(self.cfg.get("models.num_ctx", 8192))
        selection = None
        spec = profile["spec"]
        mode = request.get("participant_mode") or spec["participant_mode"]
        if (mode in ("AUTO", "HYBRID") and spec.get("auto_strategy") == "llm" and run_id
                and not request.get("agents")):
            selection = self.llm_selection(run_id, card, spec, catalog, settings)
        plan = build_plan(card, profile, request, catalog, settings, base_ctx,
                          self.ctx_of, self.is_cloud, selection)
        self._glm_plan(plan, request)
        return plan

    def _glm_plan(self, plan: dict, request: dict) -> None:
        """Режим «всё на GLM 5.x» (§17.6): каждый агент — на модель Coding Plan по слоту
        (judge — судья, default — прочие). Условия агента (фокус, вето, temperature, бюджет
        досье) сохраняются — как при облачной эскалации. Облако выключено: тумблер шапки не
        действует (агенты по профилю), а явная отметка запуска — `glm_blocked`: прогон
        завершается с причиной (glm_mode.review_gate), локальными не подменяется."""
        if glm_mode is None:
            return
        explicit = glm_mode.requested(request) or self.glm_only
        cloud_on = self.cloud is not None and self.cfg.cloud_enabled()
        # Без отметки — по тумблеру, и только пока GLM доступен: квота/сбой Z.AI → ревью идёт локально по профилю,
        # а не ждёт (решение владельца 2026-10-15: «не GLM, значит локальные»). С отметкой — ждёт GLM (review_gate).
        if not explicit and not (cloud_on and glm_mode.live(self.store, self.cfg, self.cloud)):
            return
        if not cloud_on:
            plan["glm_blocked"] = ("режим GLM 5.x требует облака: models.cloud.enabled=true или "
                                   "AI_COUNCIL_CLOUD=1 — запуск с отметкой GLM 5.x локальными "
                                   "моделями не подменяется")
            plan["warnings"].append(plan["glm_blocked"])
            return
        mapping = {}
        for key, agent in plan["agents"].items():
            model = glm_mode.model_for(self.cfg, "judge" if key == plan["judge"] else "default")
            if not model:
                continue
            mapping[key] = {"from": agent["model"], "to": model}
            plan["agents"][key] = {
                **agent, "model": model, "cloud": True,
                "options": {"temperature": agent["options"].get("temperature", 0.2)},
                "top_level": {}, "num_ctx": None, "num_predict": None,
                "input_budget": max(int(agent.get("input_budget") or 0), 24000),
                "notes": list(agent.get("notes") or []) + [f"GLM 5.x: {agent['model']} → {model}"]}
        if mapping:
            plan["glm"] = mapping
            plan["glm_requested"] = glm_mode.requested(request)
            plan["warnings"].append("режим «всё на GLM 5.x»: все агенты — на GLM Coding API")

    def llm_selection(self, run_id: str, card: dict, spec: dict, catalog: list[dict],
                      settings: dict) -> list[dict] | None:
        reviewers = [a for a in catalog if a["kind"] == "reviewer" and a.get("enabled", True)]
        # 90 символов фокуса, не 160: каталог вырос до 14 ревьюеров (+450 токенов к промпту).
        listing = "\n".join(f"- {a['key']}: {a['label']} — {a.get('focus', '')[:90]}" for a in reviewers)
        required = spec["agents"] if spec["participant_mode"] == "HYBRID" else []
        user = (f"Карточка: {card.get('title')}\nДоска: {card.get('board')}\nМодули: {card.get('modules')}\n"
                f"Текст (начало): {(card.get('body') or '')[:1500]}\n\nКаталог агентов:\n{listing}\n\n"
                f"Обязательные (уже в составе): {required or '—'}\nВыбери до {spec['max_agents']} агентов.")
        model = settings["default_model"]
        # num_ctx — тот же, что у ревью-вызовов профиля: иначе Ollama грузит модель под окно
        # подбора, а через секунду перезагружает под окно ревью (лишняя перезагрузка на прогон).
        tokens = spec.get("tokens") or cat.DEFAULT_TOKENS
        out_lim = int(tokens.get("output_limit") or 2500) if tokens.get("output_mode") == "limit" else 3000
        num_ctx = (int(tokens.get("input_limit") or 10000) + out_lim + 1400
                   if tokens.get("input_mode") == "limit" else None)
        options = {"temperature": 0.1, "num_predict": 600, **({"num_ctx": num_ctx} if num_ctx else {})}
        data = self._call(run_id, 0, "select", "selector", model,
                          {"options": options, "top_level": {},
                           "timeout": 120, "retries": 1, "cloud": self.is_cloud(model)},
                          P.text("review.select"), user, P.SELECT_SCHEMA)
        keys = {a["key"] for a in reviewers}
        picked = [{"key": k, "reason": "выбран вручную в профиле", "source": "manual"} for k in required]
        for item in (data or {}).get("agents") or []:
            if item.get("key") in keys and item["key"] not in {p["key"] for p in picked}:
                picked.append({"key": item["key"], "reason": f"LLM: {item.get('reason', '')[:200]}",
                               "source": "llm"})
        return picked[:max(spec["max_agents"], len(required))] if len(picked) > len(required) else None

    # ── вызов модели ─────────────────────────────────────────────────────────
    def _call(self, run_id: str, stage_no: int, stage_type: str, agent_key: str, model: str,
              call: dict, system: str, user: str, schema: dict) -> dict | None:
        messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
        started = time.time()
        params = {**call.get("options", {}), **(call.get("top_level") or {})}
        if call.get("cloud") and self.escalation is not None:
            # Эскалация: отказ провайдера по доступности → следующий провайдер; отказали
            # все → CloudUnavailable, прогон уходит в очередь, частичный транскрипт сносится.
            prompt = system + "\n\n---\n\n" + user

            def failed_attempt(used_model, res):
                self.rs.log_step(run_id, stage_no, stage_type, agent_key, used_model, params, prompt,
                                 res.text or "", None, False, res.error or "", res.ms or 0,
                                 res.tokens_in, res.tokens_out)
            result = self.escalation.chat(
                run_id, f"review.{agent_key}", model, messages, schema=schema,
                temperature=call["options"].get("temperature", 0.2),
                slot="judge" if stage_type == "judge" else "default", on_fail=failed_attempt)
            model = getattr(result, "model", "") or model
        elif call.get("cloud"):
            result = self.cloud.chat(run_id, f"review.{agent_key}", model, messages, schema=schema,
                                     temperature=call["options"].get("temperature", 0.2),
                                     max_tokens=None)
        else:
            with self.ollama.large_model(model):
                result = self.ollama.chat(
                    model, messages, schema=schema,
                    temperature=call["options"].get("temperature", 0.2),
                    max_tokens=call["options"].get("num_predict", 3000),
                    timeout=call.get("timeout"), retries=call.get("retries", 1),
                    options=call["options"], extra=call.get("top_level") or None)
        data = result.data if result.ok else None
        if data is not None:
            if "vote" in data:
                data["vote"] = str(data.get("vote") or "").lower()
                if data["vote"] not in cat.VOTES:
                    data["vote"] = "needs_human"
            if "confidence" in data:
                data["confidence"] = _clamp01(data["confidence"])
        self.rs.log_step(run_id, stage_no, stage_type, agent_key, model, params,
                         system + "\n\n---\n\n" + user, result.text or "", data,
                         data is not None, result.error or ("" if data is not None else "пустой/невалидный ответ"),
                         result.ms or int((time.time() - started) * 1000),
                         result.tokens_in, result.tokens_out)
        mark = "✓" if data is not None else "✗"
        self.log(f"      {mark} [{stage_type}] {agent_key} · {model} · {(result.ms or 0) // 1000}s"
                 + ("" if data is not None else f" — {(result.error or 'нет JSON')[:90]}"))
        return data

    # ── исполнение ───────────────────────────────────────────────────────────
    def process(self, run: dict, escalation=None) -> dict:
        try:
            return self._process(run, escalation)
        finally:
            self.escalation = None

    def _escalate_plan(self, run: dict, plan: dict, escalation) -> dict | None:
        """L-агентов плана — на облачные модели первого доступного провайдера. Сохраняется
        всё, что задаёт поведение исходного агента: роль, фокус, право вето, temperature и
        бюджет досье (input_budget), — досье то же, что увидела бы локальная модель."""
        slots = {key: ("judge" if key == plan["judge"] else "default")
                 for key, a in plan["agents"].items()
                 if not a["cloud"] and self.ollama.is_large(a["model"])}
        if not slots:
            return None
        provider, mapping, failures = escalation.choose(run["id"], slots)
        if provider is None:
            raise CloudUnavailable(failures)
        models = {}
        for key, model in mapping.items():
            agent = plan["agents"][key]
            models[key] = {"from": agent["model"], "to": model}
            plan["agents"][key] = {
                **agent, "model": model, "cloud": True,
                "options": {"temperature": agent["options"].get("temperature", 0.2)},
                "top_level": {}, "num_ctx": None, "num_predict": None,
                "notes": list(agent.get("notes") or []) + [
                    f"эскалация: ждал памяти, {agent['model']} → {provider}/{model}"]}
        escalation.start(run["id"], provider)
        self.escalation = escalation
        waited = int(time.time()) - int(run.get("mem_wait_since") or time.time())
        self.log(f"    ☁ эскалация ревью: ждал памяти {waited // 60} мин → {provider}: " + ", ".join(
            f"{k} {v['from']}→{v['to']}" for k, v in models.items()))
        return {"provider": provider, "models": models, "waited_s": waited}

    def _process(self, run: dict, escalation=None) -> dict:
        run_id = run["id"]
        card = self.rs.card(run["card_id"])
        if not card:
            self.rs.finish(run_id, "failed", error="карточки нет в снапшоте очереди ревью")
            return {"status": "failed"}
        profile = self.rs.profile(run.get("profile_id")) or self.rs.profile(None)
        if not profile:
            self.rs.finish(run_id, "failed", error="нет ни одного профиля ревью")
            return {"status": "failed"}
        request = run.get("request") or {}
        settings = self.rs.settings()
        board = self.rs.boards().get(card["board"], {})
        self.log(f"  ▶ [ревью/{profile['name']}] {card.get('title', '')[:70]}")

        plan = self.plan(card, profile, request, run_id)
        # Режим «всё на GLM 5.x» (§17.6): лимиты режима и предполётная проверка окна. Явная
        # отметка без облака — итог с причиной; окно занято — прогон на своём месте до повтора.
        gate = glm_mode.review_gate(self, run_id, plan) if glm_mode is not None else None
        if gate is not None:
            return gate
        esc_info = (self._escalate_plan(run, plan, escalation)
                    if escalation is not None and not plan.get("glm") else None)
        for model in sorted({a["model"] for a in plan["agents"].values() if not a["cloud"]}):
            fits, why = self.ollama.memory_check(model)
            if not fits:
                raise MemoryUnavailable(why)
        snapshot = {
            "profile": {"id": profile["id"], "name": profile["name"], "version": profile["version"]},
            "spec": plan["spec"], "method": plan["method"], "stages": plan["stages"],
            "participants": plan["participants"], "selection": plan["selection"],
            "adversary": plan["adversary"], "judge": plan["judge"], "agents": plan["agents"],
            "blocking": plan["blocking"], "warnings": plan["warnings"], "board_policy": board,
            "settings": settings, "card_hash": card.get("review_hash"), "git_sha": git_sha(),
            "config_hash": self.cfg.config_hash(), "request": request, "escalation": esc_info,
            "consult": plan.get("consult"), "addressable": plan.get("addressable"),
            "glm": plan.get("glm"), "prompt_sha": sha16(P.text("review.base")), "policy_version": 2,
        }
        self.rs.save_snapshot(run_id, snapshot)
        self.log(f"    метод {plan['method_label']}; состав: {', '.join(plan['participants'])}"
                 + (f"; оппонент {plan['adversary']}" if plan['adversary'] else "")
                 + (f"; судья {plan['judge']}" if plan['judge'] else ""))

        state = _RunState(self, run_id, card, plan, settings,
                          "\n\n".join(x for x in (plan["spec"].get("note"), request.get("note"),
                                                  self.store.active_note_text(card["card_id"])) if x),
                          tracked=tracked_files())
        # Досье строится по ходу стадий; расширение терминов поиска в нём — тоже роль (extractor).
        restore_terms = (glm_mode.route_extractor(self.retriever, self.cloud, self.cfg, run_id)
                         if plan.get("glm") and glm_mode is not None else None)
        stage_no = 0
        try:
            for stage_no, stage in enumerate(plan["stages"], start=1):
                runner = STAGE_RUNNERS[stage["type"]]
                runner(state, stage_no, stage)
        except Cancelled:
            self.rs.finish(run_id, "cancelled", error="отменено владельцем")
            return {"status": "cancelled"}
        except CloudQuotaWait as exc:
            # Квота подписки кончилась посреди ревью. Без голосов «fail» — на место до сброса (review_cli), повтор с
            # нуля ничего не теряет. Любой уже поданный «fail» повтор мог бы не воспроизвести — сбой инфраструктуры
            # стёр бы найденный дефект. Поэтому решаем по политике, как при исчерпании времени.
            if not any(o.get("vote") == "fail" for o in state.latest.values()):
                raise
            state.trace.append(f"{exc.why} — оставшиеся стадии пропущены, голоса «fail» сохранены")
            _skip_remaining(state, plan, stage_no)
        except OutOfTime:
            state.trace.append(f"бюджет времени {settings['max_wall_seconds']}s исчерпан — "
                               "оставшиеся стадии пропущены")
            _skip_remaining(state, plan, stage_no)
        finally:
            if restore_terms is not None:
                restore_terms()
                # Лимиты — по тумблеру, как в цикле воркера: включён, но облако выключено → обычные.
                glm_mode.apply_budget(self.cloud, self.cfg, glm_mode.effective(self.store, self.cfg))
        verdict, confidence, summary = decide(state)
        result = state.result()
        self.rs.finish(run_id, "done", verdict, confidence, summary, result)
        self.log(f"    ⇒ {verdict} ({confidence:.2f}) — {summary[:100]}")
        if esc_info:
            escalation.mark_done("review_runs", run_id, esc_info["provider"], esc_info["models"],
                                 esc_info["waited_s"])
        return {"status": "done", "verdict": verdict}


# Контрольные стадии: отрезанная (оппонент, проверка пары, судья) — не повод принять работу по одинокому голосу.
_CONTROL_STAGES = ("challenge", "pair_check", "crosscheck", "judge", "cross")


def _skip_remaining(state: _RunState, plan: dict, stage_no: int) -> None:
    """Прогон оборван на стадии `stage_no` (нумерация с 1: срез начинается с оборванной): её и следующие контрольные
    стадии — в state.skipped, decide() даст NEEDS_HUMAN или FAIL, но не ACCEPT. Общая для исчерпания времени и квоты."""
    state.skipped = [s["type"] for s in plan["stages"][max(stage_no - 1, 0):] if s["type"] in _CONTROL_STAGES]


# ── стадии ──────────────────────────────────────────────────────────────────
def _participants(state: _RunState, stage: dict) -> list[str]:
    keys = [k for k in (stage.get("agents") or state.plan["participants"]) if k in state.plan["agents"]]
    if stage.get("exclude_senior"):
        senior = _senior(state)
        keys = [k for k in keys if k != senior] or keys
    if stage.get("limit"):
        keys = keys[:int(stage["limit"])]
    # Группировка по модели: меньше свопов L-моделей (C1) при той же видимости ответов.
    order = {k: i for i, k in enumerate(keys)}
    return sorted(keys, key=lambda k: (state.agent(k)["model"], order[k]))


def _senior(state: _RunState) -> str:
    parts = state.plan["participants"]
    return "architecture_reviewer" if "architecture_reviewer" in parts else (parts[-1] if parts else "")


def _asking(state: _RunState, stage_no: int, key: str) -> tuple[str, dict]:
    """Доп. текст и схема для стадии, после которой есть consult: вопросы — по enum
    адресатов (без себя). Без переписки — прежняя схема и прежний промпт."""
    consult = state.plan.get("consult") or {}
    if not consult.get("ask") or not any(s["type"] == "consult" for s in state.plan["stages"][stage_no:]):
        return "", P.REVIEW_SCHEMA
    targets = [a for a in state.plan.get("addressable") or [] if a["key"] != key]
    if not targets:
        return "", P.REVIEW_SCHEMA
    return P.ask_text(targets, int(consult["ask"])), P.review_schema([a["key"] for a in targets])


def stage_independent(state: _RunState, no: int, stage: dict) -> None:
    for key in _participants(state, stage):
        extra, schema = _asking(state, no, key)
        out = state.ask(no, "independent", key,
                        P.agent_system(state.agent(key), stage.get("flavor", ""), extra),
                        P.review_user(state.dossier(key), state.note), schema)
        state.vote(key, out)


def stage_cross(state: _RunState, no: int, stage: dict) -> None:
    keys = [k for k in _participants(state, stage) if k in state.latest]
    if len(keys) < 2:
        state.trace.append("конвергенция пропущена: меньше двух валидных выводов")
        return
    snapshot = {k: state.latest[k] for k in keys}
    for key in keys:
        peers = {k: v for k, v in snapshot.items() if k != key}
        out = state.ask(no, "cross", key, P.agent_system(state.agent(key), stage.get("flavor", "")),
                        P.cross_user(state.dossier(key), snapshot[key], peers, state.note),
                        P.REVIEW_SCHEMA)
        if out is not None:
            state.vote(key, out)


def stage_challenge(state: _RunState, no: int, stage: dict) -> None:
    adversary = (stage.get("agents") or [state.plan["adversary"]])[0] if (
        stage.get("agents") or state.plan["adversary"]) else ""
    if not adversary or adversary not in state.plan["agents"]:
        state.trace.append("атака пропущена: нет агента-оппонента")
        return
    listed = state.findings()
    votes = {k: o.get("vote") for k, o in state.latest.items()}
    extra = "Режим оппонента: " + P.flavor_text(stage.get("flavor", ""))
    out = state.ask(no, "challenge", adversary, P.agent_system(state.agent(adversary), "", extra),
                    P.challenge_user(state.dossier(adversary), listed, votes, state.note),
                    P.CHALLENGE_SCHEMA)
    if out is not None:
        state.apply_challenge(adversary, out, listed)
        state.adversary_out.append({"agent": adversary, **P.compact(out)})


def stage_pair_check(state: _RunState, no: int, stage: dict) -> None:
    parts = [k for k in state.plan["participants"] if k in state.plan["agents"]]
    primary = state.voters[0] if state.voters else (parts[0] if parts else "")
    checker = next((k for k in parts if k != primary), state.plan["adversary"])
    if not checker:
        state.trace.append("парная проверка пропущена: нет второго участника")
        return
    listed = state.findings()
    extra = f"Ты второй участник пары, проверяешь вывод «{primary}»."
    out = state.ask(no, "pair_check", checker, P.agent_system(state.agent(checker), "", extra),
                    P.challenge_user(state.dossier(checker), listed,
                                     {primary: (state.latest.get(primary) or {}).get("vote")}, state.note),
                    P.CHALLENGE_SCHEMA)
    if out is not None:
        state.apply_challenge(checker, out, listed)
        state.vote(checker, {"vote": out.get("vote"), "confidence": out.get("confidence"),
                             "summary": out.get("summary"), "findings": [],
                             "missing_evidence": out.get("missing_evidence")})
    else:
        state.vote(checker, None)


def stage_chain(state: _RunState, no: int, stage: dict) -> None:
    keys = [k for k in (stage.get("agents") or state.plan["participants"]) if k in state.plan["agents"]]
    previous: list[tuple[str, dict]] = []
    for key in keys:
        extra, schema = _asking(state, no, key)
        out = state.ask(no, "chain", key, P.agent_system(state.agent(key), stage.get("flavor", ""), extra),
                        P.chain_user(state.dossier(key), previous, state.note), schema)
        state.vote(key, out)
        if out is not None:
            previous.append((key, out))


def stage_escalate(state: _RunState, no: int, stage: dict) -> None:
    senior = (stage.get("agents") or [_senior(state)])[0]
    if not senior:
        return
    specialists = {k: v for k, v in state.latest.items() if k != senior}
    out = state.ask(no, "escalate", senior, P.agent_system(state.agent(senior), stage.get("flavor", "")),
                    P.escalate_user(state.dossier(senior), specialists, state.note), P.REVIEW_SCHEMA)
    state.vote(senior, out)


def stage_rubric(state: _RunState, no: int, stage: dict) -> None:
    rubric = state.plan["spec"].get("rubric") or cat.DEFAULT_RUBRIC
    for key in _participants(state, stage):
        out = state.ask(no, "rubric", key, P.agent_system(state.agent(key), stage.get("flavor", "")),
                        P.rubric_user(state.dossier(key), rubric, state.note), P.RUBRIC_SCHEMA)
        state.vote(key, out)
        if out is not None:
            state.rubric[key] = out.get("scores") or []


def stage_judge(state: _RunState, no: int, stage: dict) -> None:
    judge = (stage.get("agents") or [state.plan["judge"]])[0] if (
        stage.get("agents") or state.plan["judge"]) else ""
    if not judge or not state.latest:
        state.trace.append("судья пропущен: " + ("нет агента-судьи" if not judge else "нет валидных выводов"))
        return
    v = state.plan["spec"]["verdict"]
    hint = (f"Вето ролей с правом блокировки: {'да' if state.plan['blocking'] else 'нет'}; "
            f"critical-находка = FAIL: {'да' if v['reject_on_critical'] else 'нет'}"
            + (" (только с опорой в диффе и подтверждением не автором)" if v.get("evidence_gate", True) else "")
            + f"; порог accept {v['accept_threshold']:.2f}, fail {v['fail_threshold']:.2f}.")
    # Судья видит голоса и сводный список находок — уже без снятых оппонентом. Сырые
    # findings участников ему не отдаём: иначе снятое возвращается в итог через пересказ.
    votes = {k: {f: o.get(f) for f in ("vote", "confidence", "summary", "missing_evidence")}
             for k, o in state.latest.items()}
    out = state.ask(no, "judge", judge, P.text("review.judge"),
                    P.judge_user(state.card.get("title") or "", votes, state.findings(), hint,
                                 state.note, state.consults), P.JUDGE_SCHEMA)
    if out is not None:
        out["verdict"] = str(out.get("verdict") or "").upper()
        state.judge_out = {"agent": judge, **out}


STAGE_RUNNERS = {
    "independent": stage_independent, "cross": stage_cross, "challenge": stage_challenge,
    "pair_check": stage_pair_check, "chain": stage_chain, "escalate": stage_escalate,
    "rubric": stage_rubric, "consult": stage_consult, "crosscheck": stage_crosscheck,
    "judge": stage_judge,
}
