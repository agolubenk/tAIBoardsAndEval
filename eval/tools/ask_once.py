#!/usr/bin/env python3
"""Ask the owner once: before a question goes to the owner, look for its answer in what the team already has.

    python3 -I eval/tools/ask_once.py check "можно ли арендовать вырубленную карточку?"
    python3 -I eval/tools/ask_once.py record --q "…" --a "…" --source "чат 01.11" [--id d-0111-felled]
    python3 -I eval/tools/ask_once.py record --q "…" --open --source "очередь, пункт 42"   # asked, waiting

Exit code of `check`: 0 — nothing found, ask (and `record --open` right after asking); 3 — answered: cite the hit,
do not ask; 4 — already asked and still open: wait for the answer in the owner queue, do not ask again.

Sources (repo-relative, nothing leaves the machine): the ledger `eval/data/decisions.jsonl` (owner answers and asked
questions, one JSON per line), the closed-items log `docs/plans/done/*.md`, the board spec
`boards/docs/t-boards-spec.md` (rows citing owner answers `Q-0xx`/decisions `D-0xx`; `Q-1xx` — open questions) and
the roadmap `docs/plans/roadmap/open-items.md` (rows with «В:» wait for the owner). Matching is TF-IDF over
crudely stemmed words (Russian and English), so a reworded question still finds its answer. Stdlib only.
"""
import argparse
import datetime
import json
import math
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
LEDGER = 'eval/data/decisions.jsonl'
DONE_DIR = 'docs/plans/done'
SPEC = 'boards/docs/t-boards-spec.md'
ROADMAP = 'docs/plans/roadmap/open-items.md'
LEDGER_BOOST = 1.25  # a curated question→answer pair beats a line that only shares words
WORD = re.compile(r'[0-9a-zа-яё]+', re.I)
STOP = set('и в во не на с со что как по к ко о об от до за из у же ли бы то это а но или для при без над под '
           'ли ещё уже да нет его её их мы вы он она они я ты можно нужно ли the a an of to in on for and or is '
           'are be it this that with as by at from do does should can we i'.split())
ENDINGS = ('ings', 'ing', 'ies', 'ied', 'ed', 'es', 's')


def stem(word):
    w = word.lower().replace('ё', 'е')
    if re.match(r'[а-я]', w):
        return w[:5]  # Russian morphology lives in the endings; five letters keep the root
    for end in ENDINGS:
        if len(w) > len(end) + 3 and w.endswith(end):
            return w[:-len(end)][:7]
    return w[:7]


def terms(text):
    return [stem(w) for w in WORD.findall(text) if w.lower() not in STOP and len(w) > 1]


def _lines(root, rel):
    path = os.path.join(root, rel)
    if not os.path.isfile(path):
        return []
    with open(path, encoding='utf-8', errors='replace') as f:
        return list(enumerate(f.read().splitlines(), 1))


def documents(root):
    """[(status, source, text)]; status: answered | open | done | spec | roadmap."""
    docs = []
    for n, line in _lines(root, LEDGER):
        if not line.strip():
            continue
        try:
            e = json.loads(line)
        except ValueError:
            continue
        status = 'open' if e.get('status') == 'open' else 'answered'
        # `kw` — keywords in the other language: the team writes in Russian and English
        text = '%s → %s [%s]' % (e.get('q', ''), e.get('a', '…ждёт ответа'), e.get('kw', ''))
        docs.append((status, '%s:%d (%s, %s)' % (LEDGER, n, e.get('id', '?'), e.get('source', '?')), text))
    done = os.path.join(root, DONE_DIR)
    if os.path.isdir(done):
        for name in sorted(os.listdir(done)):
            rel = '%s/%s' % (DONE_DIR, name)
            for n, line in _lines(root, rel):
                if line.startswith(('- ', '* ', '|')) and len(terms(line)) >= 4:
                    docs.append(('done', '%s:%d' % (rel, n), line))
    for n, line in _lines(root, SPEC):
        if not line.startswith('|') or len(terms(line)) < 4:
            continue
        if re.search(r'\bQ-1\d\d\b', line) and not re.search(r'\b[QD]-0\d\d\b', line):
            docs.append(('open', '%s:%d' % (SPEC, n), line))
        elif re.search(r'\b[QD]-0\d\d\b', line):
            docs.append(('spec', '%s:%d' % (SPEC, n), line))
    for n, line in _lines(root, ROADMAP):
        if line.startswith('|') and len(terms(line)) >= 4:
            docs.append(('open' if '| В' in line and '🔲' in line else 'roadmap', '%s:%d' % (ROADMAP, n), line))
    return docs


