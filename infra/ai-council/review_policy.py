#!/usr/bin/env python3
"""AI Council — вердикт ревью по политике профиля. Решает КОД, судья — только в её рамках.

Канон: docs/specs/ai-council.md §17, §17.5.

Порядок один на все ветки (раньше FAIL по critical/вето и ACCEPT по порогу шли ранними
возвратами, и ветка «ничья → судья» обходила major_needs_human):

    1. валидных выводов мало                          → NEEDS_HUMAN
    2. FAIL:  вето с уликами · critical с опорой в диффе, подтверждённый не автором, — если это
              заявление о дефекте: автор голосует fail или не голосует вовсе (оппонент, консультант) ·
              порог fail по голосам, подкреплённым уликами
    2а. FAIL insufficient_evidence: аудитор доказательств (DoD) не принял работу и назвал
              неснятые пробелы, а большинства за accept нет — карточка возвращается в работу
              «приложить доказательства». Пробел DoD — не заявление о дефекте кода: опоры в
              диффе ему не нужно, а «тесты не прогнаны» при результате в досье снимает код
    3. NEEDS_HUMAN: вето без улик · critical без подтверждения/оспоренный · подтверждённый critical,
              автор которого голосует не fail (часто это подтверждение исправления — «уязвимость
              исправлена», rv_085727c0647b) · оборванная контрольная стадия
    4. порог accept: низкая уверенность / судья против / висящий major → NEEDS_HUMAN, иначе ACCEPT
    5. ничья: судья разрешает только при уверенности ≥ 0.7 и без флагов шага 3–4; FAIL судьи —
              только при находке с опорой, которая заявление о дефекте (шаг 2), а если опора есть
              только у заметок — NEEDS_HUMAN

Гейт улик (`verdict.evidence_gate`, по умолчанию вкл.) может перевести FAIL только в
NEEDS_HUMAN, но никогда — в ACCEPT: опровержение решающей находки не делает работу
принятой, оно делает её спорной. Инвариант «новый ACCEPT ⊆ прежний ACCEPT» проверяется
selftest'ом и пересчётом (review_stats.replay). Он не перестраховка: владелец отклонил 26 из
49 переходов ACCEPT (с комментариями «не выполнены все требования», «тестирование не
описано»), а FAIL применял пачками — совету не хватает строгости к принятию, а не к отказу.
Прежняя политика считается рядом (`legacy_verdict`) — замер вклада гейта на живых карточках.
"""
from __future__ import annotations

import math

import review_catalog as cat

SUPPORT = ("critical", "major")


def clamp01(value) -> float:
    try:
        return max(0.0, min(float(value), 1.0))
    except (TypeError, ValueError):
        return 0.0


def _summary(judge: dict, valid: dict, findings: list[dict]) -> str:
    if judge.get("summary"):
        return judge["summary"]
    top = [f"{f['severity']}: {f['title']}" for f in findings
           if f.get("severity") in SUPPORT][:3]
    votes = ", ".join(f"{k}={o['vote']}" for k, o in valid.items())
    return f"Голоса: {votes or '—'}." + (f" Главное: {'; '.join(top)}." if top else "")


def _common(state) -> tuple[dict, dict, int, dict, str, float, float]:
    policy = state.plan["spec"]["verdict"]
    valid = {k: o for k, o in state.latest.items() if o.get("vote") in cat.VOTES}
    expected = max(1, len(state.voters))
    judge = state.judge_out or {}
    j_verdict = judge.get("verdict") if judge.get("verdict") in cat.VERDICTS else ""
    j_conf = clamp01(judge.get("confidence"))
    avg = sum(clamp01(o.get("confidence")) for o in valid.values()) / len(valid) if valid else 0.0
    return policy, valid, expected, judge, j_verdict, j_conf, avg


