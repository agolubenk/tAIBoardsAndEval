#!/usr/bin/env python3
"""AI Council — привязки «роль → модель» и «роль → промпт», библиотека промптов.

Настройки → «Модели и промпты» (gateway /api/bindings, /api/prompts). Только stdlib.

Где что живёт — и почему не в БД:
* роль → модель: `[models.roles.<профиль>]` config.toml — тот же источник, что читают все
  процессы (cfg.roles). Правка точечная, построчно, с сохранением комментариев (тот же
  приём, что gateway.update_setting): в файле записаны причины выбора моделей, и
  перезапись TOML целиком их бы стёрла. Применяется после перезапуска консилиума.
* роль → промпт: `[prompts.bindings]` config.toml; по умолчанию промпт = имя слота.
* тексты промптов: файлы prompts/<имя>.md — под git, так правка промпта видна в диффе и
  в prompt_shas прогона (провенанс обучения), а не теряется в БД.
* системные промпты ревью (review.*): файл, если есть, иначе встроенный текст
  review_prompts.py — «создать из стандартного» кладёт копию в prompts/.

Модель, не вписанная в [models.large], но тяжелее порога, считается L-тиром по факту
(ollama.is_large) — привязка в UI не обходит модельный лок.
"""
from __future__ import annotations

import hashlib
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROMPTS_DIR = HERE / "prompts"
CONFIG_PATH = HERE / "config.toml"

# Слоты промптов консилиума проработки: имя слота = имя, которое council.py передаёт в
# load_prompt. Подпись — для UI.
COUNCIL_PROMPT_SLOTS = {
    "proposer.code": "Предлагающий: код",
    "proposer.arch": "Предлагающий: архитектура",
    "proposer.skeptic": "Предлагающий: скептик",
    "half_baked": "Сырая идея (half-baked трек)",
    "critic": "Рецензент предложений",
    "arbiter": "Арбитр (слияние)",
    "adversary": "Атакующий (адверсариальная спираль)",
    "cloud_judge": "Облачный судья",
}
REVIEW_PROMPT_SLOTS = {
    "review.base": "Ревью: общие правила ревьюера",
    "review.judge": "Ревью: судья",
    "review.select": "Ревью: подбор состава моделью",
    "review.flavor.divergent": "Ревью: оттенок «дивергентное»",
    "review.flavor.cognitive": "Ревью: оттенок «когнитивное»",
    "review.flavor.test": "Ревью: оттенок «тест-ориентированное»",
}
PROFILES = ("fast", "deep", "hybrid", "cloud")
_NAME_RE = re.compile(r"^[a-z][a-z0-9_.-]{1,60}$")
_ROLE_RE = re.compile(r"^[a-z][a-z0-9_.]{1,40}$")
MAX_PROMPT_CHARS = 40_000


class BindingError(ValueError):
    pass


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


# ── промпты ─────────────────────────────────────────────────────────────────
def prompt_path(name: str) -> Path:
    if not _NAME_RE.match(name or "") or ".." in name:
        raise BindingError("имя промпта: латиница/цифры/._-, 2–61 символ, с буквы")
    return PROMPTS_DIR / f"{name}.md"


def review_default(slot: str) -> str:
    import review_prompts as rp
    return rp.DEFAULTS.get(slot, "")


def read_prompt(name: str) -> dict:
    path = prompt_path(name)
    exists = path.exists()
    text = path.read_text(encoding="utf-8") if exists else ""
    default = review_default(name) if name in REVIEW_PROMPT_SLOTS else ""
    return {"name": name, "exists": exists, "text": text or default, "is_default": not exists,
            "default": default, "sha": _sha(text) if exists else ""}


def write_prompt(name: str, text: str, create_only: bool = False) -> dict:
    path = prompt_path(name)
    text = (text or "").replace("\r\n", "\n").strip()
    if not text:
        raise BindingError("пустой промпт — удаление не делается из UI (файл под git)")
    if len(text) > MAX_PROMPT_CHARS:
        raise BindingError(f"промпт длиннее {MAX_PROMPT_CHARS} символов")
    if create_only and path.exists():
        raise BindingError(f"промпт «{name}» уже есть")
    path.write_text(text + "\n", encoding="utf-8")
    return read_prompt(name)


def list_prompts(cfg) -> list[dict]:
    bound = prompt_bindings(cfg)
    used: dict[str, list[str]] = {}
    for slot, name in bound.items():
        used.setdefault(name, []).append(slot)
    names = {p.stem for p in PROMPTS_DIR.glob("*.md")} | set(REVIEW_PROMPT_SLOTS)
    out = []
    for name in sorted(names):
        info = read_prompt(name)
        out.append({"name": name, "exists": info["exists"], "is_default": info["is_default"],
                    "sha": info["sha"], "chars": len(info["text"]),
                    "label": COUNCIL_PROMPT_SLOTS.get(name) or REVIEW_PROMPT_SLOTS.get(name, ""),
                    "used_by": sorted(used.get(name, []))})
    return out


