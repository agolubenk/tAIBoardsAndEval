# -*- coding: utf-8 -*-
"""Тесты роя на синтетике: python3 -I -m unittest discover -s supertick-eval/swarm -p 'test_*.py'"""
import io
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import egress  # noqa: E402
import swarm  # noqa: E402

FAKE_JWT = "eyJhbGciOiJIUzI1NiJ9" + ".eyJzdWIiOiIxMjM0NTY3ODkwIn0" + ".c2lnbmF0dXJlX2Zha2VfMTIzNA"


class EgressTest(unittest.TestCase):
    def test_denied_paths(self):
        for p in ("/r/apps/backend/.env", "/r/.env.contabo", "/r/infra/certs/site.pem", "/home/u/.ssh/id_ed25519",
                  "/r/db_dump.sql", "/r/backup.sql.gz", "/r/infra/llm-gateway/.state/token", "/r/.mcp.json",
                  "/r/.claude/settings.local.json", "/u/.claude-mem/claude-mem.db"):
            self.assertTrue(egress.denied(p), p)
        for p in ("/r/apps/backend/src/main.ts", "/r/apps/backend/src/config/env.ts", "/r/docs/env.md",
                  "/r/supertick-eval/a.py"):
            self.assertIsNone(egress.denied(p), p)

    def test_masks_secrets_keeps_code(self):
        src = "\n".join([
            "const key = process.env.OPENAI_API_KEY",            # ссылка на env — не секрет
            "apiKey: string",                                     # тип — не секрет
            "API_KEY='sk-ant-abc123def456ghi789jkl'",
            "headers: { Authorization: `Bearer abcdefghijklmnop123456` }",
            "DATABASE_URL=postgresql://app:Sup3rS3cret@postgres:5432/hr",
            f"token={FAKE_JWT}",
            "ghp_" + "a" * 36,
            "Контакт: ivan.petrov@example.com, +375 (29) 123-45-67",
            "password: hunter2hunter2",
            "  password: string;",
            "db_password=s3cr3t",
        ])
        out, n = egress.mask(src)
        self.assertIn("process.env.OPENAI_API_KEY", out)
        self.assertIn("apiKey: string", out)
        for leak in ("sk-ant-abc", "abcdefghijklmnop123456", "Sup3rS3cret", "eyJhbGci", "ghp_aaaa", "ivan.petrov",
                     "123-45-67", "hunter2", "s3cr3t"):
            self.assertNotIn(leak, out, leak)
        self.assertIn("password: string;", out)
        self.assertIn("postgresql://app:<пароль>@postgres:5432/hr", out)
        self.assertGreaterEqual(sum(n.values()), 8)

    def test_private_key_block(self):
        out, n = egress.mask("x\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\nBBBB\n-----END OPENSSH PRIVATE KEY-----\ny")
        self.assertEqual(out, "x\n<приватный ключ>\ny")
        self.assertEqual(n, {"private_key": 1})

    def test_timestamps_and_ids_survive(self):
        src = "2026-10-28 16:05:00 req 1234567890 sha 46b9f87e1 line 120"
        self.assertEqual(egress.mask(src)[0], src)


class SwarmTest(unittest.TestCase):
    def test_collect_refuses_secret_files_and_numbers_lines(self):
        with tempfile.TemporaryDirectory() as d:
            ok = os.path.join(d, "a.py")
            with open(ok, "w") as f:
                f.write("x = 1\ny = 2\n")
            env = os.path.join(d, ".env")
            with open(env, "w") as f:
                f.write("SECRET=1\n")
            blocks, refused = swarm.collect([ok, env, "-"], io.StringIO("лог\n"))
            self.assertEqual([b[2] for b in blocks], [2, 1])
            self.assertEqual(len(refused), 1)
            msgs, masks, cut = swarm.build("найди", blocks, 10_000)
            self.assertIn("1| x = 1", msgs[1]["content"])
            self.assertNotIn("SECRET", msgs[1]["content"])
            self.assertFalse(cut)

    def test_clip_keeps_head_and_tail(self):
        t, cut = swarm.clip("H" * 500 + "T" * 500, 100)
        self.assertTrue(cut)
        self.assertTrue(t.startswith("H" * 40) and t.endswith("T" * 60))

    def test_strip_think(self):
        self.assertEqual(swarm.strip_think("◁think▷долго думаю◁/think▷- ответ x.ts:1"), "- ответ x.ts:1")
        self.assertEqual(swarm.strip_think("<think>\nхм\n</think>\n\nок"), "ок")

    def test_check_refs(self):
        blocks = [("apps/backend/src/x.ts", "", 50), ("stdin", "", 10)]
        ans = "- падает в `apps/backend/src/x.ts:12`\n- и в x.ts:49-50\n- лог stdin:3\n- выдумка y.ts:5\n- x.ts:99"
        self.assertEqual(swarm.check_refs(ans, blocks), (5, 2))
        self.assertEqual(swarm.check_refs("ECONNREFUSED 127.0.0.1:5433", blocks), (0, 0), "IP:порт — не ссылка")


if __name__ == "__main__":
    unittest.main()
