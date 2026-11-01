#!/usr/bin/env python3
"""
DAMS — Stop hook: доиндексация устаревших срезов RAG-индекса.

PostToolUse помечает записи изменённого файла как stale и печатает подсказку
`index_rebuild.py --type X`, но выполнять её было некому: срез оставался stale
до ручного rebuild, а `search()` до этого фикса такие документы прятала —
поиск отвечал успешно и пустым списком (неотличимо от «совпадений нет»).

Здесь закрывается сам источник: в конце сессии стали stale-типы пересобираются
автоматически (полный rebuild всех типов ~2s, один тип ~0.4s).

Fail-safe: любая ошибка → пустой вывод, exit 0 (сессия не блокируется).
"""
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

SUBPROCESS_TIMEOUT_S = 45


def main():
    import dams_common as dc

    payload = json.load(sys.stdin)
    # предыдущий Stop-хук уже продолжил цикл — второй rebuild подряд не нужен
    if payload.get("stop_hook_active"):
        return

    conn = dc.open_db()
    if conn is None:
        return
    try:
        counts = dc.stale_counts(conn)
    finally:
        conn.close()
    if not counts:
        return

    # неизвестный индексатору тип не пересобрать — иначе index_rebuild.py упадёт
    # на parser.error и stale-срез остался бы незамеченным
    try:
        import index_rebuild
        known = set(index_rebuild.INDEXERS)
    except Exception:
        known = set(counts)
    types = sorted(t for t in counts if t in known)
    if not types:
        return

    try:
        proc = subprocess.run(
            [sys.executable, str(dc.REPO_ROOT / ".claude/scripts/index_rebuild.py"),
             "--type", ",".join(types)],
            cwd=str(dc.REPO_ROOT), capture_output=True, text=True,
            timeout=SUBPROCESS_TIMEOUT_S,
        )
    except (subprocess.TimeoutExpired, OSError):
        return

    if proc.returncode != 0:
        # молча оставлять stale нельзя — иначе следующая сессия ищет по устаревшему срезу
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "Stop",
                "additionalContext": (
                    "DAMS: авто-rebuild устаревших срезов (%s) не удался — "
                    "выполнить вручную: `python3 .claude/scripts/index_rebuild.py --type %s`"
                    % (", ".join(types), ",".join(types))),
            }
        }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
