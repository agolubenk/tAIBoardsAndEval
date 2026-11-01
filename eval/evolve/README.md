# eval/evolve — the layer evolves by itself, without paying twice

> **Status (2026-11-01):** working toolkit, stdlib Python, tests `python3 -I -m unittest discover -s eval/evolve -p 'test_*.py'`.
> Source of truth: the code in this folder. The cycle is **variation → measurement → selection → pin**.

The process layer (skills, rules, subagents, commands, role cards, launch prompts, hooks, genome source) changes
every day. This folder keeps three promises:

1. **Every change is versioned without a manual step.** Git counts the versions; nobody bumps a number by hand.
2. **A new version wins on quality first, then on tokens.** A cheaper version that is worse is not selected.
3. **Nothing is paid for twice.** That covers a fact repeated in the context every session loads, a question the
   owner already answered, and a queue re-read in full by every descendant.

## The cycle

| Step | Tool | What it does |
|---|---|---|
| Variation | any edit of a layer file, or a session that proposes one | — |
| Version | git, read by `catalog.py` | The version of an artifact is the number of commits that changed it; `rev` is the last of them, `dirty` marks uncommitted edits. Every merged change is a new version with no extra step, no hook and no file to conflict on. One artifact's history: `git log --oneline -- <path>`. |
| Measure: cost | `catalog.py` | Always-loaded tokens (L1) per role genome. This is the root card, rules without `paths:`, and the skill, agent and command listings, where a skill switched off costs 0 and a name-only one costs its name. `budget.json` is a ratchet: L1 of a role may not grow past it, and CI checks that (`catalog.py --check`, layer CI). Headroom is 5 %, about 250–400 tokens per role, so it trips on purpose: cut a duplicate, or raise the cap with `--ratchet` as a visible edit in the PR. |
| Measure: waste | `dupes.py` | Clusters of the same sentence across artifacts, priced in tokens. `--l1` keeps only copies inside every session's start. `--against-l1 FILE` lists the lines of a handoff that repeat L1. `spawn_session.sh` runs it before a successor starts. |
| Measure: quality | `ab.py` + `cases/*.jsonl` | Blind A/B of two versions (git revisions or the working tree) by a judge through the local llm-gateway. Each case is judged twice with the sides swapped, so position bias cancels. Two modes: `instructions` (2 calls per case) and `outputs` (4 calls per case). |
| Select | `ab.py` | B is taken when it wins (≥ 60 % of decisive cases, at least 2), or when it is not worse and cheaper. Otherwise A is kept. |
| Pin | `ab.py --record` | The verdict goes into `verdicts.jsonl` with both versions as commit ids. A fake judge, a working-tree version, fewer than 2 decisive cases or even one judge answer out of format is never evidence. |

## No repeats, no getting lost

| Problem | Tool |
|---|---|
| Asking the owner what is already decided, or what is already asked and waiting | `eval/tools/ask_once.py check "<question>" [--oq <oq_list export>]`. Owner answers come from the ledger `eval/data/decisions.jsonl` (the last line of an id wins), `docs/plans/done/` and spec rows citing `Q-0xx`/`D-0xx`. Open questions come from the owner queue, spec `Q-1xx` and roadmap «В:» rows. Exit 3: a candidate answer, so read it and cite it if it really answers (measured 01.11: 7 of 8 answers found, 1 false candidate in 8). Exit 4: already open, do not ask again. After the answer: `record`. Wired into the skills `grill-task` and `successor-handoff`. |
| A descendant re-reading the whole queue | `eval/tools/queue_focus.py <plan or export> [--session <lineage>]`. It returns a few lines in the board's order: bugs by severity, finish before starting (a WIP limit), priority, then how much a card unblocks. Final statuses, raw ideas and goals with open leaves are left out; blocked cards are listed with their blockers. With `--session` (default `$TAIBE_LINEAGE`), cards held by other sessions leave the focus and the WIP count. |
| Sessions that look alike but must not be confused | `spawn_session.sh` gives every descendant a lineage id under its parent's (`TAIBE_LINEAGE`, e.g. `r.x1y2.k3z4`, generation = dots). The first message names it, and the session uses it as its `session` label on cards and in the queue. Launch template, genome and handoff structure stay the same for all. |
| Handoff ids lost between generations | `eval/tools/handoff_ids.py collect/diff` (existing). |

## Commands

```bash
python3 -I eval/evolve/catalog.py              # versions from git, L1 per role vs budget (also: make evolve)
python3 -I eval/evolve/catalog.py --ratchet    # set budgets to today's L1 + 5 % (commit budget.json on purpose)
python3 -I eval/evolve/dupes.py --l1           # duplicates every session pays for
python3 -I eval/evolve/dupes.py --against-l1 handoff.md --max-waste 300
python3 -I eval/evolve/ab.py --artifact .claude/skills/grill-task/SKILL.md --a HEAD~1 --b work \
    --cases eval/evolve/cases/grill-task.jsonl                # needs the llm-gateway; --record only for commits
python3 -I eval/tools/ask_once.py check "can a subtask have two parents?"
python3 -I eval/tools/queue_focus.py eval/board/plan-*.json  # also: make focus
```

## Limits — measured, not assumed

- Token counts are the eval estimate (`tokens.py`: Latin ~3.5 chars per token, Cyrillic ~2.2), the same one
  `context_audit.py` uses. They are good for comparing versions, not for billing.
- L1 counts only what the layer adds. The harness's own system prompt and MCP tool descriptions are measured by
  `eval/tools/context_audit.py` on real transcripts.
- `ab.py` with a real judge has not run in this repository's CI: CI has no gateway. The harness, the swap rule and
  the selection rule are covered by tests with a scripted judge. Before relying on the judge, measure how often it
  agrees with the owner on 10–20 labelled cases (proposal 5 in `docs/integrations/README.md`).
- `ask_once.py` uses TF-IDF with crude stemming and no embeddings. Every ledger entry carries `kw`, keywords in
  the other language, so a question in English finds an answer written in Russian. Expect false negatives on
  heavy rewording: the agent reads the hits, the exit code is a hint.

## Origins

- Blind A/B judging of skill versions comes from [i-have-adhd](https://github.com/ayghri/i-have-adhd) (MIT), as an
  idea; no code was taken. Review: [`docs/integrations/i-have-adhd/`](../../docs/integrations/i-have-adhd/README.md).
- Untrusted text goes between fences with a random nonce per call. The idea comes from
  [agno](https://github.com/agno-agi/agno); review: [`docs/integrations/agno/`](../../docs/integrations/agno/README.md).
