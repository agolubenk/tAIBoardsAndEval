#!/usr/bin/env python3
"""
DAMS — Stop hook: session memory.

Парсит transcript-файл Claude Code (JSONL) и обновляет
.claude/memory/session/latest.md — краткое резюме: тема сессии, изменённые
файлы, последний итог ассистента. Копия — в session/history/ (один файл на
сессию в день, перезаписывается на каждом Stop).

Реальный Stop-payload Claude Code не содержит session_summary/tasks_completed
(в отличие от исходной спеки DAMS) — поэтому источник данных здесь transcript.

Fail-safe: любая ошибка → пустой вывод, exit 0.
"""
import json
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

EDIT_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}
MAX_FILES = 15
MAX_HISTORY_FILES = 30
MAX_TODOS = 10
TAIL_BYTES = 8 * 1024 * 1024  # у длинных сессий парсим только хвост


def _texts_of(content):
    """message.content бывает строкой или списком блоков."""
    if isinstance(content, str):
        return [content]
    if isinstance(content, list):
        return [b.get("text", "") for b in content
                if isinstance(b, dict) and b.get("type") == "text"]
    return []


def parse_transcript(path):
    topic, last_text, files, prompts, todos = "", "", [], 0, None
    size = path.stat().st_size
    with path.open("rb") as fh:
        if size > TAIL_BYTES:
            fh.seek(size - TAIL_BYTES)  # не грузим многометровый transcript целиком
        raw = fh.read()
    if size > TAIL_BYTES:
        raw = raw[raw.find(b"\n") + 1:]
    for line in raw.decode("utf-8", "replace").splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict) or entry.get("isMeta"):
            continue
        msg = entry.get("message") or {}
        etype = entry.get("type")
        if etype == "user":
            for t in _texts_of(msg.get("content")):
                t = t.strip()
                if t and not t.startswith("<"):
                    prompts += 1
                    if not topic:
                        topic = t
                    break
        elif etype == "assistant":
            content = msg.get("content")
            if isinstance(content, list):
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") == "text" and block.get("text", "").strip():
                        last_text = block["text"].strip()
                    elif block.get("type") == "tool_use" and block.get("name") in EDIT_TOOLS:
                        inp = block.get("input") or {}
                        fp = inp.get("file_path") or inp.get("notebook_path")
                        if fp and fp not in files:
                            files.append(fp)
                    elif block.get("type") == "tool_use" and block.get("name") == "TodoWrite":
                        # последний вызов побеждает — актуальный снимок плана на момент Stop
                        cand = (block.get("input") or {}).get("todos")
                        if isinstance(cand, list):
                            todos = cand
    return topic, last_text, files, prompts, todos


def main():
    import dams_common as dc

    payload = json.load(sys.stdin)
    session_id = payload.get("session_id") or "unknown"
    tp = payload.get("transcript_path")
    if not tp or not Path(tp).exists():
        return

    topic, last_text, files, prompts, todos = parse_transcript(Path(tp))
    if not (topic or last_text or files):
        return

    files = [dc.rel_path(f) for f in files]
    now = datetime.now()

    def render_todos():
        """Открытые пункты TodoWrite — мостик для преемника (другой Claude-инстанс/
        сессия после исчерпания токенов): что уже сделано, что осталось прямо сейчас."""
        if not todos:
            return []
        open_items = [t for t in todos if t.get("status") != "completed"]
        if not open_items:
            return []
        marker = {"in_progress": "▶", "pending": "·"}
        lines = ["", "## Открытые задачи (TodoWrite) — для продолжения в новой сессии"]
        for t in open_items[:MAX_TODOS]:
            content = (t.get("content") or "").strip()
            if content:
                lines.append("- %s %s" % (marker.get(t.get("status"), "·"), content))
        if len(open_items) > MAX_TODOS:
            lines.append("- … ещё %d" % (len(open_items) - MAX_TODOS))
        return lines

    def render(itog, glm):
        lines = [
            "# Session memory — %s · %s" % (now.strftime("%Y-%m-%d %H:%M"), session_id[:8]),
            "",
            "> Автогенерация Stop-hook (`post-session.py`). Не редактировать вручную.",
            "",
            "## Тема сессии (%d промптов)" % prompts,
            (topic[:300] + "…") if len(topic) > 300 else (topic or "—"),
            "",
            "## Изменённые файлы (%d)" % len(files),
        ]
        lines += ["- `%s`" % f for f in files[:MAX_FILES]] or ["- —"]
        if len(files) > MAX_FILES:
            lines.append("- … ещё %d" % (len(files) - MAX_FILES))
        lines += [
            "",
            "## Последний итог" + (" (GLM)" if glm else ""),
            (itog[:700] + "…") if len(itog) > 700 else (itog or "—"),
        ]
        lines += render_todos()
        lines.append("")
        return "\n".join(lines)

    def persist(content):
        dc.SESSION_LATEST.parent.mkdir(parents=True, exist_ok=True)
        dc.SESSION_LATEST.write_text(content, encoding="utf-8")
        dc.SESSION_HISTORY.mkdir(parents=True, exist_ok=True)
        hist = dc.SESSION_HISTORY / ("%s-%s.md" % (now.strftime("%Y-%m-%d"), session_id[:8]))
        hist.write_text(content, encoding="utf-8")

    # 1) Сначала фолбэк-версия: даже если хук убьют на GLM-вызове, память сохранена.
    persist(render(last_text, False))

    # 2) Улучшение через GLM (fail-safe: None → остаётся фолбэк). Наружу уходит
    # только то, что и так пишется в latest.md: тема, пути файлов, последний итог.
    summary = None
    try:
        import glm_client
        # Таймаут хука в settings.json — 20 с; 12 с на всю цепочку моделей оставляют запас на запись файлов.
        summary = glm_client.summarize_session(topic, files, last_text, timeout=12)
    except Exception:
        pass
    if summary:
        persist(render(summary, True))

    old = sorted(dc.SESSION_HISTORY.glob("*.md"))
    for f in old[:-MAX_HISTORY_FILES]:
        f.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
