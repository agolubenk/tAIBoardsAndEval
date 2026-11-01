"""Synthetic-data tests for capsule.py (П6).
Run: python3 -I -m unittest discover -s supertick-eval/pipeline -p 'test_capsule.py'
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import capsule  # noqa: E402

NOTES = {
    'goal': 'Б4: t-boards на VPS за WireGuard',
    'acceptance': ['health 200 через туннель', 'дамп восстанавливается'],
    'decisions': [{'text': 'TLS на 10.77.0.1:8443 + REDIRECT', 'ref': 'deploy/vps/README.md'}, {'text': 'без S3'}],
    'next': 'selftest, затем s-пункты',
    'dont': ['не пушить форк'],
    'refs': ['HANDOFF-2026-10-28.md §Б4'],
}


def git_repo():
    repo = tempfile.mkdtemp()
    subprocess.run(['git', '-C', repo, 'init', '-q', '-b', 'tb'], check=True)
    subprocess.run(['git', '-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty',
                    '-m', 'x'], check=True)
    return repo


class CapsuleTest(unittest.TestCase):
    def test_render_has_every_section(self):
        repo = git_repo()
        open(os.path.join(repo, 'a.ts'), 'w').close()
        text = capsule.fit('author', NOTES, [capsule.repo_state(repo)], ['tb-app Up 2 hours'])
        for part in ('# Капсула: author', '**Цель.** Б4', '- health 200', '(deploy/vps/README.md)', '- без S3',
                     '[tb]', 'грязных 1', 'a.ts', '- стенд: tb-app Up', '**Следующий шаг.** selftest',
                     '- не пушить форк', '§Б4'):
            self.assertIn(part, text)

    def test_missing_fields_render_dashes(self):
        text = capsule.render('x', {}, [], [])
        self.assertIn('**Цель.** —', text)
        self.assertIn('**Не делать.**\n- —', text)

    def test_not_a_repo(self):
        state = capsule.repo_state(tempfile.mkdtemp())
        self.assertEqual(state['error'], 'not a git repository')

    def test_mechanics_shrink_before_refusing(self):
        repo = {'path': '/r', 'branch': 'b', 'head': '1', 'dirty': [f'dir/file-{i:04}.ts' for i in range(600)]}
        text = capsule.fit('x', NOTES, [repo], [])
        self.assertLessEqual(len(text.encode()), capsule.BUDGET_BYTES)
        self.assertIn('грязных 600', text)

    def test_long_notes_are_refused(self):
        notes = dict(NOTES, decisions=[{'text': 'решение ' * 40} for _ in range(40)])
        with self.assertRaises(ValueError):
            capsule.fit('x', notes, [], [])

    def test_cli_writes_file(self):
        out, tmp = tempfile.mkdtemp(), tempfile.mkdtemp()
        notes = os.path.join(tmp, 'n.json')
        with open(notes, 'w', encoding='utf-8') as f:
            json.dump(NOTES, f, ensure_ascii=False)
        self.assertEqual(capsule.main(['Author', '--notes', notes, '--repo', git_repo(), '--out', out]), 0)
        with open(os.path.join(out, 'author.md'), encoding='utf-8') as f:
            self.assertIn('Б4', f.read())
        with open(os.path.join(out, 'author.pack.txt'), encoding='utf-8') as f:
            self.assertLessEqual(len(f.read()), capsule.PACK_CHARS)

    def test_pack_keeps_everything_when_short(self):
        card = capsule.pack(NOTES)
        self.assertTrue(card.startswith('Цель: '))
        self.assertIn('Решения: ', card)
        self.assertIn('Оригиналы: ', card)

    def test_pack_drops_decisions_first(self):
        notes = dict(NOTES, decisions=[{'text': 'решение ' * 20} for _ in range(20)])
        card = capsule.pack(notes)
        self.assertLessEqual(len(card), capsule.PACK_CHARS)
        self.assertNotIn('Решения: ', card)
        self.assertIn('Дальше: ', card)
        self.assertIn('Оригиналы: ', card)

    def test_pack_refuses_long_core(self):
        with self.assertRaises(ValueError):
            capsule.pack(dict(NOTES, goal='цель ' * 500))


if __name__ == '__main__':
    unittest.main()
