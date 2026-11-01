#!/usr/bin/env python3
"""handoff_ids.py — передача дел по id, а не пересказом (R4-PLAN Ф1.2). Только stdlib.

    python3 -I eval/tools/handoff_ids.py collect [--repo DIR] [--gh owner/repo] [--oq items.json] [--agent МЕТКА]
                                                 [--work-state ws.json]
    python3 -I eval/tools/handoff_ids.py diff <отчёт.md> <файл роли>...

collect печатает блок `ids:` — по строке на открытое дело: `id · статус · дальше · блокер · ветка@голова`.
Источники: `git worktree list --porcelain` (всегда), открытые PR через `gh api` (`--gh`), выгрузка очереди
владельца (`--oq`, документы `{id, data:{...}}`; с `--agent` — только пункты, захваченные этой меткой: `agentBy`,
`session`, `source`), выгрузка work_state (`--work-state`, список `{id|key, status, next, blockers}`).
Недоступный источник не роняет сбор: строка `# <источник>: <ошибка>` в выводе.

diff печатает id, которые упомянуты в отчёте предшественника, но не встречаются ни в одном файле наследников:
`#123`, пункты очереди `c-…`/`d-…`/`m-…`/`s-…`/`i-…`, ключи карточек `TB-12`, полосы `tb-b10`. Код 1, если есть
пропавшие — так проверку можно поставить в конец передачи.
"""
import argparse
import json
import re
import subprocess
import sys

ID_RE = re.compile(r"(?<![\w/.-])(#\d+|[cdmsi]-[a-z0-9][a-z0-9-]*[a-z0-9]|[A-Z]{2,6}-\d+|tb-[a-z0-9]+)(?![\w-])")


def run(cmd, cwd=None):
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=60, cwd=cwd)
    if p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout).strip()[:200] or f"{cmd[0]}: код {p.returncode}")
    return p.stdout


def line(ident, status="—", nxt="—", blocker="—", where="—"):
    clean = [str(x or "—").replace("\n", " ").replace("·", ",").strip() or "—" for x in (ident, status, nxt, blocker, where)]
    return " · ".join(clean)


def from_worktrees(repo):
    out, cur = [], {}
    for raw in run(["git", "-C", repo, "worktree", "list", "--porcelain"]).splitlines() + [""]:
        if not raw.strip():
            if cur:
                branch = cur.get("branch", "(detached)").replace("refs/heads/", "")
                out.append(line(f"wt:{cur['worktree']}", "worktree", where=f"{branch}@{cur.get('HEAD', '')[:9]}"))
            cur = {}
            continue
        key, _, val = raw.partition(" ")
        cur[key] = val
    return out[1:]  # первая — основной checkout, не дело


def from_gh(repo):
    pulls = json.loads(run(["gh", "api", f"repos/{repo}/pulls?state=open&per_page=50"]) or "[]")
    return [line(f"#{p['number']}", "draft" if p.get("draft") else "open", p.get("title", "")[:60],
                 where=f"{p['head']['ref']}@{p['head']['sha'][:9]}") for p in pulls]


def from_oq(docs, agent):
    out = []
    for doc in docs:
        d = doc.get("data", doc)
        if d.get("done") or str(d.get("status", "")).lower() in ("done", "closed"):
            continue
        if agent and agent not in {d.get("agentBy"), d.get("session"), d.get("source")}:
            continue
        out.append(line(doc.get("id"), d.get("status") or d.get("kind"), d.get("title", "")[:60], d.get("blocker")))
    return out


def from_work_state(items):
    out = []
    for it in items:
        if str(it.get("status", "")).lower() in ("done", "closed"):
            continue
        blockers = it.get("blockers")
        if isinstance(blockers, list):
            blockers = ", ".join(map(str, blockers))
        out.append(line(it.get("id") or it.get("key"), it.get("status"), it.get("next"), blockers, it.get("branch")))
    return out


def load(path):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return data.get("docs", data.get("items", [])) if isinstance(data, dict) else data


def collect(a):
    lines, sources = [], [("worktrees", lambda: from_worktrees(a.repo))]
    if a.gh:
        sources.append(("gh", lambda: from_gh(a.gh)))
    if a.oq:
        sources.append(("oq", lambda: from_oq(load(a.oq), a.agent)))
    if a.work_state:
        sources.append(("work_state", lambda: from_work_state(load(a.work_state))))
    for name, fn in sources:
        try:
            lines.extend(fn())
        except (OSError, ValueError, RuntimeError, KeyError, subprocess.SubprocessError) as e:
            lines.append(f"# {name}: {e}")
    print("ids:")
    for ln in lines:
        print(ln if ln.startswith("#") else f"- {ln}")
    return 0


def ids_in(text):
    return set(ID_RE.findall(text))


def diff(a):
    with open(a.report, encoding="utf-8") as f:
        wanted = ids_in(f.read())
    seen = set()
    for path in a.files:
        with open(path, encoding="utf-8") as f:
            seen |= ids_in(f.read())
    lost = sorted(wanted - seen)
    for ident in lost:
        print(ident)
    print(f"# пропало {len(lost)} из {len(wanted)}", file=sys.stderr)
    return 1 if lost else 0


def main(argv):
    ap = argparse.ArgumentParser(prog="handoff_ids")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("collect")
    c.add_argument("--repo", default=".")
    c.add_argument("--gh")
    c.add_argument("--oq")
    c.add_argument("--agent")
    c.add_argument("--work-state")
    d = sub.add_parser("diff")
    d.add_argument("report")
    d.add_argument("files", nargs="+")
    a = ap.parse_args(argv)
    return collect(a) if a.cmd == "collect" else diff(a)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
