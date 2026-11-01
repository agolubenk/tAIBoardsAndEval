#!/usr/bin/env python3
"""Пересобирает таблицу модулей в docs/plans/DONE.md из файлов docs/plans/done/ (stdlib-only).

    npm run done:index                                   # переписать таблицу между маркерами
    python3 infra/scripts/misc/done-index.py --check     # только проверка (входит в npm run docs:check)

Строка таблицы — из шапки модуля (`# Закрыто · <название>`, `> **Область:** …`) и его записей (строки `- **…`):
«ID в записях» — префиксы ID, которые реально встречаются в заголовках записей (по частоте), период — минимальная и
максимальная дата YYYY-MM-DD. Файлы годов (`done/<модуль>/<год>.md`) считаются вместе со своим модулем.

`--check` проверяет и правила оглавления: запись в «Журнале» — по формату «Как добавить запись», модуль ≤ 400
записей и ≤ 300 КБ, у каталога годов есть файл модуля. Коды выхода: 0 — порядок, 1 — таблица устарела или правило
нарушено, 2 — ошибка структуры или самого скрипта.
"""
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
INDEX = ROOT / "docs/plans/DONE.md"
DONE_DIR = ROOT / "docs/plans/done"
BEGIN, END = "<!-- done-index:begin -->", "<!-- done-index:end -->"
DATE = re.compile(r"\b(20\d\d-\d\d-\d\d)\b")
TITLE = re.compile(r"^- \*\*(.+?)\*\*")
ID = re.compile(r"(?<![A-Za-z0-9-])([A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*)-\d+[a-z]?\b")
TAG = re.compile(r"\[([A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*)\]")  # [FAB], [ONB-WS]; [X-1] — это ID, его берёт ID
LEAD = re.compile(r"^([A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*)\s+—")  # ID без номера в начале: «WFC — …»
# `- **<ID> — <заголовок>** (YYYY-MM-DD · `sha` · [Notion](url)) — что сделано` — скобки ссылки внутри допустимы
JOURNAL_ENTRY = re.compile(r"^- \*\*.+?\*\* \(20\d\d-\d\d-\d\d(?:[^()]|\([^()]*\))*\) — \S")
MAX_ENTRIES, MAX_BYTES, MAX_PREFIXES = 400, 300 * 1024, 8


class StructureError(Exception):
    pass


def cell(text: str) -> str:
    return text.replace("|", "\\|")


def meta(text: str, label: str) -> str:
    m = re.search(r"^> \*\*" + re.escape(label) + r":\*\* (.+?)\.?$", text, re.M)
    return m.group(1).strip() if m else "—"


def module_parts(module_file: Path) -> list:
    return [module_file] + sorted((DONE_DIR / module_file.stem).glob("*.md"))


def journal_problems(path: Path) -> list:
    out, in_journal = [], False
    for lineno, line in enumerate(path.read_text(encoding="utf-8").split("\n"), start=1):
        if line.startswith("## "):
            in_journal = line.strip() == "## Журнал"
        elif in_journal and line.startswith("- **") and not JOURNAL_ENTRY.match(line):
            out.append(f"{path.relative_to(ROOT)}:{lineno}: запись «Журнала» не по формату DONE.md §«Как добавить запись»")
    return out


def module_row(module_file: Path, problems: list):
    texts = [p.read_text(encoding="utf-8") for p in module_parts(module_file)]
    entries = [ln for t in texts for ln in t.split("\n") if ln.startswith("- **")]
    dates = sorted(d for ln in entries for d in DATE.findall(ln))
    period = f"{dates[0]} … {dates[-1]}" if dates else "—"
    prefixes = Counter()
    for ln in entries:
        title = TITLE.match(ln).group(1)
        found = set(ID.findall(title)) | set(TAG.findall(title)) | set(LEAD.findall(title))
        prefixes.update(f"{m}-" for m in found)
    # порядок детерминирован (частота, затем алфавит): set-обход зависит от PYTHONHASHSEED, и --check «мигал» бы
    ranked = sorted(prefixes.items(), key=lambda kv: (-kv[1], kv[0]))
    ids = ", ".join(p for p, _ in ranked[:MAX_PREFIXES]) or "—"
    title_match = re.search(r"^# Закрыто · (.+)$", texts[0], re.M)
    title = title_match.group(1).strip() if title_match else module_file.stem
    head_entries = sum(1 for ln in texts[0].split("\n") if ln.startswith("- **"))  # лимит — у самого файла модуля
    size = len(texts[0].encode("utf-8"))
    if head_entries > MAX_ENTRIES or size > MAX_BYTES:
        problems.append(f"{module_file.relative_to(ROOT)}: {head_entries} записей, {size // 1024} КБ — лимит "
                        f"{MAX_ENTRIES} записей / {MAX_BYTES // 1024} КБ: закрытые годы — в done/{module_file.stem}/<год>.md")
    for part in module_parts(module_file):
        problems.extend(journal_problems(part))
    row = (f"| [{cell(title)}](done/{module_file.name}) | {cell(meta(texts[0], 'Область'))} | {cell(ids)} | "
           f"{len(entries)} | {period} |")
    return row, len(entries)


def build_table(problems: list) -> str:
    orphans = sorted(d.name for d in DONE_DIR.iterdir() if d.is_dir() and not (DONE_DIR / f"{d.name}.md").is_file())
    if orphans:
        raise StructureError(f"каталоги годов без файла модуля: {', '.join(orphans)} — создайте done/<модуль>.md с шапкой")
    lines = ["| Модуль | Что внутри | ID в записях | Записей | Период |", "|---|---|---|---|---|"]
    total = 0
    for module_file in sorted(DONE_DIR.glob("*.md")):
        row, count = module_row(module_file, problems)
        lines.append(row)
        total += count
    lines.append(f"| **Всего** | | | **{total}** | |")
    return "\n".join(lines)


def run() -> int:
    index = INDEX.read_text(encoding="utf-8")
    if BEGIN not in index or END not in index:
        raise StructureError("нет маркеров done-index в DONE.md")
    head, rest = index.split(BEGIN, 1)
    _, tail = rest.split(END, 1)
    problems: list = []
    fresh = f"{head}{BEGIN}\n{build_table(problems)}\n{END}{tail}"
    for problem in problems:
        print(f"⚠ {problem}", file=sys.stderr)
    if "--check" in sys.argv:
        if fresh != index:
            print("DONE.md: таблица модулей устарела — npm run done:index", file=sys.stderr)
            return 1
        if problems:
            return 1
        print("DONE.md: таблица модулей актуальна, правила оглавления соблюдены")
        return 0
    if fresh != index:
        INDEX.write_text(fresh, encoding="utf-8")
        print("DONE.md: таблица модулей обновлена")
    else:
        print("DONE.md: без изменений")
    return 0


def main() -> int:
    try:
        return run()
    except StructureError as exc:
        print(f"done-index: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:  # падение скрипта не должно выглядеть как «таблица устарела» (код 1)
        print(f"done-index: ошибка скрипта: {exc!r}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
