#!/usr/bin/env python3
"""Хирургическое восстановление gateway.py после повреждения редактором.

Файл в HEAD мог содержать чужие правки другой сессии — поэтому НЕ checkout целиком,
а склейка: рабочая голова (до конца моего метода knowledge) + хвост из HEAD
(с заменой старого роута /api/knowledge на новый P1-роут).
"""
import subprocess
from pathlib import Path

P = Path("infra/ai-council/gateway.py")
head = subprocess.run(["git", "show", "HEAD:infra/ai-council/gateway.py"],
                      capture_output=True, text=True, check=True).stdout.splitlines()
work = P.read_text().splitlines()

# 1) рабочая часть — до последней содержательной строки моего knowledge-метода
#    (маркер: return с "pages": pages)
keep_until = max(i for i, l in enumerate(work) if '"pages": pages}' in l)
head_part = work[: keep_until + 1]

# 2) хвост из HEAD: начиная со строки после «return {..."pages": pages}»-эквивалента.
#    В HEAD старый knowledge кончался return {... "hits": hits}; ищем его.
tail_from = None
for i, l in enumerate(head):
    if 'return {"kinds": kinds, "embedded": embedded.get("n", 0), "hits": hits}' in l:
        tail_from = i + 1
        break
assert tail_from, "маркер конца старого knowledge не найден в HEAD"
tail = head[tail_from:]

# 3) в хвосте заменяем старый роут на P1-вариант
old_route = 'if route == "/api/knowledge":'
new_route = '''if route == "/api/knowledge":
                return self._json(self.api.knowledge(
                    one("q"), one("kind"),
                    max(1, int(one("page", "1"))),
                    int(one("page_size", "50")),
                    int(one("limit", "40"))))'''
for i, l in enumerate(tail):
    if old_route in l:
        indent = l[: len(l) - len(l.lstrip())]
        # старый роут — 2 строки (if + return), заменяем обе
        assert 'api.knowledge(one("q")' in tail[i + 1], f"неожиданный формат роута: {tail[i+1]}"
        tail[i] = indent + new_route
        del tail[i + 1]
        break
else:
    raise AssertionError("роут /api/knowledge не найден в хвосте HEAD")

P.write_text("\n".join(head_part + tail) + "\n", encoding="utf-8")

# 4) валидация
import ast
ast.parse(P.read_text())
print("OK, строк:", len(head_part) + len(tail))
print("проверка роута:", [l for l in tail if 'api.knowledge(' in l][:1])