#!/usr/bin/env python3
"""AI Council — управление очередью: пауза, продолжение с того же места, возврат снятого,
подхват прогонов, оборванных рестартом. Только stdlib.

    python3 infra/ai-council/queue_control.py status
    python3 infra/ai-council/queue_control.py pause  [--batch <id>]
    python3 infra/ai-council/queue_control.py resume [--batch <id>] [--cancelled] [--expired]

Почему не «снять и поставить заново». Снятие (cancel) теряет позицию: новая постановка
идёт в хвост, без окна серии, а дубли по карточке молча отсекаются dedupe. Пауза здесь
ничего в очереди не трогает:

* глобальная пауза — флаг в council_state: воркер доделывает текущий прогон и перестаёт
  брать новые; очередь, приоритеты и порядок остаются как были, «продолжить» — снять флаг;
* пауза серии — queued → paused (воркер такие не берёт), продолжение — обратно в queued
  с прежними priority/created_at, то есть на то же место;
* возврат снятых/просроченных — только не начатых (started_at IS NULL) и только если по
  карточке нет другого живого прогона того же трека (тот же инвариант, что dedupe);
* осиротевшие running (воркер убит рестартом) возвращаются в очередь при старте воркера
  сразу, а не через 15 минут reap_stale.

Memory-guard (ollama.memory_check) блокирует ПРОФИЛЬ, а не очередь: прогоны профиля, чьей
L-модели некуда встать, остаются на своём месте, остальные идут. Это и есть фикс голодания
2026-10-06: пауза на каждый отказ морозила fast-прогоны на S-моделях за ревью на 30B.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from store import Store, now                             # noqa: E402

PAUSE_KEY = "queue.paused"
OWNER_CANCEL = "снято владельцем"
MEMORY_BLOCK_SECONDS = 120
# «Есть ли по карточке другой живой прогон того же трека» — тот же инвариант, что dedupe
# в store.enqueue. Снятое, которое владелец уже поставил заново, к возврату не считается.
ALIVE_ELSEWHERE = ("AND NOT EXISTS (SELECT 1 FROM runs o WHERE o.card_id = r.card_id "
                   "AND o.track = r.track AND o.id != r.id "
                   "AND o.status IN ('queued', 'running', 'paused'))")


# ── глобальная пауза ────────────────────────────────────────────────────────
def get_state(store: Store, key: str, default=None):
    row = store.q1("SELECT value FROM council_state WHERE key = ?", (key,))
    if not row:
        return default
    try:
        return json.loads(row["value"])
    except (TypeError, ValueError):
        return default


def set_state(store: Store, key: str, value) -> None:
    if value is None:
        store.x("DELETE FROM council_state WHERE key = ?", (key,))
        return
    store.x("INSERT INTO council_state (key, value, updated_at) VALUES (?,?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            (key, json.dumps(value, ensure_ascii=False), now()))


def is_paused(store: Store) -> dict | None:
    return get_state(store, PAUSE_KEY)


def pause(store: Store, batch_id: str = "", actor: str = "ui", reason: str = "") -> dict:
    if batch_id:
        n = store.x("UPDATE runs SET status='paused' WHERE status='queued' AND batch_id = ?",
                    (batch_id,)).rowcount
        store.event("queue.paused", batch_id, json.dumps({"runs": n, "by": actor}, ensure_ascii=False))
        return {"ok": True, "scope": "batch", "batch_id": batch_id, "paused": n}
    set_state(store, PAUSE_KEY, {"at": now(), "by": actor, "reason": reason[:300]})
    store.event("queue.paused", "", json.dumps({"by": actor, "reason": reason[:300]}, ensure_ascii=False))
    return {"ok": True, "scope": "all", "paused": True, "queued": _count(store, "queued")}


def resume(store: Store, batch_id: str = "", include_cancelled: bool = False,
           include_expired: bool = False, actor: str = "ui") -> dict:
    """Продолжить с того же места. Без batch_id — снимает глобальную паузу и возвращает
    ВСЕ paused-прогоны; снятые/просроченные — только с явными флагами."""
    out: dict = {"ok": True, "scope": "batch" if batch_id else "all"}
    where, params = ("AND batch_id = ?", (batch_id,)) if batch_id else ("", ())
    out["resumed"] = store.x(f"UPDATE runs SET status='queued' WHERE status='paused' {where}",
                             params).rowcount
    statuses = [s for s, on in (("cancelled", include_cancelled), ("expired", include_expired)) if on]
    out["restored"], out["skipped_duplicates"] = 0, 0
    if statuses:
        marks = ", ".join("?" for _ in statuses)
        rows = store.q(
            f"SELECT id, card_id, track, status FROM runs WHERE status IN ({marks}) "
            f"AND started_at IS NULL {where} ORDER BY priority DESC, created_at",
            tuple(statuses) + params)
        for r in rows:
            if r["status"] == "cancelled" and not _owner_cancelled(store, r["id"]):
                continue
            alive = store.q1("SELECT 1 FROM runs WHERE card_id = ? AND track = ? AND id != ? "
                             "AND status IN ('queued', 'running', 'paused')",
                             (r["card_id"], r["track"], r["id"]))
            if alive:
                out["skipped_duplicates"] += 1
                continue
            # Окно серии уже истекло — продолжение без окна, иначе claim_run снова снимет.
            store.x("UPDATE runs SET status='queued', outcome=NULL, finished_at=NULL, error=NULL, "
                    "expires_at=CASE WHEN expires_at < ? THEN NULL ELSE expires_at END WHERE id = ?",
                    (now(), r["id"]))
            out["restored"] += 1
    if not batch_id:
        set_state(store, PAUSE_KEY, None)
    store.event("queue.resumed", batch_id, json.dumps({**out, "by": actor}, ensure_ascii=False))
    out["queued"] = _count(store, "queued")
    return out


def _owner_cancelled(store: Store, run_id: str) -> bool:
    row = store.q1("SELECT outcome FROM runs WHERE id = ?", (run_id,))
    return bool(row and (row["outcome"] or "").startswith(("снято", "приостановлено")))


def _count(store: Store, status: str) -> int:
    return (store.q1("SELECT COUNT(*) n FROM runs WHERE status = ?", (status,)) or {}).get("n", 0)


def status(store: Store, after_seconds: int = 7200, escalation_enabled: bool = True) -> dict:
    by_status = {r["status"]: r["n"] for r in store.q("SELECT status, COUNT(*) n FROM runs GROUP BY status")}
    by_profile = store.q("SELECT profile, COUNT(*) n FROM runs WHERE status='queued' GROUP BY profile")
    review = {r["status"]: r["n"] for r in store.q("SELECT status, COUNT(*) n FROM review_runs GROUP BY status")}
    return {"paused": is_paused(store), "runs": by_status,
            "queued_by_profile": {r["profile"]: r["n"] for r in by_profile},
            "review": review, "memory_blocked": get_state(store, "memory.blocked", {}) or {},
            "resumable_cancelled": (store.q1(
                "SELECT COUNT(*) n FROM runs r WHERE r.status='cancelled' AND r.started_at IS NULL "
                "AND (r.outcome LIKE 'снято%' OR r.outcome LIKE 'приостановлено%') " + ALIVE_ELSEWHERE)
                or {}).get("n", 0),
            "escalation": escalation_status(store, after_seconds, escalation_enabled)}


# ── осиротевшие прогоны ─────────────────────────────────────────────────────
_PID_RE = re.compile(r"-p(\d+)$")


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def worker_id(prefix: str = "council") -> str:
    """pid в id воркера: по нему при старте отличаем осиротевший running от живого."""
    return f"{prefix}-{time.strftime('%H%M%S')}-p{os.getpid()}"


def recover_orphans(store: Store, me: str) -> dict:
    """running, чей воркер мёртв, — обратно в очередь на то же место (attempts не жжём:
    прогон не виноват, что его убил рестарт). Чужие running живых воркеров не трогаем — это и основной воркер,
    и облачные полосы (`--lane cloud`): pid есть в id у всех. Старые id без pid (до 2026-10-06) — осиротевшие."""
    out = {"runs": 0, "review_runs": 0}
    for table, key in (("runs", "runs"), ("review_runs", "review_runs")):
        for row in store.q(f"SELECT id, claimed_by FROM {table} WHERE status='running'"):
            holder = row["claimed_by"] or ""
            if holder == me:
                continue
            m = _PID_RE.search(holder)
            if m and _alive(int(m.group(1))):
                continue
            if table == "review_runs":
                store.x("DELETE FROM review_steps WHERE run_id = ?", (row["id"],))
            store.x(f"UPDATE {table} SET status='queued', claimed_by=NULL, started_at=NULL, "
                    f"attempts=MAX(attempts-1, 0) WHERE id = ? AND status='running'", (row["id"],))
            out[key] += 1
    # Отложенные старым memory-guard (до 2026-10-06) — на прежнее место, без not_before.
    out["undeferred"] = store.x(
        "UPDATE runs SET not_before=NULL, error=NULL WHERE status='queued' AND error LIKE 'нет памяти%'"
    ).rowcount
    out["undeferred"] += store.x(
        "UPDATE review_runs SET not_before=NULL, error=NULL WHERE status='queued' AND error LIKE 'нет памяти%'"
    ).rowcount
    if any(out.values()):
        store.event("queue.recovered", me, json.dumps(out))
    return out


# ── блокировка профилей по памяти ───────────────────────────────────────────
def _wait_target(kind: str) -> tuple[str, str]:
    return ("runs", "profile") if kind == "runs" else ("review_runs", "COALESCE(profile_id, '')")


def escalation_status(store: Store, after_seconds: int = 7200, enabled: bool = True) -> dict:
    """Сводка облачной эскалации для UI/MCP: сколько ждут памяти, сколько уже дольше
    порога, пауза облака после отказа провайдеров, сколько уже ушло в облако."""
    cutoff = now() - int(after_seconds)
    out: dict = {"enabled": bool(enabled), "after_seconds": int(after_seconds)}
    for table, key in (("runs", "runs"), ("review_runs", "reviews")):
        row = store.q1(
            f"SELECT SUM(CASE WHEN mem_wait_since IS NOT NULL THEN 1 ELSE 0 END) waiting, "
            f"SUM(CASE WHEN mem_wait_since IS NOT NULL AND mem_wait_since <= ? THEN 1 ELSE 0 END) due, "
            f"MIN(mem_wait_since) oldest FROM {table} WHERE status = 'queued'", (cutoff,)) or {}
        done = store.q1(f"SELECT COUNT(*) n FROM {table} WHERE escalation LIKE '%\"state\": \"done\"%'") or {}
        out[f"waiting_{key}"] = int(row.get("waiting") or 0)
        out[f"due_{key}"] = int(row.get("due") or 0)
        out[f"oldest_{key}"] = row.get("oldest")
        out[f"done_{key}"] = int(done.get("n") or 0)
    state = get_state(store, "cloud.escalation")
    out["cooldown"] = state if state and int(state.get("until") or 0) > now() else None
    return out


class MemoryBlocks:
    """Какие профили сейчас не грузятся. Живёт в воркере; зеркалится в council_state,
    чтобы UI/MCP видели, почему часть очереди стоит."""

    def __init__(self, store: Store, ttl: int = MEMORY_BLOCK_SECONDS):
        self.store = store
        self.ttl = ttl
        self.blocked: dict[str, dict] = {}       # "runs:deep" | "review:<profile_id>" → {until, why}

    def active(self, kind: str) -> list[str]:
        ts = time.time()
        return [k.split(":", 1)[1] for k, v in self.blocked.items()
                if k.startswith(kind + ":") and v["until"] > ts]

    def block(self, kind: str, name: str, why: str, label: str = "") -> bool:
        """True — новый эпизод (стоит залогировать), False — продление."""
        key = f"{kind}:{name}"
        fresh = key not in self.blocked
        self.blocked[key] = {"until": time.time() + self.ttl, "why": why[:300],
                             "label": label or name,
                             "since": self.blocked.get(key, {}).get("since", now())}
        self._mirror()
        # Стаж ожидания памяти — на каждой задаче профиля (облачная эскалация через N ч,
        # cloud_escalation.py). COALESCE: продление блокировки стаж не сбрасывает, а задачи,
        # поставленные уже во время блокировки, получают отметку при следующем продлении.
        table, col = _wait_target(kind)
        self.store.x(f"UPDATE {table} SET mem_wait_since = COALESCE(mem_wait_since, ?) "
                     f"WHERE status = 'queued' AND {col} = ?", (now(), name))
        if fresh:
            self.store.event("memory.blocked", key, why[:300])
        return fresh

    def clear(self, kind: str, name: str) -> bool:
        key = f"{kind}:{name}"
        # Память вернулась: задачи профиля больше не «ждут памяти» — пойдут локально,
        # бесплатно. Без условия на self.blocked: после рестарта воркера словарь пуст, а
        # стаж в БД остался бы и сработал бы при следующей блокировке как давний.
        table, col = _wait_target(kind)
        self.store.x(f"UPDATE {table} SET mem_wait_since = NULL, cloud_retry_at = NULL "
                     f"WHERE status = 'queued' AND {col} = ? AND mem_wait_since IS NOT NULL", (name,))
        if key in self.blocked:
            del self.blocked[key]
            self._mirror()
            self.store.event("memory.unblocked", key, "")
            return True
        return False

    def _mirror(self) -> None:
        set_state(self.store, "memory.blocked",
                  {k: {"why": v["why"], "since": v["since"], "label": v.get("label", "")}
                   for k, v in self.blocked.items()} or None)


def main() -> int:
    parser = argparse.ArgumentParser(description="AI Council — управление очередью")
    parser.add_argument("cmd", choices=["status", "pause", "resume"])
    parser.add_argument("--batch", default="")
    parser.add_argument("--cancelled", action="store_true", help="вернуть снятые владельцем, не начатые")
    parser.add_argument("--expired", action="store_true", help="вернуть просроченные по окну, не начатые")
    parser.add_argument("--reason", default="")
    parser.add_argument("--source", default="cli")
    args = parser.parse_args()
    with Store() as store:
        if args.cmd == "status":
            import config as config_mod
            cfg = config_mod.load(strict=False)
            res = status(store, int(cfg.get("models.cloud_escalation.after_seconds", 7200)),
                         bool(cfg.get("models.cloud_escalation.enabled", False)))
        elif args.cmd == "pause":
            res = pause(store, args.batch, args.source, args.reason)
        else:
            res = resume(store, args.batch, args.cancelled, args.expired, args.source)
    print(json.dumps(res, ensure_ascii=False, indent=1, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