def prompt_bindings(cfg) -> dict:
    """Слот → имя промпта. Незаданный слот = промпт с тем же именем."""
    raw = cfg.get("prompts.bindings", {}) or {}
    return {slot: str(raw.get(slot) or slot) for slot in COUNCIL_PROMPT_SLOTS}


# ── точечная правка config.toml ─────────────────────────────────────────────
def _key_re(key: str) -> re.Pattern:
    # ключ в TOML может быть голым (arbiter) или в кавычках ("proposer.code")
    return re.compile(rf'^(\s*)("?{re.escape(key)}"?)(\s*=\s*)("[^"]*"|\S+)(\s*(?:#.*)?)$')


def _render_key(key: str) -> str:
    return key if re.match(r"^[A-Za-z0-9_-]+$", key) else f'"{key}"'


def _edit_section(lines: list[str], section: str, key: str, value: str,
                  create: bool) -> tuple[list[str], str]:
    """Заменить key = "..." в [section] или (create) дописать в конец секции/файла.
    Возвращает (строки, прежнее значение)."""
    current, start, end = "", None, None
    for i, line in enumerate(lines):
        head = re.match(r"^\s*\[([^\]]+)\]\s*$", line)
        if head:
            if current == section and start is not None and end is None:
                end = i
            current = head.group(1).strip()
            if current == section:
                start = i
            continue
        if current == section:
            m = _key_re(key).match(line)
            if m:
                before = m.group(4).strip('"')
                lines[i] = f'{m.group(1)}{m.group(2)}{m.group(3)}"{value}"{m.group(5)}'
                return lines, before
    if not create:
        raise BindingError(f"в [{section}] нет ключа {key} — новые роли добавляются руками в config.toml")
    entry = f'{_render_key(key)} = "{value}"'
    if start is None:
        lines = lines + ["", f"[{section}]", entry]
    else:
        stop = end if end is not None else len(lines)
        insert_at = stop
        while insert_at - 1 > start and not lines[insert_at - 1].strip():
            insert_at -= 1
        lines = lines[:insert_at] + [entry] + lines[insert_at:]
    return lines, ""


def _apply(edit) -> dict:
    """Правка с проверкой: если после неё config.load(strict) не проходит — откат."""
    import config as config_mod
    original = CONFIG_PATH.read_text(encoding="utf-8")
    lines, before = edit(original.splitlines())
    CONFIG_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")
    try:
        config_mod.load(CONFIG_PATH, strict=True)
    except config_mod.ConfigError as exc:
        CONFIG_PATH.write_text(original, encoding="utf-8")
        raise BindingError(f"конфиг после правки не прошёл валидацию, откатил: {exc}") from exc
    return {"before": before}


def set_role_model(cfg, profile: str, role: str, model: str, available: set[str]) -> dict:
    if profile not in PROFILES:
        raise BindingError(f"профиль: одно из {PROFILES}")
    if not _ROLE_RE.match(role or ""):
        raise BindingError("роль: неверное имя")
    roster = cfg.get(f"models.roles.{profile}", {}) or {}
    if role not in roster:
        raise BindingError(f"в профиле {profile} нет роли {role}")
    model = (model or "").strip()
    if model not in available:
        raise BindingError(f"модели «{model}» нет ни в Ollama, ни в облачном ростере")
    res = _apply(lambda lines: _edit_section(lines, f"models.roles.{profile}", role, model, create=False))
    return {"ok": True, "profile": profile, "role": role, "model": model, **res}


def set_prompt_binding(cfg, slot: str, prompt: str) -> dict:
    if slot not in COUNCIL_PROMPT_SLOTS:
        raise BindingError(f"слот: одно из {', '.join(COUNCIL_PROMPT_SLOTS)}")
    prompt = (prompt or "").strip() or slot
    if not prompt_path(prompt).exists():
        raise BindingError(f"промпта «{prompt}» нет в prompts/")
    res = _apply(lambda lines: _edit_section(lines, "prompts.bindings", slot, prompt, create=True))
    return {"ok": True, "slot": slot, "prompt": prompt, **res}


def overview(cfg, installed: list[str], cloud: list[str], large) -> dict:
    """Всё для экрана «Модели и промпты» одним ответом."""
    profiles = {}
    roles: list[str] = []
    for profile in PROFILES:
        roster = cfg.get(f"models.roles.{profile}", {}) or {}
        profiles[profile] = dict(roster)
        roles += [r for r in roster if r not in roles]
    bound = prompt_bindings(cfg)
    return {
        "profiles": profiles, "roles": roles,
        "prompt_slots": [{"slot": s, "label": label, "prompt": bound[s]}
                         for s, label in COUNCIL_PROMPT_SLOTS.items()],
        "review_slots": [{"slot": s, "label": label} for s, label in REVIEW_PROMPT_SLOTS.items()],
        "prompts": list_prompts(cfg),
        "models": {"local": [{"name": m, "large": large(m)} for m in installed], "cloud": cloud},
        "config_path": str(CONFIG_PATH.relative_to(HERE.parent.parent)),
    }
