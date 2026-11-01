#!/usr/bin/env python3
"""
HR Helper Ops — локальный контроллер хоста (агент). Только stdlib python3 (>= 3.8).

Что делает в цикле (каждые OPS_AGENT_INTERVAL секунд):
  1. Собирает метрики хоста (CPU, память, диски, сеть, uptime), состояние docker-контейнеров
     (state/health/restartCount/exitCode/restart policy, CPU/RAM, пик памяти и swap, кого ядро убило
     по нехватке памяти — по журналу ядра), статистику nginx за минуту и бизнес-метрики из BUSINESS_CMDS.
  2. Отправляет отчёт в Ops-консоль: POST {OPS_CONSOLE_URL}/api/agent/report, подпись HMAC-SHA256.
  3. Выполняет команды из ответа (перезапуск контейнера) — с собственным allowlist и cooldown,
     результат уходит следующим отчётом.

Входящих портов агент не открывает: консоль (локальная или на Vercel) никогда не стучится на
сервер сама, всё инициирует агент. Подпись: X-Ops-Signature = sha256=HMAC(secret,
"{ts}.POST.{path}.{sha256(body)}"), ts — unix ms, строго возрастает (повтор отклоняется).

Переменные окружения (файл /etc/hrh-ops-agent.env для systemd):
  OPS_CONSOLE_URL          адрес консоли (https://…; http — только localhost)       обязательно
  OPS_AGENT_ID             id агента из «Настройки → Агенты»                        обязательно
  OPS_AGENT_SECRET         секрет агента (показывается один раз при создании)       обязательно
  OPS_AGENT_INTERVAL       период отчётов, сек (по умолчанию 15)
  OPS_COMPOSE_PROJECT      основной docker compose проект (стек продукта): его nginx, его контейнеры — первыми.
                           Видны контейнеры всех проектов; это не фильтр (до 1.5 был фильтром)
  OPS_CONTAINER_EXCLUDE    glob-маски имён контейнеров, которые не показывать вовсе (по умолчанию пусто)
  OPS_RESTART_PROJECTS     glob-маски compose-проектов, чьи контейнеры можно перезапускать из консоли
                           (по умолчанию — OPS_COMPOSE_PROJECT, а если он пуст — «*»; без проекта — имя «»)
  OPS_RESTART_ALLOW        glob-маски имён, которые можно перезапускать (по умолчанию «*»)
  OPS_RESTART_DENY         glob-маски, которые перезапускать нельзя никогда (по умолчанию пусто)
  OPS_RESTART_COOLDOWN_SEC пауза между перезапусками одного контейнера (по умолчанию 120)
  OPS_STATEFUL             имена/маски контейнеров, которые считать stateful (дополнительно к эвристике консоли)
  OPS_DISK_MOUNTS          точки монтирования через запятую (по умолчанию «/»)
  NGINX_ACCESS_LOG         путь к access.log nginx на самом сервере (по умолчанию /var/log/nginx/access.log)
  NGINX_CONTAINER          nginx в Docker: имя контейнера; пусто — найти сервис compose «nginx»
                           в OPS_COMPOSE_PROJECT (лог берётся через docker logs за последнюю минуту)
  OPS_NGINX_CONTAINERS     glob-маски контейнеров nginx, чьи server_name показывать доменами (раз в 10 мин
                           `nginx -T`, сертификаты — рукопожатием раз в 6 ч); пусто — сервис compose «nginx»
                           или образ nginx в любом проекте; «-» — домены не собирать
  BUSINESS_CMDS            JSON {"имя": "shell-команда, печатающая число"} — опционально
  BUSINESS_INTERVAL_SEC    как часто запускать BUSINESS_CMDS, сек (по умолчанию 300)
  HRH_STATE_DIR            где хранить учёт OOM (oom.json) и направлений VPN (vpn-flows.json.gz); по умолчанию —
                           StateDirectory юнита ($STATE_DIRECTORY)
  OPS_VPN_FILE             итог корневого сборщика WireGuard hrh-ops-vpnd.py (по умолчанию /run/hrh-ops-vpn/vpn.json);
                           файла нет — VPN не показывается; «-» — не читать
  OPS_VPN_PEERS            имена пиров: «10.77.0.2=Mac,10.77.0.3=телефон» (по умолчанию — адрес)
  OPS_VPN_PTR              имена адресов направлений обратным DNS (по умолчанию 1; 0 — не спрашивать)

Запуск: python3 hrh-ops-agent.py [--once] [--dry-run]
"""
import fnmatch
import hashlib
import hmac
import json
import os
import platform
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

