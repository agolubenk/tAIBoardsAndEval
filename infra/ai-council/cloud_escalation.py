#!/usr/bin/env python3
"""AI Council — эскалация в облако задач, которые слишком долго ждут памяти. Только stdlib.

Канон: docs/specs/ai-council.md §17.4. Решение владельца 2026-10-08:

* задача ждёт памяти дольше `after_seconds` (2 ч) → её тяжёлые (L) роли уходят в облако.
  Всё остальное — как у исходного агента: профиль и трек, промпты ролей, капсула, указания
  владельца; у ревью — состав, метод, фокус агентов, temperature, бюджет досье и политика
  вердикта. Лёгкие (S) роли остаются локальными: памяти им хватает, а окно подписки не
  резиновое;
* облачный сервис недоступен → пробуем следующий провайдер (`providers`; второй биллинговый
  контур Z.AI работает внутри провайдера, по его правилам `when`);
* недоступны все → проверяем API живым пингом и назначаем повтор по ответу:
    квота/токены кончились       → время сброса + 2 минуты (`quota_margin_seconds`);
    сервис перегружен / сеть     → через 5 минут (`overload_retry_seconds`);
    сервис ответил               → сбой был разовым, повтор через минуту;
    ключа нет / ошибка конфига   → через час: ожиданием это не лечится, нужен владелец.

«Ждёт памяти» = профиль задачи СЕЙЧАС заблокирован memory-guard (queue_control.MemoryBlocks).
Стаж ожидания — `mem_wait_since` (runs / review_runs): ставится при блокировке профиля и
снимается, когда память вернулась, — появилась память, задача идёт локально и бесплатно.

Прогон начинается, только если в окне подписки свободно не меньше его потолка вызовов
(профиль бюджета `escalation`): иначе он оборвался бы на середине, сжёг вызовы и ничего не
дал — и так по кругу при каждом освобождении окна.
"""
from __future__ import annotations

import calendar
import datetime as dt
import json
import re
import time
from dataclasses import dataclass, field

import queue_control
from cloud import day_start

ESCALATION_PROFILE = "escalation"      # профиль бюджета: max_calls_per_run_by_profile.escalation
STATE_KEY = "cloud.escalation"         # council_state: пауза облака после отказа всех провайдеров

QUOTA, OVERLOAD, DOWN = "quota", "overload", "down"
NO_KEY, CONFIG, DISABLED = "no_key", "config", "disabled"
RUN_CAP, MODEL = "run_cap", "model"
# Провайдер жив, плохой ответ модели — не повод менять провайдера или откладывать прогон:
# такой ответ обрабатывается протоколом, как молчание локальной модели.
NOT_AVAILABILITY = {RUN_CAP, MODEL}
KIND_RU = {QUOTA: "квота/токены кончились", OVERLOAD: "перегружен", DOWN: "недоступен (сеть)",
           NO_KEY: "нет ключа/доступа", CONFIG: "ошибка конфигурации", DISABLED: "облако выключено",
           RUN_CAP: "потолок вызовов на прогон", MODEL: "плохой ответ модели"}

_RESET_AT = re.compile(r"(?:reset_at=|reset at\s+)(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})", re.I)
_RETRY_AFTER = re.compile(r"retry_after=(\d+)", re.I)
_RETRY_IN = re.compile(r"retry in\s+([\d.]+)\s*s", re.I)
_RETRY_DELAY = re.compile(r'"retryDelay"\s*:\s*"(\d+)(?:\.\d+)?s"', re.I)
_HTTP = re.compile(r"http (\d{3})", re.I)


@dataclass
class Failure:
    provider: str
    model: str
    kind: str
    reset_at: float | None
    error: str

    def as_dict(self) -> dict:
        return {"provider": self.provider, "model": self.model, "kind": self.kind,
                "reset_at": int(self.reset_at) if self.reset_at else None,
                "error": (self.error or "")[:300]}


class CloudUnavailable(Exception):
    """Все провайдеры отказали по доступности. Прогон возвращается на место в очереди."""

    def __init__(self, failures: list[Failure]):
        self.failures = failures
        super().__init__("; ".join(f"{f.provider}/{f.model}: {KIND_RU.get(f.kind, f.kind)}"
                                   for f in failures) or "облако недоступно")


@dataclass
class Decision:
    retry_at: int
    kind: str
    why: str
    probes: list[dict] = field(default_factory=list)


