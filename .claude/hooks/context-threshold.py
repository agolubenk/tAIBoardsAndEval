#!/usr/bin/env python3
"""
Порог наследника — PostToolUse hook (решение владельца 30.10: 80% окна).

Когда контекст сессии доходит до SUCCESSOR_THRESHOLD (0.8) окна сжатия, хук один раз вставляет в контекст
инструкцию: дописать шаг, записать work_state и handoff, открыть наследника в новом окне терминала
(spawn_session.sh — `supertick-eval/tools/` в инстансе HR, `eval/tools/` в каноническом доме) и остановиться после его подтверждения. На 84% — одно напоминание:
сжатие при окне 250K приходит на 213–221K (8 транскриптов 30.10), до 90% сессия не доживает.
Сжатие на 100% переписывает ≈ 100K и теряет детали; свежая сессия стартует с базы ≈ 55K + handoff.

Контекст = usage последнего ответа модели в транскрипте: input + cache_read + cache_creation + output.
Окно — `autoCompactWindow` из настроек проекта (settings.local.json, затем settings.json, затем
пользовательские), иначе 200 000; переопределение — SUCCESSOR_WINDOW_TOKENS. Выключить: SUCCESSOR_AUTO=off.

Цена: хук срабатывает на каждый вызов инструмента, поэтому транскрипт читается, только когда он вырос на
CHECK_EVERY_BYTES с прошлой проверки, и только хвост TAIL_BYTES. После сжатия или ручного /compact (контекст
ниже порога − RESET_GAP) уровни сбрасываются — порог снова сработает в той же сессии.

Параллельность: у каждой сессии свои файлы (`session/successor/<sid>.*`), общего read-modify-write нет.
Уровень занимается атомарно — маркер `<sid>.lvlN` через O_CREAT|O_EXCL: из параллельных вызовов одной сессии
печатает только тот, кто создал маркер.

Fail-safe: любая ошибка → пустой вывод, exit 0.
"""
import json
import os
import sys
import tempfile
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
STATE_DIR = Path(os.environ.get("SUCCESSOR_STATE_DIR") or REPO_ROOT / ".claude/memory/session/successor")
DEFAULT_WINDOW = 200_000  # без autoCompactWindow окно 200K: при 250K порог 80% совпал бы с самим сжатием
DEFAULT_THRESHOLD = 0.8
REMIND_AT = 0.84
RESET_GAP = 0.15  # контекст растёт до сжатия монотонно: падение ниже порога − 0.15 — это сжатие или /clear
CHECK_EVERY_BYTES = 24_000
TAIL_BYTES = 400_000
STATE_MAX_AGE_S = 3 * 86400


def _spawn_relpath() -> str:
    """Путь к spawn_session.sh относительно корня проекта: инстанс HR держит
    его в supertick-eval/, канонический дом продукта — в eval/."""
    for cand in ("supertick-eval/tools/spawn_session.sh", "eval/tools/spawn_session.sh"):
        if (REPO_ROOT / cand).exists():
            return cand
    return "eval/tools/spawn_session.sh"


SPAWN_CMD = f"bash {_spawn_relpath()} --handoff <файл>{{role_arg}}"

MESSAGE = (
    "<successor-threshold>Контекст ≈{pct}% окна ({used}K из {window}K), порог наследника {thr}% (решение "
    "владельца 30.10). Новых крупных шагов не начинай. По порядку:\n"
    "1) доведи текущий шаг до точки сохранения: WIP — коммитом в свою ветку, не в main;\n"
    "2) состояние: work_state_write (now / waiting / next / blockers); роль Т3 — ещё forest_set_work_state;\n"
    "3) handoff по скиллу successor-handoff в постоянный файл (не scratchpad): снимок на сейчас, ids — PR, "
    "ветка@голова, пункты очереди, карточки; команды прямо в тексте;\n"
    "4) наследник (если эта сессия его ещё не открыла — второго не открывай): "
    f"`{SPAWN_CMD}` из своей рабочей папки (наследник откроется в ней же; другая — `--cwd`) — новое окно Terminal с claude (без окна: `--terminal print` печатает команду);\n"
    "5) дождись от наследника подтверждения приёма (SendMessage), передай ему свои пункты очереди и остановись.\n"
    "Выключить: SUCCESSOR_AUTO=off.</successor-threshold>"
)
REMINDER = (
    "<successor-threshold>Контекст ≈{pct}% окна ({used}K из {window}K): сжатие близко. Если наследник ещё не "
    f"открыт — handoff и `{SPAWN_CMD}` из своей папки сейчас, "
    "до следующего шага.</successor-threshold>"
)


def window_tokens():
    env = os.environ.get("SUCCESSOR_WINDOW_TOKENS", "").strip()
    if env.isdigit() and int(env) > 0:
        return int(env)
    project = Path(os.environ.get("CLAUDE_PROJECT_DIR") or REPO_ROOT)
    for path in (project / ".claude/settings.local.json", project / ".claude/settings.json",
                 Path.home() / ".claude/settings.json"):
        try:
            value = json.loads(path.read_text(encoding="utf-8")).get("autoCompactWindow")
        except (OSError, ValueError, AttributeError):
            continue
        if isinstance(value, int) and value > 0:
            return value
    return DEFAULT_WINDOW


