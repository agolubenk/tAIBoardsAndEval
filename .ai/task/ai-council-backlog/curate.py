#!/usr/bin/env python3
"""Раздельные улики по полям: где именно нашли совпадение (title/body/comments/report/modules/tags)."""
import json
import re

raw = json.load(open('.ai/task/ai-council-backlog/raw.json'))

CORE = [
    r"\bконсилиум", r"\bcouncil\b", r"ai[- ]council",
    r"\bverifier\b", r"верификатор", r"\bnotion[- ]sync\b",
    r"\bproposer\b", r"\barbiter\b", r"\bskeptic\b",
    r"модельн\w* лок", r"ростер", r"проработк\w+ постановк",
]
ECO = [
    r"\bdams\b", r"\brag\b", r"\bfts5\b", r"pgvector", r"эмбеддинг", r"\bembedding",
    r"headroom",
    r"\bollama\b", r"\bglm\b", r"\bz\.ai\b", r"\bqwen\w*", r"\bmistral\w*", r"\bgemini\b",
    r"\bdeepseek\b", r"\bllm\b",
    r"graphify", r"ai[- ]pipeline", r"ai[- ]tooling", r"\bmcp\b",
    r"\bclaude\b", r"\bcontinue\b",
    r"промпт", r"\brubric\b", r"рубрик", r"облачн", r"\bsupervisor\b",
    r"\bgateway\b", r"\bplanner\b", r"\blearning\b",
]
ALL_PATTERNS = [(p, re.compile(p, re.I)) for p in CORE + ECO]


def hits(text):
    out = []
    for p, rx in ALL_PATTERNS:
        found = rx.findall(text or "")
        if found:
            out.append((p, found[:2]))
    return out


def snippet(text, width=60):
    for _, rx in ALL_PATTERNS:
        m = rx.search(text or "")
        if m:
            s = max(0, m.start() - width)
            return (text[s:m.end() + width] or "").replace("\n", " ")
    return ""


for c in raw:
    title = c.get("title", "")
    if not hits(title):
        continue
    body = c.get("body", "") or ""
    comments = " | ".join(ct.get("text", "") for ct in c.get("comments_text", []))
    modules = " ".join(json.loads(c.get("modules", "[]") or "[]"))

    print(f"=== [{c['db']}] {c.get('status')} | {c.get('url')}")
    print(f"    title: {title[:110]}")
    print(f"    title_hits: {hits(title)}")
    print(f"    body_hits: {hits(body)[:6]}")
    print(f"    comments_hits: {hits(comments)[:4]}")
    print(f"    snippet_body: {snippet(body)[:170]}")
    print(f"    modules={modules} | pr={c.get('priority') or c.get('severity')} | hb={c.get('half_baked')} | bid={c.get('backlog_id')}")