# ── классификация отказа ────────────────────────────────────────────────────
def classify(error: str) -> str:
    """Класс отказа по тексту ошибки CloudClient: локальные стопы бюджета (check_budget,
    available) и ответы провайдеров (_post) пишутся человеческими фразами — их и разбираем."""
    low = (error or "").lower()
    if not low.strip():
        return DOWN
    if "лимит облачных вызовов на прогон" in low:
        return RUN_CAP
    if "облако выключено" in low or "вызовы запрещены" in low:
        return DISABLED
    if "не объявлена ни в одном провайдере" in low:
        return CONFIG
    if ("исчерпано окно плана" in low or "исчерпан суточный" in low or "лимит частоты" in low
            or "оценочно стоит" in low):
        return QUOTA
    if "не распарсился" in low or "лимит на reasoning" in low:
        return MODEL
    if "нет ключа" in low:
        return NO_KEY
    if "кэш-маркер сбоя" in low or "сеть/" in low:
        return DOWN
    # ИИ-шлюз продукта (провайдер gateway): «не настроен» и «нет маршрута профиля» — 503, но это конфигурация
    # внутренней компании, а не перегрузка; ожиданием 5 минут не лечится. Суточный лимит шлюза — 429, квота.
    if "executive_gateway_not_configured" in low or "executive_gateway_route_not_configured" in low:
        return CONFIG
    if "executive_gateway_daily_limit" in low:
        return QUOTA
    # OpenRouter через шлюз: дневной лимит бесплатных моделей — квота до сброса, а не перегрузка; «Too Many Requests»
    # в тексте иначе отправил бы его в OVERLOAD и повтор через 5 минут весь день (ревью «Контроля» #349). Поминутный
    # лимит (free-models-per-min) — перегрузка, как раньше.
    if "free-models-per-day" in low:
        return QUOTA
    if any(s in low for s in ("overload", "try again later", "перегруж", "too many requests",
                              "concurrency", "temporarily", "server busy", "unavailable",
                              '"1302"', '"1303"', '"1305"', '"1312"')):
        return OVERLOAD
    m = _HTTP.search(low)
    code = int(m.group(1)) if m else 0
    if any(s in low for s in ("квота", "quota", "usage limit", "limit will reset",
                              "insufficient balance", "pay-as-you-go", "resource_exhausted",
                              '"1308"', '"1310"', '"1113"', '"1304"')) or code == 429:
        return QUOTA
    if code >= 500:
        return OVERLOAD
    if code in (401, 403):
        return NO_KEY
    if code in (400, 404, 422):
        return CONFIG
    if "невалидный json от" in low:
        return OVERLOAD
    return DOWN


