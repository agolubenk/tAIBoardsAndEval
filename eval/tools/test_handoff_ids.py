#!/usr/bin/env python3
"""handoff_ids.py на синтетике: сбор строк и поиск пропавших id. Run: python3 -I <this file>"""
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import handoff_ids as h  # noqa: E402


class HandoffIdsTest(unittest.TestCase):
    def test_ids_in(self):
        text = "Влить #445 (m-445), пункт c-close-overdue-3010, s-rbac-mutation-counts, карточка TB-31, полоса tb-b10; " \
               "не id: file.md#anchor, a/c-path, 2026-10-30"
        self.assertEqual(h.ids_in(text), {"#445", "m-445", "c-close-overdue-3010", "s-rbac-mutation-counts", "TB-31",
                                          "tb-b10"})

    def test_oq_filters_by_agent_and_done(self):
        docs = [{"id": "c-1", "data": {"kind": "check", "title": "проверить", "agentBy": "t3-plan"}},
                {"id": "c-2", "data": {"kind": "check", "title": "чужое", "agentBy": "t3-coord"}},
                {"id": "c-3", "data": {"kind": "check", "title": "готово", "agentBy": "t3-plan", "done": True}}]
        lines = h.from_oq(docs, "t3-plan")
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith("c-1 · check · проверить"))

    def test_work_state_line(self):
        lines = h.from_work_state([{"key": "tb-b10", "status": "waiting", "next": "мёрж", "blockers": ["m-445"],
                                    "branch": "b10@f9275c5"}, {"key": "old", "status": "done"}])
        self.assertEqual(lines, ["tb-b10 · waiting · мёрж · m-445 · b10@f9275c5"])

    def test_diff_reports_lost_ids(self):
        with tempfile.TemporaryDirectory() as tmp:
            report, role = os.path.join(tmp, "r.md"), os.path.join(tmp, "role.md")
            open(report, "w", encoding="utf-8").write("ids: #440, m-445, s-pr440-integration-urls, tb-b10\n")
            open(role, "w", encoding="utf-8").write("принял #440 и tb-b10\n")
            p = subprocess.run([sys.executable, "-I", os.path.join(HERE, "handoff_ids.py"), "diff", report, role],
                               capture_output=True, text=True)
            self.assertEqual(p.returncode, 1)
            self.assertEqual(p.stdout.split(), ["m-445", "s-pr440-integration-urls"])

    def test_collect_survives_missing_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run(["git", "init", "-q", tmp], check=True)
            p = subprocess.run([sys.executable, "-I", os.path.join(HERE, "handoff_ids.py"), "collect", "--repo", tmp,
                                "--oq", os.path.join(tmp, "nope.json")], capture_output=True, text=True)
            self.assertEqual(p.returncode, 0)
            self.assertIn("ids:", p.stdout)
            self.assertIn("# oq:", p.stdout)


if __name__ == "__main__":
    unittest.main()
