#!/usr/bin/env python3
"""AI Council — наполнение корпуса и эмбеддингов. Только stdlib.

Канон: docs/specs/ai-council.md §6 «источник 2».

    python3 infra/ai-council/context_service.py --once [--no-embed]
    python3 infra/ai-council/context_service.py               # сервис

Корпус — динамическая часть RAG консилиума, в отличие от статического DAMS-индекса по коду:

* карточки борда (заголовок + тело + комментарии) — чтобы модели видели соседние задачи;
* записи `docs/plans/done/*.md` (оглавление — `docs/plans/DONE.md`) — канон закрытого, источник ответа «делали ли это раньше»
  и калибровки трудоёмкости;
* принятые результаты проработки — few-shot экземпляры для §9;
* знания проекта и единые знания ИИ-сервисов (правила, роли `CLAUDE.md`, правила Continue,
  память Claude Code и claude-mem) — источники и приватность в knowledge_sources.py.

Эмбеддинги (`nomic-embed-text`, 0.3 GB) считаются только для новых/изменённых документов:
ключ — `content_hash`. Полный пересчёт (карточки + записи `docs/plans/done/`, сотни документов) — один раз.
"""
from __future__ import annotations

import argparse
import json
import re
import signal
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import config as config_mod                                  # noqa: E402
import knowledge_sources                                     # noqa: E402
import ollama as ollama_mod                                  # noqa: E402
from retrieval import clip_to_tokens, est_tokens, pack_vec   # noqa: E402
from store import REPO_ROOT, Store, sha16                    # noqa: E402

_stopping = False

# Формат записи DONE.md: `- **Заголовок** (примечание) — описание`.
# Те же три варианта разделителя, что в scripts/transfer-done-to-notion.js —
# внутри многочастных секций встречаются суб-буллеты с `:`/`.` вместо `—`.
BULLET_RES = [
    re.compile(r"^-\s+\*\*(.+?)\*\*\s*(?:\(([^)]*)\))?\s*(?:—|:|\.)\s*(.+)$"),
    re.compile(r"^-\s+\*\*(.+?)\*\*\s*(?:\(([^)]*)\))?\s+(.+)$"),
]


def _handle_stop(_signum, _frame):
    global _stopping
    _stopping = True


def upsert_doc(store: Store, doc_id: str, kind: str, title: str, content: str,
               module: str = "", source_ref: str = "") -> bool:
    """True, если документ новый или изменился (значит нужен пересчёт эмбеддинга)."""
    content_hash = sha16(f"{title}\n{content}")
    prev = store.q1("SELECT content_hash FROM corpus_meta WHERE doc_id = ?", (doc_id,))
    if prev and prev["content_hash"] == content_hash:
        return False
    store.x("DELETE FROM corpus WHERE doc_id = ?", (doc_id,))
    store.x("INSERT INTO corpus (doc_id, kind, title, content, module) VALUES (?,?,?,?,?)",
            (doc_id, kind, title, content, module))
    store.x(
        "INSERT INTO corpus_meta (doc_id, kind, source_ref, module, content_hash, indexed_at) "
        "VALUES (?,?,?,?,?,?) ON CONFLICT(doc_id) DO UPDATE SET "
        "kind=excluded.kind, source_ref=excluded.source_ref, module=excluded.module, "
        "content_hash=excluded.content_hash, indexed_at=excluded.indexed_at",
        (doc_id, kind, source_ref, module, content_hash, int(time.time())),
    )
    store.x("DELETE FROM corpus_vec WHERE doc_id = ?", (doc_id,))   # вектор устарел
    return True


def index_cards(store: Store) -> int:
    changed = 0
    for card in store.open_cards():
        modules = json.loads(card.get("modules") or "[]")
        comments = json.loads(card.get("comments") or "[]")
        body = "\n".join(filter(None, [
            card.get("body") or "",
            card.get("report") or "",
            "\n".join(c.get("text", "") for c in comments),
        ]))
        label = "Ошибка" if card["db"] == "bugs" else "Задача"
        weight = card.get("severity") or card.get("priority") or ""
        title = f"[{label}{' ' + weight if weight else ''}] {card.get('title') or ''}"
        if upsert_doc(store, card["card_id"], "card", title, body[:4000],
                      module=(modules[0] if modules else ""), source_ref=card.get("url") or ""):
            changed += 1
    return changed


