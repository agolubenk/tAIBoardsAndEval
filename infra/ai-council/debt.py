#!/usr/bin/env python3
"""AI Council — учёт и отработка долга моделей. Только stdlib.

Канон: docs/specs/ai-council.md §11 (новая секция).

Механизм:
- при невалидном JSON, таймауте, отказе модели → записывается delivery_failure в model_stats (β += 1)
- счётчик долга хранится в new колонке model_debt.balances (model, role, module) → ∆β
- модель в долге продолжает участвовать, но получает приоритетную нагрузку (больше служебных вызовов)
- до погашения долга модель не допускается к критическим функциям (например, referee в финале)

Применение:
- council.py council._ask() — проверка result.ok и JSON → если нет, запись в ledger
- council_worker.py process() — ловит TimeoutError и Exception → запись
- tournament.py — проверка model_debt перед выдачей ролей
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import config as config_mod
import learning as learning_mod
from store import Store, now, sha16

DEBT_KIND = "delivery_failure"


def has_debt(store: Store, model: str, role: str, module: str = "*") -> bool:
    """Модель имеет долг — хотя бы одна запись в ledger этого вида."""
    row = store.q1(
        "SELECT 1 FROM model_debt WHERE model = ? AND role = ? AND module = ?",
        (model, role, module),
    )
    return row is not None


def total_debt(store: Store, model: str, module: str = "*") -> int:
    """Суммарный долг модели по всем ролям в модуле."""
    rows = store.q(
        "SELECT SUM(delta) total FROM model_debt WHERE model = ? AND module = ?",
        (model, module),
    )
    if not rows:
        return 0
    total = rows[0].get("total", 0)
    return int(round(total, 0)) if total else 0


def is_over_debt_limit(store: Store, model: str, role: str, module: str = "*") -> bool:
    """Проверка порога: если долг выше 10, модель имеет ограничения."""
    return total_debt(store, model, module) >= 10


def record_failure(
    store: Store,
    model: str,
    role: str,
    module: str = "*",
    reason: str = "",
    run_id: str = "",
) -> None:
    """Записать неудачный вызов как долг.

    Идемпотентно через ledger.
    """
    if not model or not role:
        return

    ref = f"{DEBT_KIND}:{model}:{role}:{sha16(reason or '')[:12]}:{now()}"
    if store.q1("SELECT 1 FROM learning_ledger WHERE kind = ? AND ref = ?",
                (DEBT_KIND, ref)):
        return  # Уже записано

    # Увеличиваем β (неудача) для этой тройки
    learning_mod._bump(
        store, model, role, module, d_alpha=0.0, d_beta=1.0
    )

    # Записываем в ledger
    store.x(
        "INSERT INTO learning_ledger (kind, ref, run_id, applied_at) VALUES (?,?,?,?)",
        (DEBT_KIND, ref, run_id, now()),
    )

    # Записываем в model_debt (балансы)
    balance_row = store.q1(
        "SELECT current FROM model_debt WHERE model = ? AND role = ? AND module = ?",
        (model, role, module),
    )
    current = balance_row.get("current", 0) if balance_row else 0
    store.x(
        "INSERT INTO model_debt (model, role, module, current, delta, created_at) "
        "VALUES (?,?,?,?,?,?) ON CONFLICT(model, role, module) DO UPDATE SET "
        "current = current + excluded.delta, updated_at = excluded.updated_at",
        (model, role, module, current, 1, now()),
    )


def get_debt_summary(store: Store, module: str = "*") -> list[dict]:
    """Список всех моделей с их долгом для UI."""
    rows = store.q(
        f"SELECT model, role, module, current FROM model_debt WHERE module = ? ORDER BY model, role",
        (module,),
    )
    summary = []
    for row in rows:
        summary.append({
            "model": row["model"],
            "role": row["role"],
            "module": row["module"],
            "debt": int(row["current"]),
        })
    return summary


def apply_debt_priority(
    cfg: config_mod.Config,
    store: Store,
    model: str,
    role: str,
    module: str = "*",
    is_service: bool = False,
) -> int:
    """Проверить долг и вернуть приоритет.

    При наличии долга:
    - service-вызовы (extrator, embed, не proposer/arbiter) получают +1 приоритет (больше нагрузки)
    - proposer/arbiter получают -1 (не допускаются к критическим функциям)

    Возвращает:
    - 1 = повышенный приоритет (служебные вызовы)
    - -1 = пониженный (критические)
    - 0 = без изменений
    """
    if not has_debt(store, model, role, module):
        return 0

    if is_service:
        return 1  # Больше служебных вызовов

    # proposer/arch/skeptic/arbiter — критические роли, долг → ограничение
    if role.startswith("proposer.") or role == "arbiter":
        return -1

    return 0


def get_burdened_models(store: Store, module: str = "*") -> list[str]:
    """Список моделей с долгом для UI и для потенциального отключения."""
    rows = store.q(
        f"SELECT DISTINCT model FROM model_debt WHERE module = ?",
        (module,),
    )
    return [row["model"] for row in rows]


def cleanup_old_debt(store: Store, days: int = 30) -> int:
    """Очистить долг старше N дней."""
    cutoff = now() - (days * 24 * 60 * 60)
    cur = store.x(
        "DELETE FROM model_debt WHERE created_at < ?",
        (cutoff,),
    )
    return cur.rowcount or 0
