#!/usr/bin/env python3
"""
Событие деплоя → Ops-консоль (живая карточка «Деплои», POST /api/agent/deploy-events).

Зовёт contabo-deploy.sh через lib/ops-deploy-events.sh — с </dev/null >/dev/null 2>&1 || true и
`timeout 5`, если он есть. Руками — для проверки: --dry-run печатает подписанный запрос, никуда не ходит.

  python3 ops-deploy-event.py --event build_start --seq 3 --sha <40 hex> --started <unix> --now <unix> \
      --log "<строки сводки>" [--rc <код, только у deploy_done>] [--env-file /etc/hrh-ops-agent.env] [--dry-run]

Учётка — агента хоста: OPS_CONSOLE_URL, OPS_AGENT_ID, OPS_AGENT_SECRET из /etc/hrh-ops-agent.env. Файл
разбирается как строки KEY=VALUE, ничего не исполняется. Нет файла, ключей или прав на чтение — выход 0
молча. Подпись — как у агента: X-Ops-Signature = sha256=HMAC(secret, "{ts}.POST.{path}.{sha256(body)}").

Гарантии для скрипта деплоя: ни строки в stdout/stderr (кроме --dry-run и --help), секрет не печатается
никогда, stdin не читается, общий дедлайн 4 с (SIGALRM без обработчика — процесс завершается сразу, даже в
DNS), каждая операция HTTP — не дольше 3 с, без прокси и без перехода по редиректам.

Коды выхода — для отладки, скрипт деплоя их не смотрит: 0 — принято или слать нечего; 1 — консоль не
ответила; 2 — консоль отклонила; 3 — неверные аргументы.

Строки сводки (--log), одна запись на строку, поля через пробел; неверная запись пропускается:
  p <фаза> <running|ok|warn|failed|skipped> <unix> <код|->       — переход фазы
  c <метка|-> <running|ok|failed> <unix> <код|-> <https-адрес>  — проверка по публичному адресу
  r <сменились> <без rollback-prev> <pending не снят>           — итог rollback-prev
Только stdlib python3 >= 3.8.
"""
import argparse
import hashlib
import hmac
import json
import os
import re
import signal
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import warnings

DEADLINE_SEC = 4
HTTP_TIMEOUT_SEC = 3
EVENT_PATH = "/api/agent/deploy-events"
MAX_BODY = 16 * 1024
DEFAULT_ENV_FILE = "/etc/hrh-ops-agent.env"
EVENT_TYPES = (
    "deploy_start",
    "prepare",
    "build_start",
    "build_done",
    "rollback_prev",
    "nginx_apply",
    "health_checks",
    "deploy_done",
)
PHASE_STATUS = ("running", "ok", "warn", "failed", "skipped")
CHECK_STATUS = ("running", "ok", "failed")
MAX_RECORDS = 200
MAX_ITEMS = 16

KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
URL_RE = re.compile(r"^https://[A-Za-z0-9.-]{1,253}(?::\d{1,5})?/[A-Za-z0-9._~/-]{0,200}$")
UINT_RE = re.compile(r"^\d{1,10}$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
AGENT_RE = re.compile(r"^[a-z0-9-]{1,64}$")
ENV_KEY_RE = re.compile(r"^[A-Z_][A-Z0-9_]*$")
LOOPBACK = ("localhost", "127.0.0.1", "::1")


class QuietParser(argparse.ArgumentParser):
    """Ошибка аргументов — код 3 без вывода: в лог деплоя не должно попасть ни строки."""

    def error(self, message):
        raise SystemExit(3)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Подписанный запрос уходит только по адресу из файла агента."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def parse_args(argv):
    p = QuietParser(prog="ops-deploy-event.py", description="Событие деплоя в Ops-консоль (подробно — в начале файла).")
    p.add_argument("--event", required=True, choices=EVENT_TYPES)
    p.add_argument("--seq", required=True, type=int)
    p.add_argument("--sha", required=True)
    p.add_argument("--started", required=True, type=int)
    p.add_argument("--now", required=True, type=int)
    p.add_argument("--log", default="")
    p.add_argument("--rc", type=int)
    p.add_argument("--env-file", default=DEFAULT_ENV_FILE)
    p.add_argument("--dry-run", action="store_true")
    return p.parse_args(argv)


def read_env_file(path):
    """KEY=VALUE по строкам (как EnvironmentFile systemd): комментарии, пустые строки, кавычки вокруг значения."""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            text = f.read(65536)
    except OSError:
        return None
    env = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        key, sep, value = line.partition("=")
        key = key.strip()
        if not sep or not ENV_KEY_RE.match(key):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        env[key] = value
    return env


def load_credentials(path):
    """(адрес консоли, id агента, секрет) или None — слать нечего."""
    env = read_env_file(path)
    if not env:
        return None
    url = env.get("OPS_CONSOLE_URL", "").strip().rstrip("/")
    agent = env.get("OPS_AGENT_ID", "").strip()
    secret = env.get("OPS_AGENT_SECRET", "")
    if not url or not secret or not AGENT_RE.match(agent):
        return None
    try:
        parsed = urllib.parse.urlparse(url)
        host = parsed.hostname
    except ValueError:
        return None
    # Как у агента: https, а http — только до самого сервера (консоль в контейнере на loopback).
    if parsed.username or parsed.password or not host:
        return None
    if parsed.scheme != "https" and not (parsed.scheme == "http" and host in LOOPBACK):
        return None
    return url, agent, secret


def _uint(tok):
    return int(tok) if UINT_RE.match(tok) else None


def _code(tok):
    if tok == "-":
        return None
    v = _uint(tok)
    return v if v is not None and v <= 255 else None


def summarize(log):
    """Записи сводки → (фазы, проверки, rollback): поздняя запись побеждает, начало фазы — первая running."""
    phases, phase_order, checks, check_order, rollback = {}, [], {}, [], None
    for line in log.splitlines()[:MAX_RECORDS]:
        f = line.split()
        if not f:
            continue
        if f[0] == "p" and len(f) == 5 and KEY_RE.match(f[1]) and f[2] in PHASE_STATUS:
            at = _uint(f[3])
            if at is None:
                continue
            ph = phases.get(f[1])
            if ph is None:
                if len(phase_order) >= MAX_ITEMS:
                    continue
                ph = phases[f[1]] = {"key": f[1], "status": "running", "startedAt": None, "endedAt": None, "rc": None}
                phase_order.append(f[1])
            if f[2] == "running":
                ph.update(status="running", endedAt=None, rc=None)
                if ph["startedAt"] is None:
                    ph["startedAt"] = at
            else:
                ph.update(status=f[2], endedAt=at, rc=_code(f[4]))
                if ph["startedAt"] is None:
                    ph["startedAt"] = at
        elif f[0] == "c" and len(f) == 6 and (f[1] == "-" or KEY_RE.match(f[1])) and f[2] in CHECK_STATUS and URL_RE.match(f[5]):
            at = _uint(f[3])
            if at is None:
                continue
            url = f[5]
            ck = checks.get(url)
            if ck is None:
                if len(check_order) >= MAX_ITEMS:
                    continue
                ck = checks[url] = {"key": None, "url": url, "status": "running", "rc": None, "startedAt": None, "endedAt": None}
                check_order.append(url)
            if f[1] != "-":
                ck["key"] = f[1]
            if f[2] == "running":
                ck.update(status="running", startedAt=ck["startedAt"] or at, endedAt=None, rc=None)
            else:
                ck.update(status=f[2], endedAt=at, rc=_code(f[4]))
                if ck["startedAt"] is None:
                    ck["startedAt"] = at
        elif f[0] == "r" and len(f) == 4 and all(UINT_RE.match(x) for x in f[1:]):
            changed, failed, stuck = (min(int(x), 64) for x in f[1:])
            rollback = {"changed": changed, "failed": failed, "stuck": stuck}
    return [phases[k] for k in phase_order], [checks[u] for u in check_order], rollback


def build_event(args):
    """Тело события или None, если аргументы не годятся."""
    started = args.started
    if not SHA_RE.match(args.sha) or not 1_000_000_000 <= started <= 9_999_999_999 or not 1 <= args.seq <= 10_000:
        return None
    final = args.event == "deploy_done"
    if final != (args.rc is not None) or (final and not 0 <= args.rc <= 255):
        return None
    phases, checks, rollback = summarize(args.log)
    return {
        "v": 1,
        "deployId": "%s-%d" % (args.sha, started),
        "seq": args.seq,
        "type": args.event,
        "sha": args.sha,
        "startedAt": started,
        "at": max(args.now, started),
        "phases": phases,
        "checks": checks,
        "rollback": rollback,
        "rc": args.rc if final else None,
    }


def signed_request(url, agent, secret, body):
    ts = int(time.time() * 1000)
    signing = "%d.POST.%s.%s" % (ts, EVENT_PATH, hashlib.sha256(body).hexdigest())
    sig = hmac.new(secret.encode("utf-8"), signing.encode("utf-8"), hashlib.sha256).hexdigest()
    headers = {
        "Content-Type": "application/json",
        "User-Agent": "hrh-ops-deploy-event/1",
        "X-Ops-Agent": agent,
        "X-Ops-Timestamp": str(ts),
        "X-Ops-Signature": "sha256=" + sig,
    }
    return url + EVENT_PATH, headers


def post(url, headers, body):
    # Прокси не используем: консоль — loopback на проде или прямой https.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    req = urllib.request.Request(url, data=body, method="POST", headers=headers)
    try:
        with opener.open(req, timeout=HTTP_TIMEOUT_SEC) as res:
            res.read(4096)
            return 0 if 200 <= res.status < 300 else 2
    except urllib.error.HTTPError:
        return 2
    except Exception:  # noqa: BLE001 — сеть, таймаут, TLS: деплой не должен об этом узнать
        return 1


def main(argv):
    # Без обработчика SIGALRM завершает процесс сразу — и в зависшем DNS, и в медленном ответе по байту.
    # Сброс на умолчание: унаследованный от родителя SIG_IGN пережил бы exec и отключил бы дедлайн.
    signal.signal(signal.SIGALRM, signal.SIG_DFL)
    signal.alarm(DEADLINE_SEC)
    # Унаследованные дескрипторы не держим: среди них flock обёртки hrhelper-deploy (fd 9) — живой помощник
    # отменённого деплоя не должен держать блокировку следующего.
    os.closerange(3, 1024)
    warnings.simplefilter("ignore")
    args = parse_args(argv)
    event = build_event(args)
    if event is None:
        return 3
    creds = load_credentials(args.env_file)
    if creds is None:
        return 0
    body = json.dumps(event, separators=(",", ":")).encode("utf-8")
    if len(body) > MAX_BODY:
        return 3
    url, headers = signed_request(creds[0], creds[1], creds[2], body)
    if args.dry_run:
        out = {"method": "POST", "url": url, "path": EVENT_PATH, "headers": headers, "body": body.decode("utf-8")}
        sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
        return 0
    return post(url, headers, body)


if __name__ == "__main__":
    try:
        code = main(sys.argv[1:])
    except SystemExit as e:
        code = e.code if isinstance(e.code, int) else 3
    except BaseException:  # noqa: BLE001 — ни трейсбека, ни строки в лог деплоя
        code = 1
    sys.exit(code)