def threshold():
    try:
        value = float(os.environ.get("SUCCESSOR_THRESHOLD", DEFAULT_THRESHOLD))
    except ValueError:
        return DEFAULT_THRESHOLD
    return value if 0.1 <= value < 1.0 else DEFAULT_THRESHOLD


def last_context_tokens(transcript):
    """usage последнего ответа модели основной цепочки (не субагента) из хвоста транскрипта."""
    size = transcript.stat().st_size
    with transcript.open("rb") as fh:
        fh.seek(max(0, size - TAIL_BYTES))
        tail = fh.read().decode("utf-8", "ignore")
    for line in reversed(tail.splitlines()):
        if '"usage"' not in line:
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue  # первая строка хвоста обрезана
        if entry.get("type") != "assistant" or entry.get("isSidechain"):
            continue
        usage = (entry.get("message") or {}).get("usage") or {}
        total = sum(int(usage.get(k) or 0) for k in (
            "input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"))
        if total > 0:
            return total
    return None


def _safe_sid(session_id):
    return "".join(ch for ch in session_id if ch.isalnum() or ch in "-_")[:80]


def last_size(sid):
    try:
        return int((STATE_DIR / (sid + ".size")).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return 0


def save_size(sid, size):
    """Только подсказка «когда читать снова»: потеря записи при гонке стоит одной лишней проверки."""
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=STATE_DIR, prefix=sid + ".")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(str(size))
    os.replace(tmp, STATE_DIR / (sid + ".size"))


def current_level(sid):
    return max((n for n in (1, 2) if (STATE_DIR / ("%s.lvl%d" % (sid, n))).exists()), default=0)


def claim_level(sid, level):
    """True — этот вызов первым занял уровень и печатает; False — уровень уже занят другим вызовом."""
    try:
        os.close(os.open(STATE_DIR / ("%s.lvl%d" % (sid, level)), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600))
    except FileExistsError:
        return False
    if level == 2:  # 80% пропущен (сразу 85%+) — нижний уровень тоже занят, второго текста не будет
        try:
            os.close(os.open(STATE_DIR / ("%s.lvl1" % sid), os.O_CREAT | os.O_WRONLY, 0o600))
        except OSError:
            pass
    return True


def reset_levels(sid):
    for n in (1, 2):
        try:
            (STATE_DIR / ("%s.lvl%d" % (sid, n))).unlink()
        except FileNotFoundError:
            pass


def prune(now):
    try:
        for path in STATE_DIR.iterdir():
            if now - path.stat().st_mtime > STATE_MAX_AGE_S:
                path.unlink()
    except OSError:
        pass


def decide(used, window, thr, level):
    """(новый уровень, текст или None). Уровни: 0 — тихо, 1 — инструкция дана, 2 — напоминание дано."""
    share = used / window
    if share < max(0.1, thr - RESET_GAP):
        return 0, None
    if level < 1 and share >= thr:
        return (2 if share >= REMIND_AT else 1), MESSAGE
    if level == 1 and share >= REMIND_AT:
        return 2, REMINDER
    return level, None


def render(template, used, window, thr):
    role = os.environ.get("T3_ROLE_KEY", "").strip()
    return template.format(pct=round(used * 100 / window), used=used // 1000, window=window // 1000,
                           thr=round(thr * 100),
                           role_arg=(" --role " + role) if role else " [--role <ключ реестра> — роль Т3]")


def pipeline_on(name):
    """The product's switch (tAI-Boards → workspace settings → «Pipeline & evolution»); errors → on."""
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
        import pipeline_settings
        return pipeline_settings.enabled(name, refresh=False)
    except Exception:  # noqa: BLE001 — a hook never fails on settings
        return True


def main():
    if os.environ.get("SUCCESSOR_AUTO", "").lower() in ("off", "0", "false"):
        return
    payload = json.load(sys.stdin)
    sid = _safe_sid(payload.get("session_id") or "")
    transcript = Path(payload.get("transcript_path") or "")
    if not sid or not transcript.is_file():
        return
    size = transcript.stat().st_size
    if abs(size - last_size(sid)) < CHECK_EVERY_BYTES:
        return
    first_seen = not (STATE_DIR / (sid + ".size")).exists()
    save_size(sid, size)
    if first_seen:
        prune(time.time())
    # After the cheap exits, and from the cache only: this hook runs on every tool call; the prompt hook refreshes.
    if not pipeline_on("successorAuto"):
        return
    used = last_context_tokens(transcript)
    if used is None:
        return
    window, thr = window_tokens(), threshold()
    level = current_level(sid)
    new_level, template = decide(used, window, thr, level)
    if new_level == 0 and level:
        reset_levels(sid)
    if template and claim_level(sid, new_level):
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": render(template, used, window, thr),
        }}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass  # fail-safe: порог — подсказка, а не гейт
    sys.exit(0)