def decide_legacy(state) -> tuple[str, str]:
    """Политика до §17.5 — без опоры находок и встречной проверки. Только для сравнения."""
    policy, valid, expected, judge, j_verdict, j_conf, _avg = _common(state)
    if len(valid) < math.ceil(expected / 2):
        return "NEEDS_HUMAN", "insufficient"
    findings = state.findings()
    if state.plan["blocking"] and any(o["vote"] == "fail" and state.agent(k)["can_block"]
                                      for k, o in valid.items()):
        return "FAIL", "veto"
    if policy["reject_on_critical"] and any(f.get("severity") == "critical" for f in findings):
        return "FAIL", "critical"
    accept = sum(1 for o in valid.values() if o["vote"] == "accept")
    fail = sum(1 for o in valid.values() if o["vote"] == "fail")
    ar, fr = accept / len(valid), fail / len(valid)
    if ar >= policy["accept_threshold"]:
        avg = _common(state)[6]
        if avg < policy["min_confidence"] or j_verdict in ("FAIL", "NEEDS_HUMAN"):
            return "NEEDS_HUMAN", "accept_blocked"
        if policy.get("major_needs_human", True) and any(f.get("severity") == "major" for f in findings):
            return "NEEDS_HUMAN", "major"
        return "ACCEPT", "threshold"
    if fr >= policy["fail_threshold"]:
        return ("NEEDS_HUMAN", "judge_vs_majority") if j_verdict == "ACCEPT" else ("FAIL", "threshold")
    if policy["judge_tiebreak"] and j_verdict in ("ACCEPT", "FAIL") and j_conf >= 0.7:
        return j_verdict, "judge_tiebreak"
    return ("INCONCLUSIVE" if policy["allow_inconclusive"] else "NEEDS_HUMAN"), "tie"


def _supported(f: dict) -> bool:
    return bool(f.get("decisive")) and f.get("severity") in SUPPORT


def _defect_claim(f: dict, valid: dict, voters) -> bool:
    """Находка — заявление о дефекте, а не заметка: её автор голосует fail или не голосует вовсе
    (оппонент и консультанты — их роль искать дефекты, голоса у них нет; проверяющий пары голосует,
    и его находки судятся по его голосу). FAIL по critical не сильнее голоса его автора.

    Critical при голосе accept или needs_human — чаще всего подтверждение исправления: локальные
    модели ставят важность по теме, а не по наличию дефекта («[critical] IDOR-уязвимость исправлена»
    при accept 0.90 у обоих ревьюеров — FAIL и предложение вернуть карточку в «открыто»,
    rv_085727c0647b). needs_human — ещё и голос, которым движок заменяет испорченный ответ; голосовавший
    с невалидным голосом тоже не «неголосующий». Подтверждение коллегой, даже голосующим fail, —
    согласие с текстом находки, а не заявление о дефекте. Отказа такая находка не даёт, но и в
    принятие не пускает — решает человек.
    """
    by = f.get("by") or ""
    if by in valid:
        return valid[by].get("vote") == "fail"
    return by not in voters


