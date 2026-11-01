#!/usr/bin/env python3
"""
DAMS Orchestrator — UserPromptSubmit hook.

Route (keyword-матчинг чанков из capital.json) → Expand (загрузка контента чанка)
→ RAG (FTS5-указатели, без тел документов) → Brief (GLM RU→EN структуризация
крупных новых задач) → инжекция через additionalContext.

Grill: каждой реплике, кроме явного продолжения («продолжай», «да», ответ с Q-ID,
отчёт субагента), добавляется подсказка <grill-task-auto> — начать задачу со скилла
grill-task. Окончательно «новая задача или продолжение» решает модель по SKILL.md;
хук ошибается в сторону подсказки (лишняя строка дешевле пропущенной прожарки).
Выключить: GRILL_AUTO=off.

Экономия токенов:
- системные уведомления (фоновая задача, отчёт субагента, сообщение другой сессии) не
  обрабатываются вовсе: они длинные, проходили порог брифинга и съедали его лимит — к середине
  сессии реплики владельца брифа уже не получали (2026-10-15: 8 из 8, ~5 — на уведомления);
- дедупликация в рамках сессии (state-файл): чанк/указатель инжектится один раз;
- L3 — только указатели (doc_id, title, path), детали Claude читает сам через
  Read или .claude/scripts/rag_query.py; у реплик короче BRIEF_MIN_CHARS — только при
  латинском идентификаторе или SHA в тексте: по русским алиасам и GLM-rewrite коротких реплик
  указатели почти всегда шли мимо (сессия 2026-10-15: «на каком этапе?» → маршруты hr-tasks/status);
- короткие реплики (<8 символов) не роутятся;
- task-brief — только для достаточно длинных промптов; его английские термины заодно уточняют
  L3-поиск (отдельного GLM-rewrite в хуке нет).

Дедлайн: вывод печатается один раз, в конце, а хук, не уложившийся в таймаут из
settings.json (15 с), убивается вместе со всем собранным — уже выбранные L2-чанки и
L3-указатели терялись вслед за медленным GLM (rewrite 12 с + brief 20 с > 15 с). Поэтому
весь хук укладывается в HOOK_DEADLINE_S: L2/L3 считаются всегда, единственный GLM-вызов —
брифинг (цепочка моделей внутри его бюджета) — ждётся не дольше остатка, вызов, который
заведомо не успеет, не запускается вовсе.

Fail-safe: любая ошибка → пустой вывод, exit 0 (промпт пользователя не блокируется).
"""
import json
import os
import re
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

L2_MAX_TOKENS = 4000   # бюджет на инжекцию чанков за один промпт
L2_MAX_CHUNKS = 3
L3_MAX_HITS = 5
BRIEF_MIN_CHARS = 280       # короче — почти наверняка не «новая большая задача»
BRIEF_MAX_PER_SESSION = 50  # предохранитель от зацикливания, не бюджет: бриф ~2 с и доли цента

# Общий дедлайн хука от старта main(): таймаут UserPromptSubmit в .claude/settings.json — 15 с,
# 3 с запаса — на старт интерпретатора и выход. Меняя одно, сверить с другим
# (test_user_prompt_deadline.py проверяет зазор).
HOOK_DEADLINE_S = 12.0
# Собственный потолок брифинга (дефолт glm_client — для осознанного MCP task_brief); фактический
# таймаут — min(свой, остаток бюджета), это общий бюджет цепочки glm-4.7-flash → glm-4.7.
BRIEF_TIMEOUT_S = 20
# Меньше этого остатка бриф не успеет (glm-4.7-flash ~2 с, ответ до 220 токенов) — не запускаем его.
BRIEF_MIN_BUDGET_S = 4.0
L3_RESERVE_S = 0.5  # FTS-поиск + лог запроса после брифинга (обычно миллисекунды)

