#!/usr/bin/env python3
"""dams_common.search(): «nothing found» is never confused with «search broken» (bug E9, 01.11).
Run: python3 -I .claude/scripts/test_dams_search.py"""
import os
import sqlite3
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import dams_common as dc  # noqa: E402
from index_rebuild import SCHEMA  # noqa: E402


def index(rows):
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    for doc_id, title, content, status in rows:
        conn.execute("INSERT INTO rag_docs (doc_id, doc_type, module, title, content, metadata, tags, status) "
                     "VALUES (?, 'rule_chunk', 'x', ?, ?, '', '', ?)", (doc_id, title, content, status))
        conn.execute("INSERT INTO rag_meta (doc_id, doc_type, file_path) VALUES (?, 'rule_chunk', ?)",
                     (doc_id, doc_id + ".md"))
    return conn


class SearchOutcomeTest(unittest.TestCase):
    def test_found_and_no_match_are_different(self):
        conn = index([("r1", "Felling contract", "felled trees are read only", "active")])
        found = dc.search(conn, ["felled"])
        self.assertEqual((found.status, len(found), found[0]["doc_id"]), ("found", 1, "r1"))
        none = dc.search(conn, ["parachute"])
        self.assertEqual((none.status, list(none)), ("no_match", []))
        self.assertFalse(none.failed)

    def test_stale_rows_are_marked(self):
        conn = index([("r1", "Leases", "fencing token on writes", "stale")])
        self.assertEqual(dc.search(conn, ["fencing"]).status, "index_stale")

    def test_broken_index_is_a_failure_not_an_empty_answer(self):
        conn = sqlite3.connect(":memory:")  # no rag_docs table at all
        broken = dc.search(conn, ["felled"])
        self.assertEqual(list(broken), [])
        self.assertTrue(broken.failed)
        self.assertEqual(broken.status, "query_error")
        self.assertIn("no such table", broken.error)
        missing = dc.search(None, ["felled"])
        self.assertTrue(missing.failed)
        self.assertIn("index missing", missing.error)

    def test_no_terms(self):
        self.assertEqual(dc.search(index([]), []).status, "no_terms")

    def test_still_a_list(self):
        conn = index([("r1", "Felling contract", "felled trees", "active")])
        rows = dc.search(conn, ["felled"])
        self.assertIsInstance(rows, list)
        self.assertEqual([r["doc_id"] for r in rows], ["r1"])  # old callers iterate as before


if __name__ == "__main__":
    unittest.main()
