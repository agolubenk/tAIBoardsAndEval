#!/usr/bin/env python3
"""queue_focus.py: the board's order on a synthetic queue and on the real plan files. Run: python3 -I <this file>"""
import glob
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import queue_focus as q  # noqa: E402

PLANS = sorted(glob.glob(os.path.join(HERE, '..', 'board', 'plan-*.json')))


def cards(*rows):
    return {r['key']: dict({'title': r['key'], 'status': 'to-do', 'priority': 'medium', '_project': ''}, **r)
            for r in rows}


class QueueFocusTest(unittest.TestCase):
    def keys(self, result, part='focus'):
        return [i['key'] for i in result[part]]

    def test_bugs_first_then_active_then_priority(self):
        got = q.focus(cards({'key': 'T-1', 'priority': 'high'}, {'key': 'T-2', 'status': 'in-progress', 'priority': 'low'},
                            {'key': 'E-1', 'kind': 'bug', 'priority': 'low'}, {'key': 'E-2', 'severity': 'critical'},
                            {'key': 'T-3', 'priority': 'low'}), wip=5)
        self.assertEqual(self.keys(got), ['E-2', 'E-1', 'T-2', 'T-1', 'T-3'])

    def test_out_of_focus(self):
        got = q.focus(cards({'key': 'A', 'status': 'done'}, {'key': 'B', 'halfBaked': True},
                            {'key': 'C', 'report': 'не строим'}, {'key': 'G'}, {'key': 'G-1', 'parent': 'G'},
                            {'key': 'L', 'status': 'Брёвна'}))
        self.assertEqual(self.keys(got), ['G-1'])  # the goal G has an open subtask — its leaf is the work
        self.assertEqual(got['skipped'], {'final': 2, 'halfBaked': 1, 'report': 1, 'container': 1})

    def test_blocked_and_unblocking(self):
        got = q.focus(cards({'key': 'A', 'blocks': ['B']}, {'key': 'B', 'blocks': ['C']}, {'key': 'C'},
                            {'key': 'D', 'priority': 'medium'}, {'key': 'E', 'blockedBy': ['Z']}))
        self.assertEqual(self.keys(got), ['A', 'D', 'E'])  # A unblocks 2 → before D; Z unknown → E not blocked
        self.assertEqual([(i['key'], i['blockedBy']) for i in got['blocked']], [('B', ['A']), ('C', ['B'])])
        done = q.focus(cards({'key': 'A', 'status': 'done', 'blocks': ['B']}, {'key': 'B'}))
        self.assertEqual(self.keys(done), ['B'])  # a closed blocker blocks nothing

    def test_wip_limit_stops_new_starts(self):
        got = q.focus(cards({'key': 'A', 'status': 'in-progress'}, {'key': 'B', 'status': 'на ревью'},
                            {'key': 'C', 'priority': 'high'}), wip=2)
        self.assertEqual(self.keys(got), ['A', 'B'])
        self.assertIn('новое не бери', got['note'])

    def test_export_list_shape(self):
        with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False, encoding='utf-8') as f:
            json.dump({'tasks': [{'ticketId': 'ОШИБКИ-3', 'title': 'x', 'status': 'открыто', 'priority': 'high',
                                  'project': 'Ошибки'}, {'ticketId': 'ЗАДАЧИ-9', 'title': 'y', 'status': 'в работе'}]}, f)
        try:
            got = q.focus(q.load([f.name]))
        finally:
            os.remove(f.name)
        self.assertEqual(self.keys(got), ['ОШИБКИ-3', 'ЗАДАЧИ-9'])
        self.assertTrue(got['focus'][0]['bug'])

    @unittest.skipUnless(PLANS, 'no plan files')
    def test_real_plans_compact(self):
        result = q.focus(q.load(PLANS))
        text = q.render(result)
        self.assertLessEqual(len(text), 2000)  # a focus fits a capsule (≤ 2K), not the whole queue
        keys = self.keys(result)
        self.assertFalse(any(k.startswith('GL-00') and k != 'GL-003' for k in keys))  # goals with leaves are out
        all_cards = q.load(PLANS)
        self.assertTrue(all(not all_cards[k].get('halfBaked') for k in keys))


if __name__ == '__main__':
    unittest.main()
