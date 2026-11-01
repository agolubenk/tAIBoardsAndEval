#!/usr/bin/env python3
"""1) Контекст упоминаний Council/консилиум в ТЕЛАХ (не комментариях) core-карточек.
2) Широкий скан заголовков по AI-лексике (для adjacent-секции).
3) Прямой поиск council в заголовках."""
import json
import re

raw = json.load(open('.ai/task/ai-council-backlog/raw.json'))

print("── 1. Council/консилиум/AI Council в ТЕЛЕ карточек ──")
for c in raw:
    body = c.get("body", "") or ""
    for m in re.finditer(r"(?i)(консилиум|council|ai[- ]council)", body):
        s = max(0, m.start() - 90)
        print(f"[{c['db']}/{c.get('status')}] {c.get('title')[:70]}")
        print(f"   …{body[s:m.end() + 110]}…".replace(chr(10), " "))
        break  # первое вхождение на карточку

print("\n── 2. Заголовки с AI-лексикой ──")
ai_rx = re.compile(r"(?i)(\bИИ\b|\bAI\b|LLM|GPT|нейрос|искусственн|модел|ollama|llama|glm|gemini|qwen|mistral|deepseek|whisper|STT|TTS|эмбеддинг|vector|RAG|DAMS|headroom|graphify|промпт|prompt|MCP|консилиум|council|агент\b|agent)")
for c in raw:
    t = c.get("title", "")
    if ai_rx.search(t):
        print(f"[{c['db']}/{c.get('status')}] {str(c.get('priority') or c.get('severity')):8s} {t[:100]}")

print("\n── 3. Заголовки со словом council/консилиум напрямую ──")
for c in raw:
    if re.search(r"(?i)(council|консилиум|consilium)", c.get("title", "")):
        print(f"[{c['db']}/{c.get('status')}] {c.get('title')[:100]}")