def rank(question, docs, top=3):
    """[(score, status, source, text)] by cosine of TF-IDF vectors."""
    bags = [terms(text) for _, _, text in docs]
    df = {}
    for bag in bags:
        for t in set(bag):
            df[t] = df.get(t, 0) + 1
    n = len(docs) or 1
    idf = {t: math.log((n + 1) / (c + 0.5)) for t, c in df.items()}

    def vec(bag):
        v = {}
        for t in bag:
            v[t] = v.get(t, 0) + idf.get(t, math.log(n + 1))
        norm = math.sqrt(sum(x * x for x in v.values())) or 1.0
        return {t: x / norm for t, x in v.items()}

    q = vec(terms(question))
    scored = []
    for (status, source, text), bag in zip(docs, bags):
        d = vec(bag)
        score = sum(w * d.get(t, 0.0) for t, w in q.items())
        if source.startswith(LEDGER):
            score *= LEDGER_BOOST
        if score > 0:
            scored.append((round(score, 3), status, source, text))
    scored.sort(key=lambda s: -s[0])
    return scored[:top]


def verdict(hits, threshold):
    strong = [h for h in hits if h[0] >= threshold]
    if not strong:
        return 0
    return 4 if strong[0][1] == 'open' else 3


def record(root, q, a, source, ident, is_open, date):
    if not q.strip() or not source.strip():
        raise SystemExit('ask_once: --q and --source are required')
    if not is_open and not (a or '').strip():
        raise SystemExit('ask_once: --a is required (or --open for an asked question that waits)')
    entry = {'id': ident or 'q-%s-%d' % (date.replace('-', ''), len(_lines(root, LEDGER)) + 1), 'date': date,
             'q': q.strip(), 'source': source.strip(), 'status': 'open' if is_open else 'answered'}
    if not is_open:
        entry['a'] = a.strip()
    path = os.path.join(root, LEDGER)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'a', encoding='utf-8') as f:
        f.write(json.dumps(entry, ensure_ascii=False) + '\n')
    return entry


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--root', default=ROOT)
    sub = ap.add_subparsers(dest='cmd', required=True)
    c = sub.add_parser('check')
    c.add_argument('question')
    c.add_argument('--threshold', type=float, default=0.25)
    c.add_argument('--top', type=int, default=3)
    c.add_argument('--json', action='store_true')
    r = sub.add_parser('record')
    r.add_argument('--q', required=True)
    r.add_argument('--a', default='')
    r.add_argument('--source', required=True)
    r.add_argument('--id', default='')
    r.add_argument('--open', action='store_true')
    r.add_argument('--date', default=datetime.date.today().isoformat())
    args = ap.parse_args(argv)

    if args.cmd == 'record':
        print(json.dumps(record(args.root, args.q, args.a, args.source, args.id, args.open, args.date),
                         ensure_ascii=False))
        return 0
    hits = rank(args.question, documents(args.root), args.top)
    code = verdict(hits, args.threshold)
    if args.json:
        print(json.dumps({'verdict': {0: 'ask', 3: 'answered', 4: 'open'}[code],
                          'hits': [dict(zip(('score', 'status', 'source', 'text'), h)) for h in hits]},
                         ensure_ascii=False, indent=1))
    else:
        label = {0: 'не найдено — спрашивай владельца, затем `record --open`',
                 3: 'уже решено — сошлись на источник, не спрашивай',
                 4: 'уже спрошено и ждёт ответа — смотри очередь владельца, не спрашивай повторно'}[code]
        print('ask_once: %s' % label)
        for score, status, source, text in hits:
            print('  %.2f %-8s %s\n       %s' % (score, status, source, text.strip()[:220]))
    return code


if __name__ == '__main__':
    sys.exit(main())