def _reset_candidates(stamp: str) -> list[float]:
    """Провайдер пишет время сброса без зоны (Z.AI 1308: «limit will reset at …»). Берём
    все правдоподобные прочтения — местное, UTC, UTC+8 — и самое раннее в будущем: ранний
    повтор стоит один отказной запрос (на квоте он не тарифицируется), поздний — часы простоя.
    Если прочтение было ранним, следующий отказ отбросит его как прошедшее."""
    try:
        parsed = dt.datetime.strptime(stamp.replace("T", " "), "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return []
    local = time.mktime(parsed.timetuple())
    utc = calendar.timegm(parsed.timetuple())
    return sorted({local, utc, utc - 8 * 3600})


def provider_reset(error: str, now: float | None = None) -> float | None:
    """Время сброса квоты из ответа провайдера: Retry-After, retryDelay Gemini, «reset at»."""
    now = now or time.time()
    text = error or ""
    for rx in (_RETRY_AFTER, _RETRY_DELAY, _RETRY_IN):
        m = rx.search(text)
        if m:
            return now + float(m.group(1))
    m = _RESET_AT.search(text)
    if m:
        future = [t for t in _reset_candidates(m.group(1)) if t > now]
        return future[0] if future else None
    return None


# ── эскалация ───────────────────────────────────────────────────────────────
class Escalation:
    def __init__(self, cfg, store, ollama_client, cloud_client, logger=None):
        node = cfg.get("models.cloud_escalation", {}) or {}
        self.cfg = cfg
        self.store = store
        self.ollama = ollama_client
        self.cloud = cloud_client
        self.log = logger or (lambda msg: None)
        self.enabled = bool(node.get("enabled", False)) and cloud_client is not None
        self.after = int(node.get("after_seconds", 7200))
        providers = list(node.get("providers") or [])
        known = list((cloud_client.providers if cloud_client else {}) or {})
        self.providers = [p for p in providers if p in known] or known
        self.models = node.get("models", {}) or {}
        self.quota_margin = int(node.get("quota_margin_seconds", 120))
        self.overload_retry = int(node.get("overload_retry_seconds", 300))
        self.unknown_retry = int(node.get("quota_unknown_retry_seconds", 3600))
        self.ok_retry = int(node.get("available_retry_seconds", 60))
        # Прогон, прерванный отказом облака, начинается заново, и уже потраченные вызовы
        # пропадают. Без предела задача гоняла бы облако по кругу: замер 2026-10-08 —
        # 33 вызова на одно ревью за 14 откладываний. После max_deferrals откладываний
        # подряд задача ждёт облако giveup_seconds (остальные задачи — как обычно).
        self.max_deferrals = int(node.get("max_deferrals", 3))
        self.giveup_seconds = int(node.get("giveup_seconds", 21600))
        # прогон текущий: выбранный провайдер и разжалованные (отказавшие в этом прогоне)
        self.provider = ""
        self.run_id = ""
        self.demoted: set[str] = set()

    # ── готовность ───────────────────────────────────────────────────────────
    def cooldown(self) -> dict | None:
        state = queue_control.get_state(self.store, STATE_KEY)
        if state and int(state.get("until") or 0) > time.time():
            return state
        return None

    def ready(self) -> bool:
        return bool(self.enabled and self.cloud.budget.enabled and self.providers
                    and self.cooldown() is None)

    # ── модели ───────────────────────────────────────────────────────────────
    def model_for(self, provider: str, slot: str) -> str:
        spec = self.models.get(provider) or {}
        model = spec.get(slot) or spec.get("default")
        if not model:
            models = (self.cloud.providers.get(provider) or {}).get("models") or []
            model = models[0] if models else ""
        return str(model)

    def heavy_slots(self, models: dict[str, str]) -> dict[str, str]:
        """{ключ: слот} того, что уходит в облако: только L-модели (сейчас не грузятся).
        embed не трогаем никогда — вектор облачной моделью несовместим с корпусом."""
        return {key: key for key, model in models.items()
                if key != "embed" and model and not self.cloud.provider_of(model)
                and self.ollama.is_large(model)}

    def need_calls(self) -> int:
        self.cloud.profile = ESCALATION_PROFILE
        return max(1, self.cloud.run_allowance())

    # ── бюджет окна ──────────────────────────────────────────────────────────
    def window_free_at(self, need: int) -> float:
        b = self.cloud.budget
        now_ts = time.time()
        rows = self.store.q("SELECT created_at FROM cloud_usage WHERE ok = 1 AND created_at >= ? "
                            "ORDER BY created_at", (int(now_ts) - b.window_hours * 3600,))
        excess = len(rows) + need - b.max_calls_per_window
        if excess <= 0 or not rows:
            return now_ts
        return float(rows[min(excess, len(rows)) - 1]["created_at"] + b.window_hours * 3600)

    def local_reset(self, error: str, provider: str, need: int = 1) -> float | None:
        """Когда отпустит собственный стоп бюджета (cloud.check_budget)."""
        low = (error or "").lower()
        if "окно плана" in low:
            return self.window_free_at(need)
        if "суточн" in low or "оценочно стоит" in low:
            return float(day_start() + 86400)
        m = re.search(r"за последние (\d+) мин", low)
        if m:
            minutes = int(m.group(1))
            row = self.store.q1("SELECT MIN(created_at) t FROM cloud_usage WHERE provider = ? "
                                "AND ok = 1 AND created_at >= ?",
                                (provider, int(time.time()) - minutes * 60)) or {}
            return float((row.get("t") or time.time()) + minutes * 60)
        return None

    def reset_for(self, error: str, provider: str, kind: str, need: int = 1) -> float | None:
        if kind != QUOTA:
            return None
        return self.local_reset(error, provider, need) or provider_reset(error)

    def budget_gap(self, need: int) -> Failure | None:
        """Хватит ли окна и суток на весь прогон. Общие на всех провайдеров — как и
        check_budget: переход на другой провайдер окно подписки не расширяет."""
        b = self.cloud.budget
        window, day = self.cloud.spent_in_window(), self.cloud.spent_today()
        if window["calls"] + need > b.max_calls_per_window:
            why = (f"исчерпано окно плана для прогона: {window['calls']}/{b.max_calls_per_window} "
                   f"за {b.window_hours} ч, прогону нужно до {need}")
            return Failure("*", "", QUOTA, self.window_free_at(need), why)
        if day["calls"] + need > b.max_calls_per_day:
            why = f"исчерпан суточный лимит для прогона: {day['calls']}/{b.max_calls_per_day}, нужно до {need}"
            return Failure("*", "", QUOTA, float(day_start() + 86400), why)
        return None

    # ── выбор провайдера ─────────────────────────────────────────────────────
    def choose(self, run_id: str, slots: dict[str, str]) -> tuple[str | None, dict[str, str], list[Failure]]:
        """slots {ключ: слот} → (провайдер, {ключ: облачная модель}, отказы). Провайдеры по
        порядку: первый, у которого все нужные модели доступны и проходят бюджет."""
        need = self.need_calls()
        gap = self.budget_gap(need)
        if gap is not None:
            return None, {}, [gap]
        failures: list[Failure] = []
        for provider in self.providers:
            mapping = {key: self.model_for(provider, slot) for key, slot in slots.items()}
            bad = None
            for model in sorted(set(mapping.values())):
                ok, why = self.cloud.available(model)
                if ok:
                    ok, why = self.cloud.check_budget(run_id, model)
                if not ok:
                    kind = classify(why)
                    bad = Failure(provider, model, kind, self.reset_for(why, provider, kind, need), why)
                    break
            if bad is None:
                return provider, mapping, failures
            failures.append(bad)
        return None, {}, failures

    def start(self, run_id: str, provider: str) -> "Escalation":
        self.run_id, self.provider, self.demoted = run_id, provider, set()
        self.cloud.profile = ESCALATION_PROFILE
        return self

    # ── вызов с переходом на другой провайдер ────────────────────────────────
    def chat(self, run_id: str, role: str, model: str, messages: list[dict], *,
             schema: dict | None = None, temperature: float = 0.2, slot: str = "",
             on_fail=None):
        """Облачный вызов роли. Провайдер отказал по доступности — тот же запрос следующему
        провайдеру (модель того же слота); отказавший разжалуется до конца прогона. Отказали
        все — CloudUnavailable: прогон уходит в очередь, частичный результат не пишется."""
        primary = self.cloud.provider_of(model)
        order = list(dict.fromkeys([primary] + self.providers))
        active = [p for p in order if p and p not in self.demoted] or [p for p in order if p]
        tried: list[Failure] = []
        seen: set[str] = set()
        for provider in active:
            m = model if provider == primary else self.model_for(provider, slot or "default")
            if not m or m in seen:
                continue
            seen.add(m)
            result = self.cloud.chat(run_id, role, m, messages, schema=schema,
                                     temperature=temperature, max_tokens=None)
            if not result.ok and "timed out" in (result.error or "").lower():
                # Таймаут длинной генерации — не «провайдер лежит», но CloudClient ставит
                # маркер сбоя на 5 мин, и весь прогон ушёл бы на другой провайдер или в
                # очередь (так и было: таймаут zai → gemini недоступен → прогон заново).
                # Один повтор тем же провайдером со снятым маркером.
                if callable(on_fail):
                    on_fail(m, result)
                self.cloud._down_until.pop(provider, None)
                self.log(f"    ↻ {role}: {provider}/{m} — таймаут ответа, повтор")
                result = self.cloud.chat(run_id, role, m, messages, schema=schema,
                                         temperature=temperature, max_tokens=None)
            if result.ok:
                if provider != primary:
                    self.log(f"    ↪ {role}: {primary} недоступен → {provider}/{m}")
                return result
            kind = classify(result.error)
            if kind in NOT_AVAILABILITY:
                return result
            tried.append(Failure(provider, m, kind, self.reset_for(result.error, provider, kind),
                                 result.error))
            self.demoted.add(provider)
            if callable(on_fail):
                on_fail(m, result)
        raise CloudUnavailable(tried)

    # ── проверка API и решение о повторе ─────────────────────────────────────
    def probe(self) -> list[dict]:
        """Живой пинг провайдеров по порядку до первого ответившего. Пинг идёт через тот же
        check_budget: при исчерпанном собственном окне запроса наружу нет вовсе. Отказной
        запрос (квота, перегрузка) провайдер не тарифицирует; успешный тратит один вызов —
        это цена знания, что сбой был разовым."""
        out: list[dict] = []
        self.cloud.profile = ESCALATION_PROFILE
        for provider in self.providers:
            model = self.model_for(provider, "default")
            if not model:
                out.append({"provider": provider, "ok": False, "kind": CONFIG,
                            "reset_at": None, "detail": "у провайдера нет моделей"})
                continue
            self.cloud._calls_this_run.pop("ping", None)   # потолок «на прогон» к пингу не относится
            ok, detail = self.cloud.ping(model)
            if ok:
                self.cloud._down_until.pop(provider, None)
                out.append({"provider": provider, "ok": True, "kind": "", "reset_at": None,
                            "detail": detail})
                break
            kind = classify(detail)
            out.append({"provider": provider, "ok": False, "kind": kind,
                        "reset_at": self.reset_for(detail, provider, kind), "detail": detail[:300]})
        return out

    def _retry_at(self, kind: str, reset_at: float | None, now_ts: float) -> float:
        if kind == QUOTA:
            return (reset_at + self.quota_margin) if reset_at else now_ts + self.unknown_retry
        if kind in (OVERLOAD, DOWN):
            return now_ts + self.overload_retry
        return now_ts + self.unknown_retry

    def decide(self, failures: list[Failure]) -> Decision:
        now_ts = time.time()
        gap = next((f for f in failures if f.provider == "*"), None)
        if gap is not None:
            # Окна не хватает на прогон: API даже не вызывался, пинговать нечего.
            retry = max(self._retry_at(QUOTA, gap.reset_at, now_ts), now_ts + 30)
            return Decision(int(retry), QUOTA, gap.error, [])
        probes = self.probe()
        options: list[tuple[float, str, str]] = []
        for p in probes:
            if p["ok"]:
                options.append((now_ts + self.ok_retry, "ok",
                                f"{p['provider']}: отвечает — сбой был разовым"))
            else:
                options.append((self._retry_at(p["kind"], p.get("reset_at"), now_ts), p["kind"],
                                f"{p['provider']}: {KIND_RU.get(p['kind'], p['kind'])} — "
                                f"{(p.get('detail') or '')[:140]}"))
        if not options:
            options = [(now_ts + self.overload_retry, DOWN, "нет провайдеров для проверки")]
        retry, kind, _ = min(options, key=lambda o: o[0])
        why = "; ".join(o[2] for o in options)
        return Decision(int(max(retry, now_ts + 30)), kind, why, probes)

    # ── очередь ──────────────────────────────────────────────────────────────
    def claim(self, table: str, worker: str, profiles: list[str]) -> dict | None:
        """Атомарный захват задачи, которая ждёт памяти дольше порога, — только среди
        профилей, заблокированных ПРЯМО СЕЙЧАС (память вернулась — идём локально)."""
        if not profiles or table not in ("runs", "review_runs"):
            return None
        ts = int(time.time())
        col = "profile" if table == "runs" else "COALESCE(profile_id, '')"
        marks = ", ".join("?" for _ in profiles)
        # Задача «только для GLM 5.x» не эскалируется в другого провайдера — она ждёт GLM (вторая очередь).
        import glm_mode  # noqa: PLC0415
        not_glm = ("COALESCE(cloud_mode, '') != 'glm5'" if table == "runs"
                   else f"NOT ({glm_mode.REVIEW_REQUESTED_SQL})")
        conn = self.store.conn
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                f"SELECT id FROM {table} WHERE status = 'queued' AND mem_wait_since IS NOT NULL "
                f"AND mem_wait_since <= ? AND (cloud_retry_at IS NULL OR cloud_retry_at <= ?) "
                f"AND (not_before IS NULL OR not_before <= ?) AND {col} IN ({marks}) AND {not_glm} "
                f"ORDER BY priority DESC, created_at LIMIT 1",
                (ts - self.after, ts, ts, *profiles)).fetchone()
            if row is None:
                conn.execute("COMMIT")
                return None
            extra = ", claimed_at = ?" if table == "runs" else ""
            params = (worker, ts, ts) + ((ts,) if extra else ()) + (row["id"],)
            conn.execute(f"UPDATE {table} SET status='running', claimed_by=?, heartbeat_at=?, "
                         f"started_at=COALESCE(started_at, ?), attempts=attempts+1{extra} "
                         f"WHERE id = ?", params)
            conn.execute("COMMIT")
        except Exception:                                          # noqa: BLE001
            try:
                conn.execute("ROLLBACK")
            except Exception:                                      # noqa: BLE001
                pass
            return None
        return self.store.q1(f"SELECT * FROM {table} WHERE id = ?", (row["id"],))

    def _escalation_json(self, table: str, run_id: str) -> dict:
        row = self.store.q1(f"SELECT escalation FROM {table} WHERE id = ?", (run_id,)) or {}
        try:
            return json.loads(row.get("escalation") or "{}") or {}
        except (TypeError, ValueError):
            return {}

    def defer(self, table: str, run_id: str, failures: list[Failure]) -> Decision:
        """Облако недоступно: проверка API → повтор по ответу. Прогон — на прежнее место,
        без сожжённой попытки; облако на паузе для всей эскалации до того же времени."""
        decision = self.decide(failures)
        info = self._escalation_json(table, run_id)
        deferrals = int(info.get("deferrals") or 0) + 1
        spent = int(self.cloud._calls_this_run.get(run_id, 0))
        retry_at, state = decision.retry_at, "waiting_cloud"
        if deferrals >= self.max_deferrals:
            retry_at, state = max(retry_at, int(time.time()) + self.giveup_seconds), "gave_up"
        info.update({"state": state, "retry_at": retry_at,
                     "kind": decision.kind, "why": decision.why[:500], "deferrals": deferrals,
                     "calls_spent": int(info.get("calls_spent") or 0) + spent,
                     "failures": [f.as_dict() for f in failures][:6], "at": int(time.time())})
        if table == "review_runs":
            self.store.x("DELETE FROM review_steps WHERE run_id = ?", (run_id,))
        self.store.x(f"UPDATE {table} SET status='queued', claimed_by=NULL, started_at=NULL, "
                     f"attempts=MAX(attempts-1, 0), cloud_retry_at=?, escalation=?, error=? "
                     f"WHERE id = ?", (retry_at, json.dumps(info, ensure_ascii=False),
                                       decision.why[:500], run_id))
        self.cloud._calls_this_run.pop(run_id, None)
        queue_control.set_state(self.store, STATE_KEY, {
            "until": decision.retry_at, "kind": decision.kind, "why": decision.why[:500],
            "at": int(time.time())})
        when = time.strftime("%H:%M", time.localtime(decision.retry_at))
        self.store.event("cloud.deferred", run_id,
                         f"{KIND_RU.get(decision.kind, decision.kind)} → повтор в {when}: "
                         f"{decision.why[:200]}")
        self.log(f"    ⏸ облако недоступно ({KIND_RU.get(decision.kind, decision.kind)}) — "
                 f"повтор в {when}: {decision.why[:160]}")
        if state == "gave_up":
            until = time.strftime("%d.%m %H:%M", time.localtime(retry_at))
            self.store.event("cloud.gave_up", run_id, f"{deferrals} откладываний, потрачено "
                                                      f"{info['calls_spent']} вызовов → до {until}")
            self.log(f"    ⊘ облако для этой задачи отложено до {until}: {deferrals} откладываний "
                     f"подряд, потрачено {info['calls_spent']} вызовов")
        return decision

    def mark_done(self, table: str, run_id: str, provider: str, models: dict, waited_s: int) -> None:
        info = self._escalation_json(table, run_id)
        info.update({"state": "done", "provider": provider, "models": models,
                     "waited_s": int(waited_s), "at": int(time.time()),
                     "calls_spent": int(info.get("calls_spent") or 0)
                     + int(self.cloud._calls_this_run.get(run_id, 0))})
        self.store.x(f"UPDATE {table} SET escalation = ?, cloud_retry_at = NULL WHERE id = ?",
                     (json.dumps(info, ensure_ascii=False), run_id))
        queue_control.set_state(self.store, STATE_KEY, None)
        self.store.event("cloud.escalated", run_id,
                         f"{provider}: " + ", ".join(f"{k} {v.get('from')}→{v.get('to')}"
                                                     for k, v in models.items())[:250])
