"""Сверка контракта headroom-runtime ↔ backend (`headroom-runtime.client.ts`) на синтетике.

Тело запроса и проверка ответа повторяют клиент backend: POST /v1/compress, Bearer-токен,
{messages, model, config:{compress_user_messages:true, protect_recent:0}}; ответ — та же форма,
что CompressResponseSchema (zod). Данные синтетические, без реальных людей.
Запуск — infra/headroom/runtime/README.md §«Обновление образа»:
  python3 infra/headroom/runtime/contract_check.py http://127.0.0.1:8798 <token> <метка-версии>
"""
import json
import re
import sys
import time
import urllib.error
import urllib.request

BASE, TOKEN, LABEL = sys.argv[1].rstrip("/"), sys.argv[2], sys.argv[3]

PROSE = (
    "Вакансия: старший бэкенд-разработчик в команду платёжного сервиса. Кандидат прошёл техническое интервью, "
    "показал уверенное знание Go и PostgreSQL, рассказал о миграции монолита на сервисы и о том, как команда "
    "снижала задержку платёжного шлюза. Интервьюер отметил сильную архитектурную аргументацию и слабое место — "
    "мало опыта с наблюдаемостью и нагрузочным тестированием. Ожидания по компенсации в пределах вилки, выход "
    "возможен через месяц, нужен гибридный формат работы. Рекомендация: пригласить на финальную встречу с "
    "руководителем направления, отдельно обсудить онбординг и план на испытательный срок. "
) * 6

CANDIDATES = [
    {"id": f"0f8c{i:04d}-1b2c-4d5e-8f90-a1b2c3d4e5f6", "stage": ["screening", "interview", "offer"][i % 3],
     "score": 50 + (i * 7) % 50, "updatedAt": f"2026-10-{(i % 28) + 1:02d}T10:00:00Z", "source": "hh.ru"}
    for i in range(80)
]
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def valid_shape(data) -> str:
    """Та же проверка, что CompressResponseSchema в backend."""
    if not isinstance(data, dict) or not isinstance(data.get("messages"), list):
        return "нет messages[]"
    for m in data["messages"]:
        if not (isinstance(m, dict) and isinstance(m.get("role"), str) and isinstance(m.get("content"), str)):
            return "messages[i] не {role:str, content:str}"
    for k in ("tokens_before", "tokens_after"):
        if k in data and data[k] is not None and not (isinstance(data[k], (int, float)) and data[k] >= 0):
            return f"{k} не число ≥0"
    if "transforms_applied" in data and data["transforms_applied"] is not None and not (
            isinstance(data["transforms_applied"], list) and all(isinstance(t, str) for t in data["transforms_applied"])):
        return "transforms_applied не string[]"
    if "compression_skipped" in data and data["compression_skipped"] is not None and not isinstance(
            data["compression_skipped"], bool):
        return "compression_skipped не bool"
    return "OK"


def post(content: str, token: str = TOKEN):
    body = json.dumps({"messages": [{"role": "user", "content": content}], "model": "glm-4.7",
                       "config": {"compress_user_messages": True, "protect_recent": 0}}).encode()
    req = urllib.request.Request(BASE + "/v1/compress", data=body, method="POST", headers={
        "Content-Type": "application/json", "Authorization": f"Bearer {token}"})
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read()), int((time.time() - started) * 1000)
    except urllib.error.HTTPError as err:
        return err.code, None, int((time.time() - started) * 1000)


def main() -> None:
    json_text = "Контекст (кандидаты):\n" + json.dumps(CANDIDATES, ensure_ascii=False, indent=2)
    for name, text in (("проза", PROSE), ("JSON-80", json_text), ("проза-повтор", PROSE)):
        code, data, ms = post(text)
        if data is None:
            print(f"{LABEL} {name:<12} HTTP {code} за {ms} мс")
            continue
        out = "".join(m["content"] for m in data.get("messages", []))
        kept = sum(1 for u in set(UUID_RE.findall(text)) if u in out)
        total = len(set(UUID_RE.findall(text)))
        print(f"{LABEL} {name:<12} HTTP {code} {ms:>5} мс | схема {valid_shape(data)} | токены "
              f"{data.get('tokens_before')}→{data.get('tokens_after')} | {data.get('transforms_applied')} | "
              f"skipped={data.get('compression_skipped')} {data.get('skip_reason') or ''}| UUID {kept}/{total}")
    code, _, _ = post("проверка", token="wrong-token")
    print(f"{LABEL} чужой токен → HTTP {code} (ожидается 401)")


main()