# Сборщики — в соседнем файле (install.sh кладёт оба в /opt/hrh-ops); каталог скрипта уже в sys.path.
from hrh_ops_collect import (
    Background,
    HostSampler,
    business_metrics,
    disks,
    docker_containers,
    find_nginx_container,
    log,
    nginx_background,
    OomJournal,
    nginx_stats,
    os_name,
    run,
    uptime_sec,
)

# Домены — отдельный модуль: его сбой (старая установка без файла, ошибка разбора) выключает только домены.
try:
    from hrh_ops_edge import DomainFeed
except Exception as e:  # noqa: BLE001
    DomainFeed = None
    log("домены выключены: модуль hrh_ops_edge не загрузился (%s)" % type(e).__name__)

try:
    from hrh_ops_vpn import Ptr, VpnFeed, parse_names
except Exception as e:  # noqa: BLE001
    VpnFeed = None
    log("VPN выключен: модуль hrh_ops_vpn не загрузился (%s)" % type(e).__name__)

AGENT_VERSION = "1.6.0"
REPORT_PATH = "/api/agent/report"


def env_list(name, default=""):
    return [x.strip() for x in os.environ.get(name, default).split(",") if x.strip()]


class Config:
    def __init__(self):
        self.console_url = os.environ.get("OPS_CONSOLE_URL", "").rstrip("/")
        self.agent_id = os.environ.get("OPS_AGENT_ID", "")
        self.secret = os.environ.get("OPS_AGENT_SECRET", "")
        self.interval = max(5, min(600, int(os.environ.get("OPS_AGENT_INTERVAL", "15") or 15)))
        self.compose_project = os.environ.get("OPS_COMPOSE_PROJECT", "").strip()
        self.container_exclude = env_list("OPS_CONTAINER_EXCLUDE")
        # Наблюдение расширилось на все проекты, действия — нет: по умолчанию перезапуск, как и раньше, только в основном.
        self.restart_projects = env_list("OPS_RESTART_PROJECTS", self.compose_project or "*")
        self.restart_allow = env_list("OPS_RESTART_ALLOW", "*")
        self.restart_deny = env_list("OPS_RESTART_DENY")
        self.restart_cooldown = int(os.environ.get("OPS_RESTART_COOLDOWN_SEC", "120") or 120)
        self.stateful = env_list("OPS_STATEFUL")
        self.disk_mounts = env_list("OPS_DISK_MOUNTS", "/")
        self.nginx_log = os.environ.get("NGINX_ACCESS_LOG", "/var/log/nginx/access.log")
        self.nginx_container = os.environ.get("NGINX_CONTAINER", "").strip()
        self.nginx_containers = env_list("OPS_NGINX_CONTAINERS")
        self.business_interval = max(30, int(os.environ.get("BUSINESS_INTERVAL_SEC", "300") or 300))
        # Учёт OOM по журналу ядра: итоги по контейнерам переживают перезапуск агента (файл в StateDirectory).
        self.state_dir = os.environ.get("HRH_STATE_DIR") or os.environ.get("STATE_DIRECTORY") or None
        self.oom = OomJournal(self.state_dir)
        self.vpn_file = os.environ.get("OPS_VPN_FILE", "").strip() or "/run/hrh-ops-vpn/vpn.json"
        self.vpn_peers = os.environ.get("OPS_VPN_PEERS", "")
        self.vpn_ptr = os.environ.get("OPS_VPN_PTR", "1").strip() != "0"
        try:
            self.business_cmds = json.loads(os.environ.get("BUSINESS_CMDS", "") or "{}")
        except ValueError:
            log("BUSINESS_CMDS — не JSON, бизнес-метрики выключены")
            self.business_cmds = {}

    def validate(self):
        missing = [n for n, v in (("OPS_CONSOLE_URL", self.console_url), ("OPS_AGENT_ID", self.agent_id), ("OPS_AGENT_SECRET", self.secret)) if not v]
        if missing:
            raise SystemExit("не заданы: " + ", ".join(missing))
        url = urllib.parse.urlparse(self.console_url)
        local = url.hostname in ("localhost", "127.0.0.1", "::1")
        if url.scheme != "https" and not (url.scheme == "http" and local):
            raise SystemExit("OPS_CONSOLE_URL должен быть https:// (http — только для localhost)")


