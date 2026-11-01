#!/usr/bin/env python3
"""AI Council — самопроверка дрейфа M10 (облачный кластеризатор, docs/ai/COUNCIL-DRIFT-DESIGN.md §2). Только stdlib,
сети, облака и Ollama нет — подставные клиенты.

Вызывается из selftest.py: облако кластеризует не чаще раза в N ч и только при доступной квоте подписки; ответ облака
записывается так же, как локальный (тема отброшена, улики — только из входа); отказ облака — тот же проход уходит в
локальную модель и говорит почему; платный второй контур облачному кластеризатору не достаётся.
"""
from __future__ import annotations

import sqlite3
import sys
import time
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

CLUSTER = {"pattern": "Воздержание при расхождении файлов, хотя файл назван в постановке",
           "target": "mechanism", "suggestion": "раунд сверки до воздержания", "run_ids": ["r1", "r2"]}


class _Cfg:
    def __init__(self, **over):
        self.values = {"learning.rubric_drift_suggest_after": 2, "learning.cluster_model": "local-fake",
                       "learning.cluster_cloud_model": "glm-5", "learning.cluster_cloud_every_hours": 12}
        self.values.update(over)

    def get(self, key, default=None):
        return self.values.get(key, default)

    def roles(self, _profile):
        return {}


class _Cloud:
    """Облако подписки: available/quota_until/provider_of — как у cloud.CloudClient; chat — записывает вызов.
    refuse — отказ без запроса, как у chat() на отметке квоты или бюджете (0 мс, 0 токенов); on_available — вызвать
    один раз из available(): так второй проход вклинивается между «проверил» и «вызвал» первого."""

    def __init__(self, ok=True, available=(True, ""), quota_until=0.0, refuse="", on_available=None):
        self.ok, self._available, self._quota, self.refuse = ok, available, quota_until, refuse
        self.on_available = on_available
        self.calls: list[dict] = []

    def available(self, _model):
        hook, self.on_available = self.on_available, None
        if hook:
            hook()
        return self._available

    def provider_of(self, _model):
        return "zai"

    def quota_until(self, _provider):
        return self._quota

    def chat(self, run_id, role, model, messages, **_kw):
        if self.refuse:
            return SimpleNamespace(ok=False, error=self.refuse, data=None, ms=0, tokens_in=0, tokens_out=0)
        self.calls.append({"run_id": run_id, "role": role, "model": model, "user": messages[-1]["content"]})
        if not self.ok:
            return SimpleNamespace(ok=False, error="HTTP 503", data=None, ms=1200, tokens_in=0, tokens_out=0)
        return SimpleNamespace(ok=True, error="", ms=900, tokens_in=4000, tokens_out=300, data={"clusters": [
            dict(CLUSTER),
            {"pattern": "Проблемы с качеством решений", "target": "prompts/arbiter", "suggestion": "думать лучше",
             "run_ids": ["r1", "r2"]},
        ]})


class _Local:
    def __init__(self):
        self.calls = 0

    def alive(self):
        return True

    def chat(self, _model, _messages, **_kw):
        self.calls += 1
        return SimpleNamespace(ok=True, error="", data={"clusters": [dict(CLUSTER)]})


def _seed(store, n: int = 2) -> None:
    for i in range(1, n + 1):
        rid = f"r{i}"
        store.x("INSERT INTO runs (id, card_id, status, outcome) VALUES (?, 'c', 'abstained', ?)",
                (rid, "модели поняли задачу по-разному (совпадение файлов 0.00 < 0.25)"))
        store.x("INSERT INTO verdicts (run_id, decision, comment, created_at) VALUES (?, 'reject', ?, 0)",
                (rid, "файл назван в постановке, расходиться не в чем " + "подробно " * 20))


