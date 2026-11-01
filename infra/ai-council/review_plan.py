#!/usr/bin/env python3
"""AI Council — план прогона ревью: состав, модели, эффективные параметры и лимиты.

Чистые функции без вызовов моделей (кроме чтения длины контекста у Ollama): тот же код
отвечает и на dry-run «что будет», и на сам прогон — иначе превью разъезжалось бы с
фактом молча.

Наследование параметров модели — слоями, последний побеждает:
    агент (вкладка «Агенты») → оверрайд агента в профиле → оверрайд разового запуска
Токены — политикой профиля поверх слоёв:
    input_mode  inherit | limit | max     → num_ctx
    output_mode inherit | limit | unlimited → num_predict
«Без лимита» не бесконечность: потолок — окно модели (Ollama /api/show) и настройка
max_num_ctx (24 GB, L-модель + KV-кэш); итог показывается до запуска.
"""
from __future__ import annotations

import json
import re

import review_catalog as cat
from review_context import card_comments

DEFAULT_OUTPUT = 3000
PROMPT_OVERHEAD = 1600          # системный промпт + схема + обвязка, токенов (+200: правила улик §17.5)
# Окно считается по прежней обвязке (1400): num_ctx не меняется — Ollama не перезагружает
# модели и KV-кэш тот же; лишние 200 токенов промпта отнимаются у досье (бюджет входа).
CTX_OVERHEAD = 1400
ADDRESSABLE_ONCALL = 3          # специалистов вне состава в списке адресатов (≈30 токенов на строку)
CLOUD_INPUT_BUDGET = 24000      # облачные модели: окно заведомо больше, режем по разумному


def card_signals(card: dict) -> tuple[str, list[str], list[str]]:
    modules = json.loads(card.get("modules") or "[]")
    tags = json.loads(card.get("tags") or "[]")
    text = " ".join([card.get("title") or "", card.get("body") or "", card.get("report") or "",
                     " ".join(c.get("text", "") for c in card_comments(card, include_own=False)),
                     " ".join(modules), " ".join(tags)]).lower()
    return text, modules, tags


def keyword_hits(keywords: list[str], text: str) -> list[str]:
    """Совпадение с начала слова, не подстрокой: «ai» не должно срабатывать в «detail»,
    а «api» — в «capital». Русские основы («миграц») по-прежнему ловят окончания."""
    return [k for k in keywords or []
            if k and re.search(r"(?<![\w])" + re.escape(k), text)]


def trigger_score(agent: dict, card: dict, text: str, modules: list[str]) -> tuple[float, list[str]]:
    trig = agent.get("triggers") or {}
    reasons, score = [], 0.0
    if trig.get("always"):
        reasons.append("всегда в составе")
        score += 1.5
    if trig.get("boards") and card.get("board") in trig["boards"]:
        reasons.append("доска «Ошибки»" if card.get("board") == "bugs" else "доска «Задачи»")
        score += 2
    hits = keyword_hits(trig.get("keywords") or [], text)
    if hits:
        reasons.append("в карточке: " + ", ".join(hits[:4]))
        score += min(len(hits), 5)
    mods = [m for m in trig.get("modules") or [] if m in modules]
    if mods:
        reasons.append("модули: " + ", ".join(mods))
        score += 3 * len(mods)
    return score, reasons


def rule_selection(card: dict, catalog: list[dict], required: list[str], max_agents: int) -> list[dict]:
    """Прозрачный автоподбор: у каждого выбранного — причина из сигналов карточки.
    Место security-ревьюера резервируется: если его сигналы сработали, широкие триггеры
    новых специалистов не вытесняют его из состава."""
    text, modules, _tags = card_signals(card)
    picked: list[dict] = []
    for key in required:
        picked.append({"key": key, "reason": "выбран вручную в профиле", "source": "manual"})
    scored = []
    for agent in catalog:
        if agent["kind"] != "reviewer" or agent.get("enabled") is False:
            continue
        if agent["key"] in required:
            continue
        score, reasons = trigger_score(agent, card, text, modules)
        if score > 0:
            scored.append((score, agent["key"], "; ".join(reasons)))
    scored.sort(key=lambda t: (-t[0], t[1]))
    for _score, key, reason in scored:
        if len(picked) >= max_agents:
            break
        picked.append({"key": key, "reason": reason, "source": "rules"})
    sec = next(((k, r) for _s, k, r in scored if k == "security_reviewer"), None)
    if sec and all(p["key"] != sec[0] for p in picked):
        rules = [i for i, p in enumerate(picked) if p["source"] == "rules"]
        if rules:
            picked[rules[-1]] = {"key": sec[0], "reason": sec[1] + " (место security зарезервировано)",
                                 "source": "rules"}
    if not picked:
        keys = {a["key"] for a in catalog}
        for key in ("code_reviewer", "dod_auditor"):
            if key in keys:
                picked.append({"key": key, "reason": "сигналов нет — базовый состав", "source": "fallback"})
    return picked[:max(max_agents, len(required))]


