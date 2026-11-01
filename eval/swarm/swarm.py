#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""swarm.py — рой (П9): рутинная выжимка уходит с Opus на бесплатную модель через llm-gateway. stdlib, python3 -I.

  python3 -I swarm.py ask "<задача>" файл1 [файл2 …]      файлы — с номерами строк
  some-cmd 2>&1 | python3 -I swarm.py ask "<задача>" -    stdin (лог, дифф)
    --model free        пул шлюза (по умолчанию free: бесплатные OpenRouter; нет ключей → локальная Ollama)
    --dry-run           показать, что уйдёт наружу после фильтра, без отправки
    --max-chars 60000   потолок контекста (голова + хвост)

Ответ — в stdout. В stderr — одна строка: модель, сколько символов ушло, что замаскировано, проверка ссылок file:line.
Вызовы строго по одному (замок): шлюз может уйти в локальную модель, а локальные — только последовательно.
"""
import argparse
import fcntl
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import egress  # noqa: E402

REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
GW_URL = os.environ.get("SWARM_GW_URL", "http://127.0.0.1:8789/v1/chat/completions")
TOKEN_FILE = os.environ.get("SWARM_GW_TOKEN_FILE", os.path.join(REPO, "infra/llm-gateway/.state/token"))
LOCK = os.path.join(HERE, "state", "swarm.lock")

SYSTEM = ("Ты — выжимщик для инженера. Отвечай кратко, по-русски, списком. Каждое утверждение — со ссылкой "
          "`путь:строка` на строку из входа (строки пронумерованы, путь — из заголовка блока «=== путь ===»). "
          "Нет данных во входе — так и скажи, не додумывай. Не пересказывай вход целиком.")

REF_RE = re.compile(r"`?([\w./-]*\.[A-Za-z]\w*|stdin):(\d+)(?:-\d+)?`?")  # расширение с буквы: не IP:порт


def numbered(name, text):
    lines = text.splitlines()
    w = len(str(len(lines)))
    return f"=== {name} ===\n" + "\n".join(f"{i:>{w}}| {s}" for i, s in enumerate(lines, 1))


def clip(text, limit):
    if len(text) <= limit:
        return text, False
    head = int(limit * 0.4)
    return text[:head] + f"\n… [вырезано {len(text) - limit} символов] …\n" + text[-(limit - head):], True


def collect(paths, stdin):
    """→ (блоки [(имя, текст, строк)], отказы [(путь, правило)])."""
    blocks, refused = [], []
    for p in paths:
        if p == "-":
            t = stdin.read()
            blocks.append(("stdin", t, len(t.splitlines())))
            continue
        rule = egress.denied(os.path.abspath(p))
        if rule:
            refused.append((p, rule))
            continue
        with open(p, encoding="utf-8", errors="replace") as f:
            t = f.read()
        rel = os.path.relpath(os.path.abspath(p), REPO)
        blocks.append((rel if not rel.startswith("..") else p, t, len(t.splitlines())))
    return blocks, refused


def check_refs(answer, blocks):
    """Ссылки `путь:строка` в ответе: сколько всего и сколько битых (нет такого входа или строки)."""
    sizes = {name: n for name, _, n in blocks}
    base = {os.path.basename(k): v for k, v in sizes.items()}
    total = bad = 0
    for path, line in REF_RE.findall(answer):
        total += 1
        n = sizes.get(path) or base.get(os.path.basename(path))
        if n is None or not 1 <= int(line) <= n:
            bad += 1
    return total, bad


def build(task, blocks, max_chars):
    body = "\n\n".join(numbered(name, t) for name, t, _ in blocks)
    body, cut = clip(body, max_chars)
    body, masks = egress.mask(body)
    task, tmask = egress.mask(task)
    for k, v in tmask.items():
        masks[k] = masks.get(k, 0) + v
    msgs = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": f"Задача: {task}\n\n{body}"}]
    return msgs, masks, cut


def call(model, msgs, timeout):
    with open(TOKEN_FILE, encoding="utf-8") as f:
        token = f.read().strip()
    data = json.dumps({"model": model, "messages": msgs, "temperature": 0.1, "stream": False}).encode()
    req = urllib.request.Request(GW_URL, data=data, headers={
        "Content-Type": "application/json", "Authorization": f"Bearer {token}"})
    os.makedirs(os.path.dirname(LOCK), exist_ok=True)
    with open(LOCK, "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)  # по одному: локальные модели не параллелим
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                out = json.load(r)
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"шлюз {e.code}: {e.read().decode('utf-8', 'replace')[:300]}") from None
    msg = (out.get("choices") or [{}])[0].get("message") or {}
    return strip_think(msg.get("content") or ""), out.get("model", model), time.time() - t0


THINK_RE = re.compile(r"(<think>|◁think▷).*?(</think>|◁/think▷)\s*", re.S)


def strip_think(text):
    """Рассуждения локальных моделей (<think>, ◁think▷) — не часть выжимки."""
    return THINK_RE.sub("", text).strip()


def main():
    p = argparse.ArgumentParser(prog="swarm")
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("ask")
    a.add_argument("task")
    a.add_argument("inputs", nargs="+")
    a.add_argument("--model", default="free")
    a.add_argument("--max-chars", type=int, default=60000)
    a.add_argument("--timeout", type=int, default=300)
    a.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    blocks, refused = collect(args.inputs, sys.stdin)
    for path, rule in refused:
        print(f"рой: {path} не отправлен (правило {rule})", file=sys.stderr)
    if not blocks:
        print("рой: отправлять нечего", file=sys.stderr)
        return 2
    msgs, masks, cut = build(args.task, blocks, args.max_chars)
    sent = sum(len(m["content"]) for m in msgs)
    if args.dry_run:
        print(msgs[1]["content"])
        print(f"рой: dry-run, {sent} символов, маски {masks or '—'}{', обрезано' if cut else ''}", file=sys.stderr)
        return 0
    answer, model, sec = call(args.model, msgs, args.timeout)
    total, bad = check_refs(answer, blocks)
    print(answer, flush=True)
    print(f"рой: {model}, {sec:.0f} с, ушло {sent} символов, маски {masks or '—'}{', обрезано' if cut else ''}; "
          f"ссылок {total}, битых {bad}" + (" — ПРОВЕРЬ ВЫЖИМКУ" if bad or not total else ""), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