# ── Команды консоли ─────────────────────────────────────────────────────────


class Executor:
    """Команды выполняются в фоновых потоках: долгий `docker restart` (до 30 с на остановку)
    не должен останавливать отчёты — иначе консоль решит, что агент молчит."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.lock = threading.Lock()
        self.last_restart = {}
        self.running = set()
        self.results = []
        self.wake = threading.Event()

    def allowed(self, name, project):
        if any(fnmatch.fnmatch(name, p) for p in self.cfg.restart_deny):
            return "запрещено OPS_RESTART_DENY на хосте"
        if not any(fnmatch.fnmatch(name, p) for p in self.cfg.restart_allow):
            return "не входит в OPS_RESTART_ALLOW на хосте"
        if not any(fnmatch.fnmatch(project, p) for p in self.cfg.restart_projects):
            return "проект «%s» не входит в OPS_RESTART_PROJECTS на хосте" % (project or "без проекта")
        return None

    def _finish(self, cid, status, output):
        with self.lock:
            self.results.append({"id": cid, "status": status, "output": output[:4000]})
        self.wake.set()

    def _current(self, target):
        """Id и compose-проект контейнера прямо сейчас: список с прошлого отчёта мог устареть — контейнер
        пересоздан под тем же именем в другом проекте. None — docker не ответил или контейнера уже нет."""
        fmt = '{{.Id}} {{.Name}} {{index .Config.Labels "com.docker.compose.project"}}'
        code, out, _ = run(["docker", "inspect", "--type", "container", "-f", fmt, target], 15)
        parts = out.strip().split(" ", 2) if code == 0 else []
        # Имя из одних hex-символов docker сопоставил бы и как префикс Id другого контейнера — сверяем имя.
        if len(parts) < 2 or not re.match(r"^[0-9a-f]{12,64}$", parts[0]) or parts[1].lstrip("/") != target:
            return None
        project = parts[2].strip() if len(parts) > 2 else ""
        return parts[0], ("" if project == "<no value>" else project)

    def _restart(self, cid, target):
        log("перезапуск %s (команда #%s)" % (target, cid))
        started = time.time()
        current = self._current(target)
        denied = "контейнер не найден на хосте" if current is None else self.allowed(target, current[1])
        if current is None or denied:
            with self.lock:
                self.running.discard(target)
            log("отказ в перезапуске %s: %s" % (target, denied))
            self._finish(cid, "failed", denied)
            return
        # -t (а не --time/--timeout): короткий флаг понимают и старые, и новые версии docker. По Id — тот самый контейнер.
        code, out, err = run(["docker", "restart", "-t", "30", current[0]], 90)
        with self.lock:
            self.last_restart[target] = time.time()
            self.running.discard(target)
        text = (out + err).strip()[-1500:] or ("ok" if code == 0 else "код %d" % code)
        self._finish(cid, "succeeded" if code == 0 else "failed", "%s (за %.1f с)" % (text, time.time() - started))

    def execute(self, commands, known_names):
        for cmd in commands[:5]:
            cid, ctype, target = cmd.get("id"), cmd.get("type"), str(cmd.get("target", ""))
            if ctype != "restart" or not isinstance(cid, int):
                continue
            with self.lock:
                since = time.time() - self.last_restart.get(target, 0)
                busy = target in self.running
            if known_names is None:
                denied = "docker на хосте не отвечает — перезапуск невозможен"
            elif target not in known_names:
                denied = "контейнер не найден на хосте"
            elif not re.match(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,189}$", target):
                denied = "недопустимое имя контейнера"
            elif busy:
                denied = "перезапуск этого контейнера уже выполняется"
            else:
                denied = self.allowed(target, known_names[target])
                if not denied and since < self.cfg.restart_cooldown:
                    denied = "cooldown хоста: прошло %d с из %d" % (since, self.cfg.restart_cooldown)
            if denied:
                log("отказ в перезапуске %s: %s" % (target, denied))
                self._finish(cid, "failed", denied)
                continue
            with self.lock:
                self.running.add(target)
            threading.Thread(target=self._restart, args=(cid, target), daemon=True).start()

    def take_results(self):
        with self.lock:
            out, self.results = self.results[:20], self.results[20:]
        return out

    def requeue(self, results):
        with self.lock:
            self.results = results + self.results


# ── Отправка ────────────────────────────────────────────────────────────────


class Client:
    def __init__(self, cfg):
        self.cfg = cfg
        self.last_ts = 0

    def post_report(self, payload):
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        ts = max(int(time.time() * 1000), self.last_ts + 1)
        self.last_ts = ts
        signing = "%d.POST.%s.%s" % (ts, REPORT_PATH, hashlib.sha256(body).hexdigest())
        sig = hmac.new(self.cfg.secret.encode(), signing.encode(), hashlib.sha256).hexdigest()
        req = urllib.request.Request(
            self.cfg.console_url + REPORT_PATH,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "User-Agent": "hrh-ops-agent/" + AGENT_VERSION,
                "X-Ops-Agent": self.cfg.agent_id,
                "X-Ops-Timestamp": str(ts),
                "X-Ops-Signature": "sha256=" + sig,
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                return json.loads(res.read(1024 * 1024).decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = e.read(2000).decode("utf-8", "replace")
            raise RuntimeError("консоль ответила HTTP %d: %s" % (e.code, detail[:300]))


def docker_snapshot(cfg, docker_bg):
    """(контейнеры | None, ошибка | None). Ждём docker не дольше 8 с; снимок годен 3 интервала."""
    docker, at = docker_bg.get(budget=min(8, cfg.interval), max_age=cfg.interval * 3)
    if docker is None:
        since = "последний ответ %d с назад" % (time.time() - at) if at else "ещё ни разу не ответил"
        return None, "docker CLI не отвечает (%s)" % since
    if isinstance(docker, Exception):
        return None, ("сбой сбора docker: %s" % docker)[:300]
    return docker


def nginx_traffic(cfg, containers, nginx_bg, nginx_target):
    """Трафик за минуту: файл access.log на хосте, иначе — лог контейнера nginx (docker logs)."""
    if not cfg.nginx_container:
        stats = nginx_stats(cfg.nginx_log)
        if stats is not None:
            return stats
    name = cfg.nginx_container or find_nginx_container(containers, cfg.compose_project)
    if not name:
        return None
    nginx_target["name"] = name
    # Сбор раз в минуту — снимок годен до следующего сбора с запасом (иначе между сборами — пусто).
    stats, _ = nginx_bg.get(budget=3, max_age=max(cfg.interval * 3, 90))
    return None if isinstance(stats, Exception) else stats


def collect(cfg, sampler, executor, elapsed, docker_bg, biz_bg, nginx_bg, nginx_target, domains=None, domains_budget=0, vpn=None):
    containers, docker_err = docker_snapshot(cfg, docker_bg)
    payload = {
        "agentVersion": AGENT_VERSION,
        "hostname": socket.gethostname()[:190],
        "os": ("%s %s" % (platform.system(), platform.release()))[:190],
        "osName": os_name(),
        "intervalSec": cfg.interval,
        "capturedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "uptimeSec": uptime_sec(),
        "cpu": sampler.cpu(),
        "memory": HostSampler.memory(),
        "disks": disks(cfg.disk_mounts),
        "commandResults": executor.take_results(),
    }
    net = sampler.network(elapsed)
    if net:
        payload["network"] = net
    if containers is not None:
        for c in containers:
            # Консоль показывает кнопку перезапуска только там, где хост его выполнит (cooldown не в счёт).
            c["restartable"] = executor.allowed(c["name"], c.get("composeProject", "")) is None
        # В отчёт — не больше 200: основной стек и работающие первыми, иначе срез по порядку `docker ps -a` (новые
        # первыми) то выкидывал бы, то возвращал контейнер, и консоль сравнивала бы его со старым счётчиком рестартов.
        containers.sort(key=lambda c: (c.get("composeProject", "") != cfg.compose_project, c.get("state") != "running", c["name"]))
        payload["containers"] = containers[:200]
        if cfg.compose_project:
            payload["mainProject"] = cfg.compose_project[:120]
    if docker_err:
        payload["dockerError"] = docker_err
    ngx = nginx_traffic(cfg, containers, nginx_bg, nginx_target)
    if ngx:
        payload["nginx"] = ngx
    # Бизнес-команды идут раз в BUSINESS_INTERVAL_SEC: последний результат живёт до следующего. businessAt —
    # время замера: по нему консоль считает правила бизнес-метрик в замерах, а не в отчётах (агент ≥ 1.3).
    biz, biz_at = biz_bg.get(budget=2, max_age=cfg.business_interval + cfg.interval * 6)
    if cfg.business_cmds and isinstance(biz, Exception):
        # Сбор упал целиком — все команды не посчитаны: консоль поднимет «Бизнес-метрики не считаются».
        payload["businessFailed"] = [str(k)[:48] for k in list(cfg.business_cmds)[:20]]
        payload["businessAt"] = int(biz_at)
    elif cfg.business_cmds and biz:
        values, failed = biz
        if values:
            payload["business"] = values
        payload["businessFailed"] = failed
        payload["businessAt"] = int(biz_at)
    if domains is not None:
        # Список до сортировки и обрезки по 200: домены ищутся во всех nginx хоста, а не в попавших в отчёт.
        domains.attach(payload, containers, domains_budget)
    if vpn is not None:
        try:
            vpn.attach(payload)
        except Exception as e:  # noqa: BLE001 — сбой разбора VPN не должен останавливать отчёт
            log("VPN: снимок не разобран (%s)" % type(e).__name__)
    if payload["uptimeSec"] is None:
        del payload["uptimeSec"]
    if payload["osName"] is None:
        del payload["osName"]
    # None — docker не ответил: состав контейнеров неизвестен, перезапуски не выполняем. Имя → compose-проект.
    return payload, (None if containers is None else {c["name"]: c.get("composeProject", "") for c in containers})


def main():
    cfg = Config()
    once = "--once" in sys.argv
    dry = "--dry-run" in sys.argv
    if not dry:
        cfg.validate()
    sampler, executor, client = HostSampler(), Executor(cfg), Client(cfg)
    docker_bg = Background(lambda: docker_containers(cfg))
    biz_bg = Background(lambda: business_metrics(cfg.business_cmds), min_interval=cfg.business_interval)
    nginx_target = {"name": None}
    # Трафик nginx — счётчики за минуту: собирать раз в минуту, отчёт уходит каждые OPS_AGENT_INTERVAL.
    nginx_bg = nginx_background(lambda: nginx_target["name"])
    domains = DomainFeed(cfg.nginx_containers, cfg.compose_project) if DomainFeed and cfg.nginx_containers != ["-"] else None
    vpn = None
    if VpnFeed and cfg.vpn_file != "-":
        vpn = VpnFeed(cfg.vpn_file, parse_names(cfg.vpn_peers), cfg.state_dir, Ptr(cfg.vpn_ptr and not dry))
    sampler.cpu()  # первая точка для дельты CPU
    log("старт: агент %s → %s, период %d с" % (cfg.agent_id or "?", cfg.console_url or "(dry-run)", cfg.interval))
    backoff = cfg.interval
    last = time.time()
    while True:
        now = time.time()
        # В цикле домены не ждём (скан идёт в фоне, уйдёт со следующим отчётом); --dry-run ждёт его, чтобы показать.
        payload, names = collect(cfg, sampler, executor, now - last, docker_bg, biz_bg, nginx_bg, nginx_target, domains, 120 if dry else 0, vpn)
        last = now
        if dry:
            print(json.dumps(payload, ensure_ascii=False, indent=2))
            return
        pending = list(payload["commandResults"])
        try:
            res = client.post_report(payload)
            backoff = cfg.interval
            if domains is not None:
                domains.delivered()
            commands = res.get("commands") or []
            if commands:
                executor.execute(commands, names)
        except Exception as e:  # noqa: BLE001 — агент не должен падать из-за сети/консоли
            executor.requeue(pending)
            # Потолок 60 с: после рестарта консоли агент возвращается в пределах её окна «молчит».
            backoff = min(backoff * 2, 60)
            log("отчёт не доставлен: %s; повтор через %d с" % (e, backoff))
            if once:
                sys.exit(1)
            time.sleep(backoff)
            continue
        if once:
            log("отчёт доставлен")
            return
        # Завершившаяся команда будит цикл: результат и свежее состояние — сразу, не через интервал.
        executor.wake.wait(max(1, cfg.interval - (time.time() - now)))
        if executor.wake.is_set():
            executor.wake.clear()
            time.sleep(2)


if __name__ == "__main__":
    main()
