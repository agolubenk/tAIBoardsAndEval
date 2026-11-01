#!/usr/bin/env python3
"""AI Council — дополнительный раунд вместо воздержания (M2 сверка, M3 дожим) и языковой гейт (M6).

Канон: docs/ai/COUNCIL-DRIFT-DESIGN.md (дрейф рубрики 2026-10-14/15) и docs/specs/ai-council.md. Вынесено из council.py:
тот уже больше лимита размера, а доп. раунд — отдельная ответственность. Классы ниже — миксины `Council`: им нужны
его `cfg`, `log`, `store`, `_ask`/`_ask_once`, `verify`, `review`, `should_abstain`, `_maybe_locked`.

Инварианты (ревью #159, линза «корректность протокола»):
- раунд, который не завершился (рецензенты не ответили, кончилось время), откатывается к состоянию до раунда —
  ни выдуманной оценки «0.0 ниже порога», ни оценки верификатора вместо рецензии, ни потерянных возражений R2;
- авторы в сверке видят ИСХОДНЫЕ версии друг друга, а не уже переписанные (иначе первый задаёт тон остальным);
- предложение, потерявшее все файлы постановки, исключается из ворот и из арбитража (а не только понижается);
- переписанное предложение перепроверяется и перезаписывается в базе; неизменённое — нет (без дублей верификации).
"""
from __future__ import annotations

import copy
import json
import re
import time

import textutil
from verifier import REPO_ROOT


# ── чистые функции ──────────────────────────────────────────────────────────
def strings(value) -> list[str]:
    """Все строки структурного ответа (для языкового гейта)."""
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [s for v in value.values() for s in strings(v)]
    if isinstance(value, list):
        return [s for v in value for s in strings(v)]
    return []


_PATH_IN_TEXT_RE = re.compile(r"(?<![\w/.-])((?:apps|packages|infra|docs|shared|scripts)/[\w./@-]+\.[a-z]{1,5})\b")


def file_exists(path: str) -> bool:
    return (REPO_ROOT / path).is_file()


def statement_files(text: str) -> set[str]:
    """Файлы, названные в постановке путём от корня репозитория и существующие в нём. Устаревший путь из постановки
    не должен награждать предложение, которое его повторило, и наказывать то, что верно его опустило (ревью #159)."""
    return {m for m in (raw.rstrip(".") for raw in _PATH_IN_TEXT_RE.findall(text or "")) if file_exists(m)}


def abstain_kind(reason: str) -> str:
    """Вид воздержания для дополнительного раунда: `divergence` — модели разошлись в файлах или цели
    (лечит M2 сверка), `below` — лучшая оценка ниже порога (лечит M3 дожим), иначе — ничего."""
    if reason.startswith(("модели поняли задачу по-разному", "модели разошлись в понимании ЦЕЛИ")):
        return "divergence"
    if reason.startswith("лучшая оценка"):
        return "below"
    return ""


def extra_round_allowed(started: float, deadline: float, now: float | None = None, reserve: float = 0.0) -> bool:
    """Один дополнительный раунд, если в запасе не меньше уже потраченного (не меньше 3 мин) плюс резерв на арбитра.
    У раунда то же число вызовов, что у первого прохода (правки + рецензии), и они идут через тот же
    последовательный слот, поэтому его цена — замер этого же прогона; резерв — чтобы арбитру осталось время
    (замер 15.10: арбитр glm4 — в среднем 33 с, максимум 64 с за 14 дней)."""
    now = time.time() if now is None else now
    return deadline - now >= max(180.0, now - started) + reserve


def _brief(payload: dict) -> dict:
    from council import norm_files  # noqa: PLC0415 — council импортирует этот модуль
    return {"цель": payload.get("goal") or "", "файлы": sorted(norm_files(payload))[:12],
            "пункты": [str(d.get("what") if isinstance(d, dict) else d)[:160]
                       for d in (payload.get("decomposition") or [])[:2]]}


