#!/usr/bin/env python3
"""Разбор и обход graph.json (graphify) — общий слой между `gateway.py` (визуализация,
план §3) и MCP-сервером (`council_graph_neighbors`, план §P4/Ф2). Только stdlib.

Вынесено из `gateway.Api._graph_index`/`_graph_slice`/`_filter_adj`/`_graph_communities`/
`_community_subgraph` (план, строки про P4: «council_graph_neighbors(...) — соседи по
graph.json через общий graph_index.py»). `gateway.Api` держит тонкие делегирующие обёртки
тех же имён — не ради обратной совместимости API, а потому что существующий selftest
(test_graph_communities_empty_filter_guard) подменяет `api._graph_index` инстансным
атрибутом и вызывает `gateway.Api._filter_adj`/`_graph_communities`/`_community_subgraph`
как classmethod-подобные статики; переезд логики сюда не должен требовать правки теста.
"""
from __future__ import annotations

import heapq
import json
import threading
from pathlib import Path

_CACHE: dict = {}
_LOCK = threading.Lock()


def load_index(path: Path) -> dict:
    """Два уровня одного графа.

    `symbols` — как graphify его построил: узел = функция/класс/файл, 68k узлов.
    `files`   — то же, свёрнутое до файлов: связь между символами становится связью
                между их файлами, `contains` (файл→свой символ) исчезает сам собой.
    Уровень файлов — то, что человек называет картой проекта; уровень символов нужен,
    когда карта уже привела в конкретный модуль.
    """
    stat = path.stat()
    key = (stat.st_mtime_ns, stat.st_size)
    with _LOCK:
        if _CACHE.get("key") == key:
            return _CACHE
        raw = json.loads(path.read_text(encoding="utf-8"))
        meta: dict[str, dict] = {}
        source_of: dict[str, str] = {}
        fmeta: dict[str, dict] = {}
        for node in raw.get("nodes") or []:
            node_id = str(node.get("id") or node.get("name") or "")
            if not node_id:
                continue
            source = str(node.get("source_file") or "")
            # У graphify человекочитаемое имя лежит в label, а id — слаг: показывать
            # слаг вместо `hh.service.ts` значит сделать граф нечитаемым.
            label = str(node.get("label") or node.get("norm_label") or node_id)
            community = str(node.get("community") or node.get("group") or "")
            kind = str(node.get("file_type") or node.get("kind") or "")
            meta[node_id] = {"label": label, "file": source, "kind": kind,
                             "community": community}
            if source:
                source_of[node_id] = source
                # Узел-контейнер файла (label = имя файла) отдаёт файлу своё
                # сообщество; у прочих символов оно своё и файлу не принадлежит.
                if source not in fmeta or label == source.rsplit("/", 1)[-1]:
                    fmeta[source] = {"label": source.rsplit("/", 1)[-1], "file": source,
                                     "kind": kind, "community": community}

        adj: dict[str, list] = {}
        fadj: dict[str, list] = {}
        total_edges = 0
        relations: set[str] = set()
        for edge in raw.get("edges") or raw.get("links") or []:
            a = str(edge.get("source") or edge.get("from") or "")
            b = str(edge.get("target") or edge.get("to") or "")
            if not a or not b or a == b:
                continue
            total_edges += 1
            relation = str(edge.get("relation") or "")
            if relation:
                relations.add(relation)
            adj.setdefault(a, []).append((b, relation))
            adj.setdefault(b, []).append((a, relation))
            fa, fb = source_of.get(a, ""), source_of.get(b, "")
            if fa and fb and fa != fb:
                fadj.setdefault(fa, []).append((fb, relation))
                fadj.setdefault(fb, []).append((fa, relation))

        _CACHE.clear()
        _CACHE.update({
            "key": key, "total_nodes": len(meta), "total_edges": total_edges,
            "relations": sorted(relations),
            "symbols": {"meta": meta, "adj": adj},
            "files": {"meta": fmeta, "adj": fadj},
        })
        return _CACHE


