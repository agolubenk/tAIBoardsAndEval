#!/usr/bin/env python3
"""selftest: политика вердикта ревью-консилиума (§17.5) — FAIL / NEEDS_HUMAN / ACCEPT по голосам,
находкам и судье, перебор инварианта «гейт не создаёт ACCEPT сверх прежней политики».

Вынесено из selftest_review.py (> 500 строк). Досье и фабрика состояний — там же; модели не вызываются.
"""
from __future__ import annotations

import review_service as RS
from review_engine import decide
from selftest_review import F_CARD, F_MAJOR_CARD, F_MAJOR_NONE, F_NO_TESTS, F_NONE, F_PATCH, _state


def policy_checks(check) -> None:
    v, _c, _s = decide(_state({"code": "accept", "dod": "accept", "security": "fail"},
                              {"security": [dict(F_PATCH, severity="major")]}))
    check("ревью: вето security С УЛИКАМИ перекрывает большинство accept", v == "FAIL", v)
    st = _state({"code": "accept", "dod": "accept", "security": "fail"})
    v, _c, _s = decide(st)
    check("ревью: вето без улик → NEEDS_HUMAN (не FAIL и не ACCEPT)",
          v == "NEEDS_HUMAN" and st.policy["verdict_reason"] == "unsupported_veto"
          and st.policy["legacy_verdict"] == "FAIL", (v, st.policy))
    v, _c, _s = decide(_state({"code": "accept", "dod": "accept", "security": "fail"}, blocking=False))
    check("ревью: без блокирующей политики вето нет (2 из 3 accept → ACCEPT)", v == "ACCEPT", v)
    v, _c, _s = decide(_state({"code": "accept", "dod": "accept"}, {"code": [F_PATCH]}))
    check("ревью: critical с опорой в диффе без подтверждения → NEEDS_HUMAN", v == "NEEDS_HUMAN", v)
    st = _state({"code": "accept", "dod": "accept"}, {"code": [F_PATCH]}, confirm={F_PATCH["title"]: "dod"})
    v, _c, _s = decide(st)
    check("ревью: critical с опорой, подтверждён не автором, но оба голосуют accept — заметка, не FAIL "
          "(«уязвимость исправлена», rv_085727c0647b); принятие держит → NEEDS_HUMAN",
          v == "NEEDS_HUMAN" and st.policy["verdict_reason"] == "critical_author_not_fail"
          and st.policy["legacy_verdict"] == "FAIL", (v, st.policy))
    text = RS._comment_text({"id": "rv_test", "verdict": v, "confidence": _c, "summary": _s, "profile_name": "p",
                             "snapshot": {}, "result": st.result()}, "")
    check("ревью: комментарий на карточку — основание словами, у заметки-critical метка «проверить»",
          RS.REASON_RU["critical_author_not_fail"] in text
          and f"• [critical] {F_PATCH['title']} (подтвердил dod; автор голосует не fail" in text, text)
    st = _state({"code": "fail", "dod": "accept"}, {"code": [F_PATCH]}, confirm={F_PATCH["title"]: "dod"})
    v, _c, _s = decide(st)
    check("ревью: critical с опорой, автор голосует fail, подтверждён не автором → FAIL",
          v == "FAIL" and st.policy["verdict_reason"] == "critical", (v, st.policy))
    # needs_human — и голос, которым движок заменяет испорченный ответ; невалидный голос — не «не голосует»
    for author in ("needs_human", "ACCEPT"):
        st = _state({"code": author, "dod": "accept", "qa": "accept"}, {"code": [F_PATCH]},
                    confirm={F_PATCH["title"]: "dod"})
        v, _c, _s = decide(st)
        check(f"ревью: critical с опорой, автор голосует {author!r}, подтверждён не автором → решает человек",
              v == "NEEDS_HUMAN" and st.policy["verdict_reason"] == "critical_author_not_fail", (v, st.policy))
    for confirmer in ("fail", "needs_human"):
        st = _state({"code": "accept", "dod": "accept", "qa": confirmer}, {"code": [F_PATCH]},
                    confirm={F_PATCH["title"]: "qa"})
        v, _c, _s = decide(st)
        check(f"ревью: critical голосовавшего accept подтвердил голосующий {confirmer} — подтверждение не "
              "делает заметку дефектом → NEEDS_HUMAN",
              v == "NEEDS_HUMAN" and st.policy["verdict_reason"] == "critical_author_not_fail", (v, st.policy))
    st = _state({"code": "accept", "dod": "accept"})
    st.add_findings("adversary", [dict(F_PATCH)])
    f_adv = next(x for x in st.findings() if x.get("by") == "adversary")
    st.confirmed.setdefault(f_adv["id"], set()).add("dod")
    v, _c, _s = decide(st)
    check("ревью: critical оппонента (не голосует) с опорой, подтверждён голосующим → FAIL, как раньше",
          v == "FAIL" and st.policy["verdict_reason"] == "critical", (v, st.policy))
    for who in ("code", "qa"):
        st = _state({"code": "accept", "qa": "needs_human"}, {who: [dict(F_PATCH, severity="major")]},
                    judge={"verdict": "FAIL", "confidence": 0.9})
        v, _c, _s = decide(st)
        check(f"ревью: ничья, судья за FAIL, а опора только у заметки голосующего не fail ({who}) → "
              "NEEDS_HUMAN, а не FAIL и не INCONCLUSIVE",
              v == "NEEDS_HUMAN" and st.policy["verdict_reason"] == "judge_fail_on_notes", (v, st.policy))
    st = _state({"code": "accept", "dod": "needs_human", "qa": "fail"}, {"qa": [dict(F_PATCH, severity="major")]},
                judge={"verdict": "FAIL", "confidence": 0.9})
    v, _c, _s = decide(st)
    check("ревью: ничья, судья за FAIL при находке с опорой от голосующего fail → FAIL (judge_tiebreak)",
          v == "FAIL" and st.policy["verdict_reason"] == "judge_tiebreak", (v, st.policy))
    st = _state({"code": "accept", "qa": "needs_human"}, judge={"verdict": "FAIL", "confidence": 0.9})
    st.add_findings("adversary", [dict(F_PATCH, severity="major")])
    v, _c, _s = decide(st)
    check("ревью: ничья, судья за FAIL при находке с опорой от оппонента (не голосует) → FAIL (judge_tiebreak)",
          v == "FAIL" and st.policy["verdict_reason"] == "judge_tiebreak", (v, st.policy))
    st = _state({"code": "accept", "dod": "accept"}, {"code": [F_PATCH]}, confirm={F_PATCH["title"]: "dod"})
    st.disputed[st.findings()[0]["id"]] = "qa: вне изменения"
    v, _c, _s = decide(st)
    check("ревью: подтверждённый, но оспоренный critical → NEEDS_HUMAN, не ACCEPT", v == "NEEDS_HUMAN", v)
    st = _state({"code": "accept", "dod": "accept"}, {"code": [F_NONE]})
    v, _c, _s = decide(st)
    check("ревью: critical без опоры — не FAIL, но и не ACCEPT (прежняя политика — FAIL)",
          v == "NEEDS_HUMAN" and st.policy["legacy_verdict"] == "FAIL", (v, st.policy))
    v, _c, _s = decide(_state({"code": "accept", "dod": "accept"}, {"code": [F_CARD]}))
    check("ревью: critical по тексту карточки (заявление исполнителя) → NEEDS_HUMAN", v == "NEEDS_HUMAN", v)
    v, _c, _s = decide(_state({"code": "accept", "dod": "accept"}, {"code": [F_MAJOR_CARD]}))
    check("ревью: accept-большинство при major с опорой → NEEDS_HUMAN", v == "NEEDS_HUMAN", v)
    v, _c, _s = decide(_state({"code": "accept", "dod": "accept"}, {"code": [F_MAJOR_NONE]}))
    check("ревью: major без опоры по-прежнему держит принятие", v == "NEEDS_HUMAN", v)
    st = _state({"code": "accept", "dod": "accept"})
    st.latest["dod"]["missing_evidence"] = ["нет результата e2e"]
    v, _c, _s = decide(st)
    check("ревью: accept с перечисленными недостающими уликами → NEEDS_HUMAN (insufficient_evidence)",
          v == "NEEDS_HUMAN" and st.policy["verdict_reason"] == "insufficient_evidence", (v, st.policy))
    v, _c, _s = decide(_state({"code": "accept", "dod": None, "qa": None}))
    check("ревью: мало валидных выводов → NEEDS_HUMAN", v == "NEEDS_HUMAN", v)
    v, _c, _s = decide(_state({"code": "accept", "dod": "needs_human"},
                              judge={"verdict": "ACCEPT", "confidence": 0.5}))
    check("ревью: ничья без уверенного судьи → INCONCLUSIVE", v == "INCONCLUSIVE", v)
    v, _c, _s = decide(_state({"code": "accept", "dod": "accept"}, judge={"verdict": "FAIL"}))
    check("ревью: судья против принятия → NEEDS_HUMAN, а не ACCEPT", v == "NEEDS_HUMAN", v)
    v, _c, _s = decide(_state({"code": "accept", "dod": "needs_human"}, {"code": [F_MAJOR_CARD]},
                              judge={"verdict": "ACCEPT", "confidence": 0.9}))
    check("ревью: судья не разрешает ничью в ACCEPT при висящем major (дыра tiebreak закрыта)",
          v == "INCONCLUSIVE", v)
    st = _state({"code": "fail", "dod": "accept"}, judge={"verdict": "ACCEPT", "confidence": 0.95})
    v, _c, _s = decide(st)
    check("ревью: голос fail без улик — решение человеку, судья не дотягивает до ACCEPT",
          v == "NEEDS_HUMAN" and st.policy["legacy_verdict"] == "NEEDS_HUMAN", (v, st.policy))
    v, _c, _s = decide(_state({"code": "fail", "dod": "accept"}, {"code": [dict(F_PATCH, severity="major")]}))
    check("ревью: голос fail с находкой в диффе → порог fail → FAIL", v == "FAIL", v)
    st = _state({"code": "accept", "dod": "accept"})
    st.skipped = ["pair_check", "judge"]
    v, _c, _s = decide(st)
    check("ревью: оборванная контрольная стадия → NEEDS_HUMAN вместо ACCEPT", v == "NEEDS_HUMAN", v)
    st = _state({"code": "accept", "dod": "needs_human"}, {"dod": [dict(F_CARD, severity="major", title="нет коммита/PR")]})
    v, _c, _s = decide(st)
    check("ревью: пробел DoD без большинства accept → FAIL «недостаточно доказательств» (в работу)",
          v == "FAIL" and st.policy["verdict_reason"] == "insufficient_evidence", (v, st.policy))
    st = _state({"code": "accept", "dod": "needs_human"}, {"dod": [dict(F_NO_TESTS, severity="major")]})
    v, _c, _s = decide(st)
    check("ревью: пробел DoD «тесты не прогнаны» при результате в досье снят кодом — не FAIL",
          v != "FAIL", (v, st.policy))
    _invariant(check)
    st = _state({"code": "accept", "dod": "accept"}, {"code": [F_NONE]}, policy={"evidence_gate": False})
    v, _c, _s = decide(st)
    check("ревью: гейт выключен — прежняя политика", v == "FAIL" and not st.policy["gate"], v)


