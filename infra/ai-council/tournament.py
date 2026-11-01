#!/usr/bin/env python3
"""AI Council — турнир (цикличный адверсариальный отбор). Только stdlib.

Канон: docs/specs/ai-council.md §11 (новая секция).

Алгоритм:
1. После R2 (review) — набор approved proposals (score >= threshold).
2. Круги выбывания:
   - худшее решение выбывает
   - худшая модель выбывает
   - повторяем, пока не останется 3 решений
3. Строгий финал:
   - финалисты проходят через самого строгого судью (arbiter + skeptic)
   - оцениваются по критериям: человеческое использование, мульти-платформенность, браузерность, мобильный/desktop
4. Вывод — 3 финальных решения с provenance

Ограничения:
- физический лимит машины (24 GB) → только одна L-модель резидентно, остальные — облако
- бюджет облачных вызовов → max_calls_per_run
- debt → модели с долгом не допускаются к критическим ролям
"""
from __future__ import annotations

import json
import random
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from cloud import CloudQuotaWait  # noqa: E402
import config as config_mod
import debt as debt_mod
import learning as learning_mod
import textutil
from store import Store, now

PROMPTS = HERE / "prompts"


@dataclass
class TournamentRound:
    """Один круг выбывания."""
    round_no: int
    approved_proposals: list[dict]
    removed_solutions: list[dict]
    removed_models: list[str]
    scores_before: dict[str, float]
    scores_after: dict[str, float]
    elapsed_seconds: float


@dataclass
class StrictFinalReview:
    """Строгий финал."""
    round_no: int
    candidates: list[str]  # id предложений
    judges: list[dict]  # {role, model, score}
    scores: dict[str, dict]  # {proposal_id: {role: score}}
    elapsed_seconds: float
    final_results: list[dict]  # 3 финалиста с полными данными


@dataclass
class TournamentOutcome:
    """Результат турнира."""
    status: str  # "done" | "abstained" | "failed"
    reason: str
    final_proposals: list[dict]
    rounds: list[TournamentRound]
    final_review: StrictFinalReview | None
    eliminated_by_debt: list[str]  # модели, которые не допустились из-за долга
    explanation: str


def load_prompt(name: str) -> str:
    path = PROMPTS / f"{name}.md"
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def jaccard_scores(proposals: list[dict]) -> dict[str, set[str]]:
    """Jaccard по touched.files для всех предложений."""
    files = []
    for p in proposals:
        if not isinstance(p, dict):
            continue
        touched = p.get("touched") or {}
        if isinstance(touched, dict):
            for key in touched:
                for ref in touched.get(key) or []:
                    if isinstance(ref, str):
                        files.add(ref)
    # Превращаем в набор для каждого предложения
    proposal_files = {}
    for p in proposals:
        if not isinstance(p, dict):
            continue
        touched = p.get("touched") or {}
        if not isinstance(touched, dict):
            continue
        files_set = set()
        for key in touched:
            for ref in touched.get(key) or []:
                if isinstance(ref, str):
                    files_set.add(ref)
        proposal_files[p.get("id", "")] = files_set
    return proposal_files


def select_worst_solution(
    proposals: list[dict], scores: dict[str, float], threshold: float = 9.0
) -> dict | None:
    """Выбрать худшее одобренное решение.

    Критерии:
    - score < threshold (по умолчанию 9 из 15)
    - Jaccard с остальными (если мало одобренных)
    """
    approved = [
        p for p in proposals
        if isinstance(p, dict)
        and (scores.get(p.get("id", ""), 0.0) >= threshold or scores.get(p.get("id", ""), 0.0) == 0.0)
    ]

    if not approved:
        return None

    # Если меньше 2 одобренных — возвращаем худшее по score
    if len(approved) <= 2:
        return min(approved, key=lambda p: scores.get(p.get("id", ""), 0.0))

    # Jaccard: худшее решение — с наименьшим пересечением с остальными
    files_map = jaccard_scores(approved)
    proposal_ids = [p.get("id", "") for p in approved]

    # Для каждого предложения считаем Jaccard со всеми другими
    best_worst = None
    min_jaccard = 1.0

    for pid in proposal_ids:
        files = files_map.get(pid, set())
        other_files = set()
        for oid in proposal_ids:
            if oid != pid:
                other_files.update(files_map.get(oid, set()))

        if not files:
            jaccard = 0.0
        elif not other_files:
            jaccard = 1.0  # Единственное предложение
        else:
            jaccard = len(files & other_files) / len(files | other_files)

        if jaccard < min_jaccard:
            min_jaccard = jaccard
            best_worst = [p for p in approved if p.get("id") == pid][0]

    return best_worst


