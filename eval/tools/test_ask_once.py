#!/usr/bin/env python3
"""ask_once.py on a synthetic tree: answered, open and unknown questions, reworded and in the other language,
and the ledger write. Run: python3 -I <this file>"""
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ask_once as a  # noqa: E402


def write(root, rel, text):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)


class AskOnceTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        ledger = [
            {'id': 'd-locale', 'q': 'Какой язык интерфейса по умолчанию?', 'a': 'Английский, пока пользователь не выберет',
             'kw': 'default language locale english', 'source': 'чат 01.11', 'status': 'answered'},
            {'id': 'q-parent', 'q': 'Запрещать ли второго родителя у подзадачи?', 'kw': 'subtask second parent',
             'source': 'E7', 'status': 'open'},
        ]
        write(self.root, a.LEDGER, ''.join(json.dumps(e, ensure_ascii=False) + '\n' for e in ledger))
        write(self.root, a.DONE_DIR + '/boards.md',
              '# Закрыто\n\n- **Кэш ассетов веба** (закрыто 2026-11-01): nginx отдаёт неизменённые чанки с expires 1y\n')
        write(self.root, a.SPEC, '| R-090 | Импорт карточек из Notion идёт пачками по сто | Q-031 |\n'
                                 '| R-101 | Форма перманентных вопросов владельца на доске | Q-104 |\n')
        write(self.root, a.ROADMAP, '| B3 | Экран: что видно владельцу и агентам | R-041 | В: состав экрана | 🔲 |\n')

    def tearDown(self):
        shutil.rmtree(self.root)

    def check(self, question):
        return a.main(['--root', self.root, 'check', question])

    def test_answered_reworded_and_other_language(self):
        self.assertEqual(self.check('какой язык выбран по умолчанию в интерфейсе'), 3)
        self.assertEqual(self.check('what is the default UI language?'), 3)
        self.assertEqual(self.check('нужен ли кэш ассетов в nginx'), 3)  # closed item
        self.assertEqual(self.check('импорт карточек из Notion пачками?'), 3)  # spec row with an owner answer

    def test_open_questions_are_not_asked_twice(self):
        self.assertEqual(self.check('can a subtask have a second parent'), 4)
        self.assertEqual(self.check('форма перманентных вопросов владельца'), 4)  # spec Q-1xx
        self.assertEqual(self.check('что видно владельцу и агентам на экране'), 4)  # roadmap «В:»

    def test_unknown_is_asked(self):
        self.assertEqual(self.check('сколько реплик Redis держать в проде'), 0)

    def test_record_then_found(self):
        a.main(['--root', self.root, 'record', '--q', 'Сколько реплик Redis держать?', '--open', '--source', 'oq 7',
                '--date', '2026-11-01'])
        self.assertEqual(self.check('сколько реплик Redis держать'), 4)
        a.main(['--root', self.root, 'record', '--q', 'Сколько реплик Redis держать?', '--a', 'Одну', '--source', 'oq 7'])
        with open(os.path.join(self.root, a.LEDGER), encoding='utf-8') as f:
            last = json.loads(f.read().splitlines()[-1])
        self.assertEqual((last['status'], last['a']), ('answered', 'Одну'))
        with self.assertRaises(SystemExit):
            a.record(self.root, 'q', '', 'src', '', False, '2026-11-01')  # an answer needs its text

    def test_stem_groups_word_forms(self):
        self.assertEqual(a.stem('вырубленного'), a.stem('вырубленные'))
        self.assertEqual(a.stem('branches'), a.stem('branch'))


if __name__ == '__main__':
    unittest.main()
