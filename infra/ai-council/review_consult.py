#!/usr/bin/env python3
"""AI Council — переписка агентов ревью: вопросы коллегам и встречная проверка. Только stdlib.

Канон: docs/specs/ai-council.md §17.5.

Два механизма «агенты обращаются друг к другу», оба ограничены бюджетом прогона:

* **встречная проверка** (`crosscheck`) — КОД отдаёт решающую находку (critical с опорой в
  диффе, основание вето) названному коллеге автора: confirms / refutes / unclear. Её
  подтверждение не автором — необходимое условие FAIL по critical, но не достаточное: автор
  ещё должен голосовать fail или не голосовать вовсе (review_policy._defect_claim). Проверенный путь:
  проверка парой сняла 234 находки code_reviewer, а critical-находки самого проверяющего
  (60 из 68 у dod_auditor) не проверял никто;
* **вопрос коллеге** (`consult`) — ревьюер сам адресует вопрос по имени (поле `ask`, адресат
  — enum допустимых ключей). Специалист вне состава отвечает на модели спрашивающего: без
  свопа L-модели и без лишней памяти на ноутбуке 24 GB.

Ни один ответ не голосует (пороги вердикта не меняются) и не снимает находку сам: «оспорено»
переводит critical в NEEDS_HUMAN, а не в ACCEPT. Ответ ограничен по времени и облачным
вызовам так, чтобы оппонент и судья — стадии, которые снимают ложные critical, — всегда
успевали: при нехватке бюджета вызов пропускается с записью в трассу, прогон идёт дальше.
"""
from __future__ import annotations

import review_evidence as EV
import review_prompts as P
from ollama import MemoryUnavailable

# Вопрос коллеге — не повод ждать 300 с × 2 попытки: замер 2026-10-08 — все 12 вызовов
# qwen3-coder 30B упёрлись в таймаут по 602 с, три прогона сожгли весь бюджет 2400 с.
LOCAL_TIMEOUT = 120
STAGE_SECONDS = {"local": 75, "cloud": 160}     # оценка стадии для резерва времени
PER_STAGE_CALLS = {"challenge": 1, "pair_check": 1, "escalate": 1, "judge": 1}


def short_call(call: dict) -> dict:
    if call.get("cloud"):
        return call
    return {**call, "timeout": min(int(call.get("timeout") or LOCAL_TIMEOUT), LOCAL_TIMEOUT),
            "retries": 0}


def _later(state, stage_no: int) -> list[dict]:
    return state.plan["stages"][stage_no:]          # stage_no — с 1, срез = стадии после текущей


def _cloudy(state) -> bool:
    return any(a.get("cloud") for a in state.plan["agents"].values())


def time_left(state, stage_no: int) -> float:
    """Секунды, которые можно потратить сейчас, оставив запас стадиям после этой."""
    unit = STAGE_SECONDS["cloud" if _cloudy(state) else "local"]
    reserve = unit * sum(1 for s in _later(state, stage_no) if s["type"] not in ("consult", "crosscheck"))
    return state.remaining() - reserve


def calls_left(state, stage_no: int) -> int | None:
    """Облачные вызовы, которые можно потратить, оставив потолок прогона последующим
    стадиям (+1 на повтор). None — облака в прогоне нет, считать нечего."""
    cloud = state.e.cloud
    if cloud is None or not _cloudy(state):
        return None
    cap = cloud.run_allowance()
    used = int(cloud._calls_this_run.get(state.run_id, 0))
    parts = len(state.plan["participants"])
    planned = sum(PER_STAGE_CALLS.get(s["type"], parts if s["type"] in ("independent", "cross", "chain",
                                                                         "rubric") else 0)
                  for s in _later(state, stage_no))
    return cap - used - planned - 1


def _budget_ok(state, stage_no: int, kind: str, spent: int) -> str:
    if time_left(state, stage_no) < 0:
        return "нет запаса времени для оппонента и судьи"
    room = calls_left(state, stage_no)
    if room is not None and room - spent <= 0:
        return "облачный потолок прогона нужен последующим стадиям"
    return ""