# Продолжение = ВСЯ реплика: слово-продолжение + не больше 3 слов без глагола новой работы.
# «Давай сразу в мейн» — продолжение; «Давай добавим экспорт в Excel» — задача.
GRILL_CONT_MAX_TAIL = 3
GRILL_CONT_RE = re.compile(
    r"^(?:продолж|дальше|далее|законч|заверш|доделай|доделы|доведи|добей|допиш|да$|ок$|окей"
    r"|ok$|okay|ага|угу|yes|yep|go$|continue|finish|соглас|принят|принима|подтвер|верно"
    r"|хорошо|отлично|давай|вперед|вперёд|поехали|сливай|влей|вливай|мерж|merge|пуш|push"
    r"|закрыв|закрой|повтори|retry|готово)")
GRILL_TASK_VERB_RE = re.compile(
    r"^(?:сдела|добав|реализ|исправ|почин|созда|напиш|напис|удал|перенес|настро|поправ|измен"
    r"|убер|убра|переде|переписа|внедр|подключ|построй|сгенер|fix|add|implement|create|build"
    r"|make|write|remove|change|refactor)")
GRILL_ANSWER_RE = re.compile(r"^(?:[QD]-\d+|принимаю рекомендац|меняю D-)", re.I)
# Только в начале реплики: новая задача со вставленным логом, где встречается маркер, — всё ещё задача.
GRILL_SYSTEM_PREFIXES = ("<task-notification>", "[Subagent hand-back]", "<agent-message",
                         "[SYSTEM NOTIFICATION", "Another Claude session sent", "<cross-session-message",
                         "[Cross-session", "<teammate-message")
# Сообщение сессии в payload хука приходит не с тем началом, что в транскрипте (там — «Another Claude
# session sent…»): префикс не срабатывал, и 604 из 640 таких сообщений получали подсказку прожарки,
# 173 — чанки DAMS (замер 30.10). Тег ищем в начале реплики, а не только префиксом.
SYSTEM_MARKER_RE = re.compile(r"<cross-session-message\b|<teammate-message\b")
SYSTEM_MARKER_HEAD = 300
MISS_LOG_MAX = 256_000
GRILL_LEAD_PUNCT = " \t\r\n\"'«»“”„—–-.…,!?:;*>"
GRILL_HINT = (
    "<grill-task-auto>Новая задача → до работы режим auto скилла `grill-task` (Skill tool; уже "
    "загружен в сессии — не вызывай повторно). Не нужен: продолжение или правка текущей работы, "
    "ответ на твой вопрос, одобрение, вопрос без деливерабла.</grill-task-auto>")


def is_continuation(text):
    words = re.findall(r"[\w\-ёЁ]+", text.lower())
    if not words or not GRILL_CONT_RE.match(words[0]):
        return False
    tail = words[1:]
    return len(tail) <= GRILL_CONT_MAX_TAIL and not any(GRILL_TASK_VERB_RE.match(w) for w in tail)


def is_system_message(prompt):
    """Уведомление о фоновой задаче, отчёт субагента, сообщение другой сессии — не реплика пользователя."""
    head = prompt.lstrip()
    return head.startswith(GRILL_SYSTEM_PREFIXES) or bool(SYSTEM_MARKER_RE.search(head[:SYSTEM_MARKER_HEAD]))


def log_marker_miss(prompt):
    """Тег сессии дальше SYSTEM_MARKER_HEAD — одна строка в журнал: где он и чем начинается prompt.
    Так видно, почему фильтр не сработал, без транскрипта (до 30.10 причину гадали по нему)."""
    found = SYSTEM_MARKER_RE.search(prompt)
    if not found:
        return
    pos = found.start()
    try:
        log = Path(__file__).resolve().parents[1] / "memory/session/hook-marker-miss.log"
        if log.exists() and log.stat().st_size > MISS_LOG_MAX:
            log.replace(log.with_suffix(".log.1"))  # одна старая копия, журнал не растёт бесконечно
        with log.open("a", encoding="utf-8") as fh:
            fh.write("%s pos=%d head=%r\n" % (time.strftime("%Y-%m-%d %H:%M"), pos, prompt[:60]))
    except OSError:
        pass


