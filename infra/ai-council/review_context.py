#!/usr/bin/env python3
"""AI Council — досье карточки для ревью. Только stdlib.

Ревью отвечает на «сделано ли то, что заявлено», поэтому кроме постановки модели нужны
улики исполнения: отчёт исполнителя в комментариях, коммиты и их дифф, запись в DONE.md.
Без диффа ревьюер оценивает пересказ работы, а не работу — ровно тот класс «принято на
слово», ради которого ревью и заводится.

Источники коммитов — только проверяемые: SHA из текста карточки (подтверждённый
`git cat-file`) и `git log --grep` по Backlog ID. Дифф режется по бюджету, файл за
файлом, а не посередине хунка.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

from retrieval import clip_to_tokens, est_tokens
from store import REPO_ROOT

REVIEW_COMMENT_MARK = "🤖 Ревью консилиума"
_SHA_RE = re.compile(r"(?<![0-9a-fA-F])([0-9a-f]{7,40})(?![0-9a-fA-F])")
_GIT_CANDIDATES = ("/Library/Developer/CommandLineTools/usr/bin/git", "/opt/homebrew/bin/git",
                   "/usr/local/bin/git")
_git_bin: str | None = None


def git_bin() -> str | None:
    """/usr/bin/git на этой машине может упираться в непринятую лицензию Xcode
    (CLAUDE.local.md) — сначала рабочие бинарники CLT/Homebrew, затем PATH."""
    global _git_bin
    if _git_bin is not None:
        return _git_bin or None
    for cand in (*_GIT_CANDIDATES, shutil.which("git") or ""):
        if not cand or not Path(cand).exists():
            continue
        try:
            res = subprocess.run([cand, "--version"], capture_output=True, text=True, timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            continue
        if res.returncode == 0:
            _git_bin = cand
            return cand
    _git_bin = ""
    return None


def _git(*args: str, timeout: int = 20) -> str:
    binary = git_bin()
    if not binary:
        return ""
    try:
        res = subprocess.run([binary, "-C", str(REPO_ROOT), *args], capture_output=True,
                             text=True, timeout=timeout, errors="replace")
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return res.stdout if res.returncode == 0 else ""


def card_comments(card: dict, include_own: bool = True) -> list[dict]:
    try:
        comments = json.loads(card.get("comments") or "[]")
    except ValueError:
        comments = []
    if include_own:
        return comments
    return [c for c in comments if not (c.get("text") or "").startswith(REVIEW_COMMENT_MARK)]


def commit_candidates(card: dict, limit: int = 6) -> list[str]:
    text = "\n".join([card.get("body") or "", card.get("report") or "",
                      "\n".join(c.get("text", "") for c in card_comments(card, include_own=False))])
    shas: list[str] = []
    for raw in _SHA_RE.findall(text):
        if raw in shas or raw.isdigit():
            continue
        full = _git("rev-parse", "--verify", "--quiet", f"{raw}^{{commit}}").strip()
        if full and full not in shas:
            shas.append(full)
        if len(shas) >= limit:
            return shas
    backlog_id = (card.get("backlog_id") or "").strip()
    if backlog_id and len(shas) < limit:
        # Граница слова: B-6 не должен находить B-65.
        pattern = rf"(^|[^A-Za-z0-9-]){re.escape(backlog_id)}([^0-9]|$)"
        out = _git("log", "--all", "-E", "-i", f"--grep={pattern}", "--format=%H",
                   f"-n{limit}")
        for sha in out.split():
            if sha not in shas:
                shas.append(sha)
            if len(shas) >= limit:
                break
    return shas


def commit_evidence(shas: list[str], budget_tokens: int) -> tuple[str, list[dict]]:
    """Шапка + stat по каждому коммиту всегда; патч — пока влезает в бюджет."""
    if not shas or budget_tokens <= 0:
        return "", []
    meta, heads = [], []
    for sha in shas:
        head = _git("show", "-s", "--format=%h %ad %an%n%s%n%b", "--date=short", sha).strip()
        stat = _git("show", "--stat=120", "--format=", sha).strip()
        heads.append(f"### commit {head}\n{stat}")
        meta.append({"sha": sha[:12], "subject": head.split("\n", 2)[1] if "\n" in head else head})
    text = "\n\n".join(heads)
    left = budget_tokens - est_tokens(text)
    patches = []
    for sha in shas:
        if left < 300:
            break
        patch = _git("show", "--format=", "--unified=2", "--no-color", sha, timeout=30)
        if not patch:
            continue
        # Лок-файлы, снапшоты и сгенерированное — шум, на ревью кода не влияет.
        files = re.split(r"(?m)^(?=diff --git )", patch)
        kept = [f for f in files if f.strip() and not re.search(
            r"diff --git a/\S*(package-lock\.json|\.lock|\.snap|ruDefaultValuesFlat\.json|"
            r"/locales/[a-z-]+\.json|\.min\.|\.svg|\.png|\.jpg|graph\.json)", f)]
        chunk = ""
        for f in kept:
            if est_tokens(chunk + f) > left:
                chunk += f"\n[…дифф обрезан по бюджету, осталось файлов: {len(kept) - kept.index(f)}]\n"
                break
            chunk += f
        if chunk.strip():
            patches.append(f"### patch {sha[:10]}\n{chunk.strip()}")
            left -= est_tokens(chunk)
    if patches:
        text += "\n\n" + "\n\n".join(patches)
    return text, meta


def done_md_lines(card: dict, max_lines: int = 6) -> str:
    backlog_id = (card.get("backlog_id") or "").strip()
    if not backlog_id:
        return ""
    lines: list[str] = []
    for path in sorted((REPO_ROOT / "docs/plans/done").rglob("*.md")):
        try:
            lines += path.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
    rx = re.compile(rf"(^|[^A-Za-z0-9-]){re.escape(backlog_id)}([^0-9]|$)")
    # Шапка модуля (`> **…:**`) и заголовки — не записи: без фильтра префикс из шапки
    # (`TOUR-`) выдавал открытую карточку TOUR за закрытую.
    hits = [ln.strip() for ln in lines
            if not ln.lstrip().startswith((">", "#")) and rx.search(ln)]
    return "\n".join(hits[:max_lines])


def card_text(card: dict, include_comments: bool, include_council_block: bool) -> str:
    modules = json.loads(card.get("modules") or "[]")
    kind = "Ошибка" if card.get("board") == "bugs" else "Задача"
    weight = card.get("severity") or card.get("priority") or "—"
    body = card.get("body") or ""
    if not include_council_block:
        body = re.sub(r"<!-- council:v1:begin -->.*?<!-- council:v1:end -->", "", body, flags=re.S)
    parts = [
        f"{kind} · {weight} · статус: {card.get('status') or '—'}"
        + (f" · {card['backlog_id']}" if card.get("backlog_id") else ""),
        f"Заголовок: {card.get('title') or ''}",
        f"Модули: {', '.join(modules) if modules else 'не указаны'}",
    ]
    if card.get("half_baked"):
        parts.append("ВНИМАНИЕ: карточка помечена Half-baked idea (сырая постановка владельца).")
    if card.get("report"):
        parts.append(f"Report (ссылка на код): {card['report']}")
    parts.append("## Постановка (тело карточки)\n" + (body.strip() or "— пусто —"))
    if include_comments:
        comments = card_comments(card)
        if comments:
            parts.append("## Комментарии (обсуждение и отчёты исполнителя, старые → новые)\n" +
                         "\n\n".join(f"[{(c.get('at') or '')[:10]}] {c.get('text', '')}"
                                     for c in comments))
    return "\n\n".join(parts)


def build_dossier(card: dict, ctx: dict, budget_tokens: int, retriever=None) -> tuple[str, dict]:
    """Возвращает (текст досье, метаданные для снимка прогона).

    Бюджет делится: карточка ≤ 40%, git ≤ 45%, правила/знания ≤ 15% (остаток карточки и
    git перетекает дальше). Карточка режется с конца — комментарии новее важнее, но
    постановка важнее комментариев, поэтому порядок в тексте сохранён, режется хвост."""
    meta: dict = {"budget_tokens": budget_tokens, "commits": [], "rag": 0}
    card_part = card_text(card, ctx.get("include_comments", True),
                          ctx.get("include_council_block", True))
    card_budget = int(budget_tokens * 0.40)
    if est_tokens(card_part) > card_budget:
        card_part = clip_to_tokens(card_part, card_budget)
        meta["card_clipped"] = True
    left = budget_tokens - est_tokens(card_part)
    sections = [card_part]

    if ctx.get("use_git", True):
        shas = commit_candidates(card)
        git_text, commits = commit_evidence(shas, int(min(left * 0.75, budget_tokens * 0.45)))
        done = done_md_lines(card)
        if done:
            git_text = (git_text + "\n\n" if git_text else "") + "### docs/plans/done/ (закрытое)\n" + done
        meta["commits"] = commits
        meta["done_md"] = bool(done)
        sections.append("## Улики исполнения (git)\n" + (git_text or
                        "— коммитов по SHA из карточки и по Backlog ID не найдено —"))
        left = budget_tokens - sum(est_tokens(s) for s in sections)

    if ctx.get("use_rag", True) and retriever is not None and left > 400:
        try:
            capsule = retriever.build({**card, "db": card.get("board")})
            ev = clip_to_tokens(capsule.evidence_text(), max(300, left - 100))
            if ev.strip():
                sections.append("## Правила и знания проекта (RAG)\n" + ev)
                meta["rag"] = len(capsule.evidence)
        except Exception as exc:                                   # noqa: BLE001
            meta["rag_error"] = f"{type(exc).__name__}: {exc}"[:200]

    text = "\n\n".join(sections)
    meta["tokens"] = est_tokens(text)
    return text, meta
