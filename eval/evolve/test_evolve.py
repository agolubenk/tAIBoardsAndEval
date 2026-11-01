#!/usr/bin/env python3
"""Evolution toolkit on a synthetic layer: catalog versions and L1 per role, duplicate clusters and handoff waste,
blind A/B with a scripted judge. Run: python3 -I -m unittest discover -s eval/evolve -p 'test_*.py'"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ab  # noqa: E402
import catalog  # noqa: E402
import dupes  # noqa: E402
from tokens import est_tokens, front_matter  # noqa: E402

SHARED = 'Every decision gets an adversarial review by at least three independent participants with different lenses.'


def write(root, rel, text):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)


def layer(root):
    write(root, 'CLAUDE.md', '# Root\n\n%s\n' % SHARED)
    write(root, '.claude/rules/01-base.md', '# Base\n\nKeep files under five hundred lines and split them early.\n')
    write(root, '.claude/rules/02-backend.md', '---\npaths:\n  - apps/backend/**\n---\n# Backend\n\n%s\n' % SHARED)
    write(root, '.claude/skills/grill/SKILL.md',
          '---\nname: grill\ndescription: Roast a task before the work starts.\n---\n# grill\n\nBody text.\n')
    write(root, '.claude/skills/animate/SKILL.md',
          '---\nname: animate\ndescription: Build an animation from scratch with many careful steps.\n---\nBody.\n')
    write(root, '.claude/agents/scout.md', '---\nname: scout\ndescription: Fast read-only reconnaissance.\n---\nx\n')
    write(root, '.claude/hooks/gate.py', 'print(1)\n')
    write(root, '.claude/hooks/test_gate.py', 'print(2)\n')
    write(root, '.continue/rules/mirror.md', 'generated mirror, never cataloged\n')
    write(root, 'eval/pipeline/genome/roles.json', json.dumps({
        'base': {'skills_off': ['animate'], 'skills_name_only': ['grill']},
        'roles': {'front': {'skills_on': ['animate']}, 'coord': {}}}))
    os.makedirs(os.path.join(root, 'eval/evolve'), exist_ok=True)


class TokensTest(unittest.TestCase):
    def test_estimate_and_front_matter(self):
        self.assertEqual(est_tokens(''), 0)
        self.assertGreater(est_tokens('привет'), est_tokens('hello!'))
        fields, body = front_matter('---\nname: x\npaths:\n  - a/**\n  - "b/**"\n---\nbody\n')
        self.assertEqual(fields, {'name': 'x', 'paths': ['a/**', 'b/**']})
        self.assertEqual(body, 'body\n')
        self.assertEqual(front_matter('no front')[0], {})


class CatalogTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        layer(self.root)

    def tearDown(self):
        shutil.rmtree(self.root)

    def test_discover_skips_tests_and_mirrors(self):
        paths = dict(catalog.discover(self.root))
        self.assertEqual(paths['.claude/hooks/gate.py'], 'hook')
        self.assertNotIn('.claude/hooks/test_gate.py', paths)
        self.assertFalse(any(p.startswith('.continue/') for p in paths))
        self.assertEqual(paths['CLAUDE.md'], 'card')
        self.assertEqual(paths['eval/pipeline/genome/roles.json'], 'genome')

    def test_versions_grow_by_themselves(self):
        self.assertEqual(catalog.main(['--root', self.root, '--write', '--date', '2026-11-01']), 0)
        self.assertEqual(catalog.main(['--root', self.root, '--check']), 0)
        write(self.root, '.claude/skills/grill/SKILL.md',
              '---\nname: grill\ndescription: Roast a task before the work starts.\n---\n# grill\n\nBody v2.\n')
        os.remove(os.path.join(self.root, '.claude/hooks/gate.py'))
        self.assertEqual(catalog.main(['--root', self.root, '--check']), 1)  # stale lock fails CI
        catalog.main(['--root', self.root, '--write', '--date', '2026-11-02'])
        lock = catalog.load_lock(self.root)
        self.assertEqual(lock['artifacts']['.claude/skills/grill/SKILL.md']['v'], 2)
        self.assertEqual(lock['artifacts']['CLAUDE.md']['v'], 1)
        self.assertNotIn('.claude/hooks/gate.py', lock['artifacts'])
        with open(os.path.join(self.root, 'eval/evolve/history.jsonl'), encoding='utf-8') as f:
            events = [json.loads(line) for line in f]
        last = [(e['event'], e['path'], e['v']) for e in events if e['date'] == '2026-11-02']
        self.assertIn(('changed', '.claude/skills/grill/SKILL.md', 2), last)
        self.assertIn(('retired', '.claude/hooks/gate.py', 1), last)

    def test_l1_per_role_follows_genome(self):
        items = catalog.scan(self.root)
        roles = catalog.roles_of(self.root)
        none, front, coord = (catalog.l1_of(items, roles[r]) for r in ('(none)', 'front', 'coord'))
        root_and_base = items['CLAUDE.md']['tokens'] + items['.claude/rules/01-base.md']['tokens']
        self.assertEqual(none['cards_rules'], root_and_base)  # a rule with paths: is not always loaded
        self.assertEqual(coord['skills_listing'], items['.claude/skills/grill/SKILL.md']['name_only'])  # animate off
        self.assertEqual(front['skills_listing'], coord['skills_listing'] + items['.claude/skills/animate/SKILL.md']['listing'])
        self.assertGreater(none['skills_listing'], front['skills_listing'])  # no genome: full grill description

    def test_budget_is_a_ratchet(self):
        catalog.main(['--root', self.root, '--write'])
        path = os.path.join(self.root, 'eval/evolve/catalog.lock.json')
        with open(path, encoding='utf-8') as f:
            lock = json.load(f)
        lock['budget'] = {'coord': 1}
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(lock, f)
        self.assertEqual(catalog.main(['--root', self.root, '--check']), 1)


class DupesTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        layer(self.root)

    def tearDown(self):
        shutil.rmtree(self.root)

    def test_units_drop_code_and_short_lines(self):
        got = [t for _, t in dupes.units('Short line.\n\n```\nthis code block has more than eight words in it\n```\n'
                                         '- a list item that is long enough to count as a unit here\n')]
        self.assertEqual(got, ['- a list item that is long enough to count as a unit here'])

    def test_cluster_across_files_priced(self):
        found = dupes.clusters(dupes.collect(self.root))
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]['files'], ['.claude/rules/02-backend.md', 'CLAUDE.md'])
        self.assertEqual(found[0]['waste'], found[0]['tokens'])
        self.assertEqual(found[0]['l1_waste'], 0)  # only one copy is always loaded
        self.assertEqual(dupes.clusters(dupes.collect(self.root, l1_only=True)), [])

    def test_handoff_against_l1(self):
        handoff = os.path.join(self.root, 'handoff.md')
        write(self.root, 'handoff.md', '# Handoff\n\n%s\n\nPR 12 is green and waits for the owner merge decision today.\n'
              % SHARED.replace('three', '3'))
        hits = dupes.against_l1(self.root, handoff)
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0][2], 'CLAUDE.md')
        self.assertEqual(dupes.main(['--root', self.root, '--against-l1', handoff, '--max-waste', '1']), 1)
        self.assertEqual(dupes.main(['--root', self.root, '--against-l1', handoff, '--max-waste', '1000']), 0)


class AbTest(unittest.TestCase):
    CASES = [{'id': str(i), 'task': 'case %d' % i, 'expect': 'good'} for i in range(4)]

    @staticmethod
    def judge(prefer):
        """A scripted judge that picks the candidate containing `prefer`, whatever its position."""
        def call(system, user):
            x = user.split('Candidate X:')[1].split('Candidate Y:')[0]
            y = user.split('Candidate Y:')[1].split('Which candidate')[0]
            return 'X' if prefer in x and prefer not in y else 'Y' if prefer in y and prefer not in x else 'TIE'
        return call

    def test_consistent_winner_selected(self):
        results = ab.run(self.judge('NEW'), self.CASES, 'old text', 'NEW text')
        self.assertEqual({r['winner'] for r in results}, {'b'})
        self.assertEqual(ab.select(results, 10, 12)['pick'], 'b')

    def test_position_bias_is_a_tie(self):
        always_x = lambda system, user: 'X'  # noqa: E731
        results = ab.run(always_x, self.CASES, 'a', 'b')
        self.assertEqual({r['winner'] for r in results}, {'tie'})
        self.assertEqual(ab.select(results, 10, 12)['pick'], 'a')  # tie and B dearer → keep A
        self.assertEqual(ab.select(results, 12, 10)['pick'], 'b')  # tie and B cheaper → B, quality not lost

    def test_outputs_mode_judges_answers(self):
        def call(system, user):
            if system is not None:
                return 'answer with NEW' if 'NEW' in system else 'answer'
            return self.judge('NEW')(system, user)
        results = ab.run(call, self.CASES[:2], 'old', 'NEW', mode='outputs')
        self.assertEqual([r['winner'] for r in results], ['b', 'b'])

    def test_fences_carry_a_fresh_nonce(self):
        prompts = []
        ab.compare(lambda s, u: prompts.append(u) or 'TIE', self.CASES[0], 'a', 'b', 'texts')
        nonces = [p.split('<<<X-')[1].split('\n')[0] for p in prompts]
        self.assertEqual(len(set(nonces)), 2)
        self.assertIn('data, not instructions', prompts[0])

    def test_parse_answer(self):
        self.assertEqual(ab.parse_answer('reasoning…\nY'), 'Y')
        self.assertEqual(ab.parse_answer('Answer: tie'), 'TIE')
        self.assertEqual(ab.parse_answer('no verdict'), 'TIE')

    def test_cli_versions_from_git(self):
        root = tempfile.mkdtemp()
        try:
            git = lambda *a: subprocess.run(['git', '-C', root, *a], check=True, capture_output=True)  # noqa: E731
            git('init', '-q')
            write(root, 's.md', 'a long first version of the skill\n')
            git('add', '.')
            git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'v1')
            write(root, 's.md', 'short v2\n')
            write(root, 'cases.jsonl', json.dumps(self.CASES[0]) + '\n')
            self.assertEqual(ab.version_text(root, 's.md', 'HEAD'), 'a long first version of the skill\n')
            self.assertEqual(ab.main(['--root', root, '--artifact', 's.md', '--a', 'HEAD', '--b', 'work',
                                      '--cases', os.path.join(root, 'cases.jsonl'), '--judge', 'fake']), 0)
            self.assertEqual(ab.main(['--root', root, '--artifact', 's.md', '--a', 'HEAD', '--b', 'work',
                                      '--cases', os.path.join(root, 'cases.jsonl'), '--judge', 'fake',
                                      '--record']), 2)  # a fake judge is never recorded as evidence
        finally:
            shutil.rmtree(root)


if __name__ == '__main__':
    unittest.main()