def _due(check, learning_mod, queue_control, Store, tmp: Path) -> None:
    with Store(tmp / "m10-due.db") as store:
        due = learning_mod.cloud_cluster_due
        check("M10: модель облака не задана — облако не зовётся, причина названа",
              due(_Cfg(**{"learning.cluster_cloud_model": ""}), store, _Cloud())[0] == "")
        check("M10: пора и квота есть — облачная модель", due(_Cfg(), store, _Cloud()) == ("glm-5", ""))
        check("M10: квота подписки исчерпана — локально, с временем сброса",
              due(_Cfg(), store, _Cloud(quota_until=time.time() + 3600))[1].startswith("квота подписки исчерпана"))
        check("M10: облако недоступно — локально, причина клиента",
              due(_Cfg(), store, _Cloud(available=(False, "нет ключа для zai")))[1] == "нет ключа для zai")
        queue_control.set_state(store, learning_mod.CLUSTER_CLOUD_STATE, {"at": int(time.time()) - 3600})
        model, why = due(_Cfg(), store, _Cloud())
        check("M10: облако было час назад — не чаще раза в 12 ч", model == "" and "не чаще раза в 12" in why, why)
        model, _ = due(_Cfg(), store, _Cloud(), now_ts=time.time() + 12 * 3600)
        check("M10: через 12 ч — снова облако", model == "glm-5")
        queue_control.set_state(store, learning_mod.CLUSTER_CLOUD_STATE, None)
        model, why = due(_Cfg(**{"learning.cluster_cloud_every_hours": 0}), store, _Cloud())
        check("M10: период 0 — облако выключено, а не «раз в 12 ч» (ревью #325)", model == "" and "= 0" in why, why)
        for bad in (-1, "abc", None):
            model, why = due(_Cfg(**{"learning.cluster_cloud_every_hours": bad}), store, _Cloud())
            check(f"M10: период {bad!r} — облако не зовётся, причина названа", model == "" and "больше 0" in why, why)


def _flow(check, learning_mod, queue_control, Store, tmp: Path) -> None:
    with Store(tmp / "m10-cloud.db") as store:
        _seed(store)
        cloud, local = _Cloud(), _Local()
        res = learning_mod.cluster_reject_reasons(_Cfg(), store, client=local, cloud_client=cloud)
        rows = store.q("SELECT target, model FROM rubric_suggestions")
        state = queue_control.get_state(store, learning_mod.CLUSTER_CLOUD_STATE) or {}
        check("M10: кластеризует облако — тема отброшена, дефект записан с моделью облака, локальная не звалась",
              res.get("via") == "cloud" and res.get("skipped_generic") == 1 and local.calls == 0
              and [(r["target"], r["model"]) for r in rows] == [("mechanism", "glm-5")], f"{res} {rows}")
        check("M10: облачный вызов отмечен (время, модель, удача) — по отметке считается «раз в 12 ч»",
              state.get("model") == "glm-5" and state.get("ok") is True and state.get("at", 0) > 0, str(state))
        check("M10: облако видит исход прогона, вызов подписан run_id и ролью",
              cloud.calls and cloud.calls[0]["run_id"] == "learning-drift" and cloud.calls[0]["role"] == "cluster"
              and "исход: воздержание" in cloud.calls[0]["user"])
        # Отметка — «час назад»: перезапись на локальном проходе дала бы «сейчас» даже в ту же секунду.
        state = {**state, "at": state["at"] - 3600}
        queue_control.set_state(store, learning_mod.CLUSTER_CLOUD_STATE, state)
        again = learning_mod.cluster_reject_reasons(_Cfg(), store, client=local, cloud_client=cloud)
        built = []
        import cloud as cloud_mod
        original, cloud_mod.build = cloud_mod.build, lambda *_a, **_kw: built.append(1) or _Cloud()
        try:
            learning_mod.cluster_reject_reasons(_Cfg(), store, client=_Local())
        finally:
            cloud_mod.build = original
        check("M10: до 12 ч клиент облака даже не собирается (ключи не читаются каждые 30 мин)", built == [])
        check("M10: следующий проход в течение 12 ч — локальная модель, облако не тронуто, причина в сводке",
              again.get("via") == "local" and len(cloud.calls) == 1 and local.calls == 1
              and "не чаще раза в 12" in again.get("cloud_skipped", ""), str(again))
        after = queue_control.get_state(store, learning_mod.CLUSTER_CLOUD_STATE) or {}
        rows = store.q("SELECT cluster_key FROM rubric_suggestions")
        check("M10: локальные проходы отметку облака не двигают — «раз в 12 ч» считается от вызова облака (ревью #325)",
              after.get("at") == state.get("at") and after.get("ok") is True and len(rows) == 1, f"{after} {rows}")

    with Store(tmp / "m10-cloud-fail.db") as store:
        _seed(store)
        cloud, local = _Cloud(ok=False), _Local()
        res = learning_mod.cluster_reject_reasons(_Cfg(), store, client=local, cloud_client=cloud)
        state = queue_control.get_state(store, learning_mod.CLUSTER_CLOUD_STATE) or {}
        check("M10: облако отказало — тот же проход в локальной модели, отказ назван, попытка отмечена",
              res.get("ok") and res.get("via") == "local" and local.calls == 1 and len(cloud.calls) == 1
              and "не дало валидного ответа" in res.get("cloud_skipped", "") and state.get("ok") is False, f"{res} {state}")

    with Store(tmp / "m10-window.db") as store:
        _seed(store, 30)   # 30 длинных причин не влезают в окно локальной модели, в облачное — целиком
        cloud = _Cloud()
        res = learning_mod.cluster_reject_reasons(_Cfg(**{"models.num_ctx": 2048}), store, client=_Local(),
                                                  cloud_client=cloud)
        sent = cloud.calls[0]["user"] if cloud.calls else ""
        check("M10: облаку уходят все причины (окно glm-5), локальная обрезала бы по своему окну",
              res.get("via") == "cloud" and res.get("reasons_dropped_for_context") == 0
              and all(f"run_id=r{i} " in sent for i in range(1, 31)), str(res))