def _no_shorter(before: dict, after: dict) -> bool:
    """Повтор не потерял поля и пункты: те же ключи, ни один список не стал короче."""
    if not set(before) <= set(after):
        return False
    return all(len(after.get(k) or []) >= len(v) for k, v in before.items() if isinstance(v, list))


# ── языковой гейт (M6) ──────────────────────────────────────────────────────
class LanguageGate:
    LANG_RETRY_MAX_CHARS = 6000

    def _language_gate(self, run_id: str, round_no: int, role: str, model: str, system: str,
                       schema: dict, temperature: float, max_tokens: int, timeout: int | None, result):
        """Строковые поля ответа на чужом языке (украинский, казахский, китайский…) — один повтор компактным
        промптом: только ответ и конкретные фрагменты, без капсулы. Правило есть в каждом промпте, нарушают его
        ~10 % успешных ответов (замер 2026-10-15: 76 из 724) — промпт не механизм. Слова, процитированные из
        постановки или улик, нарушением не считаются. Повтор не помог, не уложился во время или ответ слишком
        длинный, чтобы показать его целиком, — остаётся исходный ответ, роль попадает в provenance."""
        if not (result.ok and isinstance(result.data, dict)) or not self.cfg.get("council.language_gate", True):
            return result
        bad = textutil.foreign_script_samples("\n".join(strings(result.data)), limit=4, allowed=self._lang_allowed)
        if not bad:
            return result
        dump = json.dumps(result.data, ensure_ascii=False)
        if (timeout is not None and timeout < 30) or len(dump) > self.LANG_RETRY_MAX_CHARS:
            # Обрезанный ответ модель «закрыла» бы короче — хвост декомпозиции пропал бы без следа (ревью #159).
            self.log(f"    ! {role}: чужой язык в ответе — повтор невозможен "
                     f"({'нет времени' if timeout is not None and timeout < 30 else 'ответ слишком длинный'})")
            self._lang_failed.append(role)
            return result
        self.log(f"    ⚠ {role}: чужой язык в ответе ({'; '.join(bad)}) — повтор по-русски")
        fix = ("Твой предыдущий ответ нарушает языковое правило: фрагменты «" + "», «".join(bad)
               + "» написаны не по-русски и не по-английски. Перепиши ВЕСЬ ответ по-русски (идентификаторы, "
               "пути и команды — как есть, латиницей), сохрани смысл, все поля и ту же JSON-схему.\n\nОТВЕТ\n" + dump)
        again = self._ask_once(run_id, round_no, role, model, system, fix, schema, temperature, max_tokens, timeout)
        if (again.ok and isinstance(again.data, dict) and _no_shorter(result.data, again.data)
                and not textutil.has_foreign_script("\n".join(strings(again.data)), allowed=self._lang_allowed)):
            return again
        self.log(f"    ! {role}: повтор не исправил язык — оставлен исходный ответ")
        self._lang_failed.append(role)
        return result