def done_files(path: Path) -> list[Path]:
    """Файлы закрытого: каталог модулей `docs/plans/done/` (с подкаталогами годов) или один файл."""
    if path.is_dir():
        return sorted(path.rglob("*.md"))
    return [path] if path.is_file() else []


def index_done_md(store: Store, path: Path) -> int:
    """Записи закрытого. Секция (## / ###) даёт контекст — без неё «BE-2: DLQ-страница»
    неотличима от одноимённого пункта в другом модуле. С 2026-10-08 записи лежат по модулям
    (`docs/plans/done/<модуль>.md`): модуль — в content; doc_id прежний (секция + заголовок),
    поэтому перенос из единого файла обновляет документы на месте, а не плодит дубли."""
    changed, seen = 0, set()
    for done_file in done_files(path):
        changed += _index_done_file(store, done_file, seen)
    # Исчезнувшие записи (переименован раздел или заголовок) иначе всплывают в поиске дублями
    # со старыми путями. Чистим только после полного каталога и непустого разбора: прогон по
    # одному файлу или пустой разбор не должен стереть корпус.
    if path.is_dir() and seen:
        for row in store.q("SELECT doc_id FROM corpus_meta WHERE kind = 'done_md'"):
            if row["doc_id"] not in seen:
                for table in ("corpus", "corpus_meta", "corpus_vec"):
                    store.x(f"DELETE FROM {table} WHERE doc_id = ?", (row["doc_id"],))
    return changed


def _index_done_file(store: Store, path: Path, seen: set) -> int:
    module = path.stem if path.parent.name == "done" else f"{path.parent.name}/{path.stem}"
    rel = path.relative_to(REPO_ROOT) if path.is_relative_to(REPO_ROOT) else path
    changed, section = 0, ""
    for lineno, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        heading = re.match(r"^(#{2,4})\s+(.+)$", raw)  # #### — подразделы, перенесённые из единого файла
        if heading:
            section = heading.group(2).strip()
            continue
        line = raw.strip()
        if not line.startswith("- "):
            continue
        match = next((m for m in (r.match(line) for r in BULLET_RES) if m), None)
        if not match:
            continue
        title, paren, description = match.group(1), match.group(2) or "", match.group(3)
        doc_id = f"done:{sha16(section + title)}"
        seen.add(doc_id)
        content = f"[закрыто · {module} · {section}] {('(' + paren + ') ' if paren else '')}{description}"
        if upsert_doc(store, doc_id, "done_md", title, content[:2000],
                      source_ref=f"{rel}:{lineno}"):
            changed += 1
    return changed


def index_verdicts(store: Store) -> int:
    """Принятые результаты — few-shot экземпляры для §9. Отклонённые тоже полезны,
    но как антипримеры они в промпт не идут — только в статистику моделей."""
    changed = 0
    rows = store.q(
        "SELECT v.run_id, v.decision, v.comment, r.payload, r.card_id, c.title "
        "FROM verdicts v JOIN runs r ON r.id = v.run_id "
        "LEFT JOIN cards c ON c.card_id = r.card_id "
        "WHERE v.decision = 'accept' AND r.payload IS NOT NULL"
    )
    for row in rows:
        doc_id = f"exemplar:{row['run_id']}"
        if upsert_doc(store, doc_id, "exemplar",
                      f"[принято] {row.get('title') or row['card_id']}",
                      (row["payload"] or "")[:3000], source_ref=row["run_id"]):
            changed += 1
    return changed


def _split_markdown(text: str, max_chars: int = 3000) -> list[tuple[str, str]]:
    """Markdown → [(заголовок, тело)] по секциям верхнего уровня.

    Целый файл одним документом бесполезен: правило на 400 строк вернётся по любому
    запросу и вытеснит из капсулы всё остальное. Секция — минимальная единица, которую
    осмысленно показать модели целиком.
    """
    sections: list[tuple[str, str]] = []
    title, buf = "", []
    for line in text.splitlines():
        heading = re.match(r"^(#{1,3})\s+(.+)$", line)
        if heading:
            if buf and "".join(buf).strip():
                sections.append((title, "\n".join(buf).strip()[:max_chars]))
            title, buf = heading.group(2).strip(), []
        else:
            buf.append(line)
    if buf and "".join(buf).strip():
        sections.append((title, "\n".join(buf).strip()[:max_chars]))
    return [(t, b) for t, b in sections if b]