def _race(check, learning_mod, Store, tmp: Path) -> None:
    """Гонка «проверил → вызвал» (ревью #325, major): второй проход (ручной --once поверх планового) вклинивается
    после проверки первого и до его вызова — у второго своё соединение с той же базой, как у другого процесса."""
    path = tmp / "m10-race.db"
    with Store(path) as store:
        _seed(store)
        nested: list[dict] = []

        def second_pass():
            with Store(path) as other:
                nested.append(learning_mod.cluster_reject_reasons(_Cfg(), other, client=_Local(), cloud_client=cloud))

        cloud = _Cloud(on_available=second_pass)
        first = learning_mod.cluster_reject_reasons(_Cfg(), store, client=_Local(), cloud_client=cloud)
        check("M10: два прохода с перекрытием — облако позвано один раз, второй проход ушёл в локальную модель с причиной",
              len(cloud.calls) == 1 and bool(nested) and nested[0].get("via") == "cloud" and first.get("via") == "local"
              and "другой проход" in first.get("cloud_skipped", ""), f"{first} {nested}")


def _not_asked(check, learning_mod, queue_control, Store, tmp: Path) -> None:
    """Спросить было некого (отказ без запроса: отметка квоты, бюджет окна) — окно облака не израсходовано."""
    with Store(tmp / "m10-not-asked.db") as store:
        _seed(store)
        res = learning_mod.cluster_reject_reasons(_Cfg(), store, client=_Local(),
                                                  cloud_client=_Cloud(refuse="квота подписки zai исчерпана до 09:00"))
        state = queue_control.get_state(store, learning_mod.CLUSTER_CLOUD_STATE)
        check("M10: отказ без запроса — локальная модель, причина в сводке, отметки окна нет (ревью #325)",
              res.get("via") == "local" and state is None and "исчерпана" in res.get("cloud_skipped", ""), f"{res} {state}")
        check("M10: отказ без запроса подписан «не спрошено», а не «не дало валидного ответа» (живая проверка 23.10)",
              "не спрошено" in res.get("cloud_skipped", "")
              and "не дало валидного ответа" not in res.get("cloud_skipped", ""), res.get("cloud_skipped", ""))
        old = {"at": int(time.time()) - 13 * 3600, "model": "glm-5", "ok": True, "why": ""}
        queue_control.set_state(store, learning_mod.CLUSTER_CLOUD_STATE, old)
        learning_mod.cluster_reject_reasons(_Cfg(), store, client=_Local(), cloud_client=_Cloud(refuse="бюджет окна"))
        check("M10: отказ без запроса возвращает прежнюю отметку, а не стирает её",
              queue_control.get_state(store, learning_mod.CLUSTER_CLOUD_STATE) == old)
        cloud = _Cloud()
        res = learning_mod.cluster_reject_reasons(_Cfg(), store, client=_Local(), cloud_client=cloud)
        check("M10: следующий проход после отказа без запроса — снова облако", res.get("via") == "cloud"
              and len(cloud.calls) == 1, str(res))

    import cloud as cloud_mod
    with Store(tmp / "m10-off.db") as store:
        _seed(store)
        built = []
        original, cloud_mod.build = cloud_mod.build, lambda *_a, **_kw: built.append(1) or _Cloud()
        try:
            res = learning_mod.cluster_reject_reasons(_Cfg(**{"learning.cluster_cloud_every_hours": 0}), store,
                                                      client=_Local())
        finally:
            cloud_mod.build = original
        check("M10: период 0 — клиент облака не собирается, кластеризует локальная, причина «выключена»",
              built == [] and res.get("via") == "local" and "= 0" in res.get("cloud_skipped", ""), str(res))