def _invariant(check) -> None:
    """Перебор: гейт не создаёт ACCEPT, которого не дала бы прежняя политика, и FAIL сверх неё (кроме
    «недостаточно доказательств»); заметка — подтверждённый critical автора, голосующего не fail, — не
    проходит в принятие; подтверждённое заявление о дефекте с опорой — всегда FAIL.

    Автор — голосующий (code), оппонент (не голосует) или аудитор доказательств (dod), подтверждает — никто,
    аудитор или security. Автор-аудитор в переборе с 20.10: до правки его critical без подтверждения не держал
    принятие (flags: crit_open без пробелов DoD) — карточка «Ошибки» 3ffdd207a82581bebadbfc81cb7a174b.
    """
    import itertools
    pool = [F_PATCH, F_NONE, F_CARD, F_MAJOR_CARD, F_MAJOR_NONE, dict(F_PATCH, severity="major")]
    judges = (None, {"verdict": "ACCEPT", "confidence": 0.9}, {"verdict": "FAIL", "confidence": 0.9})
    bad, n, reasons = [], 0, set()
    for votes in itertools.product(("accept", "fail", "needs_human"), repeat=3):
        names = dict(zip(("code", "dod", "security"), votes))
        for f0, judge, author, confirmer in itertools.product(pool, judges, ("code", "adversary", "dod"),
                                                               (None, "dod", "security")):
            if author == confirmer:
                continue             # своё не подтверждают: автор-аудитор — подтверждает никто или security
            st = _state(names, {author: [dict(f0)]} if author != "adversary" else None, judge=judge)
            if author == "adversary":
                st.add_findings("adversary", [dict(f0)])
            fid = st.fid(author, f0["title"])
            if confirmer:
                st.confirmed.setdefault(fid, set()).add(confirmer)
            v, _c, _s = decide(st)
            n += 1
            reasons.add(st.policy["verdict_reason"])
            case = (names, f0["title"], judge, author, confirmer)
            if v == "ACCEPT" and st.policy["legacy_verdict"] != "ACCEPT":
                bad.append(("ACCEPT сверх прежней", *case))
            if v == "FAIL" and st.policy["legacy_verdict"] != "FAIL" \
                    and st.policy["verdict_reason"] != "insufficient_evidence":
                bad.append(("FAIL сверх прежней", *case))
            if v == "ACCEPT" and (st.policy.get("flags") or {}).get("crit_notes"):
                bad.append(("ACCEPT при заметке", *case))
            f = next((x for x in st.findings() if x["id"] == fid), None)
            claim = author == "adversary" or names[author] == "fail"
            if (f and claim and f["severity"] == "critical" and f.get("decisive") and f.get("confirmed_by")
                    and fid not in st.disputed and v != "FAIL"):
                bad.append(("заявление о дефекте без FAIL", *case))
    check(f"ревью: инвариант — гейт не создаёт ACCEPT сверх прежней политики, FAIL — только "
          f"«недостаточно доказательств», заметка не принимается, заявление о дефекте — FAIL ({n} состояний)",
          not bad and n == 3888, (n, bad[:3]))
    # Автор-аудитор голосует accept, его critical с опорой в диффе никто не подтвердил: прежняя политика — FAIL,
    # до правки 20.10 гейт давал ACCEPT; теперь пробел держит принятие.
    st = _state({"code": "accept", "dod": "accept", "security": "accept"}, {"dod": [dict(F_PATCH)]})
    v, _c, _s = decide(st)
    check("ревью: critical-пробел аудитора, проголосовавшего accept, держит принятие (open_evidence_gap)",
          v == "NEEDS_HUMAN" and st.policy["verdict_reason"] == "open_evidence_gap"
          and st.policy["legacy_verdict"] == "FAIL", (v, st.policy.get("verdict_reason")))
    run = {"id": "rv_test", "verdict": "NEEDS_HUMAN", "confidence": 0.9, "profile_name": "p", "summary": "s",
           "snapshot": {"method": "", "agents": {}},
           "result": {"policy": {"verdict_reason": "unverified_critical",
                                 "verdict_reasons": ["unverified_critical", "critical_author_not_fail"]}}}
    text = RS._comment_text(run, "")
    check("ревью: в «Основании» на карточке — все сработавшие причины, а не первая",
          RS.REASON_RU["unverified_critical"] in text and RS.REASON_RU["critical_author_not_fail"] in text, text)
    check("ревью: у каждой причины вердикта из перебора есть подпись для карточки (REASON_RU)",
          reasons <= set(RS.REASON_RU) and "judge_fail_on_notes" in reasons, sorted(reasons - set(RS.REASON_RU)))