def grill_hint(prompt):
    """Подсказка начать с grill-task, если реплика не явное продолжение (см. docstring модуля)."""
    if os.environ.get("GRILL_AUTO", "").lower() in ("off", "0", "false"):
        return None
    if is_system_message(prompt):
        return None
    text = prompt.lstrip(GRILL_LEAD_PUNCT)
    low = text.lower()
    if low.startswith("/") and not low.startswith("/grill-task"):
        return None  # пользователь выбрал другой скилл/команду явно
    if GRILL_ANSWER_RE.match(text):
        return None  # ответ в идущей прожарке
    if is_continuation(text):
        return None
    return GRILL_HINT


def emit(parts, extra=None):
    ctx = "<dams-context>\n%s\n</dams-context>" % "\n\n".join(parts) if parts else ""
    if extra:
        ctx = (ctx + "\n" + extra) if ctx else extra
    if ctx:
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "UserPromptSubmit",
                "additionalContext": ctx,
            }
        }, ensure_ascii=False))


# Порог L2 (30.10): одно совпадение подстроки грузило чужие чанки — «токенов» → arch-security (700 т),
# «очередь» → arch-db (800 т), «agentBy» → arch-agents. Теперь чанку нужно MIN_SCORE разных ключей
# либо один сильный (`!` в load_condition, узкий термин вроде `!prisma`); латинский ключ — с начала
# слова («ios» не в «scenarios»), русский — подстрокой (это основы: «токен», «ваканси»).
MIN_SCORE = 2
LATIN_KEY_RE = re.compile(r"^[a-z0-9][a-z0-9._$-]*$")


def keyword_hit(kw, text):
    if LATIN_KEY_RE.match(kw):
        return re.search(r"(?<![a-z0-9_])" + re.escape(kw), text) is not None
    return kw in text


def chunk_score(cond, text):
    """(число совпавших ключей, есть ли среди них сильный) для `task_contains:a|!b|…`."""
    hits, strong = 0, False
    for raw in cond[len("task_contains:"):].split("|"):
        kw = raw[1:] if raw.startswith("!") else raw
        if kw and keyword_hit(kw, text):
            hits += 1
            strong = strong or raw.startswith("!")
    return hits, strong


def own_session_latest(path, session_id):
    """latest.md пишет Stop-хук той сессии, что остановилась последней. Чужой итог — шум (30.10: сессия
    получила итог `77fe3a74`), поэтому файл годится только своей сессии."""
    try:
        head = path.read_text(encoding="utf-8").split("\n", 1)[0]
    except (OSError, UnicodeError):
        return False
    return bool(session_id) and session_id != "unknown" and head.rstrip().endswith("· " + session_id[:8])


def compacted_since(transcript, offset):
    """Было ли сжатие (`compact_boundary`) в транскрипте после байта `offset`. Свой latest.md нужен только
    первой реплике после сжатия: до него итог прошлого хода и так в контексте (ревью #450)."""
    try:
        size = transcript.stat().st_size
        with transcript.open("rb") as fh:
            fh.seek(max(offset, size - 2_000_000))
            return b'"compact_boundary"' in fh.read()
    except (OSError, TypeError):
        return False


def match_chunks(prompt, capital):
    prompt_lower = prompt.lower()
    matched = []
    for chunk in capital.get("chunks", []):
        if chunk.get("status") != "active":
            continue
        cond = chunk.get("load_condition", "")
        if cond == "always":
            matched.append((chunk, 999.0))
        elif cond.startswith("task_contains:"):
            hits, strong = chunk_score(cond, prompt_lower)
            if hits >= chunk.get("min_score", MIN_SCORE) or strong:
                matched.append((chunk, hits + chunk.get("relevance_boost", 0.0)))
    matched.sort(key=lambda x: (-x[1], x[0].get("token_estimate", 1000)))
    return [c for c, _ in matched]