def flags(state) -> dict:
    """Все признаки сразу — порядок применения один, в decide()."""
    findings = state.findings()
    policy = state.plan["spec"]["verdict"]
    valid = {k: o for k, o in state.latest.items() if o.get("vote") in cat.VOTES}
    veto_ok, veto_bare = [], []
    if state.plan["blocking"]:
        for k, o in valid.items():
            if o["vote"] == "fail" and state.agent(k)["can_block"]:
                # Основание вето — всё, что агент написал за прогон, снятия НЕ учитываются:
                # 7B-оппонент не может перекрыть вето красноречием (инвариант движка).
                (veto_ok if any(_supported(f) for f in state.authored(k)) else veto_bare).append(k)
    crit = [f for f in findings if f.get("severity") == "critical"] if policy["reject_on_critical"] else []
    crit_backed = [f for f in crit if f.get("decisive") and f.get("confirmed_by") and f["id"] not in state.disputed]
    crit_ok = [f for f in crit_backed if _defect_claim(f, valid, state.voters)]
    # Подтверждённый critical, автор которого голосует не fail, — заметка (см. _defect_claim): FAIL
    # не даёт, принятие держит, как и неподтверждённый.
    crit_notes = [f for f in crit_backed if f not in crit_ok]
    # Неподтверждённый critical — любой опоры — держит принятие (NEEDS_HUMAN): гейт снимает с
    # него право дать FAIL, но не делает его шумом, который можно принять.
    crit_open = [f for f in crit if f not in crit_backed]
    majors = [f for f in findings if f.get("severity") == "major"]
    fail_ok, fail_bare = [], []
    for k, o in valid.items():
        if o["vote"] != "fail":
            continue
        backed = any(_supported(f) and (f.get("by") == k or k in (f.get("confirmed_by") or ()))
                     for f in findings)
        (fail_ok if backed else fail_bare).append(k)
    # «Отсутствие доказательства не равно успеху»: accept, в котором сам голосующий перечислил
    # недостающие улики, — это insufficient_evidence, голос считается needs_human.
    thin = [k for k, o in valid.items() if o["vote"] == "accept"
            and any(str(x).strip() for x in (o.get("missing_evidence") or []))]
    auditors = [k for k in valid if state.agent(k).get("audits_evidence")]
    gaps = [f for f in findings if f.get("by") in auditors and f.get("severity") in SUPPORT]
    gap_votes = [k for k in auditors if valid[k]["vote"] in ("fail", "needs_human")
                 and (any(f.get("by") == k for f in gaps)
                      or any(str(x).strip() for x in (valid[k].get("missing_evidence") or [])))]
    # Пробелы DoD — отдельный класс: в «критические дефекты» их не записываем (иначе
    # critical-правило и вето путают «не доказано» с «сломано»).
    gap_ids = {f["id"] for f in gaps}
    # Неподтверждённый critical-пробел аудитора тоже держит принятие, пока его не закрыл путь insufficient_evidence
    # (decide, шаг 2а): иначе аудитор, проголосовавший accept, или большинство за accept давали ACCEPT там, где
    # прежняя политика (любой critical → FAIL) даёт FAIL, — нарушение «новый ACCEPT ⊆ прежний» (карточка
    # «Ошибки» 3ffdd207a82581bebadbfc81cb7a174b).
    crit_gaps = [f for f in crit_open if f["id"] in gap_ids]
    crit_open = [f for f in crit_open if f["id"] not in gap_ids]
    return {"veto_ok": veto_ok, "veto_bare": veto_bare, "gaps": sorted(gap_ids), "gap_votes": gap_votes,
            "crit_ok": [f["id"] for f in crit_ok], "crit_notes": [f["id"] for f in crit_notes],
            "crit_open": [f["id"] for f in crit_open], "crit_gaps": [f["id"] for f in crit_gaps],
            "majors": [f["id"] for f in majors], "fail_ok": fail_ok, "fail_bare": fail_bare,
            "thin_accept": thin, "skipped": list(getattr(state, "skipped", []) or [])}