# ── дополнительный раунд (M2, M3) ───────────────────────────────────────────
class ExtraRounds:
    @staticmethod
    def _snapshot(proposals) -> dict:
        return {p.id: (copy.deepcopy(p.payload), p.verification, p.review_score, list(p.objections),
                       p.extra_round, p.excluded) for p in proposals}

    @staticmethod
    def _restore(proposals, snap: dict, ids=None) -> None:
        for p in proposals:
            if p.id in snap and (ids is None or p.id in ids):
                (p.payload, p.verification, p.review_score, p.objections,
                 p.extra_round, p.excluded) = copy.deepcopy(snap[p.id][0]), *snap[p.id][1:]

    def _proposer_user(self, capsule) -> str:
        return (f"ПОСТАНОВКА\n{capsule.pinned}\n\n"
                f"УЛИКИ ИЗ ПРОЕКТА (использовать только их)\n{capsule.evidence_text()}")

    def _revise(self, run_id: str, capsule, proposal, roles: dict, block: str, round_no: int) -> bool:
        """Автор переписывает своё предложение с дополнительным блоком (сверка или возражения). True — заменено."""
        from council import PROPOSAL_SCHEMA, load_prompt  # noqa: PLC0415
        model = roles.get(proposal.role) or proposal.model
        system = load_prompt(proposal.role)
        if not system:
            return False
        with self._maybe_locked(model):
            result = self._ask(run_id, round_no, proposal.role, model, system,
                               self._proposer_user(capsule) + "\n\n" + block, PROPOSAL_SCHEMA,
                               self.cfg.get("council.temperature_proposer", 0.3))
        if not (result.ok and isinstance(result.data, dict)):
            self.log(f"    ✗ {proposal.id} ({proposal.role}): правка не удалась — остаётся прежнее")
            return False
        proposal.payload = result.data
        proposal.verification, proposal.review_score, proposal.objections = None, 0.0, []
        return True

    def _persist(self, run_id: str, proposals) -> None:
        """Переписанное — в строку `proposals`: детализация прогона показывает то, что ушло в арбитраж, а не R1."""
        for p in proposals:
            self.store.x("UPDATE proposals SET payload = ?, grounded_score = ? WHERE id = ?",
                         (json.dumps(p.payload, ensure_ascii=False), p.grounded, f"{run_id}:{p.id}"))

    def reconcile(self, run_id: str, capsule, proposals, roles: dict) -> tuple[set[str], set[str]]:
        """M2, раунд сверки: каждый автор видит ИСХОДНЫЕ краткие версии остальных (цель, файлы, 2 пункта) и
        сверяется с ПОСТАНОВКОЙ, а не друг с другом. Возвращает (переписанные, потерявшие все файлы постановки).
        Выпал любой файл постановки — возражение и вопрос владельцу; выпали все — предложение исключается."""
        from council import norm_files  # noqa: PLC0415
        named = statement_files(capsule.pinned)
        briefs = {p.id: _brief(p.payload) for p in proposals}
        rewritten: set[str] = set()
        lost_ids: set[str] = set()
        for proposal in proposals:
            others = [briefs[o.id] for o in proposals if o.id != proposal.id]
            block = ("СВЕРКА. Другие участники поняли задачу так (анонимно):\n"
                     + json.dumps(others, ensure_ascii=False, indent=1)[:3000]
                     + "\n\nСверь СВОЁ предложение с ПОСТАНОВКОЙ — не подстраивайся под других. Файл или цель, "
                       "названные в постановке, обязательны. Если другой участник прочитал постановку точнее — "
                       "исправь своё. Если расхождение по существу (нужен выбор владельца) — оставь своё и запиши в "
                       "open_questions вопрос с 2–3 вариантами, ценой каждого и рекомендацией.")
            if not self._revise(run_id, capsule, proposal, roles, block, round_no=25):
                continue
            rewritten.add(proposal.id)
            proposal.extra_round = "сверка"
            lost = sorted(named - norm_files(proposal.payload))
            if lost:
                proposal.objections.append("после сверки выпал файл из постановки: " + ", ".join(lost[:3]))
                questions = list(proposal.payload.get("open_questions") or [])
                questions.append("После сверки предложение не трогает " + ", ".join(lost[:3])
                                 + " из постановки — правка там не нужна или упущена?")
                proposal.payload["open_questions"] = questions
            if named and set(lost) == named:
                lost_ids.add(proposal.id)
        self.log(f"    ⇄ сверка: переписаны {len(rewritten)} из {len(proposals)}"
                 + (f", без файлов постановки: {', '.join(sorted(lost_ids))}" if lost_ids else ""))
        return rewritten, lost_ids

    def push(self, run_id: str, capsule, proposals, roles: dict, module: str, deadline: float):
        """M3, дожим 7–8/15: автор лучшего предложения исправляет блокирующие возражения, затем повторная рецензия
        только его предложения. Порог не снижается; рецензия не состоялась — откат к оценке R2."""
        active = [p for p in proposals if not p.excluded]
        best = max(active, key=lambda p: p.total_score)
        objections = [o for o in best.objections if str(o).strip()][:6]
        # Без второго рецензента оценку дал бы верификатор без вызова модели; без возражений «сделай конкретнее»
        # толкает к выдуманной конкретике (ревью #159).
        if len(active) < 2 or not objections:
            self.log("    · дожим пропущен: " + ("нет второго рецензента" if len(active) < 2
                                                  else "у лучшего нет блокирующих возражений"))
            return None
        snap = self._snapshot([best])
        block = ("ДОЖИМ. Рецензенты оценили твоё предложение почти достаточно, но оставили блокирующие возражения:\n"
                 + "\n".join(f"- {o}" for o in objections)
                 + "\n\nИсправь КАЖДОЕ возражение в предложении или опровергни его уликой из проекта "
                   "(в risks или open_questions). Не меняй то, что не оспорено.")
        if not self._revise(run_id, capsule, best, roles, block, round_no=26):
            return None
        self.verify(run_id, [best])
        landed = (self.review(run_id, capsule, active, roles, round_no=26, module=module, only={best.id})
                  if time.time() < deadline else {})
        if not landed.get(best.id):
            self._restore([best], snap)
            self.log(f"    · дожим {best.id} не завершён ({'время' if time.time() >= deadline else 'рецензенты не ответили'})"
                     " — оценка R2 сохранена")
            return None
        best.extra_round = "дожим"
        self._persist(run_id, [best])
        return best

    def _extra_round(self, run_id: str, capsule, proposals, roles: dict, module: str, reason: str,
                     started: float, deadline: float) -> tuple[bool, str]:
        """Один дополнительный раунд по виду воздержания; возвращает новое (abstain, reason). Раунд, который не
        завершился, откатывается: причина остаётся исходной с пометкой, возражения и оценки R2 — на месте."""
        kind = abstain_kind(reason)
        if not kind or not self.cfg.get("council.extra_round", True):
            return True, reason
        reserve = float(self.cfg.get("council.extra_round_reserve_seconds", 120))
        if not extra_round_allowed(started, deadline, reserve=reserve):
            self.log("    · дополнительный раунд пропущен: времени меньше, чем уже потрачено, плюс резерв арбитра")
            return True, reason
        label = "сверки" if kind == "divergence" else "дожима"
        if kind == "divergence" and len([p for p in proposals if not p.excluded]) >= 2:
            snap = self._snapshot(proposals)
            rewritten, lost = self.reconcile(run_id, capsule, proposals, roles)
            if not rewritten:
                return True, reason
            changed = [p for p in proposals if p.id in rewritten]
            self.verify(run_id, changed)
            landed = (self.review(run_id, capsule, proposals, roles, round_no=25, module=module, only=rewritten)
                      if time.time() < deadline else {})
            unreviewed = {pid for pid in rewritten if not landed.get(pid)}
            if unreviewed == rewritten:
                self._restore(proposals, snap)
                why = "время" if time.time() >= deadline else "рецензенты не ответили"
                self.log(f"    · сверка не завершена ({why}) — состояние до сверки восстановлено")
                return True, f"{reason} (доп. раунд не завершён: {why})"
            # Без рецензии — к версии R2 (оценка R2 честнее нуля после сброса); остальные переписанные остаются.
            self._restore(proposals, snap, ids=unreviewed)
            for p in proposals:
                if p.id in lost and p.id not in unreviewed:
                    p.excluded = True
                    p.objections.append("после сверки в предложении нет ни одного файла из постановки")
            self._persist(run_id, [p for p in changed if p.id not in unreviewed])
        elif kind == "below":
            floor = float(self.cfg.get("council.push_min_score", 7))
            if max(p.total_score for p in proposals if not p.excluded) < floor:
                return True, reason
            if self.push(run_id, capsule, proposals, roles, module, deadline) is None:
                return True, reason
        else:
            return True, reason
        self._extra_kind = "сверка" if kind == "divergence" else "дожим"
        abstain, again = self.should_abstain(proposals)
        if not abstain:
            self.log(f"    ✓ после {label} воздержание снято")
        return abstain, (f"{again} (после {label})" if abstain else "")