def index_project_knowledge(store: Store, cfg, report: dict | None = None) -> int:
    """Проектные знания: правила, саб-агенты, скиллы, DAMS-чанки — и с 2026-10-09 единые
    знания ИИ-сервисов: карточки ролей (`role`), правила Continue (`client_rule`), память
    Claude Code (`memory`) и решения claude-mem (`mem_obs`) — knowledge_sources.py.

    Зачем консилиуму именно они. Улики из RAG-индекса отвечают на вопрос «что в коде
    есть»; эти источники отвечают на «как в этом проекте принято и что запрещено».
    Без них модель предлагает технически возможное и локально запрещённое — `body: unknown`
    в контроллере, raw `fetch` вместо HttpClientService, статический импорт exceljs, — а
    верификатор такое не ловит: файлы-то существуют, ссылки настоящие. Это ровно тот
    класс ошибок, который вылезает на ревью, то есть после того, как результат уже
    записан в карточку.

    Индексируется посекционно (см. _split_markdown) и с приоритетом по виду источника:
    `rule` — запреты и конвенции, `agent` — описания ролей, `skill` — процедуры,
    `chunk` — доменные срезы DAMS. Документы исчезнувших файлов/секций вычищаются по виду
    (раньше не вычищались вовсе и всплывали в поиске со старыми путями). `report` —
    необязательный словарь, куда кладётся разбивка по видам (docs/changed/pruned).
    """
    by_kind = knowledge_sources.index_knowledge(store, cfg, upsert_doc, _split_markdown)
    if report is not None:
        report.update(by_kind)
    return sum(item["changed"] for item in by_kind.values())


def index_graph(store: Store, cfg) -> int:
    """Граф graphify: сообщества и god-узлы как текстовые документы.

    Граф даёт то, чего нет ни в индексе, ни в карточках: связность. «Этот файл лежит в
    одном сообществе с теми пятью» — ответ на вопрос «что ещё сломается», который иначе
    не задаётся вовсе. Целиком граф в капсулу не влезает и не нужен, поэтому индексируются
    только узлы с их ближайшим окружением.

    Файла может не быть: graphify — батч-инструмент (C7), а не сервис. Отсутствие графа
    это не ошибка, это «ещё не считали».
    """
    path = cfg.path_of("sources.graph.path")
    if not path.is_file():
        return 0
    try:
        graph = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return 0

    nodes = graph.get("nodes") or []
    edges = graph.get("edges") or graph.get("links") or []
    neighbours: dict[str, list[str]] = {}
    for edge in edges:
        a = str(edge.get("source") or edge.get("from") or "")
        b = str(edge.get("target") or edge.get("to") or "")
        if not a or not b:
            continue
        neighbours.setdefault(a, []).append(b)
        neighbours.setdefault(b, []).append(a)

    # В корпус идут только САМЫЕ СВЯЗАННЫЕ узлы, а не весь граф. На этом репозитории
    # граф — 68 316 узлов: залив их целиком, корпус раздувается в 100 раз против
    # осмысленного содержимого (463 документа знаний + 146 карточек), BM25 начинает
    # выдавать по любому запросу безымянные узлы, а шаг эмбеддингов уходит в вечный
    # догоняющий цикл по 400 штук за проход. Ценность графа — в god-узлах и их
    # окружении; хвост из узлов со одной связью не отвечает ни на один вопрос.
    limit = int(cfg.get("sources.graph.corpus_nodes", 400))
    ranked = sorted(nodes, key=lambda n: -len(
        neighbours.get(str(n.get("id") or n.get("name") or ""), [])))[:max(limit, 0)]

    changed = 0
    for node in ranked:
        node_id = str(node.get("id") or node.get("name") or "")
        if not node_id:
            continue
        near = neighbours.get(node_id, [])[:12]
        community = str(node.get("community") or node.get("group") or "")
        content = (f"Узел графа: {node_id}\n"
                   f"Сообщество: {community or '—'}\n"
                   f"Связан с ({len(neighbours.get(node_id, []))}): {', '.join(near) or '—'}\n"
                   f"{str(node.get('summary') or node.get('description') or '')[:1200]}")
        if upsert_doc(store, f"graph:{sha16(node_id)}", "graph_node",
                      f"[граф] {node_id}", content, module=community,
                      source_ref=f"graphify-out/graph.json#{node_id}"):
            changed += 1
    return changed