def glm_call(name, prompt, until, own_timeout, min_budget):
    """glm_client.<name>(prompt) с ответом не позже `until` (time.monotonic()); иначе None.

    Таймаут вызова — min(собственный, остаток), но urllib считает его на каждую сокетную
    операцию (connect, TLS, чтение), а DNS-резолв не ограничивает вовсе: на плохой сети
    «12-секундный» вызов длится дольше. Жёсткая граница — join() фонового потока. Поток
    daemon и не из ThreadPoolExecutor: воркеры пула интерпретатор дожидается на выходе.
    Брошенный вызов досиживает в фоне, процесс завершает os._exit в __main__.
    """
    try:
        import glm_client
        fn = getattr(glm_client, name)
    except Exception:
        return None
    budget = min(own_timeout, until - time.monotonic())  # после импорта: он тоже из бюджета
    if budget < min_budget:
        return None
    box = []

    def run():
        try:
            box.append(fn(prompt, timeout=budget))
        except Exception:
            pass  # fail-safe, как и сам glm_client

    worker = threading.Thread(target=run, name="dams-glm-" + name, daemon=True)
    worker.start()
    worker.join(budget)
    return box[0] if box else None


def main():
    deadline = time.monotonic() + HOOK_DEADLINE_S
    import dams_common as dc

    payload = json.load(sys.stdin)
    prompt = (payload.get("prompt") or "").strip()
    session_id = payload.get("session_id") or "unknown"
    if len(prompt) < 8 or is_system_message(prompt):
        return  # системному уведомлению не нужны ни DAMS, ни подсказка прожарки
    log_marker_miss(prompt)
    grill = grill_hint(prompt)
    try:
        parts = dams_parts(dc, prompt, session_id, deadline, payload.get("transcript_path"))
    except Exception:
        parts = []  # сбой DAMS не должен съедать подсказку прожарки
    emit(parts, grill)


def l3_terms(dc, prompt, brief=None):
    """Поисковые термины L3. Пустой список — поиск не нужен.

    Короткая реплика без латинского идентификатора или SHA не ищется: её термины — русские алиасы
    вроде «этап» → stage, и указатели по ним почти всегда мимо (сессия 2026-10-15). Чисто русский
    длинный промпт получает английские термины из брифа.
    """
    if len(prompt) < BRIEF_MIN_CHARS and not dc.extract_search_terms(re.sub(r"[а-яёА-ЯЁ]+", " ", prompt)):
        return []
    terms = dc.extract_search_terms(prompt)
    if len(terms) < 2 and brief:
        brief_text = re.sub(r"\b(?:GOAL|CONSTRAINTS|ACCEPTANCE):|none stated", " ", brief)
        terms = (terms + [t for t in dc.extract_search_terms(brief_text) if t not in terms])[:8]
    return terms