def _peer_for(state, finding: dict) -> str:
    """Коллега автора для встречной проверки: голосовавший не-автор на той же модели →
    любой голосовавший не-автор → оппонент → никого."""
    author = finding.get("by")
    model = state.agent(author)["model"] if author in state.plan["agents"] else ""
    voters = [k for k in state.voters if k != author and k in state.plan["agents"]]
    same = [k for k in voters if state.agent(k)["model"] == model]
    if same:
        return same[0]
    if voters:
        return voters[0]
    adv = state.plan.get("adversary") or ""
    return adv if adv and adv != author else ""


def crosscheck_candidates(state) -> list[dict]:
    """Решающие находки без подтверждения не автором: critical с опорой patch|file и
    основания вето (critical/major агента с правом блокировки)."""
    out = []
    for f in state.findings():
        if f["id"] in state.disputed or f.get("confirmed_by"):
            continue
        if not f.get("decisive"):
            continue
        author = f.get("by") or ""
        veto_basis = (f.get("severity") in ("critical", "major") and author in state.plan["agents"]
                      and state.agent(author).get("can_block") and state.plan["blocking"])
        if f.get("severity") == "critical" or veto_basis:
            out.append(f)
    order = {"critical": 0, "major": 1}
    return sorted(out, key=lambda f: (order.get(f.get("severity"), 2), f["id"]))


def stage_crosscheck(state, no: int, stage: dict) -> None:
    limit = int(state.plan.get("consult", {}).get("cross_check", 0))
    if not limit:
        return
    candidates = crosscheck_candidates(state)
    if not candidates:
        state.trace.append("встречная проверка: решающих находок без подтверждения нет")
        return
    spent = 0
    for f in candidates[:limit]:
        peer = _peer_for(state, f)
        entry = {"kind": "crosscheck", "from": f.get("by"), "to": peer, "about": f["id"],
                 "question": f"подтвердить находку {f['id']}: {f.get('title', '')[:120]}"}
        why = "некому проверить: нет второго участника" if not peer else _budget_ok(state, no, "crosscheck", spent)
        if why:
            state.consults.append({**entry, "skipped": why})
            continue
        author_label = state.agent(f["by"])["label"] if f.get("by") in state.plan["agents"] else f.get("by")
        out = _safe_ask(state, no, "crosscheck", peer,
                        P.agent_system(state.agent(peer), "",
                                       f"Встречная проверка: коллега «{author_label}» нашёл решающий "
                                       "дефект. Проверь его независимо."),
                        P.crosscheck_user(state.dossier(peer), f, author_label, state.note),
                        P.CROSSCHECK_SCHEMA, short_call(state.agent(peer)), entry)
        spent += 1
        if out is None:
            continue
        stance = out.get("stance") if out.get("stance") in ("confirms", "refutes", "unclear") else "unclear"
        state.consults.append({**entry, "stance": stance, "answer": str(out.get("reason") or "")[:400],
                               "evidence": str(out.get("evidence") or "")[:300]})
        _apply_stance(state, f, peer, stance, out.get("reason"))


def _apply_stance(state, finding: dict, who: str, stance: str, reason) -> None:
    if not finding or who == finding.get("by"):
        return
    if stance == "confirms":
        state.confirmed.setdefault(finding["id"], set()).add(who)
    elif stance == "refutes":
        state.disputed[finding["id"]] = f"{who}: {str(reason or '')[:200]}"