def select_worst_model(
    store: Store,
    cfg: config_mod.Config,
    proposals: list[dict],
    eligible_models: set[str],
) -> str | None:
    """Выбрать худшую модель по долгу.

    Критерий: модель с наибольшим долгом.
    """
    if not eligible_models:
        return None

    # Базовые роли: proposer.code/arch/skeptic/arbiter
    base_roles = ["proposer.code", "proposer.arch", "proposer.skeptic", "arbiter"]
    role_models = {}
    for p in proposals:
        if not isinstance(p, dict):
            continue
        role = p.get("role", "")
        model = p.get("model", "")
        if role in base_roles and model:
            role_models[role] = model

    # Если ролей мало, используем все модели из proposals
    if not role_models:
        for p in proposals:
            if not isinstance(p, dict):
                continue
            model = p.get("model", "")
            if model and model in eligible_models:
                role_models["proposer"] = model
                break

    # Оценка долга для каждой модели
    max_debt = -1
    worst_model = None
    module = "*"

    for role, model in role_models.items():
        debt = debt_mod.total_debt(store, model, module)
        if debt > max_debt:
            max_debt = debt
            worst_model = model

    # Если у всех нет долга — возвращаем None
    if max_debt <= 0:
        return None

    return worst_model


def round_elimination(
    run_id: str,
    cfg: config_mod.Config,
    store: Store,
    proposals: list[dict],
    eligible_models: set[str],
    capsule,
    roles: dict,
    round_no: int,
    deadline: float | None = None,
    threshold: float = 9.0,
) -> tuple[list[dict], list[dict], list[str]]:
    """Один круг выбывания.

    Возвращает:
    - approved_proposals (оставшиеся)
    - removed_solutions (выбывшие решения)
    - removed_models (выбывшие модели)
    """
    if not proposals:
        return [], [], []

    # 1. Оценка
    scores = {}
    for p in proposals:
        if not isinstance(p, dict):
            continue
        pid = p.get("id", "")
        score = p.get("review_score", 0.0)
        scores[pid] = score

    # 2. Удаление худшего решения
    worst_solution = select_worst_solution(proposals, scores, threshold)
    removed_solutions = []
    if worst_solution:
        removed_solutions.append(worst_solution)
        proposals = [p for p in proposals if p.get("id") != worst_solution.get("id")]

    # 3. Удаление худшей модели
    removed_models = []
    worst_model = select_worst_model(store, cfg, proposals, eligible_models)
    if worst_model:
        removed_models.append(worst_model)
        # Удаляем все предложения этой модели
        proposals = [p for p in proposals if p.get("model") != worst_model]

    # 4. Если осталось < 3 — останавливаем турнир
    if len(proposals) <= 3:
        return proposals, removed_solutions, removed_models

    return proposals, removed_solutions, removed_models


def strict_final_review(
    run_id: str,
    cfg: config_mod.Config,
    store: Store,
    candidates: list[dict],
    capsule,
    roles: dict,
    deadline: float | None = None,
) -> StrictFinalReview:
    """Строгий финал с самыми строгими судьями.

    Судьи:
    - arbiter (наивысший authority)
    - proposer.skeptic (критический угол)

    Критерии:
    - человеческое использование
    - мульти-платформенность
    - браузерность
    - мобильный/desktop варианты
    """
    if len(candidates) != 3:
        # Если не ровно 3 — используем все как кандидатов
        candidates = candidates[:3]

    prompt_name = "strict-final-judge"
    system = load_prompt(prompt_name)
    if not system:
        # Fallback: арбитр с усиленными требованиями
        system = load_prompt("arbiter")

    judges = []
    for i, role in enumerate(["arbiter", "proposer.skeptic"]):
        model = roles.get(role)
        if not model:
            continue
        judges.append({"role": role, "model": model})

    scores = {}
    for i, candidate in enumerate(candidates):
        pid = candidate.get("id", "")
        scores[pid] = {"scores": {}, "objections": []}

    # Каждый судья оценивает каждое предложение
    elapsed_seconds = 0.0
    start_time = time.time()

    for judge in judges:
        j_role = judge["role"]
        j_model = judge["model"]
        user = (
            f"ПОСТАНОВКА\n{capsule.pinned}\n\n"
            f"ФИНАЛЬНЫЕ КАНДИДАТЫ (СТРОГИЙ ФИНАЛ)\n"
            f"{json.dumps(candidates, ensure_ascii=False, indent=1)[:10000]}"
        )

        result = None
        if debt_mod.has_debt(store, j_model, j_role):
            # Модель в долгу — ставим 0 (не проходит)
            for pid in scores:
                scores[pid]["scores"][j_role] = 0.0
            continue

        try:
            result = cfg.council._ask(
                run_id, 6, f"judge.{j_role}", j_model, system, user,
                {"type": "object", "properties": {"scores": {"type": "object"}, "objections": {"type": "array"}}},
                temperature=0.1, max_tokens=1200,
                timeout=max(30, int(deadline - time.time()) if deadline else None)
            )
        except CloudQuotaWait:
            raise                      # квота подписки: прогон ждёт сброса, а не судит нулями
        except Exception as exc:
            # Ошибка вызова — 0
            for pid in scores:
                scores[pid]["scores"][j_role] = 0.0
            continue

        elapsed_seconds = time.time() - start_time

        if result and result.ok and isinstance(result.data, dict):
            review = result.data
            for pid in scores:
                scores[pid]["scores"][j_role] = review.get("scores", {}).get(j_role, 0.0)
                scores[pid]["objections"] = review.get("objections", [])

    final_results = []
    for pid, data in scores.items():
        if data["scores"].get("arbiter", 0.0) >= 12 and data["scores"].get("proposer.skeptic", 0.0) >= 12:
            # Выбираем кандидата с наибольшим средним
            avg_score = sum(data["scores"].values()) / len(data["scores"])
            final_results.append({
                "proposal_id": pid,
                "score": avg_score,
                "details": data,
            })

    # Если итогов меньше 3 — берём топ по score
    if len(final_results) < 3:
        final_results = sorted(final_results, key=lambda x: x["score"], reverse=True)[:3]

    return StrictFinalReview(
        round_no=6,
        candidates=[c.get("proposal_id", "") for c in final_results],
        judges=judges,
        scores={c.get("proposal_id", ""): c.get("details", {}) for c in final_results},
        elapsed_seconds=elapsed_seconds,
        final_results=[candidates[i] for i in range(min(3, len(candidates)))]
        if len(final_results) >= 3
        else final_results,
    )


