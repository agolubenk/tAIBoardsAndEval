"""ИИ-консилиум, дрейф рубрики M4 и M5 (2026-10-16): сбой инфраструктуры — не воздержание; молчащий арбитр.

M4. Демон Ollama не отвечает, слот локального инференса держит чужой процесс дольше таймаута, вызов шёл дольше двух
своих таймаутов (машина спала или зависла) — о карточке это не говорит ничего. Если из-за такого сбоя у прогона нет
предложений, рецензий или арбитра, исход — `deferred`: воркер возвращает прогон в очередь с растущей паузой (15, затем
30 мин), без сожжённой попытки и с новым дедлайном; после двух откладываний — воздержание «ресурс локальных моделей».
Замер 01–15.10, fast: 11 воздержаний «лучшая оценка 0.0» — во всех вызов шёл 16–47 мин при таймауте 300 с и рецензий
не было; один из двух «арбитр не дал валидного ответа» — вызов 26 мин. Таймаут генерации («timed out») сбоем машины не
считается: медленная модель — свойство прогона.

M5. Арбитр не дал валидного ответа — повтор с компактным пакетом: два лучших предложения (цель, пункты, файлы,
критерии) без рецензий, max_tokens 1500. Снова нет, и сбоя инфраструктуры не было, — дальше идёт лучшее предложение,
прошедшее ворота, без слияния: provenance.merge = "none", уверенность не выше 0.5, спираль не запускается (ревизор
в ней — тот же арбитр). Канон — docs/specs/ai-council.md §17.8.
"""
from __future__ import annotations

import json
import re
import time

# Ошибки локального вызова (ollama.OllamaClient._post), которые говорят о машине, а не о модели: демон не отвечает
# (и кэш-маркер после этого), runner упал (HTTP 5xx), слот локального инференса занят чужим процессом.
INFRA_ERROR_RE = re.compile(r"^(сеть/демон|ollama недоступна|HTTP 5\d\d)|локальный инференс занят")
STALL_MARGIN_S = 60
DEFER_PAUSES_S = (900, 1800)            # растущая пауза: 15, затем 30 мин
MAX_DEFERRALS = len(DEFER_PAUSES_S)
DEFER_PREFIX = "M4 отложен: "
ABSTAIN_PREFIX = "ресурс локальных моделей"
UNMERGED_CONFIDENCE = 0.5
COMPACT_ROUND = 41                      # R4.1 — повтор арбитра, по образцу R2.5 = 25 у сверки
COMPACT_MAX_TOKENS = 1500
COMPACT_MIN_TIMEOUT_S = 120             # арбитр glm4: в среднем 33 с, максимум 64 с за 14 дней (council_rounds)


def infra_event(ok: bool, error: str, ms: int, timeout_s: float) -> str:
    """Короткое описание сбоя инфраструктуры в локальном вызове или "", если вызов говорит о модели.
    `ms` — длительность удачной попытки: законный предел — ожидание слота плюс генерация, два таймаута."""
    if not ok and INFRA_ERROR_RE.search(error or ""):
        return (error or "")[:160]
    if ok and ms > (2 * timeout_s + STALL_MARGIN_S) * 1000:
        return f"вызов шёл {ms // 1000} с при таймауте {int(timeout_s)} с — машина спала или зависла"
    return ""


def defer_pause(deferrals: int) -> int:
    return DEFER_PAUSES_S[min(max(int(deferrals), 0), MAX_DEFERRALS - 1)]


def _active(proposals) -> list:
    return [p for p in proposals if not p.excluded] or list(proposals)


def compact_package(pinned: str, proposals) -> str:
    """M5: два лучших предложения без рецензий — короче вход и ответ, чем у полного пакета арбитра."""
    best = sorted(_active(proposals), key=lambda p: p.total_score, reverse=True)[:2]
    items = []
    for p in best:
        payload = p.payload or {}
        items.append({
            "id": p.id,
            "goal": payload.get("goal") or "",
            "decomposition": [{"id": s.get("id"), "what": s.get("what"), "files": s.get("files") or []}
                              for s in (payload.get("decomposition") or []) if isinstance(s, dict)][:10],
            "files": list((payload.get("touched") or {}).get("files") or [])[:30],
            "acceptance": list(payload.get("acceptance") or [])[:10],
        })
    return (f"ПОСТАНОВКА\n{pinned}\n\nДВА ЛУЧШИХ ПРЕДЛОЖЕНИЯ (рецензии опущены)\n"
            f"{json.dumps(items, ensure_ascii=False, indent=1)[:6000]}")


def unmerged(proposal) -> dict:
    """M5: лучшее предложение как результат без слияния — в форме ответа арбитра (MERGED_SCHEMA)."""
    payload = proposal.payload or {}
    return {
        "abstain": False,
        "goal": payload.get("goal") or "",
        "non_goals": list(payload.get("non_goals") or []),
        "decomposition": [{**s, "from": [proposal.id]} for s in (payload.get("decomposition") or [])
                          if isinstance(s, dict)],
        "touched": payload.get("touched") or {},
        "risks": list(payload.get("risks") or []),
        "acceptance": list(payload.get("acceptance") or []),
        "verification_cmd": payload.get("verification_cmd") or "",
        "open_questions": list(payload.get("open_questions") or []),
        "confidence": UNMERGED_CONFIDENCE,
    }


class InfraRounds:
    """Примесь к Council: учёт сбоев инфраструктуры в прогоне (M4) и повтор молчащего арбитра (M5)."""

    def _note_infra(self, role: str, result, timeout) -> None:
        limit = timeout or getattr(self.ollama, "request_timeout", 300) or 300
        event = infra_event(bool(result.ok), getattr(result, "error", "") or "", int(result.ms or 0), float(limit))
        if event:
            self._infra.append(f"{role}: {event}")
            self.log(f"    ⚠ инфраструктура: {role}: {event}")

    def infra_reason(self, where: str) -> str:
        more = f" (сбоев в прогоне: {len(self._infra)})" if len(self._infra) > 1 else ""
        return f"{where}: {self._infra[-1]}{more}"

    def arbitrate_compact(self, run_id: str, capsule, proposals, roles: dict, deadline: float | None):
        from council import MERGED_SCHEMA, load_prompt  # noqa: PLC0415 — council импортирует этот модуль
        model = roles.get("arbiter")
        if not model:
            return None
        timeout = COMPACT_MIN_TIMEOUT_S if deadline is None else max(COMPACT_MIN_TIMEOUT_S,
                                                                     int(deadline - time.time()))
        self.log("    ↻ арбитр: повтор с компактным пакетом (два лучших предложения, без рецензий)")
        with self._maybe_locked(model):
            result = self._ask(run_id, COMPACT_ROUND, "arbiter", model, load_prompt("arbiter"),
                               compact_package(capsule.pinned, proposals), MERGED_SCHEMA,
                               self.cfg.get("council.temperature_arbiter", 0.2),
                               max_tokens=COMPACT_MAX_TOKENS, timeout=timeout)
        if result.ok and isinstance(result.data, dict):
            self._merge_mode = "compact"
            return result.data
        self.log("    ✗ арбитр не ответил и на компактный пакет")
        return None

    def unmerged_best(self, proposals) -> dict | None:
        active = _active(proposals)
        if not active:
            return None
        best = max(active, key=lambda p: p.total_score)
        self._merge_mode = "none"
        self.log(f"    ⇢ без слияния: дальше идёт {best.id} ({best.role}), уверенность не выше {UNMERGED_CONFIDENCE}")
        return unmerged(best)
