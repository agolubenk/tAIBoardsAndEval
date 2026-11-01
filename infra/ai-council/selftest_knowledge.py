#!/usr/bin/env python3
"""AI Council — самопроверка «единых знаний ИИ-сервисов» (§6, 2026-10-09). Только stdlib.

Вызывается из selftest.py (`test_knowledge_sources`), отдельно не запускается: вынесено,
чтобы не раздувать общий selftest.py. Всё — на временном дереве и временных SQLite:
ни боевой council.db, ни настоящий ~/.claude-mem, ни Ollama не трогаются.
"""
from __future__ import annotations

import os
import sqlite3
import time
from pathlib import Path

import config as config_mod
import knowledge_external as kx
import knowledge_sources as ks
from context_service import _split_markdown, index_project_knowledge, upsert_doc
from retrieval import (EXPERIENCE_KINDS, KNOWLEDGE_KINDS, KNOWLEDGE_PER_KIND,
                       KNOWLEDGE_PRIORITY, Retriever)
from store import Store

# Таблица observations claude-mem — все 31 колонка живой БД (sqlite_master, снято 2026-10-09);
# опущен только FOREIGN KEY на sdk_sessions: чтению он не нужен, а фикстуре — лишняя таблица.
MEM_SCHEMA = """
CREATE TABLE observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, memory_session_id TEXT NOT NULL, project TEXT NOT NULL,
  text TEXT, type TEXT NOT NULL, title TEXT, subtitle TEXT, facts TEXT, narrative TEXT,
  concepts TEXT, files_read TEXT, files_modified TEXT, prompt_number INTEGER,
  discovery_tokens INTEGER DEFAULT 0, created_at TEXT NOT NULL, created_at_epoch INTEGER NOT NULL,
  content_hash TEXT, generated_by_model TEXT, relevance_count INTEGER DEFAULT 0,
  merged_into_project TEXT, agent_type TEXT, agent_id TEXT, metadata TEXT, synced_at INTEGER,
  origin_device_id TEXT, origin_local_id TEXT, sync_rev TEXT NOT NULL DEFAULT '1',
  occurrence_count INTEGER NOT NULL DEFAULT 1, title_norm_key TEXT, reinforcement_dates TEXT,
  last_reinforced TEXT
)"""

# подпись → (образец, фрагмент, которого после scrub быть не должно)
SECRET_SAMPLES = {
    "ключ OpenAI": ("sk-proj-AbCdEf0123456789XyZ0123", "AbCdEf0123456789"),
    "ключ Z.AI": ("0123456789abcdef0123456789abcdef.AbCdEfGh12345678", "AbCdEfGh12345678"),
    "JWT": ("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP",
            "dozjgNryP4J3"),
    "почта": ("owner.name@example.com", "owner.name"),
    "пароль в URL": ("postgres://app:Sup3rS3cret@db.example.com:5432/hr", "Sup3rS3cret"),
    "присваивание": ("NOTION_TOKEN=ntnA1b2C3d4E5f6G7h8", "ntnA1b2C3d4E5f6G7h8"),
    "пароль по-русски": ("пароль: Qwerty2026!", "Qwerty2026"),
    "телефон": ("+375 29 123-45-67", "123-45-67"),
    "телефон без +": ("8 029 765-43-21", "765-43-21"),
    "публичный IP": ("203.0.113.77", "203.0.113.77"),
}


def _cfg(data: dict) -> config_mod.Config:
    return config_mod.Config(data, Path("selftest.toml"))


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _fake_repo(tmp: Path) -> Path:
    """Мини-репозиторий: карточки ролей по дереву + те же файлы в каталогах, которые обходить
    нельзя (node_modules, worktrees, .git, prototipes, dist) — они не должны найтись."""
    repo = tmp / "repo"
    _write(repo / "CLAUDE.md", "# Корень\n\n## Роли\nкарта ролей репозитория\n")
    _write(repo / "AGENTS.md", "# Contract\nCodex reads role cards\n")
    _write(repo / "infra/ai-council/CLAUDE.md",
           "# Консилиум\n\n## Логика решений\nOllama строго последовательно, nomicembed отдельно\n")
    _write(repo / "apps/backend/CLAUDE.md", "# Backend\n\n## Гейт\nturbo typecheck\n")
    for junk in ("node_modules/pkg", "worktrees/feature/x", ".git/hooks", "prototipes/a",
                 "apps/frontend/dist", "artifacts/run"):
        _write(repo / junk / "CLAUDE.md", "# мусор\nне роль\n")
    _write(repo / ".continue/rules/03-cloud-budget.md", "# Бюджет\n\n## Права\nоблако по бюджету\n")
    return repo


