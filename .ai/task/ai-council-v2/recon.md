# recon — AI Council v2 (факты из кода)

Ключевые файлы: gateway.py (~1250 строк, Api + Handler, UI_FILE ui/index.html),
store.py (Store, ADDED_COLUMNS-миграции), schema.sql, council.py (протокол R0–R5),
council_worker.py (claim_run → process → finish_run), retrieval.py (капсула,
3 источника: DAMS RAG / corpus FTS5+vec / graph), context_service.py (индексация
корпуса, embed_pending, index_graph), graph_build.py (graphify Part A–C + Step 4),
notion.py (NotionClient, HARD_FORBIDDEN_FIELDS = Status, Half-baked), config.toml
([sources.mcp] serena/headroom/claude_mem; supervisor.services = gateway, notion-sync,
context, council, planner, learning), ui/index.html (2334 строки, вкладки overview
… settings, TABS-массив, RENDERERS-словарь, SSE /api/stream).

## Ф1 — главная страница с @-упоминаниями

- Кнопки вкладок: index.html:202–218 (`<nav>` … data-tab); TABS: index.html:311.
- API карточек: `Api.cards(db,q,limit)` gateway.py — SELECT из cards c LIKE-поиском;
  GET /api/cards в do_GET.
- Ввод сегодня: enqueue принимает только card_id существующей карточки
  (`store.get_card(card_id)` — «не в снапшоте» иначе).
- runs.card_id nullable по схеме, но ВСЯ обработка (capsule, emit, verdicts,
  learning, coverage, planner) исходит из card; ad-hoc текст без карточки сегодня
  не существует как сущность.
- Notion: query_database (фильтр Status), page_to_card, create_child_page
  (гварды child_pages + require_apply_flag_for_page_creation).
- Указания владельца: card_notes (active-флаг) + active_note_text → pinned капсулы.

## Ф2 — MCP + RAG сессионного контекста

- Конфиг уже декларирует [sources.mcp] serena/headroom/claude_mem — как намерение,
  исполняемого MCP-клиента в коде нет; retrieval читает только .claude/rag/index.db
  (DAMS) и council.db.
- Прогон = runs-строка; «сессии» как сущности нет; messages/proposals/reviews/
  verifications привязаны к run_id; exemplars (принятые payload) уже идут в корпус
  как few-shot (context_service.index_verdicts).
- Контекст прогона собирается заново каждый раз: retriever.build(card, note);
  никакой свёртки/суммаризации итогов прогонов не сохраняется, кроме payload
  последнего done-прогона в runs.payload и exemplar-документов.
- Corpus: corpus (FTS5), corpus_meta, corpus_vec; upsert_doc по content_hash.
- Для «итогового контекста перед завершением сессии» естественная точка —
  finish_run(done) в council_worker.process или hook после вердикта.

## Ф3 — граф: связи и бюджет узлов

- graph.json: nodes (id, label, source_file, file_type, community), edges
  (source, target, relation). graph_build.py — AST-извлечение graphify,
  сообщества под номерами; semantic-часть пропускается (пустой файл).
- gateway._graph_index: два уровня (symbols/files) + кэш по (mtime,size);
  _graph_slice — связный срез (heap по links_in, не топ-N).
- GET /api/graph: `max(50, min(int(one("limit","300")), 1200))` — жёсткий потолок 1200.
- UI: graphPrefs {limit:300, level, spin, labels} в localStorage; селекты
  limits = [150,300,600,1000] (index.html, renderGraph); рендер — canvas 2D,
  пространственный хеш, порядок художника, альфа-затухание; подписи top-20.
- Данных БД (prisma schema) в графе нет: graphify сканирует код, prisma/schema.prisma
  AST-экстрактором graphify не покрывается (не в file lists? — проверить: detect_files
  → collect_files). Связи «данные в БД» сегодня берутся только из DAMS RAG
  (types: prisma_model, proto_rpc).
- edges_out cap 8000 (gateway._graph_slice).

## Ф4 — знания с пагинацией

- Api.knowledge(query, limit=40): без query возвращает только kinds+embedded,
  hits пустые («введите запрос»); с query — FTS5 MATCH, substr(content,1,400),
  LIMIT min(limit,100).
- UI renderKnowledge: карточки-агрегаты по kind, поиск, hits.
- corpus_meta сейчас ~463 knowledge-док + graph_node до 400 + cards/done/exemplar.

## Проверяемые развилки (для hypotheses/плана)

1. Ad-hoc задача: (а) создать черновик карточки Notion при submit, (б) виртуальная
   карточка в council.db без Notion, (в) требовать выбор существующей. Влияет на
   emit/verdicts/learning — всё завязано на card.
2. «Сессия»: run | chain(runs одной карточки) | рабочая сессия владельца. От выбора
   зависит схема session_context и точка свёртки.
3. MCP: новый локальный MCP-сервер консилиума vs интеграция существующих MCP
   (serena/headroom) в retrieval как источников. «Дополнительный mcp» пользователя
   может означать и то и другое.
4. Граф «все»: 68k узлов — нужен либо LOD-режим (клиент-агрегация/декали), либо
   серверная агрегация (community-свертка), либо WebGL; «все» на canvas 2D нереален.
5. Ф4: пагинация по corpus FTS5 без запроса — MATCH пустым не вернуть «все»;
  нужен отдельный путь (SELECT из corpus ORDER BY doc_id LIMIT/OFFSET + kind-фильтр).