# P4 (Ф2): свёртка закрытия рабочей сессии владельца (план §P4 «Жизненный цикл»,
# решение B — контекст принадлежит сессии, не карточке). Тот же жанр промпта, что
# TERM_PROMPT в retrieval.py — служебная экстракция, не роль консилиума, поэтому
# константа здесь, а не отдельный prompts/*.md.
SESSION_SUMMARY_PROMPT = (
    "Ты — экстрактор итогов рабочей сессии. На входе список карточек (задач/ошибок), "
    "которыми занимались за сессию: статус прогона, вердикт или причина воздержания, "
    "открытые вопросы. Составь компактную сводку на русском: чем занимались, что решено, "
    "что осталось открытым, на чём остановились. Только факты из входа, без домыслов и "
    "советов. Без markdown-заголовков и списков — связный текст, 3-6 предложений."
)


def _session_runs_digest(runs: list[dict]) -> str:
    lines = []
    for r in runs:
        label = "Ошибка" if r.get("db") == "bugs" else "Задача"
        weight = r.get("severity") or r.get("priority") or ""
        bits = [f"{label}{' ' + str(weight) if weight else ''}: "
                f"{r.get('title') or r.get('card_id')}",
                f"статус: {r.get('status')}"]
        payload: dict = {}
        if r.get("payload"):
            try:
                payload = json.loads(r["payload"])
            except (TypeError, ValueError):
                payload = {}
        goal = (payload.get("statement") or {}).get("goal")
        if goal:
            bits.append(f"цель: {goal[:200]}")
        reason = payload.get("reason")
        if reason:
            bits.append(f"причина воздержания: {reason}")
        questions = payload.get("open_questions") or []
        if questions:
            bits.append("открытые вопросы: " + "; ".join(str(q) for q in questions[:3]))
        lines.append(" · ".join(bits))
    return "\n".join(lines)


def summarize_session(cfg, store: Store, client, session_id: str) -> dict | None:
    """Свёртка закрытия сессии: роль `extractor` (S-модель, локально, бесплатно) —
    вход строго факты runs/payload сессии, выход ≤ [council.session_context]
    max_summary_tokens. Пишет sessions.summary + session_contexts и индексирует в
    corpus (kind='session') для RAG-поиска по прошлым сессиям. Вызывается ПОСЛЕ
    store.close_session_if_open — сама свёртку статуса не трогает.

    None — гейт выключен, сессия пуста (ничего не прогоняли) или модель не ответила;
    ни один из этих случаев не блокирует уже случившееся закрытие сессии."""
    ctx = cfg.get("council.session_context", {}) or {}
    if not ctx.get("enabled", False):
        return None
    session = store.get_session(session_id)
    if not session:
        return None
    runs = store.session_runs(session_id)
    if not runs:
        return None

    max_tokens = int(ctx.get("max_summary_tokens", 300))
    profile = cfg.get("models.profile", "fast")
    model = cfg.roles("fast" if profile == "adaptive" else profile)["extractor"]
    digest = _session_runs_digest(runs)
    result = client.chat(
        model,
        [{"role": "system", "content": SESSION_SUMMARY_PROMPT},
         {"role": "user", "content": digest[:6000]}],
        temperature=0.2, max_tokens=max(120, int(max_tokens * 1.4)), retries=1,
    )
    if not result.ok or not result.text.strip():
        return None
    summary = clip_to_tokens(result.text.strip(), max_tokens)
    tokens = est_tokens(summary)
    source_run_id = runs[-1]["id"]
    store.set_session_summary(session_id, summary, model, tokens, source_run_id)

    title = session.get("title") or session_id
    opened = time.strftime("%Y-%m-%d", time.localtime(session.get("opened_at") or time.time()))
    upsert_doc(store, f"session:{session_id}", "session", f"[сессия {opened}] {title}",
              summary)
    return {"session_id": session_id, "summary": summary, "model": model, "tokens": tokens}


