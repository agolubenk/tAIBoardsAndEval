#!/usr/bin/env python3
"""AI Council — состояние одного прогона ревью. Только stdlib.

Канон: docs/specs/ai-council.md §17, §17.5. Отделено от review_engine.py (исполнение
стадий): здесь — что известно о прогоне, там — кто и в каком порядке говорит.
"""
from __future__ import annotations

import time

import review_catalog as cat
import review_evidence as EV
from review_context import _git, build_dossier


class Cancelled(Exception):
    pass


class OutOfTime(Exception):
    pass


_TRACKED: tuple[float, set[str]] = (0.0, set())


def tracked_files() -> set[str]:
    """`git ls-files` раз в 10 минут: существование пути из ответа модели проверяется по
    списку, файл по такому пути не открывается никогда (review_evidence)."""
    global _TRACKED
    if time.time() - _TRACKED[0] > 600:
        _TRACKED = (time.time(), {ln for ln in _git("ls-files", timeout=20).splitlines() if ln})
    return _TRACKED[1]


def _norm(text: str) -> str:
    # 160, а не 80: разные находки с общим началом заголовка склеивались в одну при снятии.
    return EV.norm(text)[:160]


class _RunState:
    """Состояние одного прогона: выводы участников, находки (со стабильными F-id и опорой,
    посчитанной кодом), снятия, подтверждения, переписка агентов, трасса."""

    def __init__(self, engine, run_id: str, card: dict, plan: dict,
                 settings: dict, note: str, tracked: set[str] | None = None):
        self.e = engine
        self.run_id = run_id
        self.card = card
        self.plan = plan
        self.note = note
        self.deadline = time.time() + int(settings.get("max_wall_seconds") or 2400)
        self.latest: dict[str, dict] = {}        # голосующие участники → последний вывод
        self.history: dict[str, list[dict]] = {}  # агент → все его выводы (основание вето — по всем)
        self.extra_findings: list[dict] = []     # найденное оппонентом/напарником/консультантом
        self.refuted: dict[tuple, str] = {}      # (by, norm(title)) → причина снятия
        self.confirmed: dict[str, set] = {}      # F-id → кто, кроме автора, подтвердил
        self.disputed: dict[str, str] = {}       # F-id → кто оспорил во встречной проверке
        self.ids: dict[tuple, str] = {}          # (by, norm(title)) → стабильный F-id
        self.asks: list[tuple[str, dict]] = []   # вопросы коллегам, ждущие стадии consult
        self.consults: list[dict] = []
        self.adversary_out: list[dict] = []
        self.judge_out: dict | None = None
        self.rubric: dict[str, list] = {}
        self.trace: list[str] = []
        self.voters: list[str] = []
        self.skipped: list[str] = []
        self.policy: dict = {}
        self.tracked = tracked or set()
        self._dossiers: dict[int, tuple[str, dict]] = {}
        self._parsed: dict[int, EV.Dossier] = {}
        self._ann: dict[str, dict] = {}

    @classmethod
    def bare(cls, plan: dict, dossier: str = "", settings: dict | None = None) -> "_RunState":
        """Состояние без движка — для selftest и пересчёта вердиктов (review_stats.replay)."""
        st = cls(None, "", {}, plan, settings or {"max_wall_seconds": 2400}, "")
        st._dossiers[0] = (dossier, {})
        return st

    # ── досье и опора ────────────────────────────────────────────────────────
    def _bucket(self, agent_key: str) -> int:
        if self.e is None or agent_key not in self.plan.get("agents", {}):
            return max(self._dossiers) if self._dossiers else 0
        budget = self.plan["agents"][agent_key]["input_budget"]
        return max(1024, (budget // 1024) * 1024)

    def dossier(self, agent_key: str) -> str:
        bucket = self._bucket(agent_key)
        if bucket not in self._dossiers:
            ctx = self.plan["spec"].get("context") or cat.DEFAULT_CONTEXT
            self._dossiers[bucket] = build_dossier(self.card, ctx, bucket, self.e.retriever)
        return self._dossiers[bucket][0]

    def parsed(self, agent_key: str) -> EV.Dossier:
        """Опора находки считается по досье, которое видел её АВТОР."""
        if agent_key not in self.plan.get("agents", {}) and self._dossiers:
            bucket = max(self._dossiers)
        else:
            bucket = self._bucket(agent_key)
            if bucket not in self._dossiers:
                self.dossier(agent_key)
        if bucket not in self._parsed:
            self._parsed[bucket] = EV.parse(self._dossiers.get(bucket, ("", {}))[0])
        return self._parsed[bucket]

    def remaining(self) -> float:
        return self.deadline - time.time()

    def guard(self) -> None:
        if self.e is not None and not self.e.rs.heartbeat(self.run_id):
            raise Cancelled()
        if time.time() > self.deadline:
            raise OutOfTime()

    # ── вызов ────────────────────────────────────────────────────────────────
    def ask(self, stage_no: int, stage_type: str, key: str, system: str, user: str,
            schema: dict, call: dict | None = None, agent: dict | None = None) -> dict | None:
        self.guard()
        a = call or self.plan["agents"][key]
        out = self.e._call(self.run_id, stage_no, stage_type, key, a["model"], a, system, user, schema)
        return self.normalize(out, agent or self.plan["agents"].get(key) or {})

    @staticmethod
    def normalize(out: dict | None, agent: dict) -> dict | None:
        """Схема у облака не навязывается (cloud._finish только парсит JSON): важность и
        метку улики приводим к допустимым значениям; потолок важности агента — здесь."""
        if out is None:
            return None
        cap = agent.get("max_severity") or ""
        for field in ("findings", "new_findings"):
            items = out.get(field)
            if not isinstance(items, list):
                out[field] = [] if field in out else items
                continue
            clean = []
            for f in items:
                if not isinstance(f, dict) or not str(f.get("title") or "").strip():
                    continue
                sev = str(f.get("severity") or "").lower()
                sev = sev if sev in cat.SEVERITIES else "minor"
                if cap:
                    capped = EV.cap_severity(sev, cap)
                    if capped != sev:
                        f["severity_raw"] = sev
                    sev = capped
                kind = str(f.get("evidence_kind") or "").lower()
                f["severity"] = sev
                f["evidence_kind"] = kind if kind in ("hypothesis", "static", "observed") else ""
                clean.append(f)
            out[field] = clean
        return out

    def agent(self, key: str) -> dict:
        return self.plan["agents"][key]

    def vote(self, key: str, out: dict | None) -> None:
        if key not in self.voters:
            self.voters.append(key)
        if out is not None:
            self.latest[key] = out
            self.history.setdefault(key, []).append(out)
            for item in out.get("ask") or []:
                if isinstance(item, dict):
                    self.asks.append((key, item))

    # ── находки ──────────────────────────────────────────────────────────────
    def fid(self, by: str, title: str) -> str:
        key = (by, _norm(title))
        if key not in self.ids:
            self.ids[key] = f"F{len(self.ids) + 1}"
        return self.ids[key]

    def annotate(self, f: dict) -> dict:
        fid = f["id"]
        if fid not in self._ann:
            ann = EV.annotate(f, self.parsed(f.get("by") or ""), self.tracked)
            why = EV.contradicted_by_checks(f, self.parsed(f.get("by") or ""))
            if why:
                self.refuted.setdefault((f.get("by"), _norm(f.get("title"))), f"код: {why}")
            self._ann[fid] = {k: ann[k] for k in ("grounding", "grounding_why", "decisive")}
        return {**f, **self._ann[fid]}

    def _raw(self) -> list[dict]:
        items, seen = [], set()
        for key in self.voters:
            for f in (self.latest.get(key) or {}).get("findings") or []:
                items.append({"by": key, **f})
        items += [dict(f) for f in self.extra_findings]
        out = []
        for f in items:
            f["id"] = self.fid(f.get("by") or "", f.get("title") or "")
            if f["id"] in seen:
                continue
            seen.add(f["id"])
            out.append(f)
        return out

    def findings(self, include_refuted: bool = False) -> list[dict]:
        items = [self.annotate(f) for f in self._raw()]
        for f in items:
            reason = self.refuted.get((f.get("by"), _norm(f.get("title"))))
            f["refuted"] = bool(reason)
            if reason:
                f["refuted_reason"] = reason
            f["confirmed_by"] = sorted(self.confirmed.get(f["id"], ()))
            if f["id"] in self.disputed:
                f["disputed"] = self.disputed[f["id"]]
        return items if include_refuted else [f for f in items if not f["refuted"]]

    def authored(self, key: str) -> list[dict]:
        """Всё, что агент написал за прогон, включая снятое, — основание вето."""
        raw = [{"by": key, **f} for out in self.history.get(key, []) for f in out.get("findings") or []]
        raw += [dict(f) for f in self.extra_findings if f.get("by") == key]
        out = []
        for f in raw:
            f["id"] = self.fid(key, f.get("title") or "")
            out.append(self.annotate(f))
        return out

    def add_findings(self, by: str, items: list[dict], via: str = "",
                     author_agent: dict | None = None) -> list[str]:
        """Новые находки не-голосующего (оппонент, проверяющий пары, консультант). Выше
        major — только с опорой в изменённых строках: проверяющий пары писал critical, которые
        потом не проверял никто (60 из 68 critical-FAIL до §17.5)."""
        added = []
        known = {self.fid(f.get("by") or "", f.get("title") or "") for f in self._raw()}
        for f in self.normalize({"findings": list(items)}, author_agent or {}).get("findings") or []:
            item = {"by": by, **f, **({"via": via} if via else {})}
            item["id"] = self.fid(by, item.get("title") or "")
            if item["id"] in known:
                continue
            ground, _why = EV.ground(item, self.parsed(by), self.tracked)
            if item["severity"] == "critical" and ground != "patch":
                item["severity_raw"], item["severity"] = "critical", "major"
            known.add(item["id"])
            self.extra_findings.append({k: v for k, v in item.items() if k != "id"})
            added.append(item["id"])
        return added

    def apply_challenge(self, by: str, out: dict, listed: list[dict]) -> None:
        index = {f["id"]: f for f in listed}
        for item in out.get("refuted") or []:
            f = index.get(str((item or {}).get("id") or "").strip())
            if f:
                self.refuted[(f.get("by"), _norm(f.get("title")))] = f"{by}: {str(item.get('reason', ''))[:300]}"
        for raw in out.get("confirmed") or []:
            f = index.get(str(raw or "").strip())
            if f and f.get("by") != by:
                self.confirmed.setdefault(f["id"], set()).add(by)
        self.add_findings(by, out.get("new_findings") or [],
                          author_agent=self.plan["agents"].get(by))

    def result(self) -> dict:
        findings = self.findings(include_refuted=True)
        dossier = self.parsed(self.voters[0] if self.voters else "")
        return {
            "schema_version": 2,
            "votes": {k: {"vote": o.get("vote"), "confidence": o.get("confidence"),
                          "summary": o.get("summary"), "missing_evidence": o.get("missing_evidence"),
                          "acceptance": o.get("acceptance"), "test_scenarios": o.get("test_scenarios")}
                      for k, o in self.latest.items()},
            "voters": self.voters,
            "missing_voters": [k for k in self.voters if k not in self.latest],
            "findings": findings,
            "consults": self.consults,
            "checks_seen": dossier.checks,
            "policy": self.policy,
            "adversary": self.adversary_out,
            "judge": self.judge_out,
            "rubric": self.rubric,
            "trace": self.trace,
            "dossier": [meta for _t, meta in self._dossiers.values()],
        }