def _mem_db(path: Path, now_ms: int) -> None:
    conn = sqlite3.connect(path)
    conn.execute(MEM_SCHEMA)
    day = 86_400_000
    rows = [
        ("decision", "HR_Helper-v2", "Решение: очередь консилиума без параллели",
         "Ollama sequential", '["one model at a time"]',
         f"написать на {SECRET_SAMPLES['почта'][0]}, ключ {SECRET_SAMPLES['ключ OpenAI'][0]}", now_ms - day),
        ("decision", "HR_Helper-v2", "Дамп БД с данными кандидатов", "", "[]",
         "в дампе были паспорта", now_ms - day),                       # смысл — PII: целиком вон
        ("security_alert", "HR_Helper-v2", "Ключ в логах", "", "[]", "alert", now_ms - day),
        ("sensitive", "HR_Helper-v2", "Чувствительное", "", "[]", "x", now_ms - day),
        ("discovery", "HR_Helper-v2", "Разведка gateway", "", "[]", "шум", now_ms - day),
        ("decision", "OtherProject", "Чужой проект", "", "[]", "не наш", now_ms - day),
        ("decision", "HR_Helper-v2", "Старое решение", "", "[]", "за окном", now_ms - 400 * day),
        ("decision", "HR_Helper-v2", "Решение: очередь консилиума без параллели!", "", "[]",
         "переформулированный дубль", now_ms - 2 * day),
    ]
    conn.executemany(
        "INSERT INTO observations (memory_session_id, type, project, title, subtitle, facts, "
        "narrative, created_at, created_at_epoch) VALUES ('s', ?, ?, ?, ?, ?, ?, 'x', ?)", rows)
    conn.commit()
    conn.close()


