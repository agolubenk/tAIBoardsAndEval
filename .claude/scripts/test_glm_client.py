#!/usr/bin/env python3
"""Цепочка моделей и маршрут glm_client без сети: транспорт _post подменяется заглушкой.

Запуск: python3 -I .claude/scripts/test_glm_client.py  (exit 1 при расхождении).
"""
import importlib.util
import os
import sys
import tempfile
import urllib.error
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("glm_client", HERE / "glm_client.py")
glm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(glm)

for name in ("GLM_MODEL", "GLM_FALLBACK_MODEL", "GLM_ENDPOINT", "GLM_HEADROOM_URL", "DAMS_GLM"):
    os.environ.pop(name, None)
glm.load_key = lambda: "test-key"
glm._network_down = lambda: False
glm.DOWN_MARKER = Path(tempfile.mkdtemp()) / "glm-down"  # реальный маркер не трогаем и в репозитории не мусорим

failures = []
calls = []


def check(name, ok, detail=""):
    if not ok:
        failures.append("%s %s" % (name, detail))


def ok(text):
    return {"choices": [{"message": {"content": text}}]}


def http_error(code):
    return urllib.error.HTTPError("http://x", code, "err", {}, None)


def refused():
    return urllib.error.URLError(ConnectionRefusedError(61, "refused"))


def stub(script):
    """script: (url, model) → ответ dict | исключение. Записывает каждый вызов."""
    def post(url, body, headers, timeout):
        import json
        model = json.loads(body)["model"]
        calls.append((url, model, round(timeout, 1), headers.get("x-headroom-base-url")))
        result = script(url, model)
        if isinstance(result, Exception):
            raise result
        return result
    glm._post = post


def chat(timeout=12.0, validate=None):
    calls.clear()
    return glm.glm_chat([{"role": "user", "content": "x"}], timeout=timeout, validate=validate)


# 1. Основная модель отвечает — запасная не вызывается, маршрут через Headroom с заголовками.
stub(lambda url, model: ok("GOAL: a"))
out = chat()
check("flash ответила", out == "GOAL: a", repr(out))
check("один вызов, модель glm-4.7-flash", len(calls) == 1 and calls[0][1] == "glm-4.7-flash", repr(calls))
check("через Headroom с меткой dams-glm", calls and calls[0][0] == "http://127.0.0.1:8787/p/dams-glm/v1/chat/completions",
      repr(calls))
check("upstream для прокси — General API без /chat/completions",
      calls and calls[0][3] == "https://api.z.ai/api/paas/v4", repr(calls))

# 2. Основная — 429 (лимит бесплатного яруса) → запасная glm-4.7.
stub(lambda url, model: http_error(429) if model == "glm-4.7-flash" else ok("GOAL: b"))
out = chat(timeout=20)
check("429 основной → ответ запасной", out == "GOAL: b", repr(out))
check("вторая модель — glm-4.7", [c[1] for c in calls] == ["glm-4.7-flash", "glm-4.7"], repr(calls))

# 3. Основная ответила не по формату → запасная (validate).
stub(lambda url, model: ok("просто текст") if model == "glm-4.7-flash" else ok("GOAL: c"))
out = chat(timeout=20, validate=lambda t: "GOAL:" in t)
check("ответ не по формату → запасная", out == "GOAL: c", repr(out))

# 4. Бюджета на запасную нет (меньше FALLBACK_MIN_S после основной) → None, без второго вызова.
stub(lambda url, model: http_error(503))
out = chat(timeout=glm.FALLBACK_MIN_S - 1)
check("на запасную не хватает бюджета — не зовём", out is None and len(calls) == 1, repr((out, calls)))

# 5. Потолок основной модели: max(4 с, 40 % бюджета) — медленная flash не съедает время запасной.
stub(lambda url, model: ok("GOAL: d"))
chat(timeout=12.0)
check("потолок основной = max(4, 0.4·12) = 4.8 с", calls and calls[0][2] == 4.8, repr(calls))

# 6. Headroom не поднят (отказ соединения) → тот же вызов напрямую, той же моделью.
stub(lambda url, model: refused() if "127.0.0.1" in url else ok("GOAL: e"))
out = chat()
check("отказ прокси → напрямую", out == "GOAL: e", repr(out))
check("второй вызов — прямой URL, та же модель",
      [c[:2] for c in calls] == [("http://127.0.0.1:8787/p/dams-glm/v1/chat/completions", "glm-4.7-flash"),
                                 ("https://api.z.ai/api/paas/v4/chat/completions", "glm-4.7-flash")], repr(calls))

# 7. GLM_HEADROOM_URL на внешний хост — игнорируется (ключ по http только на петлю), идём напрямую.
os.environ["GLM_HEADROOM_URL"] = "http://evil.example:8787/p/x"
stub(lambda url, model: ok("GOAL: f"))
chat()
check("внешний адрес прокси игнорируется", calls and calls[0][0].startswith("https://api.z.ai/"), repr(calls))
os.environ["GLM_HEADROOM_URL"] = ""
chat()
check("GLM_HEADROOM_URL='' — напрямую", calls and calls[0][0].startswith("https://api.z.ai/"), repr(calls))
os.environ.pop("GLM_HEADROOM_URL")

# 8. Сеть лежит (DNS/соединение при прямом вызове) → запасную не зовём, маркер «сеть лежит» ставится.
os.environ["GLM_HEADROOM_URL"] = ""
stub(lambda url, model: urllib.error.URLError(OSError(8, "nodename nor servname provided")))
out = chat(timeout=30)
check("сеть лежит — один вызов, None", out is None and len(calls) == 1, repr((out, calls)))
check("маркер сети поставлен", glm.DOWN_MARKER.exists())
glm.DOWN_MARKER.unlink(missing_ok=True)
os.environ.pop("GLM_HEADROOM_URL")

# 9. Основная ответила 200, но не JSON → не обрыв цепочки, запасная пробует.
def not_json(url, model):
    if model == "glm-4.7-flash":
        raise ValueError("Expecting value")  # так json.loads сообщает о не-JSON теле
    return ok("GOAL: g")


stub(not_json)
out = chat(timeout=20)
check("200 не JSON у основной → ответ запасной", out == "GOAL: g", repr((out, calls)))

# 10. GLM_FALLBACK_MODEL='' — без запасной.
os.environ["GLM_FALLBACK_MODEL"] = ""
stub(lambda url, model: http_error(429))
out = chat(timeout=30)
check("запасная отключена — один вызов", out is None and len(calls) == 1, repr(calls))
os.environ.pop("GLM_FALLBACK_MODEL")

for f in failures:
    print("FAIL", f)
print("glm_client chain: %d failed" % len(failures))
sys.exit(1 if failures else 0)