class _RaisingCloud(_Cloud):
    """Облако, у которого chat() падает уже после заявки (обрыв, ошибка разбора) — с секретом в тексте исключения."""

    def chat(self, *_a, **_kw):
        raise ConnectionError("https://api.z.ai/v4 key=sk-SECRET-123 — обрыв")


class _BeginFails:
    """Соединение, на котором BEGIN IMMEDIATE падает (база консилиума занята); остальное — как у настоящего."""

    def __init__(self, real):
        self._real = real

    def execute(self, sql, *args):
        if sql.startswith("BEGIN IMMEDIATE"):
            raise sqlite3.OperationalError("database is locked")
        return self._real.execute(sql, *args)

    def __getattr__(self, name):
        return getattr(self._real, name)


def _cloud_failures(check, learning_mod, queue_control, Store, tmp: Path) -> None:
    """Сбой облачного пути не роняет локальную кластеризацию (ревью #325, major «ресурсы и квота»)."""
    import cloud as cloud_mod
    with Store(tmp / "m10-build-fails.db") as store:
        _seed(store)

        def broken_build(*_a, **_kw):
            raise RuntimeError("models.cloud: ключ sk-SECRET-123 не разобран")

        original, cloud_mod.build = cloud_mod.build, broken_build
        try:
            res = learning_mod.cluster_reject_reasons(_Cfg(), store, client=_Local())
        finally:
            cloud_mod.build = original
        why = res.get("cloud_skipped", "")
        check("M10: клиент облака не собрался — кластеризует локальная, в причине тип исключения без его текста",
              res.get("ok") and res.get("via") == "local" and "RuntimeError" in why and "SECRET" not in why, str(res))
        check("M10: сбой до заявки — отметки окна нет, следующий проход снова попробует облако",
              queue_control.get_state(store, learning_mod.CLUSTER_CLOUD_STATE) is None)

    with Store(tmp / "m10-chat-raises.db") as store:
        _seed(store)
        res = learning_mod.cluster_reject_reasons(_Cfg(), store, client=_Local(), cloud_client=_RaisingCloud())
        state = queue_control.get_state(store, learning_mod.CLUSTER_CLOUD_STATE) or {}
        why = res.get("cloud_skipped", "")
        check("M10: облако упало после заявки — кластеризует локальная, секрета в сводке нет, заявка держит окно",
              res.get("via") == "local" and "ConnectionError" in why and "SECRET" not in why
              and state.get("at", 0) > 0 and state.get("ok") is None, f"{res} {state}")
        cloud = _Cloud()
        again = learning_mod.cluster_reject_reasons(_Cfg(), store, client=_Local(), cloud_client=cloud)
        check("M10: после падения в окне облако не зовётся до конца окна", cloud.calls == []
              and "не чаще раза в 12" in again.get("cloud_skipped", ""), str(again))

    with Store(tmp / "m10-claim-db-error.db") as store:
        _seed(store)
        real = store.conn
        store.conn = _BeginFails(real)
        try:
            claim, why = learning_mod._claim_cloud_window(_Cfg(), store, "glm-5")
            cloud = _Cloud()
            res = learning_mod.cluster_reject_reasons(_Cfg(), store, client=_Local(), cloud_client=cloud)
        finally:
            store.conn = real
        check("M10: база не записала заявку — «ошибка базы консилиума», а не «окно занято другим проходом»",
              claim is None and "ошибка базы консилиума" in why and "другой проход" not in why, why)
        check("M10: без заявки облако не зовётся, кластеризует локальная с той же причиной",
              cloud.calls == [] and res.get("via") == "local"
              and "ошибка базы консилиума" in res.get("cloud_skipped", ""), str(res))


