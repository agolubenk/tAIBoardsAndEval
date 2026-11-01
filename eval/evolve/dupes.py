#!/usr/bin/env python3
"""Duplicate facts across the process layer, priced in tokens.

    python3 -I eval/evolve/dupes.py                       # clusters of the same sentence in several artifacts
    python3 -I eval/evolve/dupes.py --l1                  # only duplicates inside the always-loaded context
    python3 -I eval/evolve/dupes.py --against-l1 FILE     # lines of a handoff/prompt that every session already has
    python3 -I eval/evolve/dupes.py --against-l1 FILE --max-waste 300   # exit 1 when the waste is larger

A sentence is a unit of ≥ 8 words after normalisation (case, markdown, punctuation). Two units match when their
word 3-gram sets overlap by Jaccard ≥ 0.6 (default). "Waste" is what the copies cost beyond the first: for a cluster
in L1 it is paid by every session on every start; outside L1 — once per read. A rule that says "see CLAUDE.md"
costs a line; a rule that restates CLAUDE.md costs the paragraph. Stdlib only.
"""
import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import catalog  # noqa: E402
from tokens import est_tokens, front_matter  # noqa: E402

MIN_WORDS = 8
SHINGLE = 3
WORD = re.compile(r'[0-9a-zа-яё_]+', re.I)
SPLIT = re.compile(r'(?<=[.!?;])\s+|\n\s*\n|\n(?=\s*(?:[-*]|\d+\.|\|)\s)')


def units(text):
    """[(normalised words, original text)] — sentences and list items of a markdown text; code blocks dropped."""
    text = re.sub(r'```.*?```', ' ', text, flags=re.S)
    out = []
    for raw in SPLIT.split(text):
        raw = raw.strip()
        words = [w.lower() for w in WORD.findall(raw)]
        if len(words) >= MIN_WORDS:
            out.append((words, raw))
    return out


def shingles(words):
    return {' '.join(words[i:i + SHINGLE]) for i in range(len(words) - SHINGLE + 1)}


def jaccard(a, b):
    return len(a & b) / len(a | b) if a and b else 0.0


def _read(root, path):
    with open(os.path.join(root, path), encoding='utf-8', errors='replace') as f:
        text = f.read()
    return front_matter(text)[1] if path.endswith('.md') else ''


def collect(root, l1_only=False):
    """[(path, words, text, shingle set, in_l1)] over the catalog's markdown artifacts."""
    items = catalog.scan(root)
    out = []
    for path, item in items.items():
        if not path.endswith('.md'):
            continue
        in_l1 = bool(item.get('always'))
        if l1_only and not in_l1:
            continue
        for words, text in units(_read(root, path)):
            out.append((path, words, text, shingles(words), in_l1))
    return out


def clusters(entries, threshold=0.6):
    """Groups of near-identical units that occur in ≥ 2 different files (inverted index on shingles)."""
    index = {}
    for i, entry in enumerate(entries):
        for s in entry[3]:
            index.setdefault(s, []).append(i)
    parent = list(range(len(entries)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, entry in enumerate(entries):
        seen = set()
        for s in entry[3]:
            for j in index[s]:
                if j <= i or j in seen:
                    continue
                seen.add(j)
                if entries[j][0] != entry[0] and jaccard(entry[3], entries[j][3]) >= threshold:
                    parent[find(j)] = find(i)
    groups = {}
    for i in range(len(entries)):
        groups.setdefault(find(i), []).append(i)
    out = []
    for members in groups.values():
        files = sorted({entries[i][0] for i in members})
        if len(files) < 2:
            continue
        cost = max(est_tokens(entries[i][2]) for i in members)
        l1_copies = len({entries[i][0] for i in members if entries[i][4]})
        out.append({
            'files': files,
            'text': entries[members[0]][2][:160],
            'tokens': cost,
            'waste': cost * (len(files) - 1),
            'l1_waste': cost * max(l1_copies - 1, 0),
        })
    return sorted(out, key=lambda c: (-c['l1_waste'], -c['waste'], c['files']))


def against_l1(root, path, threshold=0.6):
    """Units of FILE that duplicate the always-loaded context: [(tokens, text, l1 file)]."""
    with open(path, encoding='utf-8', errors='replace') as f:
        text = f.read()
    l1 = collect(root, l1_only=True)
    out = []
    for words, raw in units(text):
        sh = shingles(words)
        best = max(((jaccard(sh, e[3]), e[0]) for e in l1), default=(0.0, None))
        if best[0] >= threshold:
            out.append((est_tokens(raw), raw[:160], best[1]))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--root', default=catalog.ROOT)
    ap.add_argument('--l1', action='store_true', help='only duplicates inside the always-loaded context')
    ap.add_argument('--against-l1', metavar='FILE')
    ap.add_argument('--max-waste', type=int, default=None, help='exit 1 when waste (tokens) is larger')
    ap.add_argument('--threshold', type=float, default=0.6)
    ap.add_argument('--top', type=int, default=15)
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args(argv)

    if args.against_l1:
        hits = against_l1(args.root, args.against_l1, args.threshold)
        waste = sum(t for t, _, _ in hits)
        if args.json:
            print(json.dumps({'waste': waste, 'hits': hits}, ensure_ascii=False, indent=1))
        else:
            for tok, text, src in hits[:args.top]:
                print('%4d tok  already in %s: %s' % (tok, src, text.replace('\n', ' ')))
            print('%s: %d tokens repeat what every session already loads' % (args.against_l1, waste))
        return 1 if args.max_waste is not None and waste > args.max_waste else 0

    found = clusters(collect(args.root, l1_only=args.l1), args.threshold)
    waste = sum(c['waste'] for c in found)
    l1_waste = sum(c['l1_waste'] for c in found)
    if args.json:
        print(json.dumps({'waste': waste, 'l1_waste': l1_waste, 'clusters': found}, ensure_ascii=False, indent=1))
    else:
        for c in found[:args.top]:
            print('%4d tok × %d  L1 %4d  %s\n      %s' % (c['tokens'], len(c['files']), c['l1_waste'],
                                                     ' · '.join(c['files']), c['text'].replace('\n', ' ')))
        print('%d clusters: %d tokens of copies, %d of them in every session start (L1)' % (len(found), waste, l1_waste))
    return 1 if args.max_waste is not None and (l1_waste if args.l1 else waste) > args.max_waste else 0


if __name__ == '__main__':
    sys.exit(main())