def run(tmp: Path, check) -> None:
    started = time.time()
    tmp = tmp / "knowledge-sources"
    tmp.mkdir(parents=True, exist_ok=True)
    repo = _fake_repo(tmp)

    # ── обход с исключениями ────────────────────────────────────────────────
    files, truncated = ks.iter_source_files(repo, ["CLAUDE.md", "AGENTS.md"], [".continue"])
    rels = sorted(p.relative_to(repo).as_posix() for p in files)
    check("знания: роли — найдены все CLAUDE.md/AGENTS.md, мусорные каталоги отрезаны",
          rels == ["AGENTS.md", "CLAUDE.md", "apps/backend/CLAUDE.md",
                   "infra/ai-council/CLAUDE.md"] and not truncated, ", ".join(rels))

    # ── `~` и id проекта Claude Code ────────────────────────────────────────
    home = tmp / "home"
    old_home = os.environ.get("HOME")
    os.environ["HOME"] = str(home)
    try:
        expanded = ks.expand_path("~/.claude/projects/{claude_project_id}/memory", repo)
        check("знания: `~` раскрывается, id проекта выводится из пути (не зашит)",
              expanded and expanded[0] == home / ".claude/projects"
              / ks.claude_project_id(repo) / "memory"
              and ks.claude_project_id(Path("/Users/x/HR_Helper-v2")) == "-Users-x-HR-Helper-v2",
              str(expanded[:1]))
        main = tmp / "main"
        (main / ".git/worktrees/wt").mkdir(parents=True, exist_ok=True)
        _write(main / "worktrees/feature/wt/.git", f"gitdir: {main}/.git/worktrees/wt\n")
        check("знания: из worktree память ищется у основного чекаута",
              ks.main_checkout_root(main / "worktrees/feature/wt") == main)

        # ── scrub ───────────────────────────────────────────────────────────
        sample = "\n".join(f"{k}: {v[0]}" for k, v in SECRET_SAMPLES.items())
        evidence = "локально 127.0.0.1:8790, порт 5432, эпоха 1786082280658, 2026-10-09 12:30, PR #79"
        clean = kx.scrub(sample + "\n" + evidence)
        leaked = [k for k, (_, needle) in SECRET_SAMPLES.items() if needle in clean]
        check("знания: scrub убирает ключи, JWT, почту, пароли, телефоны, публичный IP",
              not leaked, f"утекло: {leaked}" if leaked else "")
        check("знания: scrub не трогает loopback, порты, эпохи и даты (улики)",
              evidence in clean, clean.rsplit("\n", 1)[-1])
        dashed = ks.claude_project_id(home)
        check("знания: scrub — домашний каталог → `~` (путь и id проекта Claude Code)",
              kx.scrub(f"см. {home}/proj/a.md и {dashed}-Desktop-proj")
              == "см. ~/proj/a.md и ~-Desktop-proj", kx.scrub(f"{home}/proj"))

        # ── claude-mem: фильтр приватности ─────────────────────────────────
        mem_db = home / ".claude-mem/claude-mem.db"
        mem_db.parent.mkdir(parents=True, exist_ok=True)
        _mem_db(mem_db, int(time.time() * 1000))
        mem_cfg = {"enabled": True, "path": "~/.claude-mem/claude-mem.db",
                   "project": "HR_Helper-v2", "types": ["decision", "security_alert"],
                   "window_days": 45, "max_docs": 50}
        docs, state = ks.read_claude_mem(mem_cfg, repo)
        titles = [d["title"] for d in docs]
        check("знания: claude-mem — только решения проекта за окно, без security/sensitive, "
              "PII-смысла и дублей", state == "ok" and len(docs) == 1
              and "очередь консилиума" in titles[0], f"{state}: {titles}")
        check("знания: claude-mem — содержимое прошло scrub",
              docs and SECRET_SAMPLES["почта"][1] not in docs[0]["content"]
              and SECRET_SAMPLES["ключ OpenAI"][1] not in docs[0]["content"])
        check("знания: claude-mem нет на диске — пусто, не ошибка",
              ks.read_claude_mem({**mem_cfg, "path": str(tmp / "nope.db")}, repo) == ([], "absent"))
        problems = ks.validate(_cfg({"sources": {"knowledge": {
            "paths": [{"kind": "card", "path": "x"}],
            "claude_mem": {**mem_cfg, "types": ["decision", "security_alert", "security"]}}}}))
        check("знания: валидатор — зарезервированный kind и security-типы claude-mem запрещены",
              len(problems) == 2 and "'security'" in problems[1]
              and "'security_alert'" in problems[1], "; ".join(problems))
        row = {"subtitle": "", "facts": "[]", "narrative": "x", "created_at_epoch": 0}
        rows = [{**row, "id": 1, "type": "security", "title": "Ключ в логах"},
                {**row, "id": 2, "type": "privacy_incident", "title": "Инцидент"},
                {**row, "id": 3, "type": "decision", "title": "Решение по очереди"}]
        check("знания: claude-mem — типы с основой security/sensitive/secret/privacy не берутся "
              "никогда, даже из конфига",
              [d["doc_id"] for d in kx.observation_docs(rows, 10)] == ["mem_obs:3"]
              and ks.read_claude_mem({**mem_cfg, "types": ["security", "sensitive"]}, repo)
              == ([], "disabled") and kx.is_denied_type("insecure_config")
              and not kx.is_denied_type("decision"))

        # ── индексация, doc_id, чистка исчезнувшего ─────────────────────────
        _write(home / ".claude/projects" / ks.claude_project_id(repo) / "memory/feedback_x.md",
               "---\nname: x\ndescription: Решать порядок самому\nmetadata:\n  type: feedback\n---\n"
               f"Тело памяти, ключ {SECRET_SAMPLES['ключ Z.AI'][0]}\n")
        _write(home / ".claude/projects" / ks.claude_project_id(repo) / "memory/user_me.md",
               "---\ndescription: профиль владельца\ntype: user\n---\nличное\n")
        data = {"sources": {"knowledge": {"paths": [
            {"kind": "role", "path": ".", "glob": ["CLAUDE.md", "AGENTS.md"],
             "exclude": [".continue"], "title_from": "dir"},
            {"kind": "client_rule", "path": ".continue/rules"},
            {"kind": "memory", "path": "~/.claude/projects/{claude_project_id}/memory",
             "frontmatter": True, "title_from": "frontmatter", "skip_types": ["user"]},
        ], "claude_mem": {**mem_cfg, "types": ["decision"]}}}}
        store = Store(tmp / "k.db")
        upsert_doc(store, "card-1", "card", "Карточка", "Ollama карточка борда")
        report = ks.index_knowledge(store, _cfg(data), upsert_doc, _split_markdown, repo)
        kinds = {k: v["docs"] for k, v in report.items()}
        check("знания: индексация — роли, правила клиентов, память, решения",
              kinds.get("role", 0) >= 4 and kinds.get("client_rule") == 1
              and kinds.get("memory") == 1 and kinds.get("mem_obs") == 1, str(kinds))
        rel_id = f"role:{ks.sha16('infra/ai-council/CLAUDE.md')}:0"
        mem = store.q1("SELECT title, content FROM corpus WHERE kind = 'memory'") or {}
        check("знания: doc_id — kind:sha16(относительный путь):секция (стабилен)",
              store.q1("SELECT 1 FROM corpus_meta WHERE doc_id = ?", (rel_id,)) is not None)
        check("знания: память — шапка срезана, description в заголовке, `type: user` пропущен, scrub",
              "Решать порядок самому" in (mem.get("title") or "")
              and "originSessionId" not in (mem.get("content") or "")
              and SECRET_SAMPLES["ключ Z.AI"][1] not in (mem.get("content") or ""), str(mem)[:120])
        meta, body = ks.parse_frontmatter('---\nname: "Cloud budget"\ndescription: >-\n'
                                          '  Правила расхода\n  облака.\nalwaysApply: false\n'
                                          '---\n# Тело\n')
        check("знания: шапка — блочное значение `>-` склеивается, тело без шапки",
              meta == {"name": "Cloud budget", "description": "Правила расхода облака.",
                       "alwaysApply": "false"} and body == "# Тело", str(meta))

        (repo / "apps/backend/CLAUDE.md").unlink()
        report = ks.index_knowledge(store, _cfg(data), upsert_doc, _split_markdown, repo)
        gone = store.q1("SELECT COUNT(*) n FROM corpus_meta WHERE source_ref LIKE 'apps/backend/%'")
        check("знания: документы удалённого файла вычищаются, карточки не трогаются",
              report["role"]["pruned"] >= 1 and gone["n"] == 0
              and store.q1("SELECT 1 FROM corpus_meta WHERE doc_id = 'card-1'") is not None,
              str(report["role"]))
        data["sources"]["knowledge"]["claude_mem"]["enabled"] = False
        ks.index_knowledge(store, _cfg(data), upsert_doc, _split_markdown, repo)
        check("знания: выключенный источник уходит из корпуса целиком",
              (store.q1("SELECT COUNT(*) n FROM corpus_meta WHERE kind = 'mem_obs'") or {})["n"] == 0)
        listing = {s["kind"]: s for s in ks.source_listing(_cfg(data), store, repo)}
        check("знания: листинг источников — файлы и документы по виду",
              listing["role"]["files"] == 3 and listing["role"]["docs"] >= 3
              and listing["memory"]["external"] and not listing["mem_obs"]["enabled"],
              str({k: (v["files"], v["docs"]) for k, v in listing.items()}))

        # ── retrieval: роль доходит до ведра знаний, опыт не вытесняется ────
        for i in range(10):
            upsert_doc(store, f"mem_obs:{i}", "mem_obs", f"[решение] Ollama {i}",
                       "Ollama Ollama sequential nomicembed")
        retriever = Retriever(_cfg({}), store, None)
        card = {"card_id": "probe", "title": "Ollama", "body": ""}
        ev = retriever.corpus_evidence(card, ["Ollama", "nomicembed"], limit=4,
                                       kinds=KNOWLEDGE_KINDS, priority=KNOWLEDGE_PRIORITY,
                                       per_kind=KNOWLEDGE_PER_KIND)
        got = [e.kind for e in ev]
        check("знания: поиск возвращает секцию карточки роли, решений — не больше потолка на вид",
              "role" in got and got.count("mem_obs") <= KNOWLEDGE_PER_KIND, str(got))
        ev = retriever.corpus_evidence(card, ["Ollama"], limit=1, kinds=EXPERIENCE_KINDS)
        check("знания: фильтр вида — в SQL, опыт не вытесняется массой знаний",
              [e.ref for e in ev] == ["card-1"], str([e.ref for e in ev]))
        index_project_knowledge(store, _cfg({}))                   # пустой конфиг — не падает
        retriever.close()
        store.close()
    finally:
        if old_home is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = old_home
    check("знания: проверки быстрые (< 2 с)", time.time() - started < 2.0,
          f"{time.time() - started:.2f} с")


def graph_links(check) -> None:
    """Граф-улики капсулы: рёбра из `links` (формат graphify) и из `edges` (старые выгрузки).
    До 2026-10-09 retrieval читал только `edges` — на живом graph.json улики были пусты всегда."""
    import retrieval

    cls = next(o for o in vars(retrieval).values() if isinstance(o, type) and hasattr(o, "graph_evidence"))

    class _Cfg:
        def get(self, _key, default=None):
            return default

    for key in ("links", "edges"):
        r = cls.__new__(cls)
        r.cfg = _Cfg()
        graph = {"nodes": [{"id": "alpha_mod", "label": "alpha"}, {"id": "beta_mod", "label": "beta"}],
                 key: [{"source": "alpha_mod", "target": "beta_mod"}]}
        r._load_graph = lambda g=graph: g
        out = r.graph_evidence(["alpha"])
        check(f"знания: граф-улики находят соседей по ключу `{key}`",
              any("beta_mod" in repr(e) for e in out), out)