def decide(state) -> tuple[str, float, str]:
    policy, valid, expected, judge, j_verdict, j_conf, avg = _common(state)
    trace = state.trace
    legacy, legacy_reason = decide_legacy(state)
    gate = policy.get("evidence_gate", True)
    state.policy = {"gate": bool(gate), "legacy_verdict": legacy, "legacy_reason": legacy_reason}

    def done(verdict: str, conf: float, why: str, reason: str) -> tuple[str, float, str]:
        trace.append(why)
        state.policy["verdict_reason"] = reason
        return verdict, round(conf, 3), _summary(judge, valid, state.findings())

    if not gate:
        state.policy["flags"] = {}
        return done(legacy, avg if legacy != "NEEDS_HUMAN" or valid else 0.0,
                    f"гейт улик выключен — прежняя политика ({legacy_reason})", legacy_reason)
    if len(valid) < math.ceil(expected / 2):
        return done("NEEDS_HUMAN", 0.0, f"валидных выводов {len(valid)} из {expected} — мало для решения",
                    "insufficient")
    fl = flags(state)
    state.policy["flags"] = fl
    if fl["veto_ok"]:
        return done("FAIL", avg, f"вето с уликами: {', '.join(fl['veto_ok'])}", "veto")
    if fl["crit_ok"]:
        return done("FAIL", avg, f"critical с опорой в диффе от голосующего fail или оппонента, "
                                 f"подтверждён не автором: "
                                 f"{', '.join(fl['crit_ok'][:5])}", "critical")
    accept = sum(1 for o in valid.values() if o["vote"] == "accept") - len(fl["thin_accept"])
    fail = len(fl["fail_ok"])
    ar, fr = accept / len(valid), fail / len(valid)
    tally = (f"accept {accept}, fail {fail}"
             + (f" (+{len(fl['fail_bare'])} fail без улик → needs_human)" if fl["fail_bare"] else "")
             + (f" (+{len(fl['thin_accept'])} accept с недостающими уликами → needs_human)"
                if fl["thin_accept"] else "")
             + f" из {len(valid)}")
    if fr >= policy["fail_threshold"]:
        if j_verdict == "ACCEPT":
            return done("NEEDS_HUMAN", avg, f"{tally}: судья за принятие вопреки большинству",
                        "judge_vs_majority")
        return done("FAIL", avg, f"{tally}: порог fail {policy['fail_threshold']} пройден", "threshold")
    if fl["gap_votes"] and ar < policy["accept_threshold"]:
        return done("FAIL", avg, f"{tally}: аудитор доказательств не принял работу — "
                                 f"пробелы {', '.join(fl['gaps'][:5]) or 'missing_evidence'}; "
                                 "вернуть в работу с доказательствами", "insufficient_evidence")
    # Все сработавшие основания — в порядке приоритета; первое — verdict_reason, весь список — в комментарий на
    # карточку (verdict_reasons): владелец видит и «critical без подтверждения», и заметку автора, а не одно из них.
    hard: list[tuple[str, str]] = []
    if fl["veto_bare"]:
        hard.append(("unsupported_veto", f"вето без улик ({', '.join(fl['veto_bare'])})"))
    if fl["crit_open"]:
        hard.append(("unverified_critical", f"critical без подтверждения/оспорен: {', '.join(fl['crit_open'][:5])}"))
    if fl["crit_gaps"]:
        hard.append(("open_evidence_gap", f"critical-пробел аудитора доказательств не закрыт и не вернул карточку "
                                          f"в работу: {', '.join(fl['crit_gaps'][:5])}"))
    if fl["crit_notes"]:
        hard.append(("critical_author_not_fail", f"critical, автор которого голосует не fail (часто подтверждение "
                                                 f"исправления — проверить): {', '.join(fl['crit_notes'][:5])}"))
    if fl["skipped"]:
        hard.append(("control_skipped", f"не успели стадии: {', '.join(fl['skipped'])}"))
    if hard:
        state.policy["verdict_reasons"] = [code for code, _ in hard]
        return done("NEEDS_HUMAN", avg, f"{tally}: " + "; ".join(text for _, text in hard), hard[0][0])
    if ar >= policy["accept_threshold"]:
        if avg < policy["min_confidence"]:
            return done("NEEDS_HUMAN", avg, f"{tally}: большинство за accept, но средняя уверенность "
                                            f"{avg:.2f} < {policy['min_confidence']}", "low_confidence")
        if j_verdict in ("FAIL", "NEEDS_HUMAN"):
            return done("NEEDS_HUMAN", avg, f"{tally}: судья против принятия ({j_verdict})", "judge_against")
        if policy.get("major_needs_human", True) and fl["majors"]:
            return done("NEEDS_HUMAN", avg, f"{tally}: большинство за accept, но висят major-находки: "
                                            f"{', '.join(fl['majors'][:5])}", "major")
        return done("ACCEPT", avg, f"{tally}: порог accept {policy['accept_threshold']} пройден", "threshold")
    base = "INCONCLUSIVE" if policy["allow_inconclusive"] else "NEEDS_HUMAN"
    if fl["fail_bare"] or fl["thin_accept"]:
        # Прежняя политика дала бы здесь FAIL (или не дала бы ACCEPT): решать человеку.
        return done("NEEDS_HUMAN", avg, f"{tally}: голоса без улик — решение за человеком",
                    "insufficient_evidence")
    if policy["judge_tiebreak"] and j_conf >= 0.7:
        if j_verdict == "ACCEPT" and not (policy.get("major_needs_human", True) and fl["majors"]):
            return done("ACCEPT", j_conf, f"{tally}: перевеса нет, судья разрешил (ACCEPT, {j_conf:.2f})",
                        "judge_tiebreak")
        if j_verdict == "FAIL":
            backed = [f for f in state.findings() if _supported(f)]
            if any(_defect_claim(f, valid, state.voters) for f in backed):
                return done("FAIL", j_conf, f"{tally}: перевеса нет, судья разрешил (FAIL, {j_conf:.2f}) "
                                            "при находках с опорой", "judge_tiebreak")
            if backed:
                # Прежняя политика дала бы FAIL; опора есть, но только у заметок — решать человеку, а не
                # INCONCLUSIVE, на которое карточка не двигается.
                return done("NEEDS_HUMAN", avg, f"{tally}: перевеса нет, судья за FAIL ({j_conf:.2f}), "
                                                "но находки с опорой — от голосующих не fail", "judge_fail_on_notes")
    return done(base, avg, f"{tally}: перевеса нет", "tie")
