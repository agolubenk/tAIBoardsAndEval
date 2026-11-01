#!/usr/bin/env python3
"""
DAMS — CLI-поиск по RAG-индексу (то, что нужно вызывать вручную из сессии Claude).

Usage:
  python3 .claude/scripts/rag_query.py "candidate merge duplicate"
  python3 .claude/scripts/rag_query.py "sendMessage parse_mode" --type proto_rpc --full
  python3 .claude/scripts/rag_query.py "vacancy" --type api_route --module recruiting --limit 15

  python3 .claude/scripts/rag_query.py "оптимизация бандла" --type done_entry --no-log

Типы: prisma_model | proto_rpc | api_route | rule_chunk | spec | openapi_endpoint | done_entry
Русский запрос без доменных алиасов ищется офлайн по префиксам слов; GLM — только если терминов всё равно мало
(или --rewrite). --no-log — не писать запрос в rag_query_log (проверки «только на чтение»).
"""
import argparse

from dams_common import (extract_search_terms, freshness_hint, log_query, open_db,
                         rebuild_hint, search, stale_counts)


def main():
    p = argparse.ArgumentParser(description="DAMS RAG query")
    p.add_argument("query")
    p.add_argument("--type", dest="doc_type")
    p.add_argument("--module")
    p.add_argument("--limit", type=int, default=8)
    p.add_argument("--full", action="store_true", help="Печатать полный content")
    p.add_argument("--rewrite", action="store_true",
                   help="Дополнить термины через GLM (RU-запрос → EN-термины)")
    p.add_argument("--no-log", action="store_true", help="Не писать запрос в rag_query_log")
    args = p.parse_args()

    conn = open_db()
    if conn is None:
        print("Индекс не найден. Сборка: python3 .claude/scripts/index_rebuild.py")
        return

    terms = extract_search_terms(args.query, limit=10)
    if len(terms) < 2:
        # офлайн раньше облака: префиксы русских слов (`бандл*`) — без сети и без отправки запроса наружу
        terms = extract_search_terms(args.query, limit=10, ru_prefix=True)
    if args.rewrite or len(terms) < 2:
        try:
            import glm_client
            glm_terms = glm_client.rewrite_query(args.query)
            if glm_terms:
                terms = (terms + [t for t in glm_terms if t not in terms])[:10]
                print("GLM rewrite: %s" % ", ".join(glm_terms))
        except Exception:
            pass
    if not terms:
        print("Не удалось извлечь поисковые термины из запроса")
        return

    rows = search(conn, terms, limit=args.limit,
                  doc_type=args.doc_type, module=args.module)
    if not rows:
        alt = extract_search_terms(args.query, limit=10, ru_prefix=True)
        if alt != terms:
            terms = alt
            rows = search(conn, terms, limit=args.limit, doc_type=args.doc_type, module=args.module)
    if not args.no_log:
        log_query(conn, args.query, "cli", rows, "cli")
    # Предупреждение печатаем всегда, а не только при stale в выдаче: пустой ответ
    # по устаревшему срезу иначе неотличим от «совпадений нет».
    hint = rebuild_hint(stale_counts(conn, doc_type=args.doc_type))
    fresh = freshness_hint(conn, args.doc_type)
    conn.close()

    for warning in (hint, fresh):
        if warning:
            print("⚠ %s\n" % warning)

    if not rows:
        print("Ничего не найдено (термины: %s)" % ", ".join(terms))
        return

    for r in rows:
        mark = "" if r.get("status") == "active" else " [%s]" % r.get("status")
        print("[%s|%s]%s %s" % (r["doc_type"], r["module"], mark, r["doc_id"]))
        print("  %s" % r["title"])
        if r.get("file_path"):
            print("  %s" % r["file_path"])
        if args.full:
            print("  ---")
            for line in (r["content"] or "").splitlines():
                print("  %s" % line)
        print()


if __name__ == "__main__":
    main()
