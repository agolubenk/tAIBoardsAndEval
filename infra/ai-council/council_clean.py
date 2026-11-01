"""ИИ-консилиум, дрейф рубрики M7 (2026-10-16): детерминированная чистка привязок и команды проверки до верификатора.

Маска вроде `apps/backend/**/*.spec.ts` — не путь. Верификатор не находил такого файла и засчитывал маску выдумкой с
правом вето («даже в самом чистом предложении N несуществующих ссылок»), хотя модель ничего не выдумала. Маски
снимаются с привязок (`touched.files`, файлы пунктов декомпозиции) до верификатора.

`verification_cmd` с pytest, jest или mocha при TS-файлах в apps/* и packages/* — команда не того монорепо: тесты TS
здесь идут через `turbo run test:run --filter=<пакет>` (у пакета без `test:run` — `typecheck`). Если затронут и Python,
исходная команда остаётся, turbo добавляется к ней. Снятое и заменённое уходит в removed_by_verifier: владелец видит,
что поправлено. Канон — docs/specs/ai-council.md §17.9.
"""
from __future__ import annotations

import json
import re
from functools import lru_cache

from verifier import REPO_ROOT

GLOB_RE = re.compile(r"[*?\[\]{}]")
FOREIGN_RUNNER_RE = re.compile(r"\b(pytest|jest|mocha)\b")
TS_RE = re.compile(r"\.(ts|tsx|mts|cts)$")
WORKSPACE_RE = re.compile(r"^(apps|packages)/([^/]+)/")


def _clean_ref(ref) -> str:
    return re.sub(r":\d+(-\d+)?$", "", str(ref or "").strip().strip("`'\"").lstrip("./"))


def is_mask(ref) -> bool:
    clean = _clean_ref(ref)
    return bool(clean) and bool(GLOB_RE.search(clean)) and not (REPO_ROOT / clean).exists()


def _files(payload: dict) -> list:
    touched = payload.get("touched") if isinstance(payload.get("touched"), dict) else {}
    out = list(touched.get("files") or [])
    for step in payload.get("decomposition") or []:
        if isinstance(step, dict):
            out += list(step.get("files") or [])
    return out


def strip_masks(payload: dict) -> list[str]:
    """Снять маски с привязок предложения или слияния (на месте). Возвращает снятые, без повторов."""
    removed: list[str] = []

    def keep(refs):
        kept = []
        for ref in refs or []:
            if is_mask(ref):
                if str(ref) not in removed:
                    removed.append(str(ref))
            else:
                kept.append(ref)
        return kept

    touched = payload.get("touched")
    if isinstance(touched, dict) and "files" in touched:
        touched["files"] = keep(touched.get("files"))
    for step in payload.get("decomposition") or []:
        if isinstance(step, dict) and "files" in step:
            step["files"] = keep(step.get("files"))
    return removed


@lru_cache(maxsize=64)
def _package(kind: str, name: str) -> tuple[str, frozenset]:
    """(имя пакета, его npm-скрипты) по apps/<name> или packages/<name>; ("", ∅) — не пакет монорепо."""
    try:
        data = json.loads((REPO_ROOT / kind / name / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return "", frozenset()
    return str(data.get("name") or ""), frozenset((data.get("scripts") or {}).keys())


def turbo_command(files) -> str:
    """turbo по пакетам затронутых TS-файлов: `test:run`, где он есть, иначе `typecheck`; "" — TS-пакетов нет."""
    by_task: dict[str, set[str]] = {}
    for ref in files:
        clean = _clean_ref(ref)
        match = WORKSPACE_RE.match(clean)
        if not (match and TS_RE.search(clean)):
            continue
        name, scripts = _package(match.group(1), match.group(2))
        task = "test:run" if "test:run" in scripts else "typecheck" if "typecheck" in scripts else ""
        if name and task:
            by_task.setdefault(task, set()).add(name)
    return " && ".join("turbo run " + task + "".join(f" --filter={n}" for n in sorted(names))
                       for task, names in sorted(by_task.items(), key=lambda kv: kv[0] != "test:run"))


def fix_verification_cmd(payload: dict) -> str:
    """pytest/jest/mocha при TS-файлах пакетов → turbo. Возвращает запись для removed_by_verifier или ""."""
    cmd = str(payload.get("verification_cmd") or "")
    if not FOREIGN_RUNNER_RE.search(cmd):
        return ""
    files = _files(payload)
    turbo = turbo_command(files)
    if not turbo:
        return ""
    has_python = any(_clean_ref(f).endswith(".py") for f in files)
    payload["verification_cmd"] = f"{cmd} && {turbo}" if has_python else turbo
    return f"verification_cmd: «{cmd[:120]}» → «{payload['verification_cmd'][:160]}»"


def clean_payload(payload) -> list[str]:
    """M7 целиком: маски, затем команда (по файлам уже без масок). Записи — для removed_by_verifier и лога."""
    if not isinstance(payload, dict):
        return []
    notes = [f"маска, не путь: {m}" for m in strip_masks(payload)]
    fixed = fix_verification_cmd(payload)
    return notes + ([fixed] if fixed else [])