def select_participants(card: dict, profile_spec: dict, catalog: list[dict]) -> list[dict]:
    mode = profile_spec["participant_mode"]
    manual = list(profile_spec.get("agents") or [])
    if mode == "MANUAL":
        return [{"key": k, "reason": "выбран вручную в профиле", "source": "manual"} for k in manual]
    required = manual if mode == "HYBRID" else []
    return rule_selection(card, catalog, required, profile_spec["max_agents"])


def pick_adversary(profile_spec: dict, agents: dict, cognitive: bool = False) -> str:
    if cognitive and "cognitive_auditor" in agents and agents["cognitive_auditor"].get("enabled", True):
        return "cognitive_auditor"
    if profile_spec.get("adversary") in agents:
        return profile_spec["adversary"]
    for key, a in agents.items():
        if a["kind"] == "adversary" and a.get("enabled", True) and key != "cognitive_auditor":
            return key
    return ""


def pick_judge(profile_spec: dict, agents: dict) -> str:
    if profile_spec.get("judge") in agents:
        return profile_spec["judge"]
    for key, a in agents.items():
        if a["kind"] == "judge" and a.get("enabled", True):
            return key
    return ""


def resolve_model(agent: dict, override: dict, role: str, profile_spec: dict, settings: dict) -> str:
    if override.get("model"):
        return override["model"]
    if agent.get("model"):
        return agent["model"]
    if role == "judge":
        return profile_spec.get("judge_model") or settings.get("judge_model") or settings["default_model"]
    return profile_spec.get("default_model") or settings["default_model"]