def dams_parts(dc, prompt, session_id, deadline=None, transcript_path=None):
    if deadline is None:
        deadline = time.monotonic() + HOOK_DEADLINE_S
    try:
        capital = json.loads(dc.CAPITAL_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []

    state = dc.load_state()
    sess = state.setdefault(session_id, {"chunks": [], "rag": [], "briefs": 0})
    state[session_id] = state.pop(session_id)  # LRU: активную сессию не вытеснит прунинг
    parts = []
    want_brief = (os.environ.get("DAMS_TASK_BRIEF", "").lower() not in ("off", "0", "false")
                  and len(prompt) >= BRIEF_MIN_CHARS
                  and sess.get("briefs", 0) < BRIEF_MAX_PER_SESSION)

    # --- L2: чанки по keyword-роутингу (полный контент, с дедупом по сессии)
    budget = L2_MAX_TOKENS
    injected = 0
    for chunk in match_chunks(prompt, capital):
        if injected >= L2_MAX_CHUNKS or budget <= 0:
            break
        cid = chunk.get("id", "")
        if not cid:
            continue
        path = dc.REPO_ROOT / chunk.get("path", "")
        if cid == "session-latest":
            # не через общий дедуп: после каждого сжатия — заново, до первого сжатия — никогда
            transcript = Path(transcript_path) if transcript_path else None
            if not (transcript and own_session_latest(path, session_id)
                    and compacted_since(transcript, sess.get("latest_at", 0))):
                continue
            try:
                sess["latest_at"] = transcript.stat().st_size
            except OSError:
                continue
        elif cid in sess["chunks"]:
            continue
        try:
            content = path.read_text(encoding="utf-8").strip()
        except (OSError, UnicodeError):
            continue  # один битый чанк не должен отключать весь хук
        content = content[:18000]  # предохранитель: гигантский чанк не пробьёт бюджет
        est = dc.est_tokens(content)
        if est > budget and injected > 0:
            continue
        parts.append("<!-- DAMS chunk:%s v%s src:%s -->\n%s" % (
            cid, chunk.get("version", 1), chunk.get("provenance", "?"), content))
        budget -= est
        injected += 1
        if cid != "session-latest":
            sess["chunks"].append(cid)

    # --- Brief: GLM RU→EN структуризация — только для достаточно длинных промптов
    # (короткие ответные реплики в рамках уже идущей задачи брифинга не тратят).
    # Информационный слой: не заменяет исходный текст пользователя, Claude сам решает,
    # насколько ему следовать (полезно как «конкретизация» задачи, а не источник истины).
    # До L3: его английские термины уточняют поиск; окно кончается раньше дедлайна на FTS-поиск.
    brief = None
    if want_brief:
        brief = glm_call("structure_task", prompt, deadline - L3_RESERVE_S, BRIEF_TIMEOUT_S, BRIEF_MIN_BUDGET_S)

    # --- L3: RAG-указатели (только doc_id/title/path — тела не инжектим)
    terms = l3_terms(dc, prompt, brief)
    conn = dc.open_db() if terms else None
    if conn is not None:
        # Ожидание блокировки SQLite (index_rebuild соседней сессии) — тоже из бюджета хука:
        # open_db() даёт по 2 с на операцию, а их здесь до трёх (поиск, запасной поиск, лог).
        # При полном бюджете остаётся те же 2 с.
        try:
            left = max(0.0, deadline - time.monotonic())
            conn.execute("PRAGMA busy_timeout = %d" % int(min(2.0, left / 3) * 1000))
        except Exception:
            pass
        rows = dc.search(conn, terms, limit=L3_MAX_HITS * 2)
        if not rows:  # офлайн-запасной путь: префиксы русских слов, когда алиасов и GLM не хватило
            alt = dc.extract_search_terms(prompt, ru_prefix=True)
            if alt != terms:
                terms, rows = alt, dc.search(conn, alt, limit=L3_MAX_HITS * 2)
        fresh = [r for r in rows if r["doc_id"] not in sess["rag"]][:L3_MAX_HITS]
        dc.log_query(conn, " ".join(terms), "hook", rows, session_id)
        conn.close()
        if fresh:
            # [stale] — срез индекса помечен устаревшим после правки файла:
            # указатель всё ещё полезен, но тело документа могло разойтись с диском.
            lines = ["- %s%s — %s (%s)" % (
                r["doc_id"],
                "" if r.get("status") == "active" else " [stale]",
                r["title"], r.get("file_path") or "?")
                for r in fresh]
            parts.append(
                "<!-- DAMS rag: указатели по запросу; детали — Read файла или "
                "`python3 .claude/scripts/rag_query.py \"<запрос>\" --full` -->\n"
                + "\n".join(lines))
            sess["rag"].extend(r["doc_id"] for r in fresh)

    if brief:
        parts.insert(0, "<!-- DAMS task-brief: GLM RU->EN structuring (informational — "
                         "does not replace the user's original wording) -->\n" + brief)
        sess["briefs"] = sess.get("briefs", 0) + 1

    dc.save_state(state)
    return parts


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass  # fail-safe: никогда не блокируем промпт
    # Брошенный по дедлайну GLM-поток может ещё висеть в сети. Вывод уже напечатан — выходим
    # сразу, не оставляя момент выхода финализации интерпретатора с живым потоком.
    try:
        sys.stdout.flush()
    except Exception:
        pass
    os._exit(0)
