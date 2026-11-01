#!/usr/bin/env python3
"""Focus on a large queue: the few cards to work on next, in the board's order, in a few hundred tokens.

    python3 -I eval/tools/queue_focus.py eval/board/plan-*.json            # board plan files (projects[].cards[])
    python3 -I eval/tools/queue_focus.py export.json --top 5 --wip 2       # an MCP `list_tasks` export (a list)
    python3 -I eval/tools/queue_focus.py plan.json --json

Order is the board's law (`.claude/rules/17-notion-board.md`), not a guess:
1. bugs before tasks (kind `bug`, a severity, or the «Ошибки» project), by severity critical → high → medium → low;
2. finish before starting: cards already in progress or on review come first — when their number reaches `--wip`,
   new starts are not proposed at all;
3. then priority (urgent/critical → high → medium → low), then how many open cards the card unblocks, then key.
Out of the focus: final statuses (done, Брёвна, closed, выполненные, завершённые, закрыто), raw ideas (`halfBaked`
— not taken without the owner's go-ahead) and decided «what we do not build» reports. A card blocked by an open card
is listed under «blocked» with its blockers instead of being proposed. A card with open subtasks (a goal, a branch)
is not a work item — its leaves are. Stdlib only.
"""
import argparse
import json
import sys

FINAL = {'done', 'closed', 'archived', 'брёвна', 'бревна', 'выполненные', 'завершённые', 'завершенные', 'закрыто'}
ACTIVE = {'in-progress', 'in-review', 'в работе', 'на ревью', 'review'}
RANK = {'urgent': 0, 'critical': 0, 'high': 1, 'medium': 2, 'low': 3}
BUG_PROJECTS = {'ошибки', 'bugs', 'errors'}


def _status(card):
    return str(card.get('status') or card.get('column') or '').strip().lower()


def load(paths):
    """Cards from plan files ({projects: [{key, name, cards}]}) or exports (a list of tasks, or {tasks: [...]})."""
    cards = []
    for path in paths:
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
        if isinstance(data, dict) and 'projects' in data:
            for project in data['projects']:
                for card in project.get('cards', []):
                    cards.append(dict(card, _project=str(project.get('name') or project.get('key') or '')))
        else:
            rows = data.get('tasks', data.get('items', [])) if isinstance(data, dict) else data
            for card in rows:
                key = card.get('key') or card.get('ticketId') or card.get('backlogId') or card.get('id')
                cards.append(dict(card, key=str(key), _project=str(card.get('project') or card.get('projectName') or '')))
    by_key = {}
    for card in cards:  # the same card in two plans: the later file wins (plans are patches)
        by_key[str(card['key'])] = card
    return by_key


def is_bug(card):
    return (card.get('kind') == 'bug' or bool(card.get('severity'))
            or card.get('_project', '').strip().lower() in BUG_PROJECTS)


def blockers_of(cards):
    """{key: [open blocker keys]} from `blocks` (this card blocks those) and `blockedBy`."""
    out = {}
    for key, card in cards.items():
        for target in card.get('blocks', []) or []:
            out.setdefault(str(target), set()).add(key)
        for source in card.get('blockedBy', []) or []:
            out.setdefault(key, set()).add(str(source))
    return {k: sorted(b for b in v if b in cards and _status(cards[b]) not in FINAL) for k, v in out.items()}


def unblocks(cards, key, seen=None):
    """Open cards this one unblocks, transitively."""
    seen = set() if seen is None else seen
    for target in cards.get(key, {}).get('blocks', []) or []:
        target = str(target)
        if target in cards and target not in seen and _status(cards[target]) not in FINAL:
            seen.add(target)
            unblocks(cards, target, seen)
    return seen


def focus(cards, top=7, wip=3):
    blocked_by = blockers_of(cards)
    # A card with open subtasks is a root or a branch of the forest: the work is in its leaves.
    containers = {str(c['parent']) for c in cards.values() if c.get('parent') and _status(c) not in FINAL}
    skipped = {'final': 0, 'halfBaked': 0, 'report': 0, 'container': 0}
    candidates, blocked = [], []
    for key, card in cards.items():
        status = _status(card)
        if status in FINAL:
            skipped['final'] += 1
            continue
        if card.get('halfBaked'):
            skipped['halfBaked'] += 1
            continue
        if card.get('report'):
            skipped['report'] += 1
            continue
        if key in containers:
            skipped['container'] += 1
            continue
        item = {
            'key': key,
            'title': str(card.get('title', '')),
            'status': status or 'to-do',
            'priority': str(card.get('severity') or card.get('priority') or 'low').lower(),
            'bug': is_bug(card),
            'active': status in ACTIVE,
            'unblocks': len(unblocks(cards, key)),
        }
        if blocked_by.get(key) and not item['active']:
            item['blockedBy'] = blocked_by[key]
            blocked.append(item)
        else:
            candidates.append(item)
    order = lambda i: (not i['bug'], not i['active'], RANK.get(i['priority'], 4), -i['unblocks'], i['key'])  # noqa: E731
    candidates.sort(key=order)
    blocked.sort(key=order)
    active = [i for i in candidates if i['active']]
    if len(active) >= wip:  # WIP limit: finish what is open, start nothing new
        picked = active[:top]
        note = 'WIP %d ≥ %d: доведи начатое, новое не бери' % (len(active), wip)
    else:
        picked = candidates[:top]
        note = 'WIP %d из %d' % (len(active), wip)
    return {'focus': picked, 'blocked': blocked[:top], 'note': note, 'open': len(candidates) + len(blocked),
            'skipped': skipped}


def render(result):
    sk = result['skipped']
    lines = ['Фокус (%s; открыто %d; вне фокуса: финальные %d, сырые идеи %d, отчёты %d, ветки с открытыми '
             'подзадачами %d):' % (result['note'], result['open'], sk['final'], sk['halfBaked'], sk['report'],
                                   sk['container'])]
    for i in result['focus']:
        tag = 'bug ' if i['bug'] else ''
        more = ' · открывает %d' % i['unblocks'] if i['unblocks'] else ''
        lines.append('  %s · %s%s · %s%s · %s' % (i['key'], tag, i['priority'], i['status'], more, i['title'][:80]))
    if result['blocked']:
        lines.append('Ждут блокеров:')
        for i in result['blocked']:
            lines.append('  %s ← %s · %s' % (i['key'], ', '.join(i['blockedBy']), i['title'][:70]))
    return '\n'.join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('files', nargs='+')
    ap.add_argument('--top', type=int, default=7)
    ap.add_argument('--wip', type=int, default=3, help='open in-progress/review cards before new starts stop')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args(argv)
    result = focus(load(args.files), args.top, args.wip)
    print(json.dumps(result, ensure_ascii=False, indent=1) if args.json else render(result))
    return 0


if __name__ == '__main__':
    sys.exit(main())