def effective_call(model: str, params: dict, tokens: dict, settings: dict, base_ctx: int,
                   model_ctx: int | None, is_cloud: bool) -> dict:
    """Итоговые options запроса + бюджет входа под досье. Чистая функция — её же
    показывает dry-run."""
    options = {k: v for k, v in params.items()
               if not cat.PARAM_SPEC[k].get("top_level") and not cat.PARAM_SPEC[k].get("local")}
    top_level = {k: v for k, v in params.items() if cat.PARAM_SPEC[k].get("top_level")}
    timeout = int(params.get("timeout") or 0) or None
    retries = int(params.get("retries", 1))
    notes: list[str] = []
    if is_cloud:
        return {"model": model, "cloud": True, "options": {"temperature": options.get("temperature", 0.2)},
                "top_level": {}, "timeout": timeout, "retries": retries,
                "num_ctx": None, "num_predict": None, "input_budget": CLOUD_INPUT_BUDGET,
                "notes": ["облачная модель: лимиты держит облачный бюджет, options Ollama не применяются"]}

    cap = int(settings.get("max_num_ctx") or 32768)
    out_mode = tokens.get("output_mode", "inherit")
    if out_mode == "unlimited":
        num_predict = -1
    elif out_mode == "limit":
        num_predict = int(tokens.get("output_limit") or DEFAULT_OUTPUT)
    else:
        num_predict = int(params.get("num_predict") or DEFAULT_OUTPUT)

    in_mode = tokens.get("input_mode", "inherit")
    if in_mode == "max":
        num_ctx = min(model_ctx or cap, cap)
        notes.append(f"вход до максимума модели ({model_ctx or '?'}), потолок настроек {cap}")
    elif in_mode == "limit":
        reserve = num_predict if num_predict > 0 else 4096
        num_ctx = int(tokens.get("input_limit") or 16384) + reserve + CTX_OVERHEAD
    else:
        num_ctx = int(params.get("num_ctx") or base_ctx)
    if model_ctx and num_ctx > model_ctx:
        notes.append(f"num_ctx {num_ctx} > окна модели {model_ctx} — урезано")
        num_ctx = model_ctx
    if num_ctx > cap:
        notes.append(f"num_ctx {num_ctx} > потолка настроек {cap} — урезано")
        num_ctx = cap
    if num_predict > 0 and num_predict > num_ctx // 2:
        notes.append(f"выход {num_predict} > половины окна — урезан до {num_ctx // 2}")
        num_predict = num_ctx // 2
    reserve = num_predict if num_predict > 0 else min(8192, num_ctx // 3)
    input_budget = max(1200, num_ctx - reserve - PROMPT_OVERHEAD)
    options["num_ctx"] = num_ctx
    options["num_predict"] = num_predict
    return {"model": model, "cloud": False, "options": options, "top_level": top_level,
            "timeout": timeout, "retries": max(0, retries), "num_ctx": num_ctx,
            "num_predict": num_predict, "input_budget": input_budget, "notes": notes}


def apply_request(profile_spec: dict, request: dict, agent_keys: set[str]) -> dict:
    """Разовые оверрайды запуска поверх профиля (метод, состав, заметка, токены)."""
    spec = json.loads(json.dumps(profile_spec))
    if request.get("method") in cat.METHODS:
        spec["method"] = request["method"]
    agents = [a for a in (request.get("agents") or []) if a in agent_keys]
    if agents:
        spec["agents"] = agents
        spec["participant_mode"] = request.get("participant_mode") or "MANUAL"
    elif request.get("participant_mode") in cat.PARTICIPANT_MODES:
        spec["participant_mode"] = request["participant_mode"]
    if request.get("tokens"):
        spec["tokens"] = {**spec.get("tokens", {}), **request["tokens"]}
    if request.get("default_model"):
        spec["default_model"] = str(request["default_model"])[:120]
    return spec


def build_plan(card: dict, profile: dict, request: dict, catalog: list[dict], settings: dict,
               base_ctx: int, ctx_of, is_cloud, selection: list[dict] | None = None) -> dict:
    """ctx_of(model) → длина контекста | None; is_cloud(model) → bool.
    selection — готовый состав (LLM-подбор считает движок), иначе правила."""
    agents = {a["key"]: a for a in catalog}
    spec = apply_request(profile["spec"], request, set(agents))
    method = cat.METHODS[spec["method"]]
    stages = cat.method_stages(spec)
    chosen = selection if selection is not None else select_participants(card, spec, catalog)
    participants = [c["key"] for c in chosen if c["key"] in agents]
    warnings: list[str] = []
    cognitive = any(s["type"] == "challenge" and s.get("flavor") == "cognitive" for s in stages)
    # Оппонент в составе — только там, где метод его вызывает: атака, либо парная проверка
    # без второго ревьюера. Иначе он висел бы в превью и в снимке, не сделав ни одного вызова.
    needs_adversary = any(s["type"] == "challenge" for s in stages) or (
        any(s["type"] == "pair_check" for s in stages) and len(participants) < 2)
    adversary = pick_adversary(spec, agents, cognitive) if needs_adversary else ""
    judge = pick_judge(spec, agents)
    if any(s["type"] == "challenge" for s in stages) and not adversary:
        warnings.append("в методе есть атака, но нет агента-оппонента — стадия будет пропущена")
    if not judge:
        warnings.append("нет агента-судьи — вердикт посчитает только политика")
    if spec["method"] == "PAIR" and len(participants) < 2 and not adversary:
        warnings.append("парному ревью нужен второй участник")
    roster = list(dict.fromkeys(participants + ([adversary] if adversary else [])
                                + ([judge] if judge else [])
                                + [a for s in stages for a in s.get("agents") or []]))
    resolved: dict = {}
    for key in roster:
        agent = agents[key]
        override = (spec.get("overrides") or {}).get(key, {})
        role = "judge" if key == judge else agent["kind"]
        model = resolve_model(agent, override, role, spec, settings)
        params = {**agent.get("params", {}), **override.get("params", {}),
                  **cat.clean_params((request.get("params") or {}).get(key))}
        call = effective_call(model, params, spec["tokens"], settings, base_ctx,
                              None if is_cloud(model) else ctx_of(model), is_cloud(model))
        resolved[key] = {"label": agent["label"], "kind": agent["kind"], "focus": agent.get("focus", ""),
                         "can_block": bool(override.get("can_block", agent.get("can_block"))),
                         "max_severity": agent.get("max_severity", ""),
                         "audits_evidence": bool(agent.get("audits_evidence")), **call}
    if any(a["num_ctx"] and a["num_ctx"] != base_ctx for a in resolved.values()):
        warnings.append(f"окно ревью отличается от общего num_ctx {base_ctx} — Ollama один раз "
                        "перезагрузит модели под ревью (и обратно — на следующей проработке)")
    consult = cat.consult_spec(spec)
    addressable = addressable_agents(card, catalog, participants, consult) if consult["ask"] else []
    blocking = spec["verdict"]["blocking"] or bool(method.get("force_blocking"))
    if method.get("force_blocking") and not any(resolved[k]["can_block"] for k in participants):
        warnings.append("блокирующее ревью без ролей с правом вето — вето не сработает")
    return {"spec": spec, "method": spec["method"], "method_label": method["label"],
            "stages": stages, "participants": participants, "selection": chosen,
            "adversary": adversary, "judge": judge, "agents": resolved,
            "blocking": blocking, "warnings": warnings, "consult": consult,
            "addressable": addressable}


def addressable_agents(card: dict, catalog: list[dict], participants: list[str],
                       consult: dict) -> list[dict]:
    """Кому можно задать вопрос: ревьюеры состава + до ADDRESSABLE_ONCALL специалистов
    вне состава с наибольшим откликом на сигналы карточки. Список короткий намеренно:
    13 строк каталога в системном промпте 7B-модели вытесняют досье."""
    text, modules, _tags = card_signals(card)
    reviewers = {a["key"]: a for a in catalog
                 if a["kind"] == "reviewer" and a.get("enabled", True) is not False}
    out = [{"key": k, "label": reviewers[k]["label"], "in_roster": True}
           for k in participants if k in reviewers]
    if consult.get("outside_roster"):
        scored = sorted(((trigger_score(a, card, text, modules)[0], k) for k, a in reviewers.items()
                         if k not in participants and not (a.get("triggers") or {}).get("always")),
                        key=lambda t: (-t[0], t[1]))
        out += [{"key": k, "label": reviewers[k]["label"], "in_roster": False}
                for score, k in scored[:ADDRESSABLE_ONCALL] if score > 0]
    return out