def filter_adj(adj: dict, rels: set[str] | None) -> dict:
    """Фильтр рёбер ДО свёртки уровня — план §3б: срез должен оставаться связным по
    отфильтрованным связям, не по всем сразу. `rels=None` — фильтра нет, тот же adj."""
    if not rels:
        return adj
    filtered: dict[str, list] = {}
    for node_id, links in adj.items():
        kept = [(other, relation) for other, relation in links if relation in rels]
        if kept:
            filtered[node_id] = kept
    return filtered


def graph_slice(meta: dict, adj: dict, limit: int) -> tuple[list, list]:
    """Связный плотный кусок графа заданного размера.

    Не «топ-N по связям», как было раньше: у такого среза почти нет внутренних рёбер
    (связи god-узлов уходят наружу, в неотобранные), и в 3D он выглядит облаком
    несвязанных точек — то есть врёт о структуре. Приоритет кандидата здесь — сколько
    у него связей С УЖЕ ВЫБРАННЫМИ, а не сколько всего: по общему числу вокруг хаба
    набираются его листья (у барреля `packages/rpc/src/index.ts` их под две тысячи) и
    срез вырождается в звезду — связную, но бесполезную.
    """
    degree = {node_id: len(links) for node_id, links in adj.items()}
    by_degree = sorted(degree.items(), key=lambda kv: (-kv[1], kv[0]))
    selected: list[str] = []
    chosen: set[str] = set()
    links_in: dict[str, int] = {}
    heap: list[tuple[int, int, str]] = []
    seeds = iter(by_degree)
    while len(selected) < limit:
        if not heap:
            nxt = next((n for n, _ in seeds if n not in chosen), None)
            if nxt is None:
                break                      # компоненты кончились раньше лимита
            heapq.heappush(heap, (0, -degree.get(nxt, 0), nxt))
        score, _, node_id = heapq.heappop(heap)
        if node_id in chosen or -score != links_in.get(node_id, 0):
            continue                       # устаревшая запись — есть свежая в куче
        chosen.add(node_id)
        selected.append(node_id)
        for other, _rel in adj.get(node_id, ()):
            if other in chosen:
                continue
            links_in[other] = links_in.get(other, 0) + 1
            heapq.heappush(heap, (-links_in[other], -degree.get(other, 0), other))

    # Дедупликация с весом: между двумя файлами бывают десятки связей, и рисовать их
    # как десятки линий — сплошная заливка вместо структуры.
    weights: dict[tuple[str, str], int] = {}
    relations: dict[tuple[str, str], dict] = {}
    for node_id in selected:
        for other, relation in adj.get(node_id, ()):
            if other not in chosen or other == node_id:
                continue
            pair = (node_id, other) if node_id < other else (other, node_id)
            weights[pair] = weights.get(pair, 0) + 1
            counts = relations.setdefault(pair, {})
            counts[relation] = counts.get(relation, 0) + 1

    nodes_out = [{"id": node_id,
                  "label": (meta.get(node_id) or {}).get("label") or node_id,
                  "file": (meta.get(node_id) or {}).get("file", ""),
                  "kind": (meta.get(node_id) or {}).get("kind", ""),
                  "community": (meta.get(node_id) or {}).get("community", ""),
                  "degree": degree.get(node_id, 0)} for node_id in selected]
    edges_out = [{"source": a, "target": b, "weight": max(1, w // 2),
                  "relation": max(relations[(a, b)].items(), key=lambda kv: kv[1])[0]}
                 for (a, b), w in sorted(weights.items(), key=lambda kv: -kv[1])]
    # Кап поднят 8000→25000 (план §3в): drill-down в сообщество допускает до 25000
    # узлов, и плотное сообщество такого размера легко даёт больше 8000 внутренних
    # рёбер — старый кап срезал бы связи молча, до всякого LOD-режима.
    return nodes_out, edges_out[:25000]


def graph_communities(meta: dict, adj: dict, rels: set[str] | None) -> tuple[list, list]:
    """LOD «сообщества» (план §3в): узел = сообщество, а не символ/файл. Единственный
    режим для >2500 узлов и «все» — честное «все 68k», без обрезки картинки молча.
    `adj` хранит каждое ребро дважды (по разу с каждой стороны) — тот же `// 2`,
    что и `graph_slice`, а не новый источник рассинхрона счётчиков."""
    sizes: dict[str, int] = {}
    for info in meta.values():
        community = str(info.get("community") or "?")
        sizes[community] = sizes.get(community, 0) + 1

    inter: dict[tuple[str, str], int] = {}
    for node_id, links in adj.items():
        ca = str((meta.get(node_id) or {}).get("community") or "?")
        for other, relation in links:
            if rels and relation not in rels:
                continue
            cb = str((meta.get(other) or {}).get("community") or "?")
            if ca == cb:
                continue
            pair = (ca, cb) if ca < cb else (cb, ca)
            inter[pair] = inter.get(pair, 0) + 1

    nodes_out = [{"id": f"community:{c}", "community": c,
                  "label": f"Сообщество {c}", "size": size, "degree": size}
                 for c, size in sorted(sizes.items(), key=lambda kv: -kv[1])]
    edges_out = [{"source": f"community:{a}", "target": f"community:{b}",
                  "weight": max(1, w // 2), "relation": "inter_community"}
                 for (a, b), w in sorted(inter.items(), key=lambda kv: -kv[1])]
    return nodes_out, edges_out


def community_subgraph(meta: dict, adj: dict, community_id: str) -> tuple[dict, dict]:
    """Узлы одного сообщества + их связи ТОЛЬКО друг с другом — вход для drill-down
    через `graph_slice` (план §3в, «детальный срез выбранного сообщества»)."""
    members = {node_id for node_id, info in meta.items()
               if str(info.get("community") or "?") == community_id}
    sub_meta = {node_id: meta[node_id] for node_id in members}
    sub_adj = {node_id: [(other, relation) for other, relation in adj.get(node_id, ())
                         if other in members]
               for node_id in members}
    return sub_meta, sub_adj


def neighbors(index: dict, node: str, hops: int = 1, limit: int = 50,
              level: str = "files", rel: str = "") -> dict:
    """P4/Ф2 — вход `council_graph_neighbors` MCP-инструмента: BFS-обход вокруг ОДНОГО
    узла на N шагов, а не «плотный связный кусок» произвольного размера (это
    `graph_slice`, отдельная задача для 3D-визуализации). `node` ищется и по id, и по
    label без учёта регистра — MCP-клиент(агент) знает человекочитаемое имя символа/
    файла, а не внутренний слаг graphify."""
    level = level if level in ("files", "symbols") else "files"
    layer = index.get(level) or {}
    meta: dict = layer.get("meta") or {}
    adj: dict = layer.get("adj") or {}
    rels = {r.strip() for r in rel.split(",") if r.strip()} or None
    adj = filter_adj(adj, rels)

    origin = node if node in meta else next(
        (n for n, info in meta.items()
         if str(info.get("label", "")).lower() == node.lower()), None)
    if origin is None:
        return {"available": False, "hint": f"узел {node!r} не найден на уровне {level!r}"}

    hops = max(1, min(int(hops), 5))
    limit = max(1, min(int(limit), 500))
    visited = {origin: 0}
    order = [origin]
    frontier = [origin]
    for depth in range(1, hops + 1):
        if len(order) >= limit:
            break
        next_frontier = []
        for n in frontier:
            for other, _relation in adj.get(n, ()):
                if other in visited or len(order) >= limit:
                    continue
                visited[other] = depth
                order.append(other)
                next_frontier.append(other)
        frontier = next_frontier
        if not frontier:
            break

    selected = set(order)
    edges_out = []
    seen_pairs: set[tuple[str, str]] = set()
    for n in order:
        for other, relation in adj.get(n, ()):
            if other not in selected:
                continue
            pair = (n, other) if n < other else (other, n)
            if pair in seen_pairs:
                continue
            seen_pairs.add(pair)
            edges_out.append({"source": pair[0], "target": pair[1], "relation": relation})

    nodes_out = [{"id": n, "label": (meta.get(n) or {}).get("label") or n,
                  "file": (meta.get(n) or {}).get("file", ""),
                  "kind": (meta.get(n) or {}).get("kind", ""),
                  "community": (meta.get(n) or {}).get("community", ""),
                  "hop": visited[n]} for n in order]
    return {"available": True, "origin": origin, "level": level, "hops": hops,
            "nodes": nodes_out, "edges": edges_out}
