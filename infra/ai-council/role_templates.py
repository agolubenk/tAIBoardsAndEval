#!/usr/bin/env python3
"""AI Council — каталог шаблонов ролей и генератор наборов. Только stdlib.

Канон: docs/specs/ai-council.md §11 (новая секция).
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

PROMPTS = Path(__file__).resolve().parent / "prompts"


@dataclass
class RoleTemplate:
    """Шаблон набора ролей по типу задачи/домену."""
    id: str
    name: str
    description: str
    # Какие роли обязательны (proposer.code/arch/skeptic/arbiter/extractor/embed)
    required: tuple[str, ...]
    # Какие роли опциональны (extra по домену)
    optional: tuple[str, ...]
    # Какие типы задач применяются (tags)
    applicable_tags: tuple[str, ...]
    # Угол зрения (код/дизайн/arch/ops/uiux/...), влияет на промпты
    focus_angle: str
    # Количество ролей (для batch_by_role)
    count: int


ROLE_TEMPLATES: tuple[RoleTemplate, ...] = (
    # Код/инженеринг
    RoleTemplate(
        id="engineering",
        name="Инженеринг",
        description="Решения по коду, API, базе данных, интеграциям. Для бэкенда, фронтенда, мобильных приложений.",
        required=("proposer.code", "arbiter"),
        optional=("proposer.skeptic",),
        applicable_tags=("backend", "frontend", "mobile", "telegram", "extension", "api"),
        focus_angle="код",
        count=3,
    ),
    # Архитектура
    RoleTemplate(
        id="architecture",
        name="Архитектура",
        description="Решения о границах модулей, SOLID, связях, внешних интеграциях.",
        required=("proposer.arch", "arbiter"),
        optional=("proposer.skeptic",),
        applicable_tags=("backend", "frontend", "mobile", "api", "connect-rpc", "db-queues"),
        focus_angle="архитектура",
        count=3,
    ),
    # UX/UI
    RoleTemplate(
        id="ux-ui",
        name="UX/UI",
        description="Решения по дизайну интерфейсов, пользовательскому пути, доступности, мульти-платформенности.",
        required=("proposer.code", "arbiter"),
        optional=("proposer.skeptic", "proposer.arch"),
        applicable_tags=("ux", "frontend", "mobile", "accessibility"),
        focus_angle="дизайн",
        count=4,
    ),
    # Ops/DevOps
    RoleTemplate(
        id="ops",
        name="Ops & DevOps",
        description="Решения о CI/CD, Docker, Kubernetes, билдах, деплоях, мониторинге.",
        required=("proposer.code", "arbiter"),
        optional=("proposer.skeptic", "proposer.arch"),
        applicable_tags=("ops-ci", "docker", "k8s", "build"),
        focus_angle="ops",
        count=4,
    ),
    # Безопасность
    RoleTemplate(
        id="security",
        name="Безопасность",
        description="Решения по auth, RBAC, PII, инъекциям, SSRF, X",
        required=("proposer.code", "arbiter"),
        optional=("proposer.skeptic",),
        applicable_tags=("security-auth", "pii", "critical"),
        focus_angle="безопасность",
        count=3,
    ),
    # AI/ML
    RoleTemplate(
        id="ai-ml",
        name="AI & ML",
        description="Решения по моделям, интеграциям AI-агентов, MCP, индексам.",
        required=("proposer.code", "arbiter"),
        optional=("proposer.skeptic", "proposer.arch"),
        applicable_tags=("ai-tooling/mcp", "ai-agent", "rag", "embeddings"),
        focus_angle="ai",
        count=4,
    ),
)


def select_template(card: dict) -> RoleTemplate | None:
    """Выбор шаблона на основе метаданных карточки.

    Приоритет:
    1. modules — точное совпадение с applicable_tags (backend, frontend и т.д.)
    2. tags — частичное пересечение
    3. полнота modules+tags → первое совпадение
    """
    modules = set(str(m).lower() for m in (card.get("modules") or []) if str(m).strip())
    tags = set(str(t).lower() for t in (card.get("tags") or []) if str(t).strip())
    title_lower = str(card.get("title") or "").lower()
    body_lower = str(card.get("body") or "").lower()

    # 1. Точное совпадение по modules
    for template in ROLE_TEMPLATES:
        if template.applicable_tags and template.applicable_tags[0] in modules:
            return template

    # 2. Частичное пересечение
    for template in ROLE_TEMPLATES:
        if template.applicable_tags:
            intersection = modules & set(template.applicable_tags)
            if intersection:
                # Чем шире пересечение (побольше тегов), тем приоритетнее
                return template

    # 3. По tags (полезно для задач без явных модулей)
    for template in ROLE_TEMPLATES:
        if template.applicable_tags:
            intersection = tags & set(template.applicable_tags)
            if intersection:
                return template

    # 4. По ключевым словам в title/body
    keywords = {
        "ux", "ui", "дизайн", "интерфейс", "доступность", "a11y",
        "ops", "devops", "ci/cd", "deploy", "docker", "kubernetes",
        "security", "auth", "rbac", "pii", "csrf", "xss", "ssrf",
        "ai", "ml", "agent", "mcp", "integrations", "api",
    }
    combined = modules | tags | {kw for kw in keywords if kw in title_lower or kw in body_lower}
    for template in ROLE_TEMPLATES:
        if template.applicable_tags:
            intersection = combined & set(template.applicable_tags)
            if intersection:
                return template

    return None  # Нет подходящего шаблона


def build_roles_from_template(
    cfg, store, template: RoleTemplate, profile: str
) -> dict[str, str]:
    """Построить ростер ролей из шаблона, выбрав модели из конфига.

    Возвращает словарь {role_name: model_name}.
    """
    roles = cfg.roles(profile) if cfg else {}
    available_models = set(roles.values())

    # Базовый набор ролей
    base_roles = list(template.required)
    if template.optional:
        # Выбираем по количеству (batch_by_role) + углу (считается по наличию промпта)
        # Опциональные роли: designer, analyst, ops, security, ai-ml
        base_roles.extend(list(template.optional)[: template.count - len(base_roles)])

    # Для batch_by_role у нас один прокси для каждой роли
    role_map = {}
    model_pool = list(available_models)

    # Если нет достаточно моделей, используем fallback: первый доступный для всех proposer
    if len(model_pool) < template.count:
        # Удостоверься, что есть хотя бы 2 proposer'а (code и arch)
        proposer_models = set(roles.get(r, "") for r in base_roles if r.startswith("proposer."))
        if len(proposer_models) < 2:
            return {}

        model = list(proposer_models)[0]
        for role in base_roles:
            if role in role_map:
                continue
            role_map[role] = model
        return role_map

    # Прокси для batch_by_role: разные роли — разные "экземпляры" модели
    # но модель одна — это O(roles × batch_by_role) свопов вместо O(roles × batch_by_role × models)
    # Проверка: council_worker.py уже делает batch_by_role, а ollama.large_model() проверяет model в locks.
    # ОДНАКА: council_worker.py устанавливает council.cloud.profile = run["profile"]
    # но batch_by_role = true в config.toml, и ollama.large_model() использует model из roles.
    # Значит, batch_by_role = true позволяет СЕКУНДАРНО использовать одну модель для разных ролей.
    # Проблема: при batch_by_role каждая роль — это отдельный прокси, но модель одна.
    # ollama.large_model() проверяет model в locks, и если та же модель используется для другой роли,
    # это может быть проблемой: лока держится за ролью или за моделью?

    # Проверка кода: store.acquire_model_lock(holder, model) — лока по model.
    # Значит, если одна модель используется для разных ролей, это допустимо.
    # batch_by_role = true упрощает: разные роли — разные прокси, но модель одна.
    # council_worker.py делает batch_by_role и не проблема.

    for i, role in enumerate(base_roles):
        if role in role_map:
            continue
        model = model_pool[i % len(model_pool)]
        role_map[role] = model

    return role_map


def list_templates() -> list[dict]:
    """Список всех шаблонов в виде словарей для UI."""
    return [
        {
            "id": t.id,
            "name": t.name,
            "description": t.description,
            "required": list(t.required),
            "optional": list(t.optional),
            "applicable_tags": list(t.applicable_tags),
            "focus_angle": t.focus_angle,
            "count": t.count,
        }
        for t in ROLE_TEMPLATES
    ]