def _safe_ask(state, no: int, stage_type: str, key: str, system: str, user: str, schema: dict,
              call: dict, entry: dict, agent: dict | None = None) -> dict | None:
    """Вызов, который не роняет прогон: память/таймаут → пропуск с причиной."""
    try:
        out = state.ask(no, stage_type, key, system, user, schema, call=call, agent=agent)
    except MemoryUnavailable as exc:
        state.consults.append({**entry, "skipped": f"нет памяти под модель: {str(exc)[:120]}"})
        return None
    except TimeoutError as exc:
        state.consults.append({**entry, "skipped": f"таймаут: {str(exc)[:120]}"})
        return None
    if out is None:
        state.consults.append({**entry, "skipped": "пустой/невалидный ответ"})
    return out


def stage_consult(state, no: int, stage: dict) -> None:
    """Вопросы, которые ревьюеры задали в поле `ask` предыдущих стадий."""
    limit = int(state.plan.get("consult", {}).get("ask", 0))
    allowed = {a["key"]: a for a in state.plan.get("addressable") or []}
    if not limit or not state.asks:
        if limit:
            state.trace.append("переписка: вопросов коллегам не было")
        return
    seen: set[tuple] = set()
    spent = 0
    for asker, item in state.asks:
        if spent >= limit:
            state.consults.append({"kind": "ask", "from": asker, "to": item.get("to"),
                                   "question": str(item.get("question") or "")[:300],
                                   "skipped": f"лимит вопросов на прогон ({limit})"})
            continue
        to = str(item.get("to") or "")
        question = str(item.get("question") or "").strip()
        key = (to, EV.norm(question)[:120])
        entry = {"kind": "ask", "from": asker, "to": to, "question": question[:300]}
        about = _about(state, asker, item.get("about"))
        if about:
            entry["about"] = about["id"]
        if to not in allowed or to == asker or not question:
            state.consults.append({**entry, "skipped": "адресат недоступен или вопрос пуст"})
            continue
        if key in seen:
            continue
        seen.add(key)
        why = _budget_ok(state, no, "consult", spent)
        if why:
            state.consults.append({**entry, "skipped": why})
            continue
        agent, call = _addressee(state, to, asker)
        asker_label = state.agent(asker)["label"]
        out = _safe_ask(state, no, "consult", to,
                        P.agent_system(agent, "", f"Тебе задал вопрос коллега «{asker_label}»."),
                        P.consult_user(state.dossier(asker), asker_label, question, about, state.note),
                        P.CONSULT_SCHEMA, call, entry, agent=agent)
        spent += 1
        if out is None:
            continue
        stance = out.get("stance") if out.get("stance") in ("confirms", "refutes", "unclear") else "unclear"
        added = state.add_findings(to, out.get("findings") or [], via=asker, author_agent=agent)
        state.consults.append({**entry, "stance": stance, "answer": str(out.get("answer") or "")[:500],
                               "evidence": str(out.get("evidence") or "")[:300], "findings": added})
        if about:
            _apply_stance(state, about, to, stance, out.get("answer"))
    state.asks.clear()


def _about(state, asker: str, index) -> dict | None:
    """`about` — номер находки спрашивающего (с 1) → его находка с F-id."""
    try:
        n = int(index or 0)
    except (TypeError, ValueError):
        return None
    if n < 1:
        return None
    own = [f for f in state.findings(include_refuted=True) if f.get("by") == asker]
    return own[n - 1] if n <= len(own) else None


def _addressee(state, to: str, asker: str) -> tuple[dict, dict]:
    """Агент из состава отвечает на своей модели; специалист вне состава — на модели
    спрашивающего с собственной temperature (модель уже в памяти, эскалация уже учтена)."""
    if to in state.plan["agents"]:
        return state.agent(to), short_call(state.agent(to))
    spec = state.e.rs.agent(to) or {"label": to, "focus": "", "params": {}}
    base = state.agent(asker)
    temp = (spec.get("params") or {}).get("temperature")
    options = {**base.get("options", {}), **({"temperature": temp} if temp is not None else {})}
    agent = {**base, "label": spec.get("label") or to, "focus": spec.get("focus") or "",
             "kind": "reviewer", "can_block": False, "max_severity": spec.get("max_severity", ""),
             "options": options}
    return agent, short_call(agent)