class TournamentEngine:
    """Движок турнира."""

    def __init__(self, cfg: config_mod.Config, store: Store, council):
        self.cfg = cfg
        self.store = store
        self.council = council

    def run(
        self,
        run_id: str,
        capsule,
        proposals: list[dict],
        roles: dict,
        deadline: float | None = None,
        threshold: float = 9.0,
    ) -> TournamentOutcome:
        """Запустить турнир.

        Возвращает:
        - done: 3 финальных решения
        - abstained: худший по score
        - failed: ошибки/проблемы
        """
        rounds = []
        approved = proposals
        eligible_models = set(roles.values())
        round_no = 3

        while len(approved) > 3:
            # Проверка долга моделей перед кругом
            burdened = debt_mod.get_burdened_models(self.store)
            if burdened:
                # Модели в долгу не допускаются к критическим функциям
                # Оставляем только модели без долга
                approved = [p for p in approved if p.get("model") not in burdened]
                if len(approved) <= 3:
                    break

            round_start = time.time()
            approved, removed_solutions, removed_models = round_elimination(
                run_id, self.cfg, self.store, approved, eligible_models,
                capsule, roles, round_no, deadline, threshold,
            )
            elapsed = time.time() - round_start

            round_info = TournamentRound(
                round_no=round_no,
                approved_proposals=approved,
                removed_solutions=removed_solutions,
                removed_models=removed_models,
                scores_before={p.get("id", ""): p.get("review_score", 0.0) for p in proposals if p.get("id")},
                scores_after={p.get("id", ""): p.get("review_score", 0.0) for p in approved if p.get("id")},
                elapsed_seconds=elapsed,
            )
            rounds.append(round_info)

            if not approved or len(approved) <= 3:
                break

            round_no += 1
            if round_no > 5:
                # Ограничение на количество кругов
                break

        # Строгий финал
        final_review = None
        if len(approved) >= 3:
            final_review = strict_final_review(
                run_id, self.cfg, self.store, approved, capsule, roles, deadline,
            )

        # Формируем результат
        if not approved:
            return TournamentOutcome(
                status="abstained",
                reason="ни одно решение не прошло отбор (score < threshold)",
                final_proposals=[],
                rounds=rounds,
                final_review=final_review,
                eliminated_by_debt=[],
                explanation="ни одно одобренное решение не осталось после кругов выбывания",
            )

        if len(approved) < 3:
            return TournamentOutcome(
                status="abstained",
                reason=f"осталось только {len(approved)} решения после кругов выбывания",
                final_proposals=approved,
                rounds=rounds,
                final_review=final_review,
                eliminated_by_debt=[],
                explanation="не удалось набрать 3 финальных решения",
            )

        return TournamentOutcome(
            status="done",
            reason="",
            final_proposals=approved,
            rounds=rounds,
            final_review=final_review,
            eliminated_by_debt=[],
            explanation="турнир завершён успешно — 3 финальных решения",
        )