def _pass_log(check, learning_mod, Store, tmp: Path) -> None:
    """Проход обучения пишет в лог, кто кластеризовал и почему без облака — не только в возвращаемую сводку."""
    import contextlib
    import io
    drift = {"ok": True, "clustered": 4, "suggestions": 0, "via": "local", "model": "qwen2.5:7b", "reason": "",
             "cloud_skipped": "облако glm-5 не спрошено: исчерпано окно плана: 157/100 вызовов за последние 10 ч"}
    original = learning_mod.cluster_reject_reasons
    learning_mod.cluster_reject_reasons = lambda *_a, **_kw: dict(drift)
    try:
        with Store(tmp / "m10-pass-log.db") as store:
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                learning_mod.run_once(_Cfg(), store)
    finally:
        learning_mod.cluster_reject_reasons = original
    text = out.getvalue()
    check("M10: лог прохода — кто кластеризовал и почему без облака",
          "кластеризовала local (qwen2.5:7b)" in text and "без облака: облако glm-5 не спрошено" in text, text)


def _paid_contour(check, learning_mod, Store, tmp: Path) -> None:
    import cloud as cloud_mod
    original = cloud_mod.build
    cloud_mod.build = lambda _cfg, _store=None, _logger=None: SimpleNamespace(
        providers={"zai": {"models": ["glm-5"], "fallback": {"base_url": "https://paid", "key": "k"}}})
    try:
        with Store(tmp / "m10-paid.db") as store:
            client = learning_mod._cloud_cluster_client(_Cfg(), store)
        check("M10: второй (платный) контур облачному кластеризатору не достаётся — только подписка",
              client.providers["zai"]["fallback"] == {})
    finally:
        cloud_mod.build = original


def run(tmp: Path, check) -> None:
    import learning as learning_mod
    import queue_control
    from store import Store
    _due(check, learning_mod, queue_control, Store, tmp)
    _flow(check, learning_mod, queue_control, Store, tmp)
    _race(check, learning_mod, Store, tmp)
    _not_asked(check, learning_mod, queue_control, Store, tmp)
    _cloud_failures(check, learning_mod, queue_control, Store, tmp)
    _pass_log(check, learning_mod, Store, tmp)
    _paid_contour(check, learning_mod, Store, tmp)