def embed_pending(store: Store, client, model: str, batch: int = 16,
                  limit: int = 400) -> int:
    """Векторы для документов, у которых их ещё нет. Батчами — /api/embed принимает список,
    и 400 отдельных HTTP-вызовов против 25 батчей это разница в минуты."""
    pending = store.q(
        "SELECT m.doc_id, c.title, c.content FROM corpus_meta m "
        "JOIN corpus c ON c.doc_id = m.doc_id "
        "LEFT JOIN corpus_vec v ON v.doc_id = m.doc_id "
        "WHERE v.doc_id IS NULL LIMIT ?", (limit,))
    if not pending:
        return 0
    done = 0
    for i in range(0, len(pending), batch):
        if _stopping:
            break
        chunk = pending[i:i + batch]
        texts = [f"{r['title']}\n{(r['content'] or '')[:1500]}" for r in chunk]
        vectors = client.embed(model, texts)
        if not vectors or len(vectors) != len(chunk):
            break                                   # Ollama недоступна — доберём в следующий цикл
        for row, vec in zip(chunk, vectors):
            store.x(
                "INSERT OR REPLACE INTO corpus_vec (doc_id, dim, vec, model, embedded_at) "
                "VALUES (?,?,?,?,?)",
                (row["doc_id"], len(vec), pack_vec(vec), model, int(time.time())),
            )
            done += 1
    return done


def run_once(cfg, store: Store, client, embed: bool = True, verbose: bool = True) -> dict:
    by_kind: dict = {}
    stats = {
        "cards": index_cards(store),
        "done_md": index_done_md(store, cfg.path_of("sources.done_md.path")),
        "exemplars": index_verdicts(store),
        "knowledge": index_project_knowledge(store, cfg, by_kind),
        "graph": index_graph(store, cfg),
        "embedded": 0,
    }
    stats["knowledge_by_kind"] = {k: {"docs": v["docs"], "changed": v["changed"],
                                      "pruned": v["pruned"]} for k, v in by_kind.items()}
    if embed and client is not None and client.alive():
        profile = cfg.get("models.profile", "fast")
        model = cfg.roles("fast" if profile == "adaptive" else profile)["embed"]
        stats["embedded"] = embed_pending(store, client, model)

    totals = store.q1(
        "SELECT (SELECT COUNT(*) FROM corpus_meta) docs, "
        "(SELECT COUNT(*) FROM corpus_vec) vecs")
    stats.update(totals)
    store.event("context.indexed", "", json.dumps(stats))
    if verbose:
        print(f"  корпус: {stats['docs']} документов, {stats['vecs']} векторов "
              f"(+{stats['cards']} карточек, +{stats['done_md']} DONE.md, "
              f"+{stats['exemplars']} экземпляров, +{stats['embedded']} векторов)")
        print("  знания: " + ", ".join(
            f"{k} {v['docs']}" + (f" (+{v['changed']})" if v["changed"] else "")
            + (f" (−{v['pruned']})" if v["pruned"] else "")
            for k, v in stats["knowledge_by_kind"].items()))
    return stats


def main() -> int:
    parser = argparse.ArgumentParser(description="AI Council — context service")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--no-embed", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    signal.signal(signal.SIGTERM, _handle_stop)
    signal.signal(signal.SIGINT, _handle_stop)

    cfg = config_mod.load(strict=False)
    verbose = not args.quiet
    with Store() as store:
        client = ollama_mod.build(cfg, store, holder="context")
        while True:
            if verbose:
                print(f"[{time.strftime('%H:%M:%S')}] индексация корпуса…", flush=True)
            try:
                run_once(cfg, store, client, embed=not args.no_embed, verbose=verbose)
            except Exception as exc:                          # noqa: BLE001
                print(f"  ✗ проход упал: {exc}", flush=True)
            if args.once or _stopping:
                return 0
            for _ in range(300):                              # 5 минут
                if _stopping:
                    return 0
                time.sleep(1)


if __name__ == "__main__":
    sys.exit(